#!/usr/bin/env tsx
import { Contract, RpcProvider } from "starknet";
import SessionProvider from "@cartridge/controller/session/node";
import { loadConfig } from "../config.js";
import { loadSummitAbi, extractFunctionNamesFromAbi } from "../chain/abi.js";

const CHAIN_ID_MAINNET = "0x534e5f4d41494e";
const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

type SessionCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

type SessionAccount = {
  address: string;
  execute: (calls: SessionCall[]) => Promise<{ transaction_hash?: string; transactionHash?: string }>;
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

async function main(): Promise<void> {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const beastId = parsePositiveInt(process.argv[3], 39346, "beastId");
  const revivalPotions = parseNonNegativeInt(process.argv[4], 8, "revivalPotions");
  const attackCount = parsePositiveInt(process.argv[5], 1, "attackCount");
  const attackPotions = parseNonNegativeInt(process.argv[6], 0, "attackPotions");

  const config = loadConfig(configPath);
  const provider = new RpcProvider({
    nodeUrl: config.chain.rpcUrl,
    blockIdentifier: "latest",
  });

  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const functionNames = extractFunctionNamesFromAbi(abi);
  const attackCandidates = ["attack", "attack_summit"].filter((name) => functionNames.has(name));
  if (attackCandidates.length === 0) {
    throw new Error("No attack entrypoint found in Summit ABI (expected attack or attack_summit)");
  }
  const attackEntrypoint = attackCandidates[0]!;
  const hasRequestRandom = functionNames.has("request_random");

  const summitMethods: Array<{ name: string; entrypoint: string }> = [
    ...attackCandidates.map((name) => ({ name, entrypoint: name })),
  ];
  if (hasRequestRandom) {
    summitMethods.push({ name: "request_random", entrypoint: "request_random" });
  }

  const sessionDir = config.session.file.replace(/session\.json$/, "cartridge-session-lean");
  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_MAINNET,
    policies: {
      contracts: {
        [config.chain.summitContract]: {
          methods: summitMethods,
        },
        [VRF_PROVIDER_ADDRESS]: {
          methods: [{ name: "request_random", entrypoint: "request_random" }],
        },
      },
    },
    basePath: sessionDir,
  });

  let sessionAccount = (await sessionProvider.probe()) as SessionAccount | null;
  if (!sessionAccount) {
    console.log("No valid lean session found; opening browser for approval...");
    sessionAccount = (await sessionProvider.connect()) as SessionAccount;
  }
  if (!sessionAccount) {
    throw new Error("Failed to establish lean session");
  }

  const contract = new Contract(abi, config.chain.summitContract, provider);
  const holder = await contract.call("get_summit_beast");
  const holderTokenId = Number((holder as any)?.live?.token_id ?? (holder as any)?.token_id ?? 0);
  if (!Number.isFinite(holderTokenId) || holderTokenId <= 0) {
    throw new Error("Unable to resolve summit holder token id");
  }

  console.log(`Lean probe session: ${sessionAccount.address}`);
  console.log(`Attack entrypoint: ${attackEntrypoint}`);
  console.log(`Summit holder token: ${holderTokenId}`);
  console.log(
    `Probe params: beast=${beastId} revivalPotions=${revivalPotions} attackCount=${attackCount} attackPotions=${attackPotions}`
  );

  const attackingBeasts: Array<[number, number, number]> = [[beastId, attackCount, attackPotions]];
  const attackArgs = attackEntrypoint === "attack"
    ? {
        defending_beast_token_id: holderTokenId,
        attacking_beasts: attackingBeasts,
        revival_potions: revivalPotions,
        extra_life_potions: 0,
        vrf: true,
      }
    : {
        beast_token_id: holderTokenId,
        attacking_beasts: attackingBeasts.map(([tokenId, atkPots, revPots]) => ({
          token_id: tokenId,
          attack_potions: atkPots,
          revival_potions: revPots,
        })),
        revival_potions: revivalPotions,
        extra_life_potions: 0,
      };

  const calls: SessionCall[] = [];
  if (hasRequestRandom) {
    const requestRandomCall = contract.populate("request_random", []);
    calls.push({
      contractAddress: config.chain.summitContract,
      entrypoint: "request_random",
      calldata: (requestRandomCall.calldata ?? []) as string[],
    });
  } else {
    calls.push({
      contractAddress: VRF_PROVIDER_ADDRESS,
      entrypoint: "request_random",
      // request_random(caller=Summit, source=Nonce(account))
      calldata: [config.chain.summitContract, "0", sessionAccount.address],
    });
  }

  const attackCall = contract.populate(attackEntrypoint, attackArgs as any);
  calls.push({
    contractAddress: config.chain.summitContract,
    entrypoint: attackEntrypoint,
    calldata: (attackCall.calldata ?? []) as string[],
  });

  console.log(`Executing ${calls.length} calls (VRF + ${attackEntrypoint})...`);
  const executeResult = await sessionAccount.execute(calls);
  const txHash = executeResult.transaction_hash ?? executeResult.transactionHash;
  if (!txHash) {
    throw new Error("No transaction hash returned by session account execute");
  }

  console.log(`Submitted tx: ${txHash}`);
  const receipt = await provider.waitForTransaction(txHash, {
    retryInterval: config.chain.txWaitIntervalMs,
  });
  const execStatus = (receipt as any).execution_status;
  if (execStatus === "REVERTED") {
    const reason = (receipt as any).revert_reason || "unknown";
    throw new Error(`Transaction REVERTED: ${reason}`);
  }
  console.log(`Lean probe success: ${txHash}`);
}

main().catch((err) => {
  console.error("Lean probe failed:", err);
  try {
    console.error("Lean probe error toString:", String(err));
  } catch {}
  try {
    console.error("Lean probe error message:", (err as { message?: unknown }).message);
  } catch {}
  try {
    console.error("Lean probe error data:", (err as { data?: unknown }).data);
  } catch {}
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const dump: Record<string, string> = {};
    for (const key of Object.keys(obj)) {
      try {
        dump[key] = String(obj[key]);
      } catch {
        dump[key] = "<unserializable>";
      }
    }
    console.error("Lean probe error keys:", Object.keys(obj));
    console.error("Lean probe error dump:", dump);
  }
  process.exit(1);
});
