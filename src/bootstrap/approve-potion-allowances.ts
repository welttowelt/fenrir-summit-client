#!/usr/bin/env tsx
/**
 * Approve Summit contract to spend potion ERC20s from the controller account.
 *
 * Usage:
 *   NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/approve-potion-allowances.ts config/yourprofile.json
 */

import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider, num } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";

const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";
const MAX_U128 = (2n ** 128n - 1n).toString();
const MAX_U128_HEX = num.toHex(2n ** 128n - 1n);

type AllowanceSymbol =
  | "ATTACK"
  | "REVIVE"
  | "EXTRA LIFE"
  | "POISON"
  | "SKULL"
  | "CORPSE";

type SessionAccountLike = {
  address: string;
  execute: (calls: Array<Record<string, unknown>>) => Promise<{ transaction_hash?: string; transactionHash?: string }>;
};

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
    if (obj.value !== undefined) {
      return BigInt(String(obj.value));
    }
  }

  throw new Error(`Unexpected uint256 call result shape: ${String(result)}`);
}

async function readAllowance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string
): Promise<bigint | null> {
  const entrypoints = ["allowance", "allowance_of", "allowanceOf"];
  for (const entrypoint of entrypoints) {
    try {
      const result = await provider.callContract({
        contractAddress: tokenAddress,
        entrypoint,
        calldata: [owner, spender],
      });
      return parseU256FromCall(result);
    } catch {
      // Try next entrypoint variant.
    }
  }
  return null;
}

async function loadPotionTokenAddresses(
  summit: Contract
): Promise<Record<AllowanceSymbol, string>> {
  const callAddress = async (entrypoint: string): Promise<string> => {
    const result = await summit.call(entrypoint);
    return toAddress(result);
  };

  return {
    "ATTACK": await callAddress("get_attack_potion_address"),
    "REVIVE": await callAddress("get_revive_potion_address"),
    "EXTRA LIFE": await callAddress("get_extra_life_potion_address"),
    "POISON": await callAddress("get_poison_potion_address"),
    "SKULL": await callAddress("get_skull_token_address"),
    "CORPSE": await callAddress("get_corpse_token_address"),
  };
}

async function main() {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const config = loadConfig(configPath);

  const provider = new RpcProvider({
    nodeUrl: config.chain.rpcUrl,
    blockIdentifier: "latest",
  });

  const summitAbi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const summit = new Contract(summitAbi, config.chain.summitContract, provider);
  const potionAddresses = await loadPotionTokenAddresses(summit);

  const sessionDir = config.session.file.replace(/session\.json$/, "cartridge-session-allowance");
  const policies = {
    contracts: Object.fromEntries(
      Object.values(potionAddresses).map((tokenAddress) => [
        tokenAddress,
        {
          methods: [
            {
              name: "approve",
              entrypoint: "approve",
              spender: config.chain.summitContract,
              amount: MAX_U128_HEX,
            },
          ],
        },
      ])
    ),
  };

  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_SN_MAIN,
    policies,
    basePath: sessionDir,
  });

  let sessionAccount = (await sessionProvider.probe()) as unknown as SessionAccountLike | null;
  if (!sessionAccount) {
    console.log("No allowance session found; opening browser for approval...");
    sessionAccount = (await sessionProvider.connect()) as unknown as SessionAccountLike | null;
  }
  if (!sessionAccount) {
    throw new Error("Could not establish allowance session");
  }

  console.log(`Using controller account: ${sessionAccount.address}`);
  console.log(`Summit spender: ${config.chain.summitContract}`);

  for (const [symbol, tokenAddress] of Object.entries(potionAddresses) as Array<[AllowanceSymbol, string]>) {
    const before = await readAllowance(
      provider,
      tokenAddress,
      sessionAccount.address,
      config.chain.summitContract
    );
    console.log(
      `${symbol} token ${tokenAddress} allowance before: ${before === null ? "n/a" : before.toString()}`
    );

    const result = await sessionAccount.execute([
      {
        contractAddress: tokenAddress,
        entrypoint: "approve",
        calldata: [config.chain.summitContract, MAX_U128, MAX_U128],
      },
    ]);
    const txHash = result.transaction_hash ?? result.transactionHash;
    if (!txHash) {
      throw new Error(`No tx hash returned for ${symbol} allowance approval`);
    }
    console.log(`${symbol} approve tx submitted: ${txHash}`);
    const receipt = await provider.waitForTransaction(txHash, {
      retryInterval: config.chain.txWaitIntervalMs,
    });
    if ((receipt as { execution_status?: string }).execution_status === "REVERTED") {
      throw new Error(
        `${symbol} approve reverted: ${String((receipt as { revert_reason?: string }).revert_reason ?? "unknown")}`
      );
    }

    const after = await readAllowance(
      provider,
      tokenAddress,
      sessionAccount.address,
      config.chain.summitContract
    );
    console.log(
      `${symbol} token ${tokenAddress} allowance after: ${after === null ? "n/a" : after.toString()}`
    );
  }

  console.log("Potion allowance approvals complete.");
}

main().catch((err) => {
  console.error("Failed to approve potion allowances:", err);
  process.exit(1);
});
