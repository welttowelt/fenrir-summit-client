#!/usr/bin/env tsx
/**
 * Quick status check: summit holder, our beasts, session health.
 * Usage: npx tsx src/cli/status.ts config/userprofile.json
 */

import { loadConfig } from "../config.js";
import { SummitApiClient } from "../api/client.js";
import { enrichBeast } from "../strategy/scoring.js";
import { loadCartridgeSession, sessionExpiresIn, isSessionExpired } from "../chain/controller-signer.js";

async function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const config = loadConfig(configPath);
  const api = new SummitApiClient(config.api.baseUrl);

  console.log("=== Summit Agent Status ===\n");

  // Session check
  const sessionDir = config.session.file.replace(/session\.json$/, config.session.dirName);
  try {
    const session = loadCartridgeSession(sessionDir);
    const expired = isSessionExpired(session);
    const expiresIn = sessionExpiresIn(session);
    console.log(`Session: ${expired ? "EXPIRED" : "VALID"} (expires in ${expiresIn})`);
    console.log(`  User: ${session.session.username}`);
    console.log(`  Address: ${session.session.address}`);
  } catch (err) {
    console.log(`Session: NOT FOUND - ${err}`);
  }

  console.log("");

  // Summit holder
  const holder = await api.getSummitHolder();
  if (holder) {
    const enriched = enrichBeast(holder);
    console.log(`Summit Holder: ${enriched.fullName}`);
    console.log(`  Type: ${enriched.type} | Tier: ${enriched.tier} | Level: ${holder.level}`);
    console.log(`  Power: ${enriched.basePower} | HP: ${holder.health} | Extra Lives: ${holder.extra_lives ?? 0}`);
    console.log(`  Owner: ${holder.owner}`);
  } else {
    console.log("Summit: EMPTY (no holder)");
  }

  console.log("");

  // Our beasts
  const beasts = await api.getOwnerBeasts(config.account.controllerAddress);
  const enriched = beasts.map(enrichBeast);
  const alive = enriched.filter((b) => b.isAlive);
  const dead = enriched.filter((b) => !b.isAlive);

  console.log(`Our Beasts: ${beasts.length} total (${alive.length} alive, ${dead.length} dead)`);
  const sorted = [...alive].sort((a, b) => b.basePower - a.basePower);
  for (const b of sorted.slice(0, 10)) {
    console.log(`  ${b.fullName} — ${b.type} T${b.tier} L${b.level} power=${b.basePower} hp=${b.health}`);
  }
  if (sorted.length > 10) {
    console.log(`  ... and ${sorted.length - 10} more alive beasts`);
  }
}

main().catch((err) => {
  console.error("Status check failed:", err);
  process.exit(1);
});
