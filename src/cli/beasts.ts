#!/usr/bin/env tsx
/**
 * List all our beasts with scoring info.
 * Usage: npx tsx src/cli/beasts.ts config/userprofile.json
 */

import { loadConfig } from "../config.js";
import { SummitApiClient } from "../api/client.js";
import { enrichBeast, scoreBeast, rankBeasts } from "../strategy/scoring.js";

async function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const config = loadConfig(configPath);
  const api = new SummitApiClient(config.api.baseUrl);

  const beasts = await api.getOwnerBeasts(config.account.controllerAddress);
  const enriched = beasts.map(enrichBeast);

  console.log(`=== ${config.account.username}'s Beasts (${beasts.length} total) ===\n`);

  const alive = enriched.filter((b) => b.isAlive);
  const dead = enriched.filter((b) => !b.isAlive);

  console.log(`Alive: ${alive.length} | Dead: ${dead.length}\n`);

  // If there's a summit holder, show scores against them
  const holder = await api.getSummitHolder();
  if (holder) {
    const defenderEnriched = enrichBeast(holder);
    console.log(`Scores vs Summit Holder: ${defenderEnriched.fullName} (${defenderEnriched.type} power=${defenderEnriched.basePower})\n`);

    const ranked = rankBeasts(enriched, defenderEnriched, {
      requireTypeAdvantage: false,
    });

    for (const b of ranked) {
      const advStr = b.typeAdvantage > 1 ? "STRONG" : b.typeAdvantage < 1 ? "WEAK" : "NEUTRAL";
      console.log(`  [${advStr}] ${b.fullName} — ${b.type} T${b.tier} L${b.level} power=${b.basePower} score=${b.score.toFixed(0)} (${b.reason})`);
    }
  } else {
    console.log("No summit holder — showing base stats:\n");
    const sorted = [...alive].sort((a, b) => b.basePower - a.basePower);
    for (const b of sorted) {
      console.log(`  ${b.fullName} — ${b.type} T${b.tier} L${b.level} power=${b.basePower} hp=${b.health}`);
    }
  }
}

main().catch((err) => {
  console.error("Beasts check failed:", err);
  process.exit(1);
});
