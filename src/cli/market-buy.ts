#!/usr/bin/env tsx

import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider, num } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";
import { generateSwapCalls, getSwapQuote, type SwapCall } from "../market/ekubo.js";

type MarketToken = "ATTACK" | "REVIVE" | "EXTRA LIFE" | "POISON" | "SKULL" | "CORPSE";
type PaymentToken = "SURVIVOR" | "STRK" | "USDC" | "ATTACK" | "REVIVE" | "EXTRA LIFE" | "POISON" | "SKULL" | "CORPSE";

interface CliOptions {
  configPath: string;
  payToken: PaymentToken;
  slippageBps: number;
  dryRun: boolean;
  routerAddress: string;
  quantities: Record<MarketToken, number>;
}

interface TokenMeta {
  symbol: string;
  address: string;
  decimals: number;
}

const DEFAULT_ROUTER = "0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066";
const MAINNET_STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const MAINNET_USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";

const DEFAULT_QUANTITIES: Record<MarketToken, number> = {
  "ATTACK": 1000,
  "REVIVE": 1000,
  "EXTRA LIFE": 100,
  "POISON": 1000,
  "SKULL": 10,
  "CORPSE": 0,
};

function usageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}`);
  }
  console.log(`Usage:
  npx tsx src/cli/market-buy.ts [config-path] [flags]

Flags:
  --pay <SURVIVOR|STRK|USDC|ATTACK|REVIVE|EXTRA\ LIFE|POISON|SKULL|CORPSE>
  --attack <n>
  --revive <n>
  --extra-life <n>
  --poison <n>
  --skull <n>
  --corpse <n>
  --slippage-bps <n>   (default: 100 = 1%)
  --router <address>
  --dry-run

Example:
  npx tsx src/cli/market-buy.ts config/yourprofile.json --attack 1000 --revive 1000 --poison 1000 --extra-life 100 --skull 10
`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNonNegativeInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    usageAndExit(`${flag} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    usageAndExit(`${flag} must be a safe non-negative integer`);
  }
  return value;
}

function parsePaymentToken(raw: string): PaymentToken {
  const normalized = raw.toUpperCase().replace(/_/g, " ") as PaymentToken;
  const allowed: PaymentToken[] = ["SURVIVOR", "STRK", "USDC", "ATTACK", "REVIVE", "EXTRA LIFE", "POISON", "SKULL", "CORPSE"];
  if (!allowed.includes(normalized)) {
    usageAndExit(`unsupported --pay token: ${raw}`);
  }
  return normalized;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let configPath = "config/yourprofile.json";

  if (args[0] && !args[0].startsWith("--")) {
    configPath = args.shift() as string;
  }

  const options: CliOptions = {
    configPath,
    payToken: "SURVIVOR",
    slippageBps: 100,
    dryRun: false,
    routerAddress: DEFAULT_ROUTER,
    quantities: { ...DEFAULT_QUANTITIES },
  };

  while (args.length > 0) {
    const flag = args.shift() as string;

    const requireValue = (): string => {
      const value = args.shift();
      if (!value) usageAndExit(`${flag} requires a value`);
      return value;
    };

    switch (flag) {
      case "--pay":
        options.payToken = parsePaymentToken(requireValue());
        break;
      case "--attack":
        options.quantities["ATTACK"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--revive":
        options.quantities["REVIVE"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--extra-life":
        options.quantities["EXTRA LIFE"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--poison":
        options.quantities["POISON"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--skull":
        options.quantities["SKULL"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--corpse":
        options.quantities["CORPSE"] = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--slippage-bps":
        options.slippageBps = parseNonNegativeInt(requireValue(), flag);
        break;
      case "--router":
        options.routerAddress = requireValue();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        usageAndExit(`unknown flag: ${flag}`);
    }
  }

  if (Object.values(options.quantities).every((q) => q === 0)) {
    usageAndExit("at least one quantity must be > 0");
  }

  return options;
}

function toAddress(value: unknown): string {
  if (typeof value === "string") return num.toHex(value);
  if (typeof value === "bigint") return num.toHex(value);
  if (typeof value === "number") return num.toHex(value);
  if (Array.isArray(value) && value.length > 0) return toAddress(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.address !== undefined) return toAddress(obj.address);
    if (obj.value !== undefined) return toAddress(obj.value);
    if (obj["0"] !== undefined) return toAddress(obj["0"]);
  }
  throw new Error(`Cannot parse address from value: ${String(value)}`);
}

function toUnits(amount: number, decimals: number): bigint {
  return BigInt(amount) * 10n ** BigInt(decimals);
}

function formatUnits(value: bigint, decimals: number, fractionDigits = 6): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  if (decimals === 0) return `${sign}${whole.toString()}`;

  const fracStr = frac.toString().padStart(decimals, "0").slice(0, fractionDigits).replace(/0+$/, "");
  return fracStr.length > 0 ? `${sign}${whole.toString()}.${fracStr}` : `${sign}${whole.toString()}`;
}

function parseU256FromCall(result: unknown): bigint {
  const maybeArray = Array.isArray(result)
    ? result
    : Array.isArray((result as { result?: unknown[] })?.result)
      ? (result as { result: unknown[] }).result
      : null;

  if (maybeArray && maybeArray.length >= 2) {
    const low = BigInt(String(maybeArray[0]));
    const high = BigInt(String(maybeArray[1]));
    return low + (high << 128n);
  }

  if (maybeArray && maybeArray.length === 1) {
    return BigInt(String(maybeArray[0]));
  }

  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (obj.low !== undefined && obj.high !== undefined) {
      return BigInt(String(obj.low)) + (BigInt(String(obj.high)) << 128n);
    }
  }

  throw new Error(`Unexpected balance call result shape: ${String(result)}`);
}

async function readBalance(provider: RpcProvider, tokenAddress: string, owner: string): Promise<bigint> {
  const entrypoints = ["balance_of", "balanceOf"];
  let lastError: unknown = null;

  for (const entrypoint of entrypoints) {
    try {
      const response = await provider.callContract({
        contractAddress: tokenAddress,
        entrypoint,
        calldata: [owner],
      });
      return parseU256FromCall(response);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Failed to read balance for ${tokenAddress}: ${String(lastError)}`);
}

function txHashFromExecuteResult(result: unknown): string {
  const txHash = (result as { transaction_hash?: string; transactionHash?: string }).transaction_hash
    ?? (result as { transaction_hash?: string; transactionHash?: string }).transactionHash;
  if (!txHash) {
    throw new Error(`No transaction hash in execute result: ${String(result)}`);
  }
  return txHash;
}

function ensureSucceeded(receipt: unknown): void {
  const executionStatus = (receipt as { execution_status?: string }).execution_status;
  if (executionStatus === "REVERTED") {
    const reason = (receipt as { revert_reason?: string }).revert_reason ?? "unknown";
    throw new Error(`Transaction reverted: ${reason}`);
  }
}

async function loadTokenAddresses(
  summit: Contract
): Promise<Record<MarketToken | "SURVIVOR", string>> {
  const callWithRetry = async (entrypoint: string): Promise<string> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await summit.call(entrypoint);
        return toAddress(result);
      } catch (err) {
        lastError = err;
        await sleep(400 * (attempt + 1));
      }
    }
    throw new Error(`Failed to call ${entrypoint}: ${String(lastError)}`);
  };

  const attack = await callWithRetry("get_attack_potion_address");
  const revive = await callWithRetry("get_revive_potion_address");
  const extraLife = await callWithRetry("get_extra_life_potion_address");
  const poison = await callWithRetry("get_poison_potion_address");
  const skull = await callWithRetry("get_skull_token_address");
  const corpse = await callWithRetry("get_corpse_token_address");
  const survivor = await callWithRetry("get_reward_address");

  return {
    "ATTACK": attack,
    "REVIVE": revive,
    "EXTRA LIFE": extraLife,
    "POISON": poison,
    "SKULL": skull,
    "CORPSE": corpse,
    "SURVIVOR": survivor,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configPath);

  const provider = new RpcProvider({
    nodeUrl: config.chain.rpcUrl,
    blockIdentifier: "latest",
  });

  const summitAbi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const summit = new Contract(summitAbi, config.chain.summitContract, provider);

  const tokenAddresses = await loadTokenAddresses(summit);

  const paymentAddressBySymbol: Record<PaymentToken, string> = {
    "SURVIVOR": tokenAddresses["SURVIVOR"],
    "STRK": MAINNET_STRK,
    "USDC": MAINNET_USDC,
    "ATTACK": tokenAddresses["ATTACK"],
    "REVIVE": tokenAddresses["REVIVE"],
    "EXTRA LIFE": tokenAddresses["EXTRA LIFE"],
    "POISON": tokenAddresses["POISON"],
    "SKULL": tokenAddresses["SKULL"],
    "CORPSE": tokenAddresses["CORPSE"],
  };

  const paymentDecimalsBySymbol: Record<PaymentToken, number> = {
    "SURVIVOR": 18,
    "STRK": 18,
    "USDC": 6,
    "ATTACK": 18,
    "REVIVE": 18,
    "EXTRA LIFE": 18,
    "POISON": 18,
    "SKULL": 18,
    "CORPSE": 18,
  };

  const paymentToken: TokenMeta = {
    symbol: options.payToken,
    address: paymentAddressBySymbol[options.payToken],
    decimals: paymentDecimalsBySymbol[options.payToken],
  };

  console.log("Marketplace buy request:");
  console.log(`  config: ${options.configPath}`);
  console.log(`  pay with: ${paymentToken.symbol} (${paymentToken.address})`);
  console.log(`  router: ${options.routerAddress}`);
  console.log(`  slippage bps: ${options.slippageBps}`);

  const requested = Object.entries(options.quantities)
    .filter(([, qty]) => qty > 0)
    .map(([symbol, qty]) => ({ symbol: symbol as MarketToken, qty }));

  for (const item of requested) {
    console.log(`  ${item.symbol}: ${item.qty}`);
  }

  let accountAddress = config.account.controllerAddress;
  let sessionAccount: { address: string; execute: (calls: Array<Record<string, unknown>>) => Promise<unknown> } | null = null;

  if (!options.dryRun) {
    const sessionDir = config.session.file.replace(/session\.json$/, "cartridge-session-market");
    const sessionProvider = new SessionProvider({
      rpc: config.chain.rpcUrl,
      chainId: CHAIN_ID_SN_MAIN,
      policies: {
        contracts: {
          [paymentToken.address]: {
            methods: [
              { name: "Transfer", entrypoint: "transfer" },
            ],
          },
          [options.routerAddress]: {
            methods: [
              { name: "Multihop Swap", entrypoint: "multihop_swap" },
              { name: "Multi Multihop Swap", entrypoint: "multi_multihop_swap" },
              { name: "Clear Minimum", entrypoint: "clear_minimum" },
              { name: "Clear", entrypoint: "clear" },
            ],
          },
        },
      },
      basePath: sessionDir,
    });

    const probed = await sessionProvider.probe();
    sessionAccount = probed as unknown as { address: string; execute: (calls: Array<Record<string, unknown>>) => Promise<unknown> } | null;
    if (!sessionAccount) {
      console.log("No valid market session found; opening browser for approval...");
      sessionAccount = (await sessionProvider.connect()) as unknown as { address: string; execute: (calls: Array<Record<string, unknown>>) => Promise<unknown> };
    }

    accountAddress = sessionAccount.address;
    console.log(`  session account: ${accountAddress}`);
  } else {
    console.log(`  dry-run account (from config): ${accountAddress}`);
  }

  const paymentBefore = await readBalance(provider, paymentToken.address, accountAddress);
  console.log(`  ${paymentToken.symbol} balance before: ${formatUnits(paymentBefore, paymentToken.decimals)} ${paymentToken.symbol}`);

  const tokenBalancesBefore: Record<MarketToken, bigint> = {
    "ATTACK": await readBalance(provider, tokenAddresses["ATTACK"], accountAddress),
    "REVIVE": await readBalance(provider, tokenAddresses["REVIVE"], accountAddress),
    "EXTRA LIFE": await readBalance(provider, tokenAddresses["EXTRA LIFE"], accountAddress),
    "POISON": await readBalance(provider, tokenAddresses["POISON"], accountAddress),
    "SKULL": await readBalance(provider, tokenAddresses["SKULL"], accountAddress),
    "CORPSE": await readBalance(provider, tokenAddresses["CORPSE"], accountAddress),
  };

  for (const item of requested) {
    console.log(`  ${item.symbol} before: ${formatUnits(tokenBalancesBefore[item.symbol], 18)} ${item.symbol}`);
  }

  let cumulativeEstimatedSpend = 0n;

  for (const item of requested) {
    const tokenAddress = tokenAddresses[item.symbol];
    const quote = await getSwapQuote(
      -toUnits(item.qty, 18),
      tokenAddress,
      paymentToken.address
    );

    if (!quote.splits || quote.splits.length === 0) {
      throw new Error(`No liquidity route for ${item.symbol}`);
    }

    const estimatedSpend = BigInt(quote.total) < 0n ? -BigInt(quote.total) : BigInt(quote.total);
    cumulativeEstimatedSpend += estimatedSpend;

    const calls = generateSwapCalls(
      options.routerAddress,
      paymentToken.address,
      {
        tokenAddress,
        minimumAmount: item.qty,
        quote,
      },
      options.slippageBps
    );

    if (calls.length === 0) {
      throw new Error(`Failed to generate swap calls for ${item.symbol}`);
    }

    const transferCall = calls[0];
    const transferAmount = BigInt(transferCall.calldata[1]);

    console.log(`  quote ${item.symbol}: est spend ${formatUnits(estimatedSpend, paymentToken.decimals)} ${paymentToken.symbol}, transfer cap ${formatUnits(transferAmount, paymentToken.decimals)} ${paymentToken.symbol}`);

    if (options.dryRun) continue;

    const currentPaymentBalance = await readBalance(provider, paymentToken.address, accountAddress);
    if (currentPaymentBalance < transferAmount) {
      throw new Error(
        `Insufficient ${paymentToken.symbol} for ${item.symbol}: have ${formatUnits(currentPaymentBalance, paymentToken.decimals)}, need transfer cap ${formatUnits(transferAmount, paymentToken.decimals)}`
      );
    }

    console.log(`  executing ${item.symbol} buy...`);
    if (!sessionAccount) {
      throw new Error("No session account loaded for execution");
    }
    const executeResult = await sessionAccount.execute(calls as unknown as Array<Record<string, unknown>>);
    const txHash = txHashFromExecuteResult(executeResult);
    console.log(`  tx submitted (${item.symbol}): ${txHash}`);

    const receipt = await provider.waitForTransaction(txHash, {
      retryInterval: config.chain.txWaitIntervalMs,
    });
    ensureSucceeded(receipt);
    console.log(`  tx confirmed (${item.symbol}): https://voyager.online/tx/${txHash}`);
  }

  if (options.dryRun) {
    console.log(`Dry run only. Estimated total spend: ${formatUnits(cumulativeEstimatedSpend, paymentToken.decimals)} ${paymentToken.symbol}`);
    return;
  }

  const paymentAfter = await readBalance(provider, paymentToken.address, accountAddress);
  const tokenBalancesAfter: Record<MarketToken, bigint> = {
    "ATTACK": await readBalance(provider, tokenAddresses["ATTACK"], accountAddress),
    "REVIVE": await readBalance(provider, tokenAddresses["REVIVE"], accountAddress),
    "EXTRA LIFE": await readBalance(provider, tokenAddresses["EXTRA LIFE"], accountAddress),
    "POISON": await readBalance(provider, tokenAddresses["POISON"], accountAddress),
    "SKULL": await readBalance(provider, tokenAddresses["SKULL"], accountAddress),
    "CORPSE": await readBalance(provider, tokenAddresses["CORPSE"], accountAddress),
  };

  console.log("Final balances:");
  console.log(`  ${paymentToken.symbol}: ${formatUnits(paymentAfter, paymentToken.decimals)} (delta ${formatUnits(paymentAfter - paymentBefore, paymentToken.decimals)})`);

  for (const item of requested) {
    const before = tokenBalancesBefore[item.symbol];
    const after = tokenBalancesAfter[item.symbol];
    console.log(`  ${item.symbol}: ${formatUnits(after, 18)} (delta ${formatUnits(after - before, 18)})`);
  }
}

main().catch((err) => {
  console.error("market-buy failed:", err);
  process.exit(1);
});
