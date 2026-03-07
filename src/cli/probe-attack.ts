#!/usr/bin/env tsx
import { loadConfig } from "../config.js";
import { ChainClient } from "../chain/client.js";
import { Logger } from "../utils/logger.js";

async function main() {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const beastId = Number(process.argv[3] || 50261);
  const revivalPotions = Number(process.argv[4] || 8);
  const attackCount = Number(process.argv[5] || 1);
  const attackPotions = Number(process.argv[6] || 0);

  const config = loadConfig(configPath);
  const logger = new Logger("probe-attack");
  const chain = new ChainClient(config, logger);

  await chain.init();
  const holder = await chain.getSummitHolderApiShape();
  if (!holder) {
    console.log("No summit holder");
    return;
  }

  console.log(`Holder token=${holder.token_id}`);
  console.log(`Probe with beast=${beastId} revivalPotions=${revivalPotions} attackCount=${attackCount} attackPotions=${attackPotions}`);

  const result = await chain.attack({
    defendingBeastTokenId: holder.token_id,
    attackingBeasts: [[beastId, attackCount, attackPotions]],
    revivalPotions,
    extraLifePotions: 0,
    useVrf: true,
  });

  console.log(`Probe tx success: ${result.txHash}`);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  try {
    console.error("Probe error toString:", String(err));
  } catch {}
  try {
    console.error("Probe error message:", (err as { message?: unknown }).message);
  } catch {}
  try {
    console.error("Probe error data:", (err as { data?: unknown }).data);
  } catch {}
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const dump: Record<string, string> = {};
    for (const k of Object.keys(obj)) {
      try {
        dump[k] = String(obj[k]);
      } catch {
        dump[k] = "<unserializable>";
      }
    }
    console.error("Probe error keys:", Object.keys(obj));
    console.error("Probe error dump:", dump);
  }
  process.exit(1);
});
