import { getTypeAdvantage, getBeastMeta, getBeastFullName, type BeastType } from "../data/beasts.js";
import type { ApiBeast } from "../api/types.js";
import type { EnrichedBeast, ScoredBeast } from "./types.js";

const DEATH_COOLDOWN_MS = 86_400_000;

export function enrichBeast(raw: ApiBeast): EnrichedBeast {
  const meta = getBeastMeta(raw.beast_id);
  const type = meta?.type ?? "Magic";
  const tier = meta?.tier ?? 5;
  const name = meta?.name ?? "Unknown";
  const fullName = getBeastFullName(raw.beast_id, raw.prefix, raw.suffix);
  const basePower = raw.level * (6 - tier);

  const spirit = raw.spirit ?? 0;
  const spiritReduction = spirit > 0 ? (spirit / 100) * (DEATH_COOLDOWN_MS - 4 * 3600_000) : 0;
  const cooldownMs = DEATH_COOLDOWN_MS - spiritReduction;

  const isAlive = raw.health > 0;
  const cooldownEndsAt = isAlive ? 0 : Date.now() + cooldownMs;

  return { ...raw, type, tier, name, fullName, basePower, isAlive, cooldownEndsAt };
}

export function scoreBeast(attacker: EnrichedBeast, defender: EnrichedBeast): ScoredBeast {
  const typeAdv = getTypeAdvantage(attacker.type, defender.type);
  const luck = attacker.luck ?? 0;
  const critFactor = 1 + (luck / 100);
  const score = attacker.basePower * typeAdv * critFactor;

  let reason = `power=${attacker.basePower}`;
  if (typeAdv > 1) reason += ` +type_advantage(${attacker.type}>${defender.type})`;
  if (typeAdv < 1) reason += ` -type_disadvantage(${attacker.type}<${defender.type})`;
  if (luck > 0) reason += ` +crit(luck=${luck})`;

  return { ...attacker, score, typeAdvantage: typeAdv, reason };
}

export function rankBeasts(
  ourBeasts: EnrichedBeast[],
  defender: EnrichedBeast,
  opts: { requireTypeAdvantage: boolean; includeDead?: boolean }
): ScoredBeast[] {
  const candidates = opts.includeDead ? ourBeasts : ourBeasts.filter((b) => b.isAlive);
  const scored = candidates.map((b) => scoreBeast(b, defender));
  const filtered = opts.requireTypeAdvantage ? scored.filter((b) => b.typeAdvantage >= 1.5) : scored;
  return filtered.sort((a, b) => b.score - a.score);
}
