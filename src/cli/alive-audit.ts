#!/usr/bin/env tsx
import { Contract, RpcProvider } from "starknet";
import { loadConfig } from "../config.js";
import { SummitApiClient } from "../api/client.js";
import { loadSummitAbi } from "../chain/abi.js";
import { getBeastMeta } from "../data/beasts.js";
import type { ApiBeast } from "../api/types.js";

type LiveRow = {
  health: number;
  bonus_health: number;
  last_death_timestamp: number;
  spirit: number;
  revival_count: number;
  extra_lives: number;
};

const DEFAULT_BATCH_SIZE = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(200 * (i + 1));
    }
  }
  throw lastErr;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): {
  configPath: string;
  species: string[];
  tokenIds: number[];
  limit: number;
} {
  const positional: string[] = [];
  let species: string[] = [];
  let tokenIds: number[] = [];
  let limit = 40;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--species") {
      species = parseCsv(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--token-ids") {
      tokenIds = parseCsv(argv[i + 1])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => Math.floor(v));
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  return {
    configPath: positional[0] || "config/userprofile.json",
    species,
    tokenIds,
    limit,
  };
}

function dedupeBeasts(beasts: ApiBeast[]): ApiBeast[] {
  const byId = new Map<number, ApiBeast>();
  for (const beast of beasts) {
    if (!byId.has(beast.token_id)) {
      byId.set(beast.token_id, beast);
    }
  }
  return [...byId.values()];
}

function asNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getSpiritRevivalReductionSeconds(spirit: number): number {
  const value = Math.max(0, Math.floor(spirit));
  if (value <= 5) {
    switch (value) {
      case 1:
        return 7_200;
      case 2:
        return 10_080;
      case 3:
        return 12_240;
      case 4:
        return 13_680;
      case 5:
        return 14_400;
      default:
        return 0;
    }
  }
  if (value <= 70) return 14_400 + (value - 5) * 720;
  return 61_200 + (value - 70) * 360;
}

function getBeastRevivalTimeMs(spirit: number): number {
  return Math.max(14_400_000, 86_400_000 - getSpiritRevivalReductionSeconds(spirit) * 1_000);
}

function resolveEffectiveHealth(row: LiveRow | null, beast: ApiBeast): number {
  const current = asNumber(row?.health);
  if (current > 0) return current;
  const full = asNumber(beast.health) + asNumber(row?.bonus_health ?? beast.bonus_health);
  const lastDeath = asNumber(row?.last_death_timestamp ?? beast.last_death_timestamp);
  if (current === 0) {
    if (lastDeath === 0 && full > 0) return full;
    const spirit = asNumber(row?.spirit ?? beast.spirit);
    if (lastDeath > 0 && lastDeath * 1_000 + getBeastRevivalTimeMs(spirit) <= Date.now()) {
      return full;
    }
  }
  return 0;
}

async function getLiveStatsBatch(
  contract: Contract,
  tokenIds: number[],
  batchSize: number
): Promise<Map<number, LiveRow>> {
  const out = new Map<number, LiveRow>();
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    const result: any = await withRetry(() => contract.call("get_live_stats", [batch]));
    const rows = Array.isArray(result)
      ? result
      : Array.isArray(result?.snapshot)
        ? result.snapshot
        : [];
    for (const row of rows) {
      const tokenId = asNumber(row?.token_id);
      if (!tokenId) continue;
      out.set(tokenId, {
        health: asNumber(row?.current_health ?? row?.health),
        bonus_health: asNumber(row?.bonus_health),
        last_death_timestamp: asNumber(row?.last_death_timestamp),
        spirit: asNumber(row?.stats?.spirit ?? row?.spirit),
        revival_count: asNumber(row?.revival_count),
        extra_lives: asNumber(row?.extra_lives),
      });
    }
  }
  return out;
}

async function getLiveStatsSingle(contract: Contract, tokenId: number): Promise<LiveRow | null> {
  try {
    const row: any = await withRetry(() => contract.call("get_beast", [tokenId]), 4);
    const live = row?.live ?? row;
    return {
      health: asNumber(live?.current_health ?? live?.health),
      bonus_health: asNumber(live?.bonus_health),
      last_death_timestamp: asNumber(live?.last_death_timestamp),
      spirit: asNumber(live?.stats?.spirit ?? live?.spirit),
      revival_count: asNumber(live?.revival_count),
      extra_lives: asNumber(live?.extra_lives),
    };
  } catch {
    return null;
  }
}

function speciesName(beast: ApiBeast): string {
  return getBeastMeta(beast.beast_id)?.name ?? `beast#${beast.beast_id}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const api = new SummitApiClient(config.api.baseUrl);
  const provider = new RpcProvider({
    nodeUrl: config.chain.rpcUrl,
    blockIdentifier: "latest",
  });
  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const contract = new Contract(abi, config.chain.summitContract, provider);

  const allApi = await api.getOwnerBeasts(config.account.controllerAddress);
  const unique = dedupeBeasts(allApi);
  const tokenIds = unique.map((b) => b.token_id);
  const liveBatch = await getLiveStatsBatch(contract, tokenIds, DEFAULT_BATCH_SIZE);

  const apiAlive = allApi.filter((b) => asNumber(b.health ?? b.current_health) > 0).length;
  const uniqueApiAlive = unique.filter((b) => asNumber(b.health ?? b.current_health) > 0).length;
  const beastById = new Map<number, ApiBeast>(unique.map((b) => [b.token_id, b]));
  const batchAlive = tokenIds.filter((id) => {
    const beast = beastById.get(id);
    if (!beast) return false;
    return resolveEffectiveHealth(liveBatch.get(id) ?? null, beast) > 0;
  }).length;

  console.log("=== Alive Audit ===");
  console.log(`account=${config.account.username} address=${config.account.controllerAddress}`);
  console.log(
    `api_total=${allApi.length} api_unique=${unique.length} api_alive_raw=${apiAlive} api_alive_unique=${uniqueApiAlive}`
  );
  console.log(`onchain_alive_batch=${batchAlive} onchain_dead_batch=${unique.length - batchAlive}`);
  console.log("");

  const speciesFilter = new Set(args.species.map((s) => s.toLowerCase()));
  const requestedTokenSet = new Set(args.tokenIds);
  const enableSingleCheck = speciesFilter.size > 0 || requestedTokenSet.size > 0;

  let selected = unique;
  if (speciesFilter.size > 0 || requestedTokenSet.size > 0) {
    selected = unique.filter((b) => {
      if (requestedTokenSet.has(b.token_id)) return true;
      if (speciesFilter.size === 0) return false;
      return speciesFilter.has(speciesName(b).toLowerCase());
    });
  }

  const sorted = [...selected].sort((a, b) => b.token_id - a.token_id).slice(0, args.limit);
  if (sorted.length === 0) {
    console.log("No beasts matched the filter.");
    return;
  }

  console.log("token_id species api_hp onchain_hp_batch onchain_hp_single revival_batch revival_single status");
  for (const beast of sorted) {
    const rowBatch = liveBatch.get(beast.token_id) ?? null;
    const rowSingle = enableSingleCheck ? await getLiveStatsSingle(contract, beast.token_id) : null;
    const apiHp = asNumber(beast.health ?? beast.current_health);
    const hpBatch = asNumber(rowBatch?.health);
    const hpSingle = asNumber(rowSingle?.health);
    const revivalBatch = asNumber(rowBatch?.revival_count);
    const revivalSingle = asNumber(rowSingle?.revival_count);
    const effectiveHpBatch = resolveEffectiveHealth(rowBatch, beast);
    const effectiveHpSingle = resolveEffectiveHealth(rowSingle, beast);
    const effectiveHp = Math.max(effectiveHpBatch, effectiveHpSingle);
    const status = effectiveHp > 0 ? "ALIVE" : "DEAD";
    console.log(
      `${beast.token_id} ${speciesName(beast)} ${apiHp} ${hpBatch} ${hpSingle} ${revivalBatch} ${revivalSingle} ${status}`
    );
  }
}

main().catch((err) => {
  console.error("alive-audit failed:", err);
  process.exit(1);
});
