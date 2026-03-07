#!/usr/bin/env tsx
import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";

const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";

type StatsInput = {
  spirit: number;
  luck: number;
  specials: number;
  wisdom: number;
  diplomacy: number;
};

function parseIntArg(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid integer: ${raw}`);
  }
  return n;
}

async function main() {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const beastTokenId = parseIntArg(process.argv[3], 39346);
  const spirit = parseIntArg(process.argv[4], 5);
  const luck = parseIntArg(process.argv[5], 5);
  const specials = parseIntArg(process.argv[6], 0);
  const wisdom = parseIntArg(process.argv[7], 0);
  const diplomacy = parseIntArg(process.argv[8], 0);

  const stats: StatsInput = { spirit, luck, specials, wisdom, diplomacy };

  const config = loadConfig(configPath);
  const provider = new RpcProvider({ nodeUrl: config.chain.rpcUrl, blockIdentifier: "latest" });
  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const summit = new Contract(abi, config.chain.summitContract, provider);

  const sessionDir = config.session.file.replace(/session\.json$/, "cartridge-session-upgrade");
  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_SN_MAIN,
    policies: {
      contracts: {
        [config.chain.summitContract]: {
          methods: [
            { name: "apply_stat_points", entrypoint: "apply_stat_points" },
          ],
        },
      },
    },
    basePath: sessionDir,
  });

  let sessionAccount = await sessionProvider.probe();
  if (!sessionAccount) {
    console.log("Approve upgrade session in browser...");
    sessionAccount = await sessionProvider.connect();
  }

  const call = summit.populate("apply_stat_points", {
    beast_token_id: beastTokenId,
    stats,
  });

  const calldata = (call.calldata ?? []) as string[];
  if (calldata.length === 0) {
    throw new Error("Failed to encode apply_stat_points calldata");
  }

  console.log(`Upgrading beast ${beastTokenId} with stats:`, stats);

  const tx = await (sessionAccount as any).execute([
    {
      contractAddress: config.chain.summitContract,
      entrypoint: "apply_stat_points",
      calldata,
    },
  ]);

  const txHash = (tx as any).transaction_hash;
  console.log(`Tx submitted: ${txHash}`);

  const receipt = await provider.waitForTransaction(txHash, {
    retryInterval: config.chain.txWaitIntervalMs,
  });

  if ((receipt as any).execution_status === "REVERTED") {
    throw new Error(`Reverted: ${(receipt as any).revert_reason ?? "unknown"}`);
  }

  console.log(`Success: https://voyager.online/tx/${txHash}`);
}

main().catch((err) => {
  console.error("upgrade-beast failed:", err);
  process.exit(1);
});
