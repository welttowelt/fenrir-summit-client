import { num } from "starknet";

export interface SwapQuote {
  impact: number;
  price_impact?: number;
  total: string;
  totalDisplay: number;
  splits: SwapSplit[];
}

interface SwapSplit {
  amount_specified: string;
  route: RouteNode[];
}

interface RouteNode {
  pool_key: {
    token0: string;
    token1: string;
    fee: string;
    tick_spacing: string;
    extension: string;
  };
  sqrt_ratio_limit: string;
  skip_ahead: string;
}

interface SwapQuoteResponse {
  total_calculated?: string | number;
  price_impact?: number;
  splits?: SwapSplit[];
}

export interface SwapCall {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

interface TokenQuote {
  tokenAddress: string;
  minimumAmount: number;
  quote: SwapQuote;
}

const EKUBO_QUOTER_BASE = "https://prod-api-quoter.ekubo.org/23448594291968334";

const inflightQuotes: Partial<Record<string, Promise<SwapQuote>>> = {};
let rateLimitUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applySlippage(value: bigint, slippageBps: number): bigint {
  const basis = 10_000n;
  const bps = BigInt(slippageBps);
  return (value * (basis - bps)) / basis;
}

function toSafeDisplayNumber(value: string): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

export async function getSwapQuote(
  amount: bigint | string,
  token: string,
  otherToken: string
): Promise<SwapQuote> {
  const maxRetries = 3;
  const amountParam = typeof amount === "bigint" ? amount.toString() : amount;
  const cacheKey = `${amountParam}-${token}-${otherToken}`;

  if (Date.now() < rateLimitUntil) {
    throw new Error("Quoter temporarily rate limited");
  }

  if (inflightQuotes[cacheKey]) {
    return inflightQuotes[cacheKey] as Promise<SwapQuote>;
  }

  inflightQuotes[cacheKey] = (async () => {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${EKUBO_QUOTER_BASE}/${amountParam}/${token}/${otherToken}`);
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await sleep(2000);
          continue;
        }
        throw err;
      }

      if (!response.ok) {
        if (response.status === 429) {
          rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          throw new Error("Quoter rate limited");
        }

        if (response.status >= 400 && response.status < 500) {
          const text = await response.text();
          throw new Error(text || `Quoter error ${response.status}`);
        }

        if (attempt < maxRetries - 1) {
          await sleep(2000);
          continue;
        }
      }

      let data: SwapQuoteResponse;
      try {
        data = (await response.json()) as SwapQuoteResponse;
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await sleep(2000);
          continue;
        }
        throw err;
      }

      if (data.total_calculated !== undefined) {
        const totalStr = String(data.total_calculated);
        return {
          impact: data.price_impact || 0,
          price_impact: data.price_impact || 0,
          total: totalStr,
          totalDisplay: toSafeDisplayNumber(totalStr),
          splits: data.splits || [],
        };
      }

      if (attempt < maxRetries - 1) {
        await sleep(2000);
      }
    }

    return {
      impact: 0,
      total: "0",
      totalDisplay: 0,
      splits: [],
    };
  })();

  try {
    return await (inflightQuotes[cacheKey] as Promise<SwapQuote>);
  } finally {
    delete inflightQuotes[cacheKey];
  }
}

export function generateSwapCalls(
  routerAddress: string,
  paymentTokenAddress: string,
  tokenQuote: TokenQuote,
  slippageBps = 100
): SwapCall[] {
  const { tokenAddress, minimumAmount, quote } = tokenQuote;

  if (!quote || quote.splits.length === 0) {
    return [];
  }

  const total = BigInt(quote.total);
  let totalQuoteSum: bigint;

  if (total < 0n) {
    const absTotal = -total;
    const doubledTotal = absTotal * 2n;
    totalQuoteSum = doubledTotal < absTotal + BigInt(1e19) ? doubledTotal : absTotal + BigInt(1e19);
  } else {
    totalQuoteSum = BigInt(minimumAmount) * 10n ** 18n;
  }

  const transferCall: SwapCall = {
    contractAddress: paymentTokenAddress,
    entrypoint: "transfer",
    calldata: [routerAddress, num.toHex(totalQuoteSum), "0x0"],
  };

  const clearPaymentCall: SwapCall = {
    contractAddress: routerAddress,
    entrypoint: "clear",
    calldata: [paymentTokenAddress],
  };

  let minimumClear: string;
  if (total < 0n) {
    const desired = BigInt(minimumAmount) * 10n ** 18n;
    const withSlippage = applySlippage(desired, slippageBps);
    minimumClear = num.toHex(withSlippage);
  } else {
    const withSlippage = applySlippage(total, slippageBps);
    minimumClear = num.toHex(withSlippage);
  }

  const clearProfitsCall: SwapCall = {
    contractAddress: routerAddress,
    entrypoint: "clear_minimum",
    calldata: [tokenAddress, minimumClear, "0x0"],
  };

  const { splits } = quote;

  if (splits.length === 1) {
    const split = splits[0];
    const encodedRoute = split.route.reduce(
      (memo: { token: string; encoded: string[] }, routeNode: RouteNode) => {
        const isToken1 = BigInt(memo.token) === BigInt(routeNode.pool_key.token1);
        return {
          token: isToken1 ? routeNode.pool_key.token0 : routeNode.pool_key.token1,
          encoded: memo.encoded.concat([
            routeNode.pool_key.token0,
            routeNode.pool_key.token1,
            routeNode.pool_key.fee,
            num.toHex(routeNode.pool_key.tick_spacing),
            routeNode.pool_key.extension,
            num.toHex(BigInt(routeNode.sqrt_ratio_limit) % 2n ** 128n),
            num.toHex(BigInt(routeNode.sqrt_ratio_limit) >> 128n),
            routeNode.skip_ahead,
          ]),
        };
      },
      { token: tokenAddress, encoded: [] }
    ).encoded;

    const swapCall: SwapCall = {
      contractAddress: routerAddress,
      entrypoint: "multihop_swap",
      calldata: [
        num.toHex(split.route.length),
        ...encodedRoute,
        total < 0n ? tokenAddress : paymentTokenAddress,
        num.toHex(BigInt(split.amount_specified) < 0n ? -BigInt(split.amount_specified) : BigInt(split.amount_specified)),
        total < 0n ? "0x1" : "0x0",
      ],
    };

    return [transferCall, swapCall, clearProfitsCall, clearPaymentCall];
  }

  const multiSwapCall: SwapCall = {
    contractAddress: routerAddress,
    entrypoint: "multi_multihop_swap",
    calldata: [
      num.toHex(splits.length),
      ...splits.reduce((memo: string[], split: SwapSplit) => {
        const encodedRoute = split.route.reduce(
          (routeMemo: { token: string; encoded: string[] }, routeNode: RouteNode) => {
            const isToken1 = BigInt(routeMemo.token) === BigInt(routeNode.pool_key.token1);
            return {
              token: isToken1 ? routeNode.pool_key.token0 : routeNode.pool_key.token1,
              encoded: routeMemo.encoded.concat([
                routeNode.pool_key.token0,
                routeNode.pool_key.token1,
                routeNode.pool_key.fee,
                num.toHex(routeNode.pool_key.tick_spacing),
                routeNode.pool_key.extension,
                num.toHex(BigInt(routeNode.sqrt_ratio_limit) % 2n ** 128n),
                num.toHex(BigInt(routeNode.sqrt_ratio_limit) >> 128n),
                routeNode.skip_ahead,
              ]),
            };
          },
          { token: tokenAddress, encoded: [] }
        ).encoded;

        return memo.concat([
          num.toHex(split.route.length),
          ...encodedRoute,
          total < 0n ? tokenAddress : paymentTokenAddress,
          num.toHex(BigInt(split.amount_specified) < 0n ? -BigInt(split.amount_specified) : BigInt(split.amount_specified)),
          total < 0n ? "0x1" : "0x0",
        ]);
      }, []),
    ],
  };

  return [transferCall, multiSwapCall, clearProfitsCall, clearPaymentCall];
}
