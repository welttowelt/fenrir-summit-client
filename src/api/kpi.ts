/**
 * KPI Tracker — aggregates per-player stats from Torii SQL, Summit API,
 * and Cartridge GraphQL into a unified leaderboard.
 *
 * Data sources:
 *   - Torii SQL  (BattleEvent, RewardEvent, PoisonEvent aggregations)
 *   - Summit API (/beasts/stats/top for hold time, /beasts/all for beast counts)
 *   - Cartridge GraphQL (username resolution from controller addresses)
 */

import { retry } from "../utils/time.js";
import type { ApiTopBeast, ApiBeast } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────

const TORII_SQL_URL = "https://api.cartridge.gg/x/pg-mainnet-10/torii/sql";
const CARTRIDGE_GQL_URL = "https://api.cartridge.gg/query";
const TORII_TABLE_PREFIX = "summit_relayer_6";

// ── Types ───────────────────────────────────────────────────────────

export interface PlayerKpi {
  address: string;
  username: string;
  beastCount: number;
  holdSeconds: number;
  holdPerBeast: number;
  totalXp: number;
  rewardsEarned: number;
  rewardsPerBeast: number;
  battles: number;
  attackPotionsUsed: number;
  damageDealt: number;
  damageTaken: number;
  damageRatio: number;
  criticalHits: number;
  criticalDamage: number;
  critPercent: number;
  counterDamageReceived: number;
  poisonApplied: number;
  rewardEvents: number;
}

export interface KpiSnapshot {
  timestamp: number;
  players: PlayerKpi[];
}

interface ToriiBattleRow {
  owner: string;
  battles: string;
  attack_potions: string;
  attack_damage: string;
  critical_attack_count: string;
  critical_attack_damage: string;
  counter_attack_damage: string;
  xp_gained: string;
}

interface ToriiRewardRow {
  owner: string;
  total_amount: string;
  reward_count: string;
}

interface ToriiPoisonRow {
  player: string;
  total_poison: string;
}

// ── Torii SQL helper ────────────────────────────────────────────────

async function toriiQuery<T>(sql: string): Promise<T[]> {
  const url = `${TORII_SQL_URL}?query=${encodeURIComponent(sql)}`;
  const res = await retry(() => fetch(url));
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Torii SQL ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json() as Promise<T[]>;
}

// ── Cartridge username resolution ───────────────────────────────────

function stripAddress(addr: string): string {
  // Remove 0x prefix, strip leading zeros, add 0x back
  const hex = addr.replace(/^0x/i, "").replace(/^0+/, "");
  return "0x" + (hex || "0");
}

async function resolveUsernames(
  addresses: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // Batch in groups of 10 to avoid overlong queries
  const batchSize = 10;
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const promises = batch.map(async (addr) => {
      const stripped = stripAddress(addr);
      const query = `{
        accounts(where: { hasControllersWith: [{ address: "${stripped}" }] }) {
          edges { node { username } }
        }
      }`;
      try {
        const res = await retry(() =>
          fetch(CARTRIDGE_GQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          })
        );
        const json = (await res.json()) as {
          data?: {
            accounts?: {
              edges?: Array<{ node: { username: string } }>;
            };
          };
        };
        const username =
          json.data?.accounts?.edges?.[0]?.node?.username ?? null;
        if (username) {
          result.set(addr, username);
        }
      } catch {
        // skip — address stays unresolved
      }
    });
    await Promise.all(promises);
  }
  return result;
}

// ── Data fetchers ───────────────────────────────────────────────────

async function fetchBattleStats(): Promise<Map<string, ToriiBattleRow>> {
  const sql = `
    SELECT
      attacking_beast_owner AS owner,
      COUNT(*) AS battles,
      COALESCE(SUM(CAST(attack_potions AS BIGINT)), 0) AS attack_potions,
      COALESCE(SUM(CAST(attack_damage AS BIGINT)), 0) AS attack_damage,
      COALESCE(SUM(CAST(critical_attack_count AS BIGINT)), 0) AS critical_attack_count,
      COALESCE(SUM(CAST(critical_attack_damage AS BIGINT)), 0) AS critical_attack_damage,
      COALESCE(SUM(CAST(counter_attack_damage AS BIGINT)), 0) AS counter_attack_damage,
      COALESCE(SUM(CAST(xp_gained AS BIGINT)), 0) AS xp_gained
    FROM "${TORII_TABLE_PREFIX}-BattleEvent"
    GROUP BY attacking_beast_owner
  `;
  const rows = await toriiQuery<ToriiBattleRow>(sql);
  const map = new Map<string, ToriiBattleRow>();
  for (const row of rows) {
    map.set(row.owner.toLowerCase(), row);
  }
  return map;
}

async function fetchRewardStats(): Promise<Map<string, ToriiRewardRow>> {
  const sql = `
    SELECT
      owner,
      COALESCE(SUM(CAST(amount AS BIGINT)), 0) AS total_amount,
      COUNT(*) AS reward_count
    FROM "${TORII_TABLE_PREFIX}-RewardEvent"
    GROUP BY owner
  `;
  const rows = await toriiQuery<ToriiRewardRow>(sql);
  const map = new Map<string, ToriiRewardRow>();
  for (const row of rows) {
    map.set(row.owner.toLowerCase(), row);
  }
  return map;
}

async function fetchPoisonStats(): Promise<Map<string, ToriiPoisonRow>> {
  const sql = `
    SELECT
      player,
      COALESCE(SUM(CAST(count AS BIGINT)), 0) AS total_poison
    FROM "${TORII_TABLE_PREFIX}-PoisonEvent"
    GROUP BY player
  `;
  const rows = await toriiQuery<ToriiPoisonRow>(sql);
  const map = new Map<string, ToriiPoisonRow>();
  for (const row of rows) {
    map.set(row.player.toLowerCase(), row);
  }
  return map;
}

async function fetchLeaderboard(
  summitBaseUrl: string,
  limit = 25
): Promise<ApiTopBeast[]> {
  const res = await retry(() =>
    fetch(
      `${summitBaseUrl.replace(/\/$/, "")}/beasts/stats/top?limit=${limit}`
    )
  );
  const json = (await res.json()) as { data: ApiTopBeast[] };
  return json.data;
}

async function fetchBeastCount(
  summitBaseUrl: string,
  ownerAddress: string
): Promise<number> {
  const addr = normalizeAddress(ownerAddress);
  const res = await retry(() =>
    fetch(
      `${summitBaseUrl.replace(/\/$/, "")}/beasts/all?owner=${addr}&limit=1&offset=0`
    )
  );
  const json = (await res.json()) as {
    pagination: { total: number };
  };
  return json.pagination.total;
}

function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, "").toLowerCase();
  return "0x" + hex.padStart(64, "0");
}

// ── Main KPI computation ───────────────────────────────────────────

export async function computeKpis(
  summitBaseUrl: string,
  topN = 25
): Promise<KpiSnapshot> {
  // Fetch all data sources in parallel
  const [leaderboard, battleMap, rewardMap, poisonMap] = await Promise.all([
    fetchLeaderboard(summitBaseUrl, topN),
    fetchBattleStats(),
    fetchRewardStats(),
    fetchPoisonStats(),
  ]);

  // Collect unique owner addresses from leaderboard
  const ownerAddresses = [...new Set(leaderboard.map((b) => b.owner))];

  // Resolve usernames and fetch beast counts in parallel
  const [usernameMap, beastCounts] = await Promise.all([
    resolveUsernames(ownerAddresses),
    Promise.all(
      ownerAddresses.map(async (addr) => ({
        addr,
        count: await fetchBeastCount(summitBaseUrl, addr),
      }))
    ),
  ]);

  const beastCountMap = new Map<string, number>();
  for (const { addr, count } of beastCounts) {
    beastCountMap.set(addr.toLowerCase(), count);
  }

  // Aggregate per-owner hold time and XP from leaderboard (one owner may have multiple beasts)
  const ownerHold = new Map<string, number>();
  const ownerXp = new Map<string, number>();
  for (const beast of leaderboard) {
    const key = beast.owner.toLowerCase();
    ownerHold.set(key, (ownerHold.get(key) ?? 0) + beast.summit_held_seconds);
    ownerXp.set(key, (ownerXp.get(key) ?? 0) + beast.bonus_xp);
  }

  // Build per-player KPIs
  const players: PlayerKpi[] = [];

  for (const addr of ownerAddresses) {
    const key = addr.toLowerCase();
    const username = usernameMap.get(addr) ?? addr.substring(0, 10) + "...";
    const beastCount = beastCountMap.get(key) ?? 0;
    const holdSeconds = ownerHold.get(key) ?? 0;
    const totalXp = ownerXp.get(key) ?? 0;

    const battle = battleMap.get(key);
    const reward = rewardMap.get(key);
    const poison = poisonMap.get(key);

    const battles = battle ? Number(battle.battles) : 0;
    const attackPotionsUsed = battle ? Number(battle.attack_potions) : 0;
    const damageDealt = battle ? Number(battle.attack_damage) : 0;
    const criticalHits = battle ? Number(battle.critical_attack_count) : 0;
    const criticalDamage = battle ? Number(battle.critical_attack_damage) : 0;
    const counterDamageReceived = battle
      ? Number(battle.counter_attack_damage)
      : 0;
    const xpFromBattles = battle ? Number(battle.xp_gained) : 0;

    // Damage taken = counter_attack_damage (damage our beasts received)
    const damageTaken = counterDamageReceived;
    const damageRatio = damageTaken > 0 ? damageDealt / damageTaken : damageDealt > 0 ? Infinity : 0;
    const critPercent = battles > 0 ? (criticalHits / battles) * 100 : 0;

    const rewardsRaw = reward ? Number(reward.total_amount) : 0;
    // Rewards are in wei-like format (18 decimals)
    const rewardsEarned = rewardsRaw / 1e18;
    const rewardEvents = reward ? Number(reward.reward_count) : 0;

    const poisonApplied = poison ? Number(poison.total_poison) : 0;

    players.push({
      address: addr,
      username,
      beastCount,
      holdSeconds,
      holdPerBeast: beastCount > 0 ? holdSeconds / beastCount : 0,
      totalXp: totalXp + xpFromBattles,
      rewardsEarned,
      rewardsPerBeast: beastCount > 0 ? rewardsEarned / beastCount : 0,
      battles,
      attackPotionsUsed,
      damageDealt,
      damageTaken,
      damageRatio,
      criticalHits,
      criticalDamage,
      critPercent,
      counterDamageReceived,
      poisonApplied,
      rewardEvents,
    });
  }

  // Sort by rewards earned descending
  players.sort((a, b) => b.rewardsEarned - a.rewardsEarned);

  return {
    timestamp: Date.now(),
    players,
  };
}
