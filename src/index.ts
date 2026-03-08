#!/usr/bin/env tsx
/**
 * Summit Agent — main bot loop.
 *
 * Three-layer retry strategy for attacks:
 *   Layer 1: Summit holder changed mid-tx → instant retry with fresh snapshot
 *   Layer 2: Individual beast revival mismatch → exclude that beast, retry remaining
 *   Layer 3: Stale data / unknown reverts → refresh all beasts via on-chain getLiveStats
 *
 * Usage: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/index.ts config/userprofile.json
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { loadConfig } from "./config.js";
import { SummitApiClient } from "./api/client.js";
import { SummitWsClient } from "./api/ws.js";
import { ChainClient } from "./chain/client.js";
import { StrategyEngine } from "./strategy/engine.js";
import { enrichBeast } from "./strategy/scoring.js";
import { Logger } from "./utils/logger.js";
import { sleep } from "./utils/time.js";
import type { EnrichedBeast, GameSnapshot } from "./strategy/types.js";
import type { ApiBeast } from "./api/types.js";

type OwnerBeastCacheState = {
  rawWithLive: ApiBeast[];
  enriched: EnrichedBeast[];
  fetchedAt: number;
  liveMismatchFallback: boolean;
};

type RunnerLock = {
  fd: number;
  path: string;
  released: boolean;
};

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockedPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(parsed.pid ?? 0);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function acquireRunnerLock(
  config: import("./config.js").FenrirConfig,
  logger: Logger
): RunnerLock | null {
  const lockPath = config.session.file.endsWith("session.json")
    ? config.session.file.replace(/session\.json$/, "runner.lock")
    : `${config.session.file}.runner.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          username: config.account.username,
          startedAt: new Date().toISOString(),
        }) + "\n",
        "utf-8"
      );
      logger.info(`[LOCK] Acquired runner lock ${lockPath}`, { pid: process.pid });
      return { fd, path: lockPath, released: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        logger.error(`[LOCK] Failed to create runner lock ${lockPath}: ${serializeError(err)}`);
        return null;
      }

      const lockedPid = readLockedPid(lockPath);
      if (lockedPid && isProcessAlive(lockedPid)) {
        logger.error(
          `[LOCK] Another runner is already active for ${config.account.username} (pid=${lockedPid}). Exiting.`
        );
        return null;
      }

      try {
        unlinkSync(lockPath);
        logger.warn(`[LOCK] Removed stale runner lock ${lockPath}`, { stalePid: lockedPid });
      } catch (unlinkErr) {
        logger.error(
          `[LOCK] Could not remove stale runner lock ${lockPath}: ${serializeError(unlinkErr)}`
        );
        return null;
      }
    }
  }

  logger.error(`[LOCK] Could not acquire runner lock ${lockPath}`);
  return null;
}

function releaseRunnerLock(lock: RunnerLock | null, logger: Logger): void {
  if (!lock || lock.released) return;
  lock.released = true;
  try {
    closeSync(lock.fd);
  } catch {
    // Ignore close failure; lock file cleanup below is what matters.
  }
  try {
    unlinkSync(lock.path);
    logger.info(`[LOCK] Released runner lock ${lock.path}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[LOCK] Failed to remove runner lock ${lock.path}: ${serializeError(err)}`);
    }
  }
}

// ── Error serializer ─────────────────────────────────────────────
function serializeError(err: unknown): string {
  if (err instanceof Error) {
    // StarkNet RPC errors often embed revert reason in the message
    return err.message;
  }
  if (typeof err === "string") return err;

  if (err && typeof err === "object") {
    // Cartridge throws plain objects: { code, message, data }
    const obj = err as Record<string, unknown>;
    const parts: string[] = [];

    // Extract message first (most useful)
    if (obj.message && typeof obj.message === "string") parts.push(obj.message);
    if (obj.code !== undefined) parts.push(`code=${obj.code}`);
    if (obj.data && typeof obj.data === "string") parts.push(`data=${obj.data}`);

    // StarkNet-specific: revert_reason or execution_error in nested structures
    if (obj.revert_reason) parts.push(`revert=${obj.revert_reason}`);
    if (obj.execution_error) parts.push(`exec_error=${obj.execution_error}`);

    // Dig into nested error shapes (e.g. { error: { message: ... } })
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>;
      if (inner.message) parts.push(`inner=${inner.message}`);
      if (inner.data) parts.push(`inner_data=${inner.data}`);
    }

    if (parts.length > 0) return parts.join(" | ");

    // WASM error with __wbg_ptr — try all own enumerable props
    if ("__wbg_ptr" in obj) {
      const wasmParts: string[] = [];
      for (const key of Object.keys(obj)) {
        if (key === "__wbg_ptr") continue;
        try { wasmParts.push(`${key}=${String(obj[key])}`); } catch {}
      }
      if (wasmParts.length > 0) return `WASM[${wasmParts.join("; ")}]`;
    }

    // Last resort: try JSON.stringify with a replacer that handles BigInt
    try {
      return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      // Object has circular refs or non-serializable values — enumerate keys
      const keys = Object.keys(obj);
      const kv = keys.slice(0, 10).map(k => {
        try { return `${k}=${String(obj[k]).substring(0, 100)}`; } catch { return `${k}=?`; }
      });
      return `{${kv.join(", ")}}`;
    }
  }

  return String(err);
}

// ── Hex felt decoder ─────────────────────────────────────────────
function decodeHexFelts(errStr: string): string {
  return errStr.replace(/0x([0-9a-fA-F]{2,})/gi, (match, hex) => {
    try {
      // Skip if it looks like an address (64 hex chars) or class hash
      if (hex.length >= 40) return match;
      const bytes = Buffer.from(hex, "hex");
      const text = bytes.toString("utf-8");
      // Only replace if it decodes to readable ASCII
      if (/^[\x20-\x7e]+$/.test(text)) return `${match}("${text}")`;
    } catch {}
    return match;
  });
}

const HARD_MAX_REVIVAL_POTIONS_PER_BEAST = 88;
const HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK = 5;
const ATTACK_POTION_ALLOWANCE_FALLBACK_MS = 30 * 60 * 1000;
const EXTRA_LIFE_ALLOWANCE_FALLBACK_MS = 30 * 60 * 1000;
const REVIVAL_ALLOWANCE_FALLBACK_MS = 10 * 60 * 1000;
let attackPotionAllowanceFallbackUntil = 0;
let extraLifeAllowanceFallbackUntil = 0;
let revivalAllowanceFallbackUntil = 0;
let extraLifePermanentlyDisabled = false;
let enforceSessionReRegistrationOnAllowance = true;
let sessionReRegistrationCommand =
  "NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/create-session.ts config/userprofile.json";
let sessionReRegistrationReminderMs = 60_000;
let sessionReRegistrationSleepMs = 15_000;
let sessionReRegistrationRequired = false;
let lastSessionReRegistrationReminderAt = 0;

function getSessionRegistrationScript(config: import("./config.js").FenrirConfig): string {
  const dirName = String(config.session.dirName ?? "").toLowerCase();
  return dirName.includes("lean")
    ? "src/bootstrap/create-session-lean.ts"
    : "src/bootstrap/create-session.ts";
}

function markSessionReRegistrationRequired(logger: Logger, reason: string): void {
  if (sessionReRegistrationRequired) return;
  sessionReRegistrationRequired = true;
  lastSessionReRegistrationReminderAt = 0;
  logger.warn(
    `[SESSION] ${reason}. Re-register session (slow mode): ${sessionReRegistrationCommand}`
  );
  logger.event("session_reregistration_required", {
    reason,
    command: sessionReRegistrationCommand,
  });
}

function estimateDeadBeastRevivalBudget(revivalCount: number, _attackCount: number): number {
  const normalizedRevivalCount = Math.max(0, Math.floor(revivalCount));
  // Required potions for a dead beast is the next single revival cost.
  // Do not clamp here; callers must compare against strategy cap.
  return normalizedRevivalCount + 1;
}

function getSpiritRevivalReductionSeconds(spirit: number): number {
  const value = Math.max(0, Math.floor(Number(spirit ?? 0)));
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
  if (value <= 70) {
    return 14_400 + (value - 5) * 720;
  }
  return 61_200 + (value - 70) * 360;
}

function getBeastRevivalTimeMs(spirit: number): number {
  const baseMs = 86_400_000;
  const reductionMs = getSpiritRevivalReductionSeconds(spirit) * 1_000;
  return Math.max(14_400_000, baseMs - reductionMs);
}

type BeastHealthContext = Pick<ApiBeast, "health" | "current_health" | "spirit"> & {
  bonus_health?: number;
  last_death_timestamp?: number;
};

type LiveHealthContext = {
  health?: number;
  bonus_health?: number;
  spirit?: number;
  last_death_timestamp?: number;
};

function resolveEffectiveHealth(
  live: LiveHealthContext | null | undefined,
  beast: BeastHealthContext | null | undefined,
  nowMs = Date.now()
): number {
  const currentHealth = Number(live?.health ?? 0);
  if (currentHealth > 0) return currentHealth;

  const baseHealth = Number(beast?.health ?? 0);
  const bonusHealth = Number(live?.bonus_health ?? beast?.bonus_health ?? 0);
  const fullHealth = Math.max(0, baseHealth + bonusHealth);
  const lastDeathTs = Number(live?.last_death_timestamp ?? beast?.last_death_timestamp ?? 0);
  const spirit = Number(live?.spirit ?? beast?.spirit ?? 0);

  // Beasts auto-revive after their spirit-based cooldown expires.
  // The on-chain view functions still report current_health=0 for
  // auto-revived beasts, so we infer alive status from the cooldown.
  if (currentHealth === 0) {
    // Never died → treat as alive if beast has health.
    if (lastDeathTs === 0 && fullHealth > 0) {
      return fullHealth;
    }
    // Died before → check if cooldown expired (auto-revive).
    const revivalReadyAt = lastDeathTs * 1_000 + getBeastRevivalTimeMs(spirit);
    if (lastDeathTs > 0 && revivalReadyAt <= nowMs && fullHealth > 0) {
      return fullHealth;
    }
  }

  if (!live) {
    return Math.max(0, Number(beast?.current_health ?? beast?.health ?? 0));
  }
  return 0;
}

function normalizeProtectedOwnerAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(`Invalid protected owner address: ${raw}`);
  }
  const hex = trimmed.replace(/^0x/i, "").toLowerCase().replace(/^0+/, "");
  return `0x${hex.length > 0 ? hex : "0"}`;
}

async function refreshProtectedTokenIds(
  api: SummitApiClient,
  owners: string[],
  cache: Map<string, Set<number>>,
  logger: Logger,
): Promise<void> {
  const results = await Promise.all(
    owners.map(async (owner) => {
      try {
        const beasts = await api.getOwnerBeasts(owner);
        return { owner, tokenIds: new Set(beasts.map((b) => b.token_id)) };
      } catch (err) {
        const message = decodeHexFelts(serializeError(err));
        logger.warn(`[PROTECT] Failed refreshing protected owner ${owner}: ${message.substring(0, 220)}`);
        return null;
      }
    })
  );

  for (const result of results) {
    if (!result) continue;
    cache.set(result.owner, result.tokenIds);
    logger.info(
      `[PROTECT] Refreshed protected owner ${result.owner} tokens=${result.tokenIds.size}`
    );
  }
}

async function mergeLiveStats(chain: ChainClient, beasts: ApiBeast[]): Promise<ApiBeast[]> {
  if (beasts.length === 0) return beasts;
  const useOnchainLiveStats = process.env.FENRIR_USE_ONCHAIN_LIVE !== "0";
  if (!useOnchainLiveStats) return beasts;

  try {
    const stats = await chain.getLiveStats(beasts.map((b) => b.token_id));
    if (stats.size === 0) return beasts;

    return beasts.map((b) => {
      const s = stats.get(b.token_id);
      if (!s) return b;
      const effectiveHealth = resolveEffectiveHealth(s, b);
      return {
        ...b,
        health: effectiveHealth,
        current_health: effectiveHealth,
        bonus_health: Number(s.bonus_health ?? b.bonus_health ?? 0),
        last_death_timestamp: Number(s.last_death_timestamp ?? b.last_death_timestamp ?? 0),
        extra_lives: s.extra_lives,
        revival_count: s.revival_count,
        attack_streak: s.attack_streak,
        bonus_xp: s.bonus_xp,
        summit_held_seconds: s.summit_held_seconds,
        rewards_earned: s.rewards_earned,
        rewards_claimed: s.rewards_claimed,
        quest_captured_summit: s.quest_captured_summit,
        quest_used_revival_potion: s.quest_used_revival_potion,
        quest_used_attack_potion: s.quest_used_attack_potion,
        quest_max_attack_streak: s.quest_max_attack_streak,
      };
    });
  } catch {
    return beasts;
  }
}

function getBonusLevels(baseLevel: number, bonusXp: number): number {
  const base = Math.max(1, Math.floor(baseLevel));
  const bonus = Math.max(0, Math.floor(bonusXp));
  const current = Math.floor(Math.sqrt(base * base + bonus));
  return Math.max(0, current - base);
}

function calculateQuestRewardsUnits(beast: ApiBeast): number {
  let total = 0;

  if (Number(beast.bonus_xp ?? 0) > 0) total += 5; // First Blood
  if (Number(beast.quest_used_revival_potion ?? 0) === 1) total += 10; // Second Wind
  if (Number(beast.quest_used_attack_potion ?? 0) === 1) total += 10; // A Vital Boost

  const bonusLevels = getBonusLevels(Number(beast.level ?? 1), Number(beast.bonus_xp ?? 0));
  if (bonusLevels >= 10) total += 30;
  else if (bonusLevels >= 5) total += 18;
  else if (bonusLevels >= 3) total += 10;
  else if (bonusLevels >= 1) total += 4;

  if (Number(beast.quest_captured_summit ?? 0) === 1) total += 10; // Summit Conqueror
  if (Number(beast.summit_held_seconds ?? 0) >= 10) total += 20; // Iron Grip
  if (Number(beast.quest_max_attack_streak ?? 0) === 1) total += 10; // Consistency is Key

  return total;
}

async function maybeClaimQuestRewards(
  chain: ChainClient,
  beasts: ApiBeast[],
  logger: Logger,
): Promise<{ attempted: number; claimed: number }> {
  if (beasts.length === 0) return { attempted: 0, claimed: 0 };

  const tokenIds = beasts.map((b) => b.token_id);
  const claimedMap = await chain.getQuestRewardsClaimed(tokenIds);

  const claimable = beasts
    .map((b) => {
      const totalUnits = calculateQuestRewardsUnits(b);
      const claimedUnits = claimedMap.get(b.token_id) ?? 0;
      return {
        tokenId: b.token_id,
        totalUnits,
        claimedUnits,
        pendingUnits: Math.max(0, totalUnits - claimedUnits),
      };
    })
    .filter((x) => x.pendingUnits > 0);

  if (claimable.length === 0) return { attempted: 0, claimed: 0 };

  const batchSize = 25;
  let attempted = 0;
  let claimed = 0;

  for (let i = 0; i < claimable.length; i += batchSize) {
    const batch = claimable.slice(i, i + batchSize);
    attempted += batch.length;
    const ids = batch.map((x) => x.tokenId);
    try {
      const result = await chain.claimQuestRewards(ids);
      claimed += batch.length;
      logger.info(
        `[QUEST] Claimed quest rewards for ${batch.length} beasts tx=${result.txHash}`
      );
    } catch (err) {
      const message = decodeHexFelts(serializeError(err));
      if (
        message.includes("No quest rewards to claim") ||
        message.includes("Quest rewards pool is empty")
      ) {
        logger.info(`[QUEST] Claim skipped: ${message}`);
        break;
      }
      logger.warn(`[QUEST] Claim batch failed: ${message.substring(0, 300)}`);
    }
  }

  return { attempted, claimed };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const config = loadConfig(configPath);
  const extraLifePotionCap = Math.max(
    0,
    Math.min(
      HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK,
      Math.floor(Number(config.strategy.extraLifePotionsPerAttack ?? 0))
    )
  );

  const logger = new Logger("summit-agent", config.logging.eventsFile);
  const sessionRegistrationScript = getSessionRegistrationScript(config);
  sessionReRegistrationCommand = `NODE_OPTIONS='--experimental-wasm-modules' npx tsx ${sessionRegistrationScript} ${configPath}`;
  enforceSessionReRegistrationOnAllowance =
    process.env.FENRIR_REQUIRE_SESSION_REREG_ON_ALLOWANCE !== "0";
  sessionReRegistrationReminderMs = Math.max(
    15_000,
    Math.floor(Number(process.env.FENRIR_SESSION_REREG_REMINDER_MS ?? 60_000))
  );
  sessionReRegistrationSleepMs = Math.max(
    config.api.pollIntervalMs,
    Math.floor(Number(process.env.FENRIR_SESSION_REREG_SLEEP_MS ?? 15_000))
  );
  sessionReRegistrationRequired = false;
  lastSessionReRegistrationReminderAt = 0;
  const runnerLock = acquireRunnerLock(config, logger);
  if (!runnerLock) {
    process.exit(1);
  }
  const releaseLock = () => releaseRunnerLock(runnerLock, logger);
  process.once("exit", () => releaseLock());
  process.once("SIGINT", () => {
    logger.warn("[LOCK] Received SIGINT, shutting down");
    releaseLock();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    logger.warn("[LOCK] Received SIGTERM, shutting down");
    releaseLock();
    process.exit(0);
  });

  const protectedOwners = config.strategy.protectedOwners
    .map((owner) => {
      try {
        return normalizeProtectedOwnerAddress(owner);
      } catch (err) {
        logger.warn(`[PROTECT] Ignoring invalid protected owner "${owner}": ${serializeError(err)}`);
        return null;
      }
    })
    .filter((owner): owner is string => owner !== null);

  // Validate session exists
  const sessionDir = config.session.file.replace(/session\.json$/, config.session.dirName);
  const sessionFile = `${sessionDir}/session.json`;
  if (!existsSync(sessionFile)) {
    logger.error(`Cartridge session not found at ${sessionFile}`);
    logger.error("Run: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/create-session.ts");
    process.exit(1);
  }

  logger.info("Summit Agent starting...", {
    username: config.account.username,
    address: config.account.controllerAddress,
    pollMs: config.api.pollIntervalMs,
    cooldownMs: config.strategy.attackCooldownMs,
    maxBeasts: config.strategy.maxBeastsPerAttack,
    maxRevivalPotionsPerBeast: Math.min(
      HARD_MAX_REVIVAL_POTIONS_PER_BEAST,
      Math.max(0, Math.floor(config.strategy.maxRevivalPotionsPerBeast))
    ),
    extraLifePotionCap,
    protectedOwners: protectedOwners.length,
  });

  // Initialize clients
  const api = new SummitApiClient(config.api.baseUrl);
  const chain = new ChainClient(config, logger);
  const engine = new StrategyEngine(config, logger);

  await chain.init();
  logger.info("Chain client initialized");

  // WebSocket for real-time events — triggers early poll on holder changes
  let wsHolderChanged = false;
  const ws = new SummitWsClient(config.api.wsUrl, logger);
  ws.onEvent((channel, data) => {
    if (channel === "summit_change" || channel === "beast_killed") {
      logger.info(`WS event: ${channel}`, data as Record<string, unknown>);
      wsHolderChanged = true;
    }
  });
  ws.start();

  // ── Main poll loop ─────────────────────────────────────────────
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  const beastCooldownExclusions = new Map<number, number>(); // token_id -> unix ms expiry
  let lastQuestClaimCheckAt = Date.now();
  const QUEST_CLAIM_CHECK_MS = Math.max(
    60_000,
    Math.floor(Number(process.env.FENRIR_QUEST_CLAIM_CHECK_MS ?? 600_000))
  );
  const QUEST_CLAIM_SCAN_SIZE = Math.max(
    25,
    Math.floor(Number(process.env.FENRIR_QUEST_CLAIM_SCAN_SIZE ?? 120))
  );
  let questClaimCursor = 0;
  const protectedTokenIdsByOwner = new Map<string, Set<number>>();
  let lastProtectedRefreshAt = 0;
  const lastPoisonAtByHolder = new Map<number, number>();
  const poisonSpikeCacheByHolder = new Map<number, { checkedAt: number; latestPoison: number }>();
  const lastDefendExtraLifeAtByHolder = new Map<number, number>();
  let loggedMissingAddExtraLifeSupport = false;
  const defendPoisonProbeCacheMs = Math.max(
    5_000,
    Math.floor(Number(process.env.FENRIR_DEFEND_POISON_PROBE_CACHE_MS ?? 15_000))
  );
  const defendPoisonLookbackBlocks = Math.max(
    20,
    Math.floor(Number(process.env.FENRIR_DEFEND_POISON_LOOKBACK_BLOCKS ?? 300))
  );
  const ownerBeastsRefreshMs = Math.max(
    config.api.pollIntervalMs,
    Math.floor(config.strategy.ownerBeastsRefreshMs)
  );
  const useOnchainLiveStats = process.env.FENRIR_USE_ONCHAIN_LIVE !== "0";
  const useOnchainSingleAliveVerify = process.env.FENRIR_ONCHAIN_ALIVE_SINGLE_VERIFY !== "0";
  const onchainSingleAliveVerifyLimit = Math.max(
    1,
    Math.floor(Number(process.env.FENRIR_ONCHAIN_ALIVE_SINGLE_VERIFY_LIMIT ?? 8))
  );
  const ownerBeastCache: OwnerBeastCacheState = {
    rawWithLive: [],
    enriched: [],
    fetchedAt: 0,
    liveMismatchFallback: false,
  };
  const countAliveByHealth = (beasts: ApiBeast[]): number =>
    beasts.filter((beast) => Number(beast.health ?? beast.current_health ?? 0) > 0).length;

  const getOwnerBeastsCached = async (force = false): Promise<OwnerBeastCacheState> => {
    const now = Date.now();
    const cacheFresh = now - ownerBeastCache.fetchedAt < ownerBeastsRefreshMs;
    if (!force && cacheFresh && ownerBeastCache.enriched.length > 0) {
      return ownerBeastCache;
    }

    const startedAt = Date.now();
    const ownerBeastsApi = await api.getOwnerBeasts(config.account.controllerAddress);
    const apiAliveCount = countAliveByHealth(ownerBeastsApi);
    let rawWithLive = await mergeLiveStats(chain, ownerBeastsApi);
    let liveMismatchFallback = false;
    const mergedAliveCount = countAliveByHealth(rawWithLive);
    if (useOnchainLiveStats && mergedAliveCount === 0 && apiAliveCount >= 25) {
      // Optional override: trust API health when on-chain live stats report everyone dead.
      const explicitTrustApiOnMismatch =
        process.env.FENRIR_TRUST_API_ON_ALL_DEAD_MISMATCH === "1";
      const trustApiOnAllDeadMismatch =
        explicitTrustApiOnMismatch || !config.strategy.useRevivalPotions;
      const probeIds = ownerBeastsApi
        .filter((beast) => Number(beast.health ?? beast.current_health ?? 0) > 0)
        .slice(0, 16)
        .map((beast) => beast.token_id);
      const apiBeastById = new Map<number, ApiBeast>(
        ownerBeastsApi.map((beast) => [beast.token_id, beast])
      );

      let probeAliveCount = 0;
      if (probeIds.length > 0) {
        try {
          const probeStats = await chain.getLiveStats(probeIds);
          probeAliveCount = probeIds.filter((id) => {
            const live = probeStats.get(id);
            const beast = apiBeastById.get(id);
            return resolveEffectiveHealth(live, beast) > 0;
          }).length;
          if (probeAliveCount === 0 && useOnchainSingleAliveVerify) {
            const verifyIds = probeIds.slice(0, onchainSingleAliveVerifyLimit);
            let singleAliveCount = 0;
            for (const tokenId of verifyIds) {
              try {
                const stat = await chain.getLiveStat(tokenId);
                const beast = apiBeastById.get(tokenId);
                if (resolveEffectiveHealth(stat, beast) > 0) singleAliveCount += 1;
              } catch {
                // Best effort. Batch result remains the fallback.
              }
            }
            if (singleAliveCount > 0) {
              probeAliveCount = singleAliveCount;
              logger.warn(
                `[CACHE] Batch live probe reported 0 alive, single-token verify found alive=${singleAliveCount}/${verifyIds.length}`
              );
            }
          }
        } catch (probeErr) {
          const probeMsg = decodeHexFelts(serializeError(probeErr));
          logger.warn(
            `[CACHE] Live stats mismatch probe failed: ${probeMsg.substring(0, 220)}`
          );
        }
      }

      if (probeAliveCount > 0 || trustApiOnAllDeadMismatch) {
        rawWithLive = ownerBeastsApi;
        liveMismatchFallback = true;
        if (probeAliveCount > 0) {
          logger.warn(
            `[CACHE] Live stats mismatch (API alive=${apiAliveCount}, merged alive=0, probe alive=${probeAliveCount}/${probeIds.length}) — using API snapshot for attacker selection`
          );
        } else if (!config.strategy.useRevivalPotions) {
          logger.warn(
            `[CACHE] Live stats mismatch (API alive=${apiAliveCount}, merged alive=0, probe alive=${probeAliveCount}/${probeIds.length}) — using API snapshot because revival is disabled (alive-only mode)`
          );
        } else {
          logger.warn(
            `[CACHE] Live stats mismatch (API alive=${apiAliveCount}, merged alive=0, probe alive=${probeAliveCount}/${probeIds.length}) — using API snapshot due explicit FENRIR_TRUST_API_ON_ALL_DEAD_MISMATCH=1`
          );
        }
      } else {
        logger.warn(
          `[CACHE] Live stats mismatch (API alive=${apiAliveCount}, merged alive=0, probe alive=${probeAliveCount}/${probeIds.length}) — keeping on-chain snapshot as source of truth for tx validity`
        );
      }
    }
    ownerBeastCache.rawWithLive = rawWithLive;
    ownerBeastCache.enriched = rawWithLive.map(enrichBeast);
    ownerBeastCache.fetchedAt = Date.now();
    ownerBeastCache.liveMismatchFallback = liveMismatchFallback;

    logger.debug(
      `[CACHE] Owner beasts refreshed count=${rawWithLive.length} force=${force} tookMs=${Date.now() - startedAt}`
    );

    return ownerBeastCache;
  };

  while (true) {
    try {
      if (sessionReRegistrationRequired) {
        const now = Date.now();
        if (
          now - lastSessionReRegistrationReminderAt >= sessionReRegistrationReminderMs
        ) {
          lastSessionReRegistrationReminderAt = now;
          logger.warn(
            `[SESSION] Waiting for session re-registration approval. Run: ${sessionReRegistrationCommand}`
          );
        }
        await sleep(sessionReRegistrationSleepMs);
        continue;
      }

      // Build snapshot from API/cache
      const [holderRaw, ownerCache] = await Promise.all([
        chain.getSummitHolderApiShape(),
        getOwnerBeastsCached(false),
      ]);
      const nowMs = Date.now();
      for (const [tokenId, expiry] of beastCooldownExclusions) {
        if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
      }
      const ourBeastsRawWithLive = ownerCache.rawWithLive;
      let ourBeastsRaw = ourBeastsRawWithLive.filter(
        (b) => !beastCooldownExclusions.has(b.token_id)
      );
      let ourBeastsEnriched = ownerCache.enriched.filter(
        (b) => !beastCooldownExclusions.has(b.token_id)
      );
      if (ourBeastsRawWithLive.length > 0 && ourBeastsRaw.length === 0) {
        const aliveInSnapshot = ownerCache.enriched.filter((b) => b.isAlive).length;
        if (ownerCache.liveMismatchFallback || aliveInSnapshot > 0) {
          // Only clear expired exclusions — don't re-introduce beasts with valid cooldowns
          // (e.g. death-mountain 24h) that will just fail again immediately.
          const nowMs = Date.now();
          for (const [tokenId, expiry] of beastCooldownExclusions) {
            if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
          }
          ourBeastsRaw = ourBeastsRawWithLive.filter(
            (b) => !beastCooldownExclusions.has(b.token_id)
          );
          ourBeastsEnriched = ownerCache.enriched.filter(
            (b) => !beastCooldownExclusions.has(b.token_id)
          );
          logger.warn(
            `[RECOVERY] All beasts were cooldown-excluded (aliveInSnapshot=${aliveInSnapshot}, apiFallback=${ownerCache.liveMismatchFallback}) — cleared expired exclusions, ${beastCooldownExclusions.size} still active`
          );
        }
      }

      const snapshot: GameSnapshot = {
        summitHolder: holderRaw ? enrichBeast(holderRaw) : null,
        ourBeasts: ourBeastsEnriched,
        timestamp: Date.now(),
      };

      if (protectedOwners.length > 0) {
        const now = Date.now();
        const refreshInterval = Math.max(15_000, config.strategy.protectedOwnersRefreshMs);
        if (
          now - lastProtectedRefreshAt >= refreshInterval ||
          protectedOwners.some((owner) => !protectedTokenIdsByOwner.has(owner))
        ) {
          await refreshProtectedTokenIds(
            api,
            protectedOwners,
            protectedTokenIdsByOwner,
            logger
          );
          lastProtectedRefreshAt = now;
        }
      }

      if (Date.now() - lastQuestClaimCheckAt >= QUEST_CLAIM_CHECK_MS) {
        try {
          const questScanCount = Math.min(
            ourBeastsRawWithLive.length,
            QUEST_CLAIM_SCAN_SIZE
          );
          const scanStart = questClaimCursor % Math.max(1, ourBeastsRawWithLive.length || 1);
          const scanEnd = scanStart + questScanCount;
          const claimSubset =
            ourBeastsRawWithLive.length === 0
              ? []
              : scanEnd <= ourBeastsRawWithLive.length
                ? ourBeastsRawWithLive.slice(scanStart, scanEnd)
                : ourBeastsRawWithLive
                    .slice(scanStart)
                    .concat(ourBeastsRawWithLive.slice(0, scanEnd % ourBeastsRawWithLive.length));
          questClaimCursor =
            ourBeastsRawWithLive.length === 0
              ? 0
              : (scanStart + questScanCount) % ourBeastsRawWithLive.length;
          const claimResult = await maybeClaimQuestRewards(chain, claimSubset, logger);
          if (claimResult.attempted > 0) {
            logger.info(
              `[QUEST] Claim check complete attempted=${claimResult.attempted} successfulBatchesApprox=${claimResult.claimed} scanSize=${claimSubset.length} totalBeasts=${ourBeastsRawWithLive.length}`
            );
          }
        } catch (claimErr) {
          const claimMsg = decodeHexFelts(serializeError(claimErr));
          logger.warn(`[QUEST] Claim check failed: ${claimMsg.substring(0, 300)}`);
        } finally {
          lastQuestClaimCheckAt = Date.now();
        }
      }

      // ── Single protected-owner check (reused for both attack and poison) ──
      let holderIsProtected = false;
      if (holderRaw && protectedOwners.length > 0) {
        const missingCoverage = protectedOwners.some(
          (owner) => !protectedTokenIdsByOwner.has(owner)
        );
        if (missingCoverage) {
          logger.warn("[PROTECT] Protected owner token set unavailable — skipping attack cycle");
          await sleep(config.api.pollIntervalMs);
          consecutiveErrors = 0;
          continue;
        }

        holderIsProtected = [...protectedTokenIdsByOwner.values()].some((ids) =>
          ids.has(holderRaw.token_id)
        );

        // Fallback: if token isn't in the cached set, check the on-chain owner
        // directly. This catches beasts missed by pagination or acquired after
        // the last protected-owner refresh.
        if (!holderIsProtected) {
          try {
            const holderOwner = await chain.getBeastOwner(holderRaw.token_id);
            if (holderOwner && protectedOwners.includes(holderOwner)) {
              holderIsProtected = true;
              // Add to cache so future checks are instant
              for (const [owner, ids] of protectedTokenIdsByOwner) {
                if (owner === holderOwner) {
                  ids.add(holderRaw.token_id);
                  break;
                }
              }
            }
          } catch (ownerErr) {
            // Can't verify — treat as protected to avoid friendly fire
            holderIsProtected = true;
            logger.warn(
              `[PROTECT] Owner fallback lookup failed for token=${holderRaw.token_id}; treating as protected: ${serializeError(ownerErr).substring(0, 220)}`
            );
          }
        }

        if (holderIsProtected) {
          logger.info(`[PROTECT] Skipping protected summit holder token=${holderRaw.token_id}`);
          await sleep(config.api.pollIntervalMs);
          consecutiveErrors = 0;
          continue;
        }
      }

      if (holderRaw && config.strategy.usePoisonOnHighExtraLives) {
        const holderIsOurs = ourBeastsRawWithLive.some(
          (beast) => beast.token_id === holderRaw.token_id
        );
        // holderIsProtected already checked above — no need for second RPC call
        if (holderIsOurs) {
          logger.debug(
            `[POISON] Skip: holder token=${holderRaw.token_id} belongs to our account`
          );
        } else if (holderIsProtected) {
          logger.info(
            `[PROTECT] Skipping poison for protected holder token=${holderRaw.token_id}`
          );
        } else {
          const extraLives = Number(holderRaw.extra_lives ?? 0);
          const threshold = Math.max(0, config.strategy.poisonHolderExtraLivesThreshold);
          if (extraLives > 0 && extraLives >= threshold) {
            const holderId = holderRaw.token_id;
            const now = Date.now();
            const cooldownMs = Math.max(1_000, config.strategy.poisonCooldownMs);
            const lastPoisonAt = lastPoisonAtByHolder.get(holderId) ?? 0;
            if (now - lastPoisonAt >= cooldownMs) {
              const poisonCount = Math.max(
                1,
                Math.floor(config.strategy.poisonCountPerCast)
              );
              try {
                const result = await chain.applyPoison(holderId, poisonCount);
                lastPoisonAtByHolder.set(holderId, now);
                logger.info(
                  `[POISON] Applied poison to holder token=${holderId} extraLives=${extraLives} count=${poisonCount} tx=${result.txHash}`
                );
                logger.event("poison_applied", {
                  tokenId: holderId,
                  extraLives,
                  count: poisonCount,
                  multiplier: 1,
                  txHash: result.txHash,
                });
              } catch (poisonErr) {
                const poisonMsg = decodeHexFelts(serializeError(poisonErr));
                logger.warn(
                  `[POISON] Failed for holder token=${holderId} extraLives=${extraLives}: ${poisonMsg.substring(0, 300)}`
                );
                const retryMs = Math.max(1_000, Math.min(5_000, Math.floor(cooldownMs / 4)));
                // Retry failed poison sooner instead of waiting the full poison cooldown.
                lastPoisonAtByHolder.set(holderId, now - cooldownMs + retryMs);
              }
            }
          }
        }
      }

      if (holderRaw && config.strategy.useExtraLifePotions) {
        const holderIsOurs = ourBeastsRawWithLive.some(
          (beast) => beast.token_id === holderRaw.token_id
        );
        if (holderIsOurs) {
          const holderId = holderRaw.token_id;
          const now = Date.now();
          const cooldownMs = Math.max(
            5_000,
            Math.floor(
              Number(
                process.env.FENRIR_DEFEND_EXTRA_LIFE_COOLDOWN_MS ??
                  Math.max(config.api.pollIntervalMs * 3, 20_000)
              )
            )
          );
          const poisonStopThreshold = Math.max(
            0,
            Math.floor(Number(process.env.FENRIR_SKIP_EXTRA_LIFE_POISON_THRESHOLD ?? 200))
          );
          let holderPoison = Math.max(
            0,
            Math.floor(
              Number((holderRaw as any).poison_count ?? (holderRaw as any).poison ?? 0)
            )
          );
          const poisonCache = poisonSpikeCacheByHolder.get(holderId);
          if (!poisonCache || now - poisonCache.checkedAt >= defendPoisonProbeCacheMs) {
            try {
              const recentPoisonApplied = await chain.getRecentPoisonAppliedCountForBeast(
                holderId,
                defendPoisonLookbackBlocks
              );
              poisonSpikeCacheByHolder.set(holderId, {
                checkedAt: now,
                latestPoison: recentPoisonApplied,
              });
              // Prefer live holder poison when available; otherwise use latest poison apply event.
              if (holderPoison <= 0) {
                holderPoison = Math.max(0, recentPoisonApplied);
              }
            } catch (poisonProbeErr) {
              logger.debug(
                `[DEFEND] Poison probe failed token=${holderId}: ${decodeHexFelts(serializeError(poisonProbeErr)).substring(0, 220)}`
              );
            }
          } else {
            if (holderPoison <= 0) {
              holderPoison = Math.max(0, poisonCache.latestPoison);
            }
          }
          if (holderPoison > poisonStopThreshold) {
            const lastDefendAt = lastDefendExtraLifeAtByHolder.get(holderId) ?? 0;
            if (now - lastDefendAt >= cooldownMs) {
              lastDefendExtraLifeAtByHolder.set(holderId, now);
              logger.warn(
                `[DEFEND] Skipping add_extra_life for holder token=${holderId}: poison=${holderPoison} > threshold=${poisonStopThreshold}`
              );
            }
          } else if (!chain.canAddExtraLife()) {
            if (!loggedMissingAddExtraLifeSupport) {
              logger.warn("[DEFEND] add_extra_life unavailable in ABI/session policy; skipping defend top-up");
              loggedMissingAddExtraLifeSupport = true;
            }
          } else if (
            !extraLifePermanentlyDisabled &&
            Date.now() >= extraLifeAllowanceFallbackUntil
          ) {
            const lastDefendAt = lastDefendExtraLifeAtByHolder.get(holderId) ?? 0;
            if (now - lastDefendAt >= cooldownMs) {
              const targetExtraLives = extraLifePotionCap;
              const currentExtraLives = Math.max(0, Math.floor(Number(holderRaw.extra_lives ?? 0)));
              const defendCap = targetExtraLives;
              if (currentExtraLives < defendCap) {
                const remainingToCap = defendCap - currentExtraLives;
                const extraLifePotions = Math.min(
                  extraLifePotionCap,
                  remainingToCap
                );
                try {
                  const result = await chain.addExtraLife(holderId, extraLifePotions);
                  lastDefendExtraLifeAtByHolder.set(holderId, now);
                  logger.info(
                    `[DEFEND] Added extra life to summit holder token=${holderId} extraLivesBefore=${currentExtraLives} cap=${defendCap} spend=${extraLifePotions} tx=${result.txHash}`
                  );
                  logger.event("extra_life_defend", {
                    tokenId: holderId,
                    extraLivesBefore: currentExtraLives,
                    cap: defendCap,
                    extraLifePotions,
                    txHash: result.txHash,
                  });
                } catch (extraLifeErr) {
                  const extraLifeMsg = decodeHexFelts(serializeError(extraLifeErr));
                  const extraLifeMsgLower = extraLifeMsg.toLowerCase();
                  logger.warn(
                    `[DEFEND] add_extra_life failed for holder token=${holderId}: ${extraLifeMsg.substring(0, 800)}`
                  );
                  const hasAllowanceError = extraLifeMsgLower.includes(
                    "erc20: insufficient allowance"
                  );
                  const hasBalanceError = extraLifeMsgLower.includes(
                    "erc20: insufficient balance"
                  );
                  if (hasAllowanceError || hasBalanceError) {
                    let allowanceRecovered = false;
                    if (hasAllowanceError) {
                      const approvalResult = await chain.ensurePotionAllowances({
                        reason: "defend_add_extra_life_allowance",
                      });
                      if (approvalResult.attempted && approvalResult.success) {
                        allowanceRecovered = true;
                        logger.warn(
                          `[DEFEND] Allowance refresh tx submitted (${approvalResult.txHash}); retrying extra-life next cycle`
                        );
                      } else if (!approvalResult.success) {
                        logger.warn(
                          `[DEFEND] Allowance refresh failed: ${(approvalResult.reason ?? "unknown").substring(0, 240)}`
                        );
                      }
                    }
                    if (hasBalanceError || !allowanceRecovered) {
                      extraLifePermanentlyDisabled = true;
                      logger.warn(
                        "[DEFEND] ERC20 allowance/balance insufficient — disabling extra-life usage for this run; continuing attacks without extra-life"
                      );
                    }
                  } else if (
                    extraLifeMsgLower.includes("session/not-registered") ||
                    extraLifeMsgLower.includes("session not registered")
                  ) {
                    extraLifeAllowanceFallbackUntil = Math.max(
                      extraLifeAllowanceFallbackUntil,
                      Date.now() + EXTRA_LIFE_ALLOWANCE_FALLBACK_MS
                    );
                    logger.warn(
                      `[DEFEND] Session missing add_extra_life permission — re-register session, pausing defend extra-life for ${Math.floor(EXTRA_LIFE_ALLOWANCE_FALLBACK_MS / 60_000)}m`
                    );
                  }
                  if (
                    hasAllowanceError &&
                    !hasBalanceError &&
                    !extraLifePermanentlyDisabled
                  ) {
                    extraLifeAllowanceFallbackUntil = Math.max(
                      extraLifeAllowanceFallbackUntil,
                      Date.now() + 3_000
                    );
                  }
                  if (
                    !hasAllowanceError &&
                    !hasBalanceError &&
                    !(
                      extraLifeMsgLower.includes("session/not-registered") ||
                      extraLifeMsgLower.includes("session not registered")
                    )
                  ) {
                    extraLifePermanentlyDisabled = true;
                    logger.warn(
                      `[DEFEND] add_extra_life failed with unhandled error category; disabling defend extra-life for this run`
                    );
                  }
                  lastDefendExtraLifeAtByHolder.set(holderId, now);
                }
              } else {
                lastDefendExtraLifeAtByHolder.set(holderId, now);
                logger.debug(
                  `[DEFEND] Holder token=${holderId} already at defend cap extraLives=${currentExtraLives} cap=${defendCap} poison=${holderPoison}`
                );
              }
            }
          }
        }
      }

      const action = engine.decide(snapshot);

      if (action.type === "wait") {
        logger.debug(`Wait: ${action.reason}`);
        // Use short-polling so WS holder-change events wake us up early
        const targetSleepMs = action.reason.startsWith("Cooldown")
          ? Math.max(250, Math.min(config.api.pollIntervalMs, Math.floor(config.strategy.attackCooldownMs / 2)))
          : config.api.pollIntervalMs;
        const sliceMs = 500;
        for (let waited = 0; waited < targetSleepMs; waited += sliceMs) {
          if (wsHolderChanged) {
            wsHolderChanged = false;
            logger.info("[WS] Holder changed — waking early from wait");
            break;
          }
          await sleep(Math.min(sliceMs, targetSleepMs - waited));
        }
        wsHolderChanged = false;
        consecutiveErrors = 0;
        continue;
      }

      if (action.type === "attack" && action.payload && action.beasts) {
        await executeAttackWithRetry(
          action,
          snapshot,
          api,
          chain,
          getOwnerBeastsCached,
          engine,
          config,
          logger,
          beastCooldownExclusions,
          ownerCache.liveMismatchFallback
        );
        consecutiveErrors = 0;
      }

      // Brief pause between cycles
      await sleep(Math.max(250, config.strategy.attackCooldownMs));
    } catch (err) {
      consecutiveErrors++;
      const mainErr = serializeError(err);
      logger.error(`Main loop error #${consecutiveErrors}: ${mainErr}`, {
        error: mainErr,
        stack: (err as Error).stack?.substring(0, 500),
      });

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors — pausing 60s`);
        await sleep(60_000);
        consecutiveErrors = 0;
      } else {
        await sleep(5_000);
      }
    }
  }
}

// ── Three-layer retry attack ─────────────────────────────────────
async function executeAttackWithRetry(
  action: import("./strategy/types.js").AgentAction,
  snapshot: GameSnapshot,
  api: SummitApiClient,
  chain: ChainClient,
  getOwnerBeastsCached: (force?: boolean) => Promise<OwnerBeastCacheState>,
  engine: StrategyEngine,
  config: import("./config.js").FenrirConfig,
  logger: Logger,
  beastCooldownExclusions: Map<number, number>,
  preferApiHealth = false,
): Promise<void> {
  const MAX_ATTEMPTS = 50;
  const OVER_CAP_REVIVAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const PREFER_API_PRECHECK_MAX_COOLDOWN_MS = 2 * 60 * 1000;
  const STALE_DEAD_RESELECT_LIMIT = 3;
  // Reduced from 4→2: each oscillation wastes an on-chain tx (gas).
  // 2 attempts is enough to detect budget mismatch before excluding.
  const REVIVAL_STUCK_RETRY_LIMIT = Math.max(
    2,
    Math.floor(Number(process.env.FENRIR_REVIVAL_STUCK_RETRY_LIMIT ?? 2))
  );
  const maxRevivalPotionsPerBeast = Math.min(
    HARD_MAX_REVIVAL_POTIONS_PER_BEAST,
    Math.max(0, Math.floor(config.strategy.maxRevivalPotionsPerBeast))
  );
  const revivalEnabledByConfig = config.strategy.useRevivalPotions;
  const requireAttackPotions =
    config.strategy.useAttackPotions && process.env.FENRIR_REQUIRE_ATTACK_POTIONS !== "0";
  const extraLifePotionCap = Math.max(
    0,
    Math.min(
      HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK,
      Math.floor(Number(config.strategy.extraLifePotionsPerAttack ?? 0))
    )
  );
  const isAttackPotionAllowanceFallbackActive = (): boolean =>
    Date.now() < attackPotionAllowanceFallbackUntil;
  const isExtraLifePotionAllowanceFallbackActive = (): boolean =>
    extraLifePermanentlyDisabled || Date.now() < extraLifeAllowanceFallbackUntil;
  const isRevivalAllowanceFallbackActive = (): boolean =>
    Date.now() < revivalAllowanceFallbackUntil;
  let excludedTokenIds = new Set<number>();
  let requiredRevivalPotions = new Map<number, number>();
  let forcedRevivalFloor = 0;
  let lastRevivalSignal: { beastId: number; needed: number } | null = null;
  let repeatedRevivalSignals = 0;
  let validationFailuresByToken = new Map<number, number>();
  let revivalBudgetConflictsByToken = new Map<number, number>();
  let staleDeadReselectCount = 0;
  let focusedRetryTokenId: number | null = null;
  let forceRevivalWhileAlive = false;
  let currentSnapshot = snapshot;
  let preferApiHealthMode = preferApiHealth;
  let lastForcedRevivalGateRefreshAt = 0;
  let lastOnchainAliveProbeAt = 0;
  let lastOnchainAliveCount: number | null = null;
  const ONCHAIN_ALIVE_PROBE_CACHE_MS = Math.max(
    500,
    Math.floor(Number(process.env.FENRIR_ONCHAIN_ALIVE_PROBE_CACHE_MS ?? 2_500))
  );
  const ONCHAIN_ALIVE_PROBE_TOKEN_LIMIT = Math.max(
    24,
    Math.floor(Number(process.env.FENRIR_ONCHAIN_ALIVE_PROBE_TOKEN_LIMIT ?? 48))
  );
  const ONCHAIN_ALIVE_SINGLE_VERIFY_ENABLED =
    process.env.FENRIR_ONCHAIN_ALIVE_SINGLE_VERIFY !== "0";
  const ONCHAIN_ALIVE_SINGLE_VERIFY_LIMIT = Math.max(
    1,
    Math.floor(Number(process.env.FENRIR_ONCHAIN_ALIVE_SINGLE_VERIFY_LIMIT ?? 8))
  );
  const revivalGateForceRefreshMs = Math.max(
    10_000,
    Math.floor(config.strategy.ownerBeastsRefreshMs / 2)
  );
  const isCurrentHolderToken = (tokenId: number): boolean =>
    Number(currentSnapshot.summitHolder?.token_id ?? 0) === Number(tokenId);
  const sweepExpiredCooldowns = () => {
    const nowMs = Date.now();
    for (const [tokenId, expiry] of beastCooldownExclusions) {
      if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
    }
  };
  const clearFocusedRetryToken = (tokenId?: number) => {
    if (tokenId === undefined || focusedRetryTokenId === tokenId) {
      focusedRetryTokenId = null;
      forceRevivalWhileAlive = false;
    }
  };
  const getPrecheckCooldownMs = (cooldownMs: number): number =>
    preferApiHealth
      ? Math.min(cooldownMs, PREFER_API_PRECHECK_MAX_COOLDOWN_MS)
      : cooldownMs;
  const excludeOverCapRevivalBeast = (beastId: number, needed: number, context: string) => {
    excludedTokenIds.add(beastId);
    requiredRevivalPotions.delete(beastId);
    clearFocusedRetryToken(beastId);
    const precheckContext =
      context.includes("live-precheck") ||
      context.includes("pre-budget") ||
      context.includes("onchain");
    const cooldownMs = precheckContext
      ? getPrecheckCooldownMs(OVER_CAP_REVIVAL_COOLDOWN_MS)
      : OVER_CAP_REVIVAL_COOLDOWN_MS;
    beastCooldownExclusions.set(beastId, Date.now() + cooldownMs);
    logger.info(
      `[L2] Beast ${beastId} needs ${needed} revival potions (> max ${maxRevivalPotionsPerBeast}) — excluding for ${Math.floor(
        cooldownMs / 60_000
      )}m (${context})`
    );
  };
  const streakTargetEnabled = Math.max(
    0,
    Math.min(10, config.strategy.attackStreakTarget)
  ) > 0;
  const beastNeedsStreakQuest = (beast: { quest_max_attack_streak?: number | null }): boolean =>
    streakTargetEnabled && Number(beast.quest_max_attack_streak ?? 0) !== 1;
  const excludeStaleDeadBeasts = (
    beastsToExclude: Array<{ token_id: number }>,
    cooldownMs: number
  ) => {
    const effectiveCooldownMs = getPrecheckCooldownMs(cooldownMs);
    if (effectiveCooldownMs !== cooldownMs && beastsToExclude.length > 0) {
      logger.debug(
        `[L0] API-health fallback reducing stale-dead exclusion cooldown ${Math.floor(cooldownMs / 60_000)}m→${Math.floor(effectiveCooldownMs / 60_000)}m`
      );
    }
    for (const beast of beastsToExclude) {
      excludedTokenIds.add(beast.token_id);
      requiredRevivalPotions.delete(beast.token_id);
      clearFocusedRetryToken(beast.token_id);
      beastCooldownExclusions.set(beast.token_id, Date.now() + effectiveCooldownMs);
    }
  };
  const getAliveCandidateCount = (beasts: EnrichedBeast[] = currentSnapshot.ourBeasts): number =>
    beasts.filter(
      (beast) =>
        beast.isAlive &&
        !excludedTokenIds.has(beast.token_id) &&
        !beastCooldownExclusions.has(beast.token_id) &&
        !isCurrentHolderToken(beast.token_id)
    ).length;
  const getAliveCandidateTokenIds = (
    beasts: EnrichedBeast[] = currentSnapshot.ourBeasts
  ): number[] => {
    const aliveIds: number[] = [];
    const deadIds: number[] = [];
    for (const beast of beasts) {
      if (
        excludedTokenIds.has(beast.token_id) ||
        beastCooldownExclusions.has(beast.token_id) ||
        isCurrentHolderToken(beast.token_id)
      ) {
        continue;
      }
      if (beast.isAlive) aliveIds.push(beast.token_id);
      else deadIds.push(beast.token_id);
    }
    // Probe IDs currently marked alive first so revival gate can short-circuit quickly.
    return aliveIds.concat(deadIds);
  };
  const getAliveCandidateCountOnchain = async (
    force = false,
    beasts: EnrichedBeast[] = currentSnapshot.ourBeasts
  ): Promise<number> => {
    const tokenIds = getAliveCandidateTokenIds(beasts);
    if (tokenIds.length === 0) {
      lastOnchainAliveProbeAt = Date.now();
      lastOnchainAliveCount = 0;
      return 0;
    }

    const now = Date.now();
    if (
      !force &&
      lastOnchainAliveCount !== null &&
      now - lastOnchainAliveProbeAt < ONCHAIN_ALIVE_PROBE_CACHE_MS
    ) {
      return lastOnchainAliveCount;
    }

    try {
      const maxProbeIds = Math.max(
        ONCHAIN_ALIVE_PROBE_TOKEN_LIMIT,
        force ? ONCHAIN_ALIVE_PROBE_TOKEN_LIMIT * 2 : ONCHAIN_ALIVE_PROBE_TOKEN_LIMIT
      );
      const probeIds = tokenIds.slice(0, maxProbeIds);
      const live = await chain.getLiveStats(probeIds);
      const beastByToken = new Map<number, EnrichedBeast>(
        beasts.map((beast) => [beast.token_id, beast])
      );
      let alive = 0;
      for (const tokenId of probeIds) {
        const stats = live.get(tokenId);
        const beast = beastByToken.get(tokenId);
        if (resolveEffectiveHealth(stats, beast) > 0) {
          alive += 1;
        }
      }
      if (alive === 0 && ONCHAIN_ALIVE_SINGLE_VERIFY_ENABLED) {
        const verifyIds = probeIds.slice(0, ONCHAIN_ALIVE_SINGLE_VERIFY_LIMIT);
        let singleAlive = 0;
        for (const tokenId of verifyIds) {
          try {
            const stat = await chain.getLiveStat(tokenId);
            const beast = beastByToken.get(tokenId);
            if (resolveEffectiveHealth(stat, beast) > 0) singleAlive += 1;
          } catch {
            // Keep batch result if single-token verify fails.
          }
        }
        if (singleAlive > 0) {
          alive = singleAlive;
          logger.warn(
            `[L0] On-chain batch probe reported alive=0, single-token verify found alive=${singleAlive}/${verifyIds.length}`
          );
        }
      }
      if (preferApiHealthMode && alive === 0) {
        const snapshotAlive = getAliveCandidateCount(beasts);
        if (snapshotAlive > 0) {
          alive = snapshotAlive;
          logger.warn(
            `[L0] API health fallback overriding on-chain alive=0 with snapshot alive=${snapshotAlive}`
          );
        }
      }
      lastOnchainAliveProbeAt = now;
      lastOnchainAliveCount = alive;
      if (probeIds.length < tokenIds.length) {
        logger.debug(
          `[L0] On-chain alive probe sampled ${probeIds.length}/${tokenIds.length} candidates (alive=${alive})`
        );
      }
      return alive;
    } catch (err) {
      const fallback = getAliveCandidateCount(beasts);
      lastOnchainAliveProbeAt = now;
      lastOnchainAliveCount = fallback;
      logger.debug(
        `[L0] On-chain alive probe failed, using snapshot alive=${fallback}: ${serializeError(err).substring(0, 180)}`
      );
      return fallback;
    }
  };
  const refreshSnapshotFromCache = async (force: boolean): Promise<EnrichedBeast[]> => {
    const ownerCache = await getOwnerBeastsCached(force);
    preferApiHealthMode = preferApiHealthMode || ownerCache.liveMismatchFallback;
    sweepExpiredCooldowns();
    let refreshedBeasts = ownerCache.enriched.filter(
      (beast) => !beastCooldownExclusions.has(beast.token_id)
    );
    if (ownerCache.enriched.length > 0 && refreshedBeasts.length === 0) {
      const aliveInSnapshot = ownerCache.enriched.filter((beast) => beast.isAlive).length;
      if (ownerCache.liveMismatchFallback || aliveInSnapshot > 0) {
        // Only clear expired exclusions — preserve valid cooldowns (death-mountain, etc.)
        sweepExpiredCooldowns();
        refreshedBeasts = ownerCache.enriched.filter(
          (beast) => !beastCooldownExclusions.has(beast.token_id)
        );
        logger.warn(
          `[L0] Refresh recovered from full cooldown exclusion (aliveInSnapshot=${aliveInSnapshot}, apiFallback=${ownerCache.liveMismatchFallback}, stillExcluded=${beastCooldownExclusions.size})`
        );
      }
    }
    currentSnapshot = {
      ...currentSnapshot,
      ourBeasts: refreshedBeasts,
      timestamp: Date.now(),
    };
    return refreshedBeasts;
  };
  const clearRevivalFocus = () => {
    clearFocusedRetryToken();
    requiredRevivalPotions = new Map();
    forcedRevivalFloor = 0;
    lastRevivalSignal = null;
    repeatedRevivalSignals = 0;
    revivalBudgetConflictsByToken = new Map();
  };
  const shouldYieldAfterStaleDeadReselect = (): boolean => {
    staleDeadReselectCount += 1;
    if (staleDeadReselectCount < STALE_DEAD_RESELECT_LIMIT) {
      return false;
    }
    logger.warn(
      `[L0] Stale-dead reselection limit reached (${staleDeadReselectCount}) — yielding to next poll cycle`
    );
    clearRevivalFocus();
    return true;
  };
  const ensureRevivalAllowed = async (): Promise<{ allowed: boolean; aliveCount: number }> => {
    sweepExpiredCooldowns();
    let aliveCount = await getAliveCandidateCountOnchain();
    if (aliveCount > 0) {
      return { allowed: false, aliveCount };
    }
    const now = Date.now();
    const shouldForceRefresh = now - lastForcedRevivalGateRefreshAt >= revivalGateForceRefreshMs;
    if (shouldForceRefresh) {
      try {
        const refreshedBeasts = await refreshSnapshotFromCache(true);
        aliveCount = await getAliveCandidateCountOnchain(true, refreshedBeasts);
        lastForcedRevivalGateRefreshAt = Date.now();
      } catch {
        // If refresh fails, continue with current best-effort snapshot.
      }
    }
    return { allowed: aliveCount === 0, aliveCount };
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let sentAttackPotionsThisAttempt = 0;
    let sentExtraLifePotionsThisAttempt = 0;
    let sentRevivalPotionsThisAttempt = 0;

    if (focusedRetryTokenId !== null && !forceRevivalWhileAlive) {
      const aliveAlternatives = await getAliveCandidateCountOnchain() > 0;
      if (aliveAlternatives) {
        logger.info(
          `[L0] Clearing focused revival beast ${focusedRetryTokenId} because alive attackers are available`
        );
        clearRevivalFocus();
      }
    }

    // Re-decide with current snapshot (excluding dead/failed beasts).
    // When a revival mismatch identifies a specific beast, pin retries to that
    // beast so we can converge on the exact potion budget instead of rotating.
    let filteredBeasts = currentSnapshot.ourBeasts.filter(
      (b) =>
        !excludedTokenIds.has(b.token_id) &&
        (focusedRetryTokenId === null || b.token_id === focusedRetryTokenId)
    );
    if (focusedRetryTokenId !== null && filteredBeasts.length === 0) {
      clearFocusedRetryToken();
      filteredBeasts = currentSnapshot.ourBeasts.filter(
        (b) => !excludedTokenIds.has(b.token_id)
      );
    }

    const freshSnapshot: GameSnapshot = {
      ...currentSnapshot,
      ourBeasts: filteredBeasts,
    };

    if (attempt > 1) {
      engine.allowImmediateAttack();
    }
    const freshAction = attempt === 1 ? action : engine.decide(freshSnapshot);

    if (freshAction.type !== "attack" || !freshAction.payload || !freshAction.beasts) {
      if (focusedRetryTokenId !== null && attempt < MAX_ATTEMPTS) {
        logger.info(
          `Retry ${attempt}: focused beast ${focusedRetryTokenId} unavailable (${freshAction.reason}) — clearing focus`
        );
        clearFocusedRetryToken();
        continue;
      }
      logger.info(`Retry ${attempt}: engine says wait — ${freshAction.reason}`);
      return;
    }
    const freshPayload = freshAction.payload as Record<string, unknown>;
    const forcedRevivalModeForAction = Boolean(freshPayload.forceRevivalMode);
    const getPayloadAttackTuples = (): Array<[number, number, number]> =>
      Array.isArray(freshPayload.attackingBeasts)
        ? (freshPayload.attackingBeasts as Array<[number, number, number]>)
        : [];
    const getPayloadAttackCountForToken = (tokenId: number): number => {
      const tuple = getPayloadAttackTuples().find(
        (entry) => Number(entry?.[0] ?? 0) === tokenId
      );
      return Math.max(1, Number(tuple?.[1] ?? 1));
    };
    const pruneActionAttackersByToken = (tokenIds: Set<number>): number => {
      if (tokenIds.size === 0) return 0;
      const currentBeasts = freshAction.beasts ?? [];
      const before = currentBeasts.length;
      freshAction.beasts = currentBeasts.filter(
        (beast) => !tokenIds.has(beast.token_id)
      );
      const tuples = getPayloadAttackTuples();
      (freshPayload as { attackingBeasts?: Array<[number, number, number]> }).attackingBeasts =
        tuples.filter((entry) => !tokenIds.has(Number(entry?.[0] ?? 0)));
      if (focusedRetryTokenId !== null && tokenIds.has(focusedRetryTokenId)) {
        clearFocusedRetryToken(focusedRetryTokenId);
      }
      return Math.max(0, before - freshAction.beasts.length);
    };
    if (attempt === 1) {
      const aliveBelow = Number(freshPayload.streakAuditAliveBelowTarget ?? -1);
      const deadBelow = Number(freshPayload.streakAuditDeadBelowTarget ?? -1);
      if (aliveBelow >= 0 || deadBelow >= 0) {
        logger.info(
          `[AUDIT] Streak execution plan aliveBelow10=${Math.max(0, aliveBelow)} deadBelow10=${Math.max(0, deadBelow)} forceRevival=${forcedRevivalModeForAction ? "yes" : "no"}`
        );
      }
    }

    const activeSnapshotBeasts = currentSnapshot.ourBeasts.filter(
      (b) =>
        !excludedTokenIds.has(b.token_id) &&
        !beastCooldownExclusions.has(b.token_id) &&
        !isCurrentHolderToken(b.token_id)
    );
    let revivalModeForAttempt =
      revivalEnabledByConfig &&
      (forcedRevivalModeForAction ||
        forceRevivalWhileAlive ||
        (activeSnapshotBeasts.length > 0 && activeSnapshotBeasts.every((b) => !b.isAlive)));
    let liveStatsForAttempt: Awaited<ReturnType<ChainClient["getLiveStats"]>> | null = null;

    try {
      if (!revivalEnabledByConfig) {
        // Hard stop: never spend revives when config disables them.
        if (
          focusedRetryTokenId !== null ||
          requiredRevivalPotions.size > 0 ||
          forcedRevivalFloor > 0
        ) {
          clearRevivalFocus();
        }
        revivalModeForAttempt = false;
      }

      if (
        preferApiHealthMode &&
        revivalModeForAttempt &&
        !forcedRevivalModeForAction &&
        !forceRevivalWhileAlive
      ) {
        revivalModeForAttempt = false;
        clearRevivalFocus();
        logger.info(
          "[L0] API health fallback active — suppressing revival mode while alive attackers are available in API snapshot"
        );
      }

      if (revivalModeForAttempt) {
        if (forcedRevivalModeForAction) {
          logger.info("[L0] Forced revival mode active — reviving dead streak beast by policy");
        } else if (forceRevivalWhileAlive) {
          logger.info("[L0] Focused revival mode active — reviving dead beast with pending streak quest");
        } else {
          const revivalGate = await ensureRevivalAllowed();
          if (!revivalGate.allowed) {
            logger.info(
              `[L0] Revival blocked: ${revivalGate.aliveCount} alive beasts available — retrying without revival`
            );
            clearRevivalFocus();
            continue;
          }
        }
      }

      if (!revivalModeForAttempt && freshAction.beasts.length > 0) {
        try {
          const live = await chain.getLiveStats(freshAction.beasts.map((b) => b.token_id));
          liveStatsForAttempt = live;
            let staleDead = freshAction.beasts.filter((b) => {
              const stats = live.get(b.token_id);
              return resolveEffectiveHealth(stats, b) <= 0;
            });
            if (preferApiHealthMode && staleDead.length > 0) {
              logger.warn(
                `[L0] API health fallback active — ignoring on-chain stale-dead precheck for ${staleDead.length}/${freshAction.beasts.length} selected attackers`
              );
              staleDead = [];
              liveStatsForAttempt = null;
            }
            if (staleDead.length > 0) {
              if (staleDead.length < freshAction.beasts.length) {
                const staleDeadIds = new Set(staleDead.map((beast) => beast.token_id));
                const pruned = pruneActionAttackersByToken(staleDeadIds);
                if (pruned > 0 && freshAction.beasts.length > 0) {
                  logger.info(
                    `[L0] Pruned ${pruned} dead attackers from this submission — attacking with ${freshAction.beasts.length} alive beasts`
                  );
                  staleDead = [];
                }
              }
            }
            if (staleDead.length > 0) {
              if (staleDead.length === freshAction.beasts.length) {
                const aliveAlternativesOnchain = await getAliveCandidateCountOnchain(true);
                if (aliveAlternativesOnchain > 0) {
                  try {
                    await refreshSnapshotFromCache(true);
                  } catch {
                    // Fall back to local snapshot if forced refresh fails.
                  }

                  excludeStaleDeadBeasts(staleDead, 6 * 60 * 60 * 1000);
                  logger.info(
                    `[L0] Selected attackers are dead on-chain, but ${aliveAlternativesOnchain} alive beasts remain — skipping revive and restarting selection`
                  );
                  if (shouldYieldAfterStaleDeadReselect()) {
                    return;
                  }
                  continue;
                }

                const deadBelowStreakCandidates = staleDead.filter((beast) =>
                  beastNeedsStreakQuest(beast)
                );
                if (revivalEnabledByConfig && deadBelowStreakCandidates.length > 0) {
                  const eligibleDeadBelowStreak = deadBelowStreakCandidates.filter((beast) => {
                  const liveState = live.get(beast.token_id);
                  const attackCountForBeast = getPayloadAttackCountForToken(beast.token_id);
                  const required = estimateDeadBeastRevivalBudget(
                    Number(liveState?.revival_count ?? beast.revival_count ?? 0),
                    attackCountForBeast
                  );
                  if (required > maxRevivalPotionsPerBeast) {
                    excludeOverCapRevivalBeast(
                      beast.token_id,
                      required,
                      "live-precheck/streak"
                    );
                    return false;
                  }
                  return true;
                });
                if (eligibleDeadBelowStreak.length === 0) {
                  logger.info(
                    `[L0] All dead streak candidates exceed revival cap ${maxRevivalPotionsPerBeast} — rotating attackers`
                  );
                  continue;
                }
                const focusCandidate = eligibleDeadBelowStreak[0]!;
                const focusId = focusCandidate.token_id;
                const attackCountForFocus = getPayloadAttackCountForToken(focusId);
                const estimatedRequired = Math.min(
                  maxRevivalPotionsPerBeast,
                  estimateDeadBeastRevivalBudget(
                    Number(live.get(focusId)?.revival_count ?? focusCandidate.revival_count ?? 0),
                    attackCountForFocus
                  )
                );
                const knownRequired = Math.max(
                  0,
                  Number(requiredRevivalPotions.get(focusId) ?? 0)
                );
                const focusRequired = Math.min(
                  maxRevivalPotionsPerBeast,
                  Math.max(estimatedRequired, knownRequired)
                );
                requiredRevivalPotions.set(focusId, focusRequired);
                focusedRetryTokenId = focusId;
                forceRevivalWhileAlive = true;
                  logger.info(
                    `[L0] Selected attackers are dead on-chain and streak quest is pending — forcing focused revival for beast ${focusId} (revival=${focusRequired})`
                  );
                  continue;
                }

                try {
                  const refreshedBeasts = await refreshSnapshotFromCache(false);
                  const refreshedAliveCount = await getAliveCandidateCountOnchain(
                    true,
                    refreshedBeasts
                  );

                if (refreshedAliveCount > 0) {
                  excludeStaleDeadBeasts(staleDead, 6 * 60 * 60 * 1000);
                  logger.info(
                    `[L0] Selected attackers are dead on-chain, refreshed cache found ${refreshedAliveCount} alive beasts — skipping revive and restarting selection`
                  );
                  if (shouldYieldAfterStaleDeadReselect()) {
                    return;
                  }
                  continue;
                }
              } catch {
                // If refresh fails, continue to controlled revival fallback.
              }

              const revivalGate = await ensureRevivalAllowed();
              if (!revivalGate.allowed) {
                excludeStaleDeadBeasts(staleDead, 6 * 60 * 60 * 1000);
                logger.info(
                  `[L0] Revival blocked after live precheck: ${revivalGate.aliveCount} alive beasts available — rotating attackers`
                );
                clearRevivalFocus();
                continue;
              }

              if (!revivalEnabledByConfig) {
                excludeStaleDeadBeasts(staleDead, 12 * 60 * 60 * 1000);
                logger.info(
                  "[L0] All selected attackers are dead on-chain, but revival is disabled — excluding and rotating attackers"
                );
                clearRevivalFocus();
                continue;
              }

              revivalModeForAttempt = true;
              forceRevivalWhileAlive = false;
              const eligibleStaleDead = staleDead.filter((beast) => {
                const liveState = live.get(beast.token_id);
                const attackCountForBeast = getPayloadAttackCountForToken(beast.token_id);
                const required = estimateDeadBeastRevivalBudget(
                  Number(liveState?.revival_count ?? beast.revival_count ?? 0),
                  attackCountForBeast
                );
                if (required > maxRevivalPotionsPerBeast) {
                  excludeOverCapRevivalBeast(
                    beast.token_id,
                    required,
                    "live-precheck/all-dead"
                  );
                  return false;
                }
                return true;
              });
              if (eligibleStaleDead.length === 0) {
                logger.info(
                  `[L0] All selected dead attackers exceed revival cap ${maxRevivalPotionsPerBeast} — rotating attackers`
                );
                clearRevivalFocus();
                continue;
              }
              const focusCandidate = eligibleStaleDead[0]!;
              const focusId = focusCandidate.token_id;
              const attackCountForFocus = getPayloadAttackCountForToken(focusId);
              const estimatedRequired = Math.min(
                maxRevivalPotionsPerBeast,
                estimateDeadBeastRevivalBudget(
                  Number(
                    live.get(focusId)?.revival_count ?? focusCandidate.revival_count ?? 0
                  ),
                  attackCountForFocus
                )
              );
              const knownRequired = Math.max(
                0,
                Number(requiredRevivalPotions.get(focusId) ?? 0)
              );
              const focusRequired = Math.min(
                maxRevivalPotionsPerBeast,
                Math.max(estimatedRequired, knownRequired)
              );
              if (focusedRetryTokenId !== focusId) {
                requiredRevivalPotions.set(focusId, focusRequired);
                focusedRetryTokenId = focusId;
                forceRevivalWhileAlive = false;
                logger.info(
                  `[L0] All selected attackers are dead on-chain — switching to revival mode and focusing beast ${focusId} (revival=${focusRequired})`
                );
                continue;
              }
              if (!requiredRevivalPotions.has(focusId)) {
                requiredRevivalPotions.set(focusId, focusRequired);
              }
              logger.info(
                `[L0] All selected attackers are dead on-chain — switching to revival mode (focused beast ${focusId})`
              );
            } else {
              excludeStaleDeadBeasts(staleDead, 12 * 60 * 60 * 1000);
              logger.info(
                `[L0] Filtered ${staleDead.length} stale-dead beasts via live precheck — rotating attackers`
              );
              continue;
            }
          }
        } catch {
          // Continue without precheck if live stats are temporarily unavailable.
        }
      }

      // Even in revival mode, fetch live state for selected attackers so revival
      // budget is computed from current on-chain health instead of stale snapshots.
      if (revivalModeForAttempt && freshAction.beasts.length > 0 && liveStatsForAttempt === null) {
        try {
          liveStatsForAttempt = await chain.getLiveStats(
            freshAction.beasts.map((b) => b.token_id)
          );
        } catch {
          // Keep retrying with snapshot data if live check is temporarily unavailable.
        }
      }

      if (!revivalEnabledByConfig && !revivalModeForAttempt && freshAction.beasts.length > 0) {
        if (preferApiHealthMode) {
          logger.warn(
            "[L0] API health fallback active — skipping alive-only submit guard and trusting API-selected attackers"
          );
        } else {
          if (liveStatsForAttempt === null) {
            try {
              liveStatsForAttempt = await chain.getLiveStats(
                freshAction.beasts.map((b) => b.token_id)
              );
            } catch {
              // Best effort fallback; revert handler still excludes dead beasts.
            }
          }
          if (liveStatsForAttempt) {
            let deadAtSubmit = freshAction.beasts.filter((beast) => {
              const stats = liveStatsForAttempt?.get(beast.token_id);
              return resolveEffectiveHealth(stats, beast) <= 0;
            });
            if (deadAtSubmit.length > 0 && ONCHAIN_ALIVE_SINGLE_VERIFY_ENABLED) {
              let recoveredAlive = 0;
              for (const beast of deadAtSubmit) {
                try {
                  const single = await chain.getLiveStat(beast.token_id);
                  if (single) {
                    liveStatsForAttempt.set(beast.token_id, single);
                  }
                  if (resolveEffectiveHealth(single, beast) > 0) {
                    recoveredAlive += 1;
                  }
                } catch {
                  // Keep batch value if single-token verify fails.
                }
              }
              if (recoveredAlive > 0) {
                const initialDeadCount = deadAtSubmit.length;
                deadAtSubmit = freshAction.beasts.filter((beast) => {
                  const stats = liveStatsForAttempt?.get(beast.token_id);
                  return resolveEffectiveHealth(stats, beast) <= 0;
                });
                logger.warn(
                  `[L0] Submit single-token verify recovered alive=${recoveredAlive}/${initialDeadCount} from batch-dead attackers`
                );
              }
            }
            if (deadAtSubmit.length === freshAction.beasts.length) {
              excludeStaleDeadBeasts(deadAtSubmit, 12 * 60 * 60 * 1000);
              logger.info(
                "[L0] Submit guard found all selected attackers dead while revival is disabled — rotating attackers"
              );
              await sleep(Math.max(500, Math.min(2_000, config.api.pollIntervalMs)));
              return;
            }
            if (deadAtSubmit.length > 0) {
              const deadIds = new Set(deadAtSubmit.map((beast) => beast.token_id));
              const pruned = pruneActionAttackersByToken(deadIds);
              if (pruned > 0) {
                logger.info(
                  `[L0] Submit guard pruned ${pruned} dead attackers — keeping alive-only attack payload`
                );
              }
            }
          }
        }
      }

      const basePayload = freshAction.payload as any;
      const baseAttackingBeasts = Array.isArray(basePayload.attackingBeasts)
        ? basePayload.attackingBeasts
        : [];
      const strictSingleAttacker = Math.max(1, config.strategy.maxBeastsPerAttack) === 1;
      const selectedBeasts = strictSingleAttacker
        ? freshAction.beasts.slice(0, 1)
        : freshAction.beasts;
      const disableAttackPotionSpendForAttempt =
        isAttackPotionAllowanceFallbackActive();
      const disableExtraLifePotionSpendForAttempt =
        isExtraLifePotionAllowanceFallbackActive();
      if (requireAttackPotions && disableAttackPotionSpendForAttempt) {
        const remainingMs = Math.max(0, attackPotionAllowanceFallbackUntil - Date.now());
        logger.warn(
          `[L2A] Attack potion fallback active — blocking attack (no-potion attacks disabled) for ${Math.ceil(remainingMs / 1000)}s`
        );
        await sleep(Math.max(1_000, Math.min(10_000, remainingMs || 1_000)));
        return;
      }

      const tuplesByToken = new Map<number, [number, number, number]>();
      const selectedTupleSource = strictSingleAttacker
        ? baseAttackingBeasts.slice(0, 1)
        : baseAttackingBeasts;
      for (const tuple of selectedTupleSource) {
        const tokenId = Number(tuple?.[0] ?? 0);
        if (!tokenId) continue;
        tuplesByToken.set(tokenId, [
          tokenId,
          Number(tuple?.[1] ?? 1),
          Number(tuple?.[2] ?? 0),
        ]);
      }

      const attackingBeasts = selectedBeasts.map((b) => {
        const tuple = tuplesByToken.get(b.token_id);
        const baseAttackCount = Math.max(1, Number(tuple?.[1] ?? 1));
        const knownRevivalBudget = Math.max(
          0,
          Number(requiredRevivalPotions.get(b.token_id) ?? 0)
        );
        const forceSingleAttackCount =
          revivalModeForAttempt &&
          (focusedRetryTokenId === b.token_id || forceRevivalWhileAlive) &&
          knownRevivalBudget <= 0;
        const attackCount = forceSingleAttackCount ? 1 : baseAttackCount;
        const tupleAttackPotions = Math.max(0, Number(tuple?.[2] ?? 0));
        const configuredAttackPotions = Math.max(
          1,
          Math.floor(config.strategy.attackPotionsPerBeast)
        );
        const scoredAttackPotions = requireAttackPotions
          ? configuredAttackPotions
          : tupleAttackPotions;
        const effectiveAttackPotions = disableAttackPotionSpendForAttempt
          ? 0
          : scoredAttackPotions;
        return [b.token_id, attackCount, effectiveAttackPotions] as [number, number, number];
      });

      if (requireAttackPotions) {
        const zeroPotionAttackers = attackingBeasts
          .filter(([, , attackPotions]) => Math.max(0, Number(attackPotions ?? 0)) === 0)
          .map(([tokenId]) => tokenId);
        if (zeroPotionAttackers.length > 0) {
          logger.warn(
            `[L0] Blocking attack: attackers missing attack potions tokenIds=${zeroPotionAttackers.join(",")}`
          );
          await sleep(Math.max(500, config.api.pollIntervalMs));
          return;
        }
      }

      // Pre-budget revival potions when dead beasts are selected so we don't
      // waste the first attempt with revivalPotions=0.
      let excludedOverCapDuringPrebudget = 0;
      if (revivalModeForAttempt) {
        for (const b of selectedBeasts) {
          const tuple = tuplesByToken.get(b.token_id);
          const attackCountForBeast = Math.max(1, Number(tuple?.[1] ?? 1));
          const liveState = liveStatsForAttempt?.get(b.token_id);
          const isDead = resolveEffectiveHealth(liveState, b) <= 0;
          if (!isDead) continue;
          const revivalCount = Math.max(
            0,
            Number(liveState?.revival_count ?? b.revival_count ?? 0)
          );
          const estimatedRaw = estimateDeadBeastRevivalBudget(
            revivalCount,
            attackCountForBeast
          );
          if (estimatedRaw > maxRevivalPotionsPerBeast) {
            excludeOverCapRevivalBeast(
              b.token_id,
              estimatedRaw,
              "pre-budget/revival-mode"
            );
            excludedOverCapDuringPrebudget += 1;
            continue;
          }
          const estimated = Math.min(maxRevivalPotionsPerBeast, estimatedRaw);
          if (!requiredRevivalPotions.has(b.token_id)) {
            requiredRevivalPotions.set(b.token_id, estimated);
          }
        }
        if (excludedOverCapDuringPrebudget > 0) {
          logger.info(
            `[L0] Excluded ${excludedOverCapDuringPrebudget} over-cap dead beasts during pre-budget — recomputing attack set`
          );
          continue;
        }
      }

      const revivalPotions = revivalModeForAttempt
        ? selectedBeasts.reduce(
            (sum, b) => sum + (requiredRevivalPotions.get(b.token_id) ?? 0),
            0
          )
        : 0;
      const effectiveRevivalPotions = revivalModeForAttempt
        ? Math.max(revivalPotions, forcedRevivalFloor)
        : 0;
      const targetExtraLives = extraLifePotionCap;
      const baseExtraLifePotions = Math.max(
        0,
        Math.floor(Number(basePayload.extraLifePotions ?? 0))
      );
      const primaryAttacker = freshAction.beasts[0];
      const primaryAttackerLive = primaryAttacker
        ? liveStatsForAttempt?.get(primaryAttacker.token_id)
        : null;
      const primaryExtraLives = Math.max(
        0,
        Math.floor(
          Number(primaryAttackerLive?.extra_lives ?? primaryAttacker?.extra_lives ?? 0)
        )
      );
      const remainingPrimaryExtraLives = Math.max(0, targetExtraLives - primaryExtraLives);
      const cappedExtraLifePotions = Math.min(
        baseExtraLifePotions,
        remainingPrimaryExtraLives,
        extraLifePotionCap
      );
      const effectiveExtraLifePotions = disableExtraLifePotionSpendForAttempt
        ? 0
        : cappedExtraLifePotions;
      sentAttackPotionsThisAttempt = attackingBeasts.reduce(
        (sum, [, , attackPotions]) => sum + Math.max(0, Number(attackPotions ?? 0)),
        0
      );
      sentExtraLifePotionsThisAttempt = effectiveExtraLifePotions;
      sentRevivalPotionsThisAttempt = effectiveRevivalPotions;

      if (effectiveRevivalPotions > 0 && isRevivalAllowanceFallbackActive()) {
        const remainingMs = Math.max(0, revivalAllowanceFallbackUntil - Date.now());
        logger.warn(
          `[L2R] Revival allowance fallback active — pausing revival attacks for ${Math.ceil(
            remainingMs / 1000
          )}s`
        );
        await sleep(Math.max(1_000, Math.min(10_000, remainingMs || 1_000)));
        return;
      }

      const payloadForAttempt = {
        ...basePayload,
        attackingBeasts,
        revivalPotions: effectiveRevivalPotions,
        extraLifePotions: effectiveExtraLifePotions,
      };

      const expectedDefenderTokenId = Math.max(
        0,
        Number(basePayload.defendingBeastTokenId ?? 0)
      );
      if (expectedDefenderTokenId > 0) {
        try {
          const latestHolder = await chain.getSummitHolderApiShape();
          const latestHolderId = Number(latestHolder?.token_id ?? 0);
          if (latestHolderId > 0 && latestHolderId !== expectedDefenderTokenId) {
            currentSnapshot = {
              ...currentSnapshot,
              summitHolder: latestHolder ? enrichBeast(latestHolder) : currentSnapshot.summitHolder,
              timestamp: Date.now(),
            };
            logger.info(
              `[L0] Holder changed before submit expected=${expectedDefenderTokenId} actual=${latestHolderId} — reselecting attackers`
            );
            continue;
          }
        } catch {
          // Best effort: continue with existing snapshot if holder preflight fails.
        }
      }

      logger.info(`Attack attempt ${attempt}/${MAX_ATTEMPTS}: ${selectedBeasts.length} beasts, revivalPotions=${effectiveRevivalPotions}`, {
        profileId: typeof basePayload.profileId === "string" ? basePayload.profileId : null,
        attackPotionAllowanceFallback: disableAttackPotionSpendForAttempt,
        extraLifePotionAllowanceFallback: disableExtraLifePotionSpendForAttempt,
        attackers: selectedBeasts.map((b, idx) => {
          const [tokenId, atkCount, atkPots] = attackingBeasts[idx] ?? [b.token_id, 1, 0];
          return {
            tokenId,
            type: b.type,
            typeAdvantage: b.typeAdvantage,
            atkCount,
            atkPots,
            revivalRequired: requiredRevivalPotions.get(tokenId) ?? 0,
          };
        }),
      });
      const result = await chain.attack(payloadForAttempt);
      const profileId =
        typeof (payloadForAttempt as { profileId?: unknown }).profileId === "string"
          ? String((payloadForAttempt as { profileId?: unknown }).profileId)
          : undefined;
      const attackCountPerBeast = Number(attackingBeasts[0]?.[1] ?? 1);
      const attackPotionsPerBeast = Number(attackingBeasts[0]?.[2] ?? 0);
      const holderAfter = await chain.getSummitHolderApiShape();
      const captured = holderAfter
        ? freshAction.beasts.some((b) => b.token_id === holderAfter.token_id)
        : false;
      engine.recordAttackOutcome({
        profileId,
        captured,
        attackerCount: selectedBeasts.length,
        attackCountPerBeast,
        attackPotionsPerBeast,
        revivalPotions,
        txHash: result.txHash,
      });

      // SUCCESS!
      logger.info(
        `ATTACK SUCCESS! tx=${result.txHash} captured=${captured ? "yes" : "no"} profile=${profileId ?? "n/a"}`
      );
      logger.event("attack_success", {
        txHash: result.txHash,
        attempt,
        beastCount: selectedBeasts.length,
        beasts: selectedBeasts.map((b) => ({
          id: b.token_id,
          name: b.fullName,
          type: b.type,
          score: b.score,
        })),
        defender: currentSnapshot.summitHolder
          ? {
              id: currentSnapshot.summitHolder.token_id,
              name: currentSnapshot.summitHolder.fullName,
              type: currentSnapshot.summitHolder.type,
            }
          : null,
      });
      logger.event("attack_outcome", {
        txHash: result.txHash,
        profileId: profileId ?? "n/a",
        captured,
        attackerCount: selectedBeasts.length,
        attackCountPerBeast,
        attackPotionsPerBeast,
        revivalPotions,
        holderTokenIdAfter: holderAfter?.token_id ?? null,
      });
      return;
    } catch (err) {
      const errStr = serializeError(err);
      const decodedErr = decodeHexFelts(errStr);

      logger.debug(`[${attempt}] err: ${decodedErr.substring(0, 800)}`);

      // Combine raw + decoded for regex matching
      const matchStr = errStr + " " + decodedErr;

      if (
        matchStr.includes("ERC20: insufficient allowance") ||
        matchStr.includes("ERC20: insufficient balance")
      ) {
        const hasInsufficientAllowance = matchStr.includes("ERC20: insufficient allowance");
        const attackFallbackWasActive = isAttackPotionAllowanceFallbackActive();
        const extraLifeFallbackWasActive = isExtraLifePotionAllowanceFallbackActive();
        const revivalFallbackWasActive = isRevivalAllowanceFallbackActive();
        const sentAttackPotions = sentAttackPotionsThisAttempt > 0;
        const sentExtraLifePotions = sentExtraLifePotionsThisAttempt > 0;

        if (hasInsufficientAllowance) {
          const approvalResult = await chain.ensurePotionAllowances({
            reason: "attack_insufficient_allowance",
          });
          if (approvalResult.attempted && approvalResult.success) {
            logger.warn(
              `[L2A] Refreshed token allowances tx=${approvalResult.txHash}; retrying attack`
            );
            await sleep(350);
            continue;
          }
          if (!approvalResult.success) {
            logger.warn(
              `[L2A] Allowance refresh failed: ${(approvalResult.reason ?? "unknown").substring(0, 240)}`
            );
          }
        }

        // Mixed spends are ambiguous. Disable extra-life first, then only disable
        // attack potions if allowance/balance errors persist without extra-life.
        if (
          sentAttackPotions &&
          sentExtraLifePotions &&
          !extraLifePermanentlyDisabled &&
          !extraLifeFallbackWasActive
        ) {
          extraLifePermanentlyDisabled = true;
          logger.warn(
            "[L2A] ERC20 allowance/balance insufficient during mixed spend — disabling extra-life first and retrying attack potions"
          );
          await sleep(250);
          continue;
        }

        // In strict session mode we still apply the safe extra-life fallback above first.
        // If allowance issues persist after that, pause and request re-registration.
        if (hasInsufficientAllowance && enforceSessionReRegistrationOnAllowance) {
          markSessionReRegistrationRequired(
            logger,
            "ERC20 insufficient allowance detected"
          );
          await sleep(Math.max(1_000, config.api.pollIntervalMs));
          return;
        }

        if (sentAttackPotions && !attackFallbackWasActive) {
          attackPotionAllowanceFallbackUntil = Math.max(
            attackPotionAllowanceFallbackUntil,
            Date.now() + ATTACK_POTION_ALLOWANCE_FALLBACK_MS
          );
          logger.warn(
            `[L2A] ERC20 allowance/balance insufficient — disabling attack potions for ${Math.floor(ATTACK_POTION_ALLOWANCE_FALLBACK_MS / 60_000)}m`
          );
        } else if (sentExtraLifePotions && !extraLifeFallbackWasActive) {
          extraLifePermanentlyDisabled = true;
          logger.warn(
            "[L2A] ERC20 allowance/balance insufficient — disabling extra-life potions for this run; continuing attacks without extra-life"
          );
        } else if (!sentAttackPotions && !sentExtraLifePotions) {
          if (sentRevivalPotionsThisAttempt > 0) {
            revivalAllowanceFallbackUntil = Math.max(
              revivalAllowanceFallbackUntil,
              Date.now() + REVIVAL_ALLOWANCE_FALLBACK_MS
            );
            if (!revivalFallbackWasActive) {
              logger.warn(
                `[L2R] Allowance error persists with only revival spend — pausing revival attacks for ${Math.floor(REVIVAL_ALLOWANCE_FALLBACK_MS / 60_000)}m`
              );
            }
            return;
          }
          logger.warn(
            "[L2A] Allowance error persists with attack/extra-life potions disabled"
          );
        }
        await sleep(250);
        continue;
      }

      // ── Layer 1: Summit holder changed ──────────────────────────
      if (
        matchStr.includes("not on summit") ||
        matchStr.includes("beast is not the summit") ||
        matchStr.includes("holder changed") ||
        matchStr.includes("not the summit beast") ||
        matchStr.includes("can only attack beast on summit")
      ) {
        logger.info(`[L1] Summit holder changed — refreshing snapshot`);

        const [newHolder, ownerCache] = await Promise.all([
          chain.getSummitHolderApiShape(),
          getOwnerBeastsCached(false),
        ]);
        preferApiHealthMode = preferApiHealthMode || ownerCache.liveMismatchFallback;
        const nowMs = Date.now();
        for (const [tokenId, expiry] of beastCooldownExclusions) {
          if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
        }
        const filteredBeasts = ownerCache.enriched.filter(
          (b) => !beastCooldownExclusions.has(b.token_id)
        );

        currentSnapshot = {
          summitHolder: newHolder ? enrichBeast(newHolder) : null,
          ourBeasts: filteredBeasts,
          timestamp: Date.now(),
        };

        if (!currentSnapshot.summitHolder) {
          logger.info("[L1] Summit now empty — waiting");
          return;
        }

        excludedTokenIds = new Set(); // Reset exclusions for new defender
        requiredRevivalPotions = new Map();
        forcedRevivalFloor = 0;
        clearFocusedRetryToken();
        lastRevivalSignal = null;
        repeatedRevivalSignals = 0;
        validationFailuresByToken = new Map();
        revivalBudgetConflictsByToken = new Map();
        continue;
      }

      // ── Layer 1.5: We are accidentally attacking our own summit holder ──
      if (matchStr.includes("attacking own beast")) {
        logger.info("[L1.5] Revert indicates attacking own beast — forcing ownership resync");

        const [newHolder, ownerCache] = await Promise.all([
          chain.getSummitHolderApiShape(),
          getOwnerBeastsCached(true),
        ]);
        preferApiHealthMode = preferApiHealthMode || ownerCache.liveMismatchFallback;
        const nowMs = Date.now();
        for (const [tokenId, expiry] of beastCooldownExclusions) {
          if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
        }
        const filteredBeasts = ownerCache.enriched.filter(
          (b) => !beastCooldownExclusions.has(b.token_id)
        );
        currentSnapshot = {
          summitHolder: newHolder ? enrichBeast(newHolder) : null,
          ourBeasts: filteredBeasts,
          timestamp: Date.now(),
        };

        excludedTokenIds = new Set();
        requiredRevivalPotions = new Map();
        forcedRevivalFloor = 0;
        clearFocusedRetryToken();
        lastRevivalSignal = null;
        repeatedRevivalSignals = 0;
        validationFailuresByToken = new Map();
        revivalBudgetConflictsByToken = new Map();

        const holderId = currentSnapshot.summitHolder?.token_id ?? 0;
        const weOwnHolder =
          holderId > 0 && currentSnapshot.ourBeasts.some((b) => b.token_id === holderId);
        if (weOwnHolder) {
          engine.blockHoldRotation(holderId);
          logger.info(
            `[L1.5] Ownership resync confirms we hold summit token=${holderId} — yielding to main loop`
          );
          return;
        }
        continue;
      }

      // ── Layer 2: Beast-specific error (revival mismatch) ────────
      if (
        matchStr.includes("revival") ||
        matchStr.includes("already dead") ||
        matchStr.includes("beast not alive") ||
        matchStr.includes("killed in the last day") ||
        matchStr.includes("cooldown") ||
        matchStr.includes("health") ||
        matchStr.includes("not alive") ||
        matchStr.includes("invalid beast")
      ) {
        let handledKilledInDay = false;
        const killedInDayMatch = matchStr.match(/beast\s+(\d+)\s+has been killed in the last day/i);
        if (killedInDayMatch) {
          const failedId = parseInt(killedInDayMatch[1]!, 10);
          excludedTokenIds.add(failedId);
          requiredRevivalPotions.delete(failedId);
          clearFocusedRetryToken(failedId);
          beastCooldownExclusions.set(failedId, Date.now() + 24 * 60 * 60 * 1000);
          logger.info(`[L2] Beast ${failedId} on death-mountain cooldown — excluding for 24h`);
          handledKilledInDay = true;
        } else if (matchStr.includes("killed in the last day") && freshAction.beasts.length === 1) {
          const failedId = freshAction.beasts[0]!.token_id;
          excludedTokenIds.add(failedId);
          requiredRevivalPotions.delete(failedId);
          clearFocusedRetryToken(failedId);
          beastCooldownExclusions.set(failedId, Date.now() + 24 * 60 * 60 * 1000);
          logger.info(`[L2] Beast ${failedId} on death-mountain cooldown — excluding for 24h`);
          handledKilledInDay = true;
        }

        if (matchStr.includes("Unused revival potions") && revivalModeForAttempt) {
          if (freshAction.beasts.length === 1) {
            const beastId = freshAction.beasts[0]!.token_id;
            const conflicts = (revivalBudgetConflictsByToken.get(beastId) ?? 0) + 1;
            revivalBudgetConflictsByToken.set(beastId, conflicts);
            if (conflicts >= REVIVAL_STUCK_RETRY_LIMIT) {
              excludedTokenIds.add(beastId);
              requiredRevivalPotions.delete(beastId);
              clearFocusedRetryToken(beastId);
              beastCooldownExclusions.set(beastId, Date.now() + 6 * 60 * 60 * 1000);
              lastRevivalSignal = null;
              repeatedRevivalSignals = 0;
              logger.info(
                `[L2] Beast ${beastId} revival budget conflict ${conflicts}x — excluding for 6h`
              );
              continue;
            }
            const current = requiredRevivalPotions.get(beastId) ?? 0;
            const step = Math.max(1, Math.ceil(current * 0.1));
            const lowered = Math.min(
              maxRevivalPotionsPerBeast,
              Math.max(0, current - step)
            );
            requiredRevivalPotions.set(beastId, lowered);
            forcedRevivalFloor = Math.min(forcedRevivalFloor, lowered);
            focusedRetryTokenId = beastId;
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(
              `[L2] Unused revival potions for beast ${beastId} — lowering budget ${current}→${lowered}`
            );
          } else {
            // Large mixed batches frequently over-provision revival potions. Collapse
            // to a single focused beast so required revival can converge quickly.
            const focusCandidate =
              freshAction.beasts.find(
                (beast) => (requiredRevivalPotions.get(beast.token_id) ?? 0) > 0
              ) ?? freshAction.beasts[0]!;
            const focusId = focusCandidate.token_id;
            const current = requiredRevivalPotions.get(focusId) ?? 1;
            const focusedBudget = Math.max(
              1,
              Math.min(maxRevivalPotionsPerBeast, current)
            );
            requiredRevivalPotions = new Map([[focusId, focusedBudget]]);
            forcedRevivalFloor = 0;
            focusedRetryTokenId = focusId;
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(
              `[L2] Unused revival potions in batch — focusing retry on beast ${focusId} revival=${focusedBudget}`
            );
          }
          await sleep(250);
          continue;
        }

        const revivalNeedsMatch = matchStr.match(/beast\s+(\d+)\s+requires\s+(\d+)\s+revival potions/i);
        if (revivalNeedsMatch && !revivalModeForAttempt) {
          const beastId = parseInt(revivalNeedsMatch[1]!, 10);
          const needed = parseInt(revivalNeedsMatch[2]!, 10);
          const aliveAlternativesInSnapshot = getAliveCandidateCount(
            currentSnapshot.ourBeasts.filter((beast) => beast.token_id !== beastId)
          );
          if (preferApiHealthMode && aliveAlternativesInSnapshot > 0) {
            excludedTokenIds.add(beastId);
            requiredRevivalPotions.delete(beastId);
            clearFocusedRetryToken(beastId);
            beastCooldownExclusions.set(beastId, Date.now() + 2 * 60 * 60 * 1000);
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(
              `[L2] Beast ${beastId} requires revival but alive alternatives=${aliveAlternativesInSnapshot} remain — excluding failed beast and continuing alive-first`
            );
            continue;
          }
          if (revivalEnabledByConfig && needed <= maxRevivalPotionsPerBeast) {
            const focusedNeeded = Math.max(1, Math.min(maxRevivalPotionsPerBeast, needed));
            requiredRevivalPotions.set(beastId, focusedNeeded);
            focusedRetryTokenId = beastId;
            forceRevivalWhileAlive = true;
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(
              `[L2] Beast ${beastId} requires revival while tested-as-alive — forcing focused revival retry (${focusedNeeded})`
            );
            continue;
          }

          if (needed > maxRevivalPotionsPerBeast) {
            excludeOverCapRevivalBeast(beastId, needed, "revert/non-revival-mode");
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            continue;
          }

          excludedTokenIds.add(beastId);
          requiredRevivalPotions.delete(beastId);
          clearFocusedRetryToken(beastId);
          beastCooldownExclusions.set(beastId, Date.now() + 12 * 60 * 60 * 1000);
          lastRevivalSignal = null;
          repeatedRevivalSignals = 0;
          logger.info(
            `[L2] Beast ${beastId} requires revival while revival mode is off — excluding for 12h`
          );
          if (freshAction.beasts.length > 1) {
            try {
              const live = await chain.getLiveStats(freshAction.beasts.map((b) => b.token_id));
              const deadBatch = freshAction.beasts.filter((b) => {
                const stats = live.get(b.token_id);
                return resolveEffectiveHealth(stats, b) <= 0;
              });
              if (deadBatch.length > 1) {
                excludeStaleDeadBeasts(deadBatch, 12 * 60 * 60 * 1000);
                logger.info(
                  `[L2] Bulk excluded ${deadBatch.length} dead attackers after revival mismatch`
                );
              }
            } catch {
              // Best effort: single-beast exclusion above is still applied.
            }
          }
          continue;
        }

        if (revivalNeedsMatch && revivalModeForAttempt) {
          const beastId = parseInt(revivalNeedsMatch[1]!, 10);
          const conflicts = (revivalBudgetConflictsByToken.get(beastId) ?? 0) + 1;
          revivalBudgetConflictsByToken.set(beastId, conflicts);
          const needed = parseInt(revivalNeedsMatch[2]!, 10);
          const attackCountForBeast = (() => {
            const tuples = (freshAction.payload as { attackingBeasts?: Array<[number, number, number]> } | undefined)?.attackingBeasts;
            if (!Array.isArray(tuples)) return 1;
            const tuple = tuples.find((t) => Number(t?.[0] ?? 0) === beastId);
            return Math.max(1, Number(tuple?.[1] ?? 1));
          })();
          const beastState = freshAction.beasts.find((b) => b.token_id === beastId);
          const estimatedFromState = beastState && !beastState.isAlive
            ? estimateDeadBeastRevivalBudget(Number(beastState.revival_count ?? 0), attackCountForBeast)
            : 0;
          const neededTotalForBeast = Math.max(needed, estimatedFromState);
          if (neededTotalForBeast > maxRevivalPotionsPerBeast) {
            excludeOverCapRevivalBeast(beastId, neededTotalForBeast, "revert/revival-mode");
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            continue;
          }
          if (
            lastRevivalSignal &&
            lastRevivalSignal.beastId === beastId &&
            lastRevivalSignal.needed === neededTotalForBeast
          ) {
            repeatedRevivalSignals += 1;
          } else {
            repeatedRevivalSignals = 1;
          }
          lastRevivalSignal = { beastId, needed: neededTotalForBeast };

          // Contract expects exact required revival amount for this beast.
          requiredRevivalPotions.set(
            beastId,
            Math.min(maxRevivalPotionsPerBeast, neededTotalForBeast)
          );
          forcedRevivalFloor = 0;
          focusedRetryTokenId = beastId;

          const total = freshAction.beasts.reduce(
            (sum, b) => sum + (requiredRevivalPotions.get(b.token_id) ?? 0),
            0
          );

          if (
            conflicts >= REVIVAL_STUCK_RETRY_LIMIT ||
            repeatedRevivalSignals >= REVIVAL_STUCK_RETRY_LIMIT
          ) {
            const repeatCount = repeatedRevivalSignals;
            excludedTokenIds.add(beastId);
            requiredRevivalPotions.delete(beastId);
            clearFocusedRetryToken(beastId);
            beastCooldownExclusions.set(beastId, Date.now() + 2 * 60 * 60 * 1000);
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(
              `[L2] Beast ${beastId} revival requirement stuck (conflicts=${conflicts}, repeat=${repeatCount}) — excluding for 2h`
            );
            continue;
          }

          logger.info(
            `[L2] Beast ${beastId} needs ${needed} revival potions (attackCount=${attackCountForBeast}) — retrying with total=${total} (repeat=${repeatedRevivalSignals})`
          );
          await sleep(250);
          continue;
        }

        if (handledKilledInDay) {
          const attackableCount = currentSnapshot.ourBeasts.filter(
            (b) => revivalModeForAttempt || b.isAlive
          ).length;
          if (excludedTokenIds.size >= attackableCount) {
            logger.warn("[L2] All beasts excluded — giving up this round");
            logger.event("attack_all_excluded", { excluded: [...excludedTokenIds] });
            return;
          }
          continue;
        }

        // Try to extract which beast failed from error message
        const beastIdMatch = matchStr.match(/token[_ ]?id[:\s=]+(\d+)/i) ||
          matchStr.match(/beast[:\s=]+(\d+)/i);

        if (beastIdMatch) {
          const failedId = parseInt(beastIdMatch[1]!, 10);
          excludedTokenIds.add(failedId);
          requiredRevivalPotions.delete(failedId);
          clearFocusedRetryToken(failedId);
          lastRevivalSignal = null;
          repeatedRevivalSignals = 0;
          logger.info(`[L2] Excluding beast ${failedId} (${excludedTokenIds.size} excluded)`);
        } else if (freshAction.beasts.length === 1) {
          // Single beast attack failed — exclude it
          excludedTokenIds.add(freshAction.beasts[0]!.token_id);
          requiredRevivalPotions.delete(freshAction.beasts[0]!.token_id);
          clearFocusedRetryToken(freshAction.beasts[0]!.token_id);
          lastRevivalSignal = null;
          repeatedRevivalSignals = 0;
          logger.info(`[L2] Excluding single attacker ${freshAction.beasts[0]!.token_id}`);
        } else {
          // Multiple beasts, can't tell which — try excluding the first
          const first = freshAction.beasts[0]!;
          excludedTokenIds.add(first.token_id);
          requiredRevivalPotions.delete(first.token_id);
          clearFocusedRetryToken(first.token_id);
          lastRevivalSignal = null;
          repeatedRevivalSignals = 0;
          logger.info(`[L2] Can't identify failing beast — excluding first: ${first.token_id} (${first.fullName})`);
        }

        // If all beasts excluded, give up
        const attackableCount = currentSnapshot.ourBeasts.filter(
          (b) => revivalModeForAttempt || b.isAlive
        ).length;
        if (excludedTokenIds.size >= attackableCount) {
          logger.warn("[L2] All beasts excluded — giving up this round");
          logger.event("attack_all_excluded", { excluded: [...excludedTokenIds] });
          return;
        }

        continue;
      }

      // ── Layer 2.5: Validation resource limits ──────────────────
      if (
        matchStr.includes("Insufficient resources for validation") ||
        matchStr.includes("code=53")
      ) {
        if (freshAction.beasts.length === 1) {
          const failedId = freshAction.beasts[0]!.token_id;
          const failures = (validationFailuresByToken.get(failedId) ?? 0) + 1;
          validationFailuresByToken.set(failedId, failures);

          if (failures >= 3) {
            excludedTokenIds.add(failedId);
            requiredRevivalPotions.delete(failedId);
            lastRevivalSignal = null;
            repeatedRevivalSignals = 0;
            logger.info(`[L2.5] Beast ${failedId} hit validation limit ${failures}x — excluding`);

            const attackableCount = currentSnapshot.ourBeasts.filter(
              (b) => revivalModeForAttempt || b.isAlive
            ).length;
            if (excludedTokenIds.size >= attackableCount) {
              logger.warn("[L2.5] All beasts excluded after validation failures — giving up this round");
              logger.event("attack_all_excluded", { excluded: [...excludedTokenIds] });
              return;
            }
            continue;
          }
        }

        logger.info("[L2.5] Validation resource limit — backing off 2s before retry");
        await sleep(2000);
        continue;
      }

      // ── Layer 3: Unknown error — full refresh ──────────────────
      logger.warn(`[L3] Unknown error — full refresh (attempt ${attempt})`);
      logger.event("attack_failed", {
        attempt,
        error: decodedErr.substring(0, 500),
        layer: 3,
      });

      // Refresh everything from API
      const [newHolder, ownerCache] = await Promise.all([
        chain.getSummitHolderApiShape(),
        getOwnerBeastsCached(false),
      ]);
      preferApiHealthMode = preferApiHealthMode || ownerCache.liveMismatchFallback;
      const nowMs = Date.now();
      for (const [tokenId, expiry] of beastCooldownExclusions) {
        if (expiry <= nowMs) beastCooldownExclusions.delete(tokenId);
      }
      const filteredBeasts = ownerCache.enriched.filter(
        (b) => !beastCooldownExclusions.has(b.token_id)
      );

      currentSnapshot = {
        summitHolder: newHolder ? enrichBeast(newHolder) : null,
        ourBeasts: filteredBeasts,
        timestamp: Date.now(),
      };

      excludedTokenIds = new Set(); // Reset exclusions
      requiredRevivalPotions = new Map();
      forcedRevivalFloor = 0;
      clearFocusedRetryToken();
      lastRevivalSignal = null;
      repeatedRevivalSignals = 0;
      validationFailuresByToken = new Map();
      revivalBudgetConflictsByToken = new Map();

      // Back off slightly on unknown errors
      await sleep(2000);
    }
  }

  logger.error(`Attack exhausted all ${MAX_ATTEMPTS} attempts`);
  logger.event("attack_exhausted", { maxAttempts: MAX_ATTEMPTS });
}

// ── Start ────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
