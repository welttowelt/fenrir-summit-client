#!/usr/bin/env tsx
import { loadConfig } from "../config.js";
import { SummitApiClient } from "../api/client.js";
import { enrichBeast } from "../strategy/scoring.js";
import { getSpecialsVariantName } from "../data/beasts.js";

type VariantStats = {
  count: number;
  maxHeldSeconds: number;
  maxBonusXp: number;
  ownerSet: Set<string>;
  exampleNames: Set<string>;
};

function parseIntArg(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer: ${raw}`);
  }
  return n;
}

async function main(): Promise<void> {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const leaderboardLimit = parseIntArg(process.argv[3], 250);
  const topToShow = parseIntArg(process.argv[4], 15);

  const config = loadConfig(configPath);
  const api = new SummitApiClient(config.api.baseUrl);

  const [ourRaw, topRaw] = await Promise.all([
    api.getOwnerBeasts(config.account.controllerAddress),
    api.getTopBeasts(leaderboardLimit),
  ]);

  const our = ourRaw.map(enrichBeast);
  const leaderboardByVariant = new Map<string, VariantStats>();
  for (const b of topRaw) {
    const variantName = `${String(b.prefix ?? "").trim()} ${String(b.suffix ?? "").trim()}`.trim();
    if (!variantName) continue;
    const key = variantName.toLowerCase();
    const existing = leaderboardByVariant.get(key) ?? {
      count: 0,
      maxHeldSeconds: 0,
      maxBonusXp: 0,
      ownerSet: new Set<string>(),
      exampleNames: new Set<string>(),
    };
    existing.count += 1;
    existing.maxHeldSeconds = Math.max(existing.maxHeldSeconds, Number(b.summit_held_seconds ?? 0));
    existing.maxBonusXp = Math.max(existing.maxBonusXp, Number(b.bonus_xp ?? 0));
    if (b.owner) existing.ownerSet.add(b.owner.toLowerCase());
    if (existing.exampleNames.size < 3) existing.exampleNames.add(String(b.full_name ?? `token#${b.token_id}`));
    leaderboardByVariant.set(key, existing);
  }

  const ourByVariant = new Map<string, typeof our>();
  for (const b of our) {
    const key = getSpecialsVariantName(b.prefix, b.suffix).toLowerCase();
    const list = ourByVariant.get(key) ?? [];
    list.push(b);
    ourByVariant.set(key, list);
  }

  const opportunities: Array<{
    variantKey: string;
    variantName: string;
    score: number;
    leaderboardCount: number;
    uniqueOwners: number;
    maxHeldSeconds: number;
    maxBonusXp: number;
    examples: string[];
    beasts: typeof our;
  }> = [];

  for (const [variantKey, beasts] of ourByVariant) {
    const board = leaderboardByVariant.get(variantKey);
    if (!board) continue;
    const score = board.count * (board.maxHeldSeconds + board.maxBonusXp);
    const labelFromOwned = beasts[0]
      ? getSpecialsVariantName(beasts[0].prefix, beasts[0].suffix)
      : variantKey;
    opportunities.push({
      variantKey,
      variantName: labelFromOwned,
      score,
      leaderboardCount: board.count,
      uniqueOwners: board.ownerSet.size,
      maxHeldSeconds: board.maxHeldSeconds,
      maxBonusXp: board.maxBonusXp,
      examples: [...board.exampleNames],
      beasts,
    });
  }

  opportunities.sort((a, b) => b.score - a.score);

  console.log(`Diplomacy Scout for ${config.account.username}`);
  console.log(`Leaderboard sample size: ${leaderboardLimit}`);
  console.log(`Your beasts: ${our.length}`);
  console.log("");

  if (opportunities.length === 0) {
    console.log("No diplomacy variant matches found between your beasts and current top leaderboard sample.");
    return;
  }

  const shown = opportunities.slice(0, topToShow);
  for (const [idx, item] of shown.entries()) {
    console.log(
      `${idx + 1}. ${item.variantName} | boardCount=${item.leaderboardCount} uniqueOwners=${item.uniqueOwners} maxHeld=${item.maxHeldSeconds}s maxBonusXp=${item.maxBonusXp}`
    );
    if (item.examples.length > 0) {
      console.log(`   top examples: ${item.examples.join(" | ")}`);
    }
    const beasts = [...item.beasts].sort((a, b) => b.basePower - a.basePower);
    for (const b of beasts) {
      const alive = b.isAlive ? "alive" : "dead";
      console.log(
        `   - token=${b.token_id} ${b.fullName} ${b.type} L${b.level} power=${b.basePower} hp=${b.health} ${alive}`
      );
      console.log(
        `     diplomacy-upgrade: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/cli/upgrade-beast.ts ${configPath} ${b.token_id} 0 0 0 0 1`
      );
    }
  }
}

main().catch((err) => {
  console.error("diplomacy-scout failed:", err);
  process.exit(1);
});
