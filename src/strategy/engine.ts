import type { FenrirConfig } from "../config.js";
import type { GameSnapshot, AgentAction, ScoredBeast } from "./types.js";
import { rankBeasts } from "./scoring.js";
import { Logger } from "../utils/logger.js";

type ProfileId = "focused" | "balanced" | "swarm";

type AttackProfile = {
  id: ProfileId;
  maxBeasts: number;
  attackCountPerBeast: number;
  attackPotionsPerBeast: number;
};

type ProfileStats = {
  attempts: number;
  captures: number;
  lastUsedAt: number;
};

const HARD_MAX_REVIVAL_POTIONS_PER_BEAST = 88;
const HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK = 5;
const HYBRID_STREAK_REVIVE_EVERY_ATTACKS = 5;

export class StrategyEngine {
  private config: FenrirConfig;
  private logger: Logger;
  private lastAttackAt = 0;
  private attackCount = 0;
  private lastHolderId: number | null = null;
  private profileStats = new Map<ProfileId, ProfileStats>();
  private beastLastSelectedAt = new Map<number, number>();
  private rotationCursorByHolder = new Map<number, number>();
  private holdRotationBlockedUntilByHolder = new Map<number, number>();

  constructor(config: FenrirConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    if (this.config.strategy.experimentMode) {
      this.logger.info("[EXP] Experiment mode enabled", {
        explorePerProfile: this.config.strategy.experimentExplorePerProfile,
      });
    }
    if (this.config.strategy.attackStreakTarget > 0) {
      this.logger.info("[STREAK] Streak target enabled", {
        target: this.config.strategy.attackStreakTarget,
      });
    }
    if (this.config.strategy.growingStrongerTargetLevels > 0) {
      this.logger.info("[LEVEL] Growing Stronger target enabled", {
        bonusLevels: this.config.strategy.growingStrongerTargetLevels,
      });
    }
  }

  decide(snapshot: GameSnapshot): AgentAction {
    const { summitHolder, ourBeasts } = snapshot;
    const uniqueOurBeasts = this.dedupeBeastsByToken(ourBeasts);
    if (uniqueOurBeasts.length !== ourBeasts.length) {
      this.logger.debug(
        `[DEDUPE] Removed ${ourBeasts.length - uniqueOurBeasts.length} duplicate beast entries from snapshot`
      );
    }

    if (!summitHolder) {
      return this.tryAttackEmpty(uniqueOurBeasts);
    }

    const ourAddr = this.config.account.controllerAddress.toLowerCase();
    const holderOwner = summitHolder.owner?.toLowerCase?.() ?? "";
    const weOwnByOwner = holderOwner === ourAddr;
    const weOwnByToken = uniqueOurBeasts.some((b) => b.token_id === summitHolder.token_id);
    const isCaptureAttempt = !(weOwnByOwner || weOwnByToken);
    const rotatingWhileHolding = weOwnByOwner || weOwnByToken;
    if (weOwnByOwner || weOwnByToken) {
      const blockedUntil = this.holdRotationBlockedUntilByHolder.get(summitHolder.token_id) ?? 0;
      if (blockedUntil > 0) {
        if (blockedUntil > Date.now()) {
          return {
            type: "wait",
            reason: `We hold summit — rotation blocked for ${Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))}s`,
          };
        }
        this.holdRotationBlockedUntilByHolder.delete(summitHolder.token_id);
      }
      const holdWaitReason = this.getHoldRotationWaitReason(summitHolder, uniqueOurBeasts);
      if (holdWaitReason) {
        this.logger.info("We hold the summit! Earning 0.007 $SURVIVOR/sec");
        return { type: "wait", reason: holdWaitReason };
      }
      this.logger.info("[CAPTURE] Rotating summit holder for pending quests", {
        holderTokenId: summitHolder.token_id,
      });
    }

    if (this.lastHolderId !== summitHolder.token_id) {
      this.lastHolderId = summitHolder.token_id;
      this.logger.info(`New holder: ${summitHolder.fullName} (${summitHolder.type} L${summitHolder.level} power=${summitHolder.basePower})`, {
        holderTokenId: summitHolder.token_id,
        holderType: summitHolder.type,
        holderPower: summitHolder.basePower,
        holderHp: summitHolder.health,
        holderExtraLives: summitHolder.extra_lives,
      });
    }

    const minHolderPower = this.config.strategy.minHolderPowerToAttack;
    if (minHolderPower > 0 && summitHolder.basePower < minHolderPower) {
      this.logger.info(`Skipping holder: power ${summitHolder.basePower} < min ${minHolderPower}`);
      return { type: "wait" as const, reason: `Holder power ${summitHolder.basePower} below min ${minHolderPower}` };
    }

    const now = Date.now();
    const timeSinceAttack = now - this.lastAttackAt;
    if (timeSinceAttack < this.config.strategy.attackCooldownMs) {
      return { type: "wait", reason: `Cooldown (${Math.ceil((this.config.strategy.attackCooldownMs - timeSinceAttack) / 1000)}s)` };
    }

    const candidateBeasts = rotatingWhileHolding
      ? uniqueOurBeasts.filter((b) => b.token_id !== summitHolder.token_id)
      : uniqueOurBeasts;

    if (candidateBeasts.length === 0) {
      return rotatingWhileHolding
        ? { type: "wait", reason: "We hold the summit — no alternate beasts to rotate" }
        : { type: "wait", reason: "No beasts in Summit yet" };
    }

    const alive = candidateBeasts.filter((b) => b.isAlive);
    // Only revive when all beasts are dead. If any are alive, keep pressure with
    // alive attackers and avoid spending revival potions early.
    const revivalModeEnabled = this.config.strategy.useRevivalPotions && alive.length === 0;
    const ranked = rankBeasts(candidateBeasts, summitHolder, {
      requireTypeAdvantage: this.config.strategy.requireTypeAdvantage,
      includeDead: revivalModeEnabled,
    });

    const attackable = revivalModeEnabled ? candidateBeasts : alive;
    if (attackable.length === 0) {
      return { type: "wait", reason: "All beasts dead/cooldown (revivals disabled)" };
    }

    if (ranked.length === 0) {
      return { type: "wait", reason: "No viable beasts to send" };
    }

    const scoreFloor = Math.max(0, this.config.strategy.minScoreToAttack);
    const viableByScore = ranked.filter((b) => b.score >= scoreFloor);
    const viable = this.config.strategy.avoidTypeDisadvantage
      ? viableByScore.filter((b) => b.typeAdvantage >= 1)
      : viableByScore;
    if (viable.length === 0) {
      return this.config.strategy.avoidTypeDisadvantage
        ? { type: "wait", reason: `No beasts meet min score ${scoreFloor} without type disadvantage` }
        : { type: "wait", reason: `No beasts meet min score ${scoreFloor}` };
    }

    const profile = this.selectProfile();
    const potionsPerBeast = this.config.strategy.useAttackPotions
      ? profile.attackPotionsPerBeast
      : 0;
    const maxRevivalPotionsPerBeast = this.getEffectiveMaxRevivalPotionsPerBeast();
    const attackCountPerBeast = profile.attackCountPerBeast;
    const streakTarget = Math.max(0, Math.min(10, this.config.strategy.attackStreakTarget));
    const configuredLevelTarget = Math.max(
      0,
      Math.min(10, this.config.strategy.growingStrongerTargetLevels)
    );
    const levelTarget =
      configuredLevelTarget > 0 ? this.getEffectiveLevelTarget(viable) : 0;

    const viableByRevival = revivalModeEnabled
      ? viable.filter((b) => {
          const plannedAttackCount = this.getPlannedAttackCount(
            b,
            attackCountPerBeast,
            levelTarget
          );
          const needed = this.estimateRevivalBudgetForAttackCount(
            Number(b.revival_count ?? 0),
            plannedAttackCount,
            b.isAlive
          );
          return needed <= maxRevivalPotionsPerBeast;
        })
      : viable;
    if (viableByRevival.length === 0) {
      return revivalModeEnabled
        ? {
            type: "wait",
            reason: `No beasts under revival budget (max ${maxRevivalPotionsPerBeast}/beast)`,
          }
        : { type: "wait", reason: "No viable beasts to send" };
    }

    const viableAlive = viableByRevival.filter((b) => b.isAlive);
    let pool = viableAlive.length > 0 ? viableAlive : viableByRevival;
    if (viableAlive.length === 0 && revivalModeEnabled) {
      this.logger.info("No alive viable beasts, falling back to dead beasts with revival potions");
    }

    const belowStreakAlive = streakTarget > 0
      ? viableAlive.filter((b) => this.getQuestMaxAttackStreak(b) !== 1)
      : [];
    const belowStreakAny = streakTarget > 0
      ? viableByRevival.filter((b) => this.getQuestMaxAttackStreak(b) !== 1)
      : [];
    const deadBelowStreakEligible = streakTarget > 0
      ? viable.filter((b) => {
          if (b.isAlive) return false;
          if (this.getQuestMaxAttackStreak(b) === 1) return false;
          const plannedAttackCount = this.getPlannedAttackCount(
            b,
            attackCountPerBeast,
            levelTarget
          );
          const needed = this.estimateRevivalBudgetForAttackCount(
            Number(b.revival_count ?? 0),
            plannedAttackCount,
            false
          );
          return needed <= maxRevivalPotionsPerBeast;
        })
      : [];

    if (streakTarget > 0 && belowStreakAny.length > 0) {
      pool = belowStreakAlive.length > 0 ? belowStreakAlive : belowStreakAny;
      this.logger.info(
        `[STREAK] Prioritizing ${belowStreakAny.length} beasts below streak ${streakTarget}`
      );
      pool = this.sortByStreakAndRotation(pool);
    } else if (levelTarget > 0) {
      const belowLevelAlive = viableAlive.filter((b) => this.getBonusLevels(b) < levelTarget);
      const belowLevelAny = viableByRevival.filter((b) => this.getBonusLevels(b) < levelTarget);
      if (belowLevelAny.length > 0) {
        pool = belowLevelAlive.length > 0 ? belowLevelAlive : belowLevelAny;
        this.logger.info(
          `[LEVEL] Prioritizing ${belowLevelAny.length} beasts below +${levelTarget} bonus level`
        );
        pool = this.sortByLevelQuestAndRotation(pool, levelTarget);
      } else {
        const captureAlive = viableAlive.filter(
          (b) => this.getQuestCapturedSummit(b) !== 1 || this.getSummitHeldSeconds(b) < 10
        );
        const captureAny = viableByRevival.filter(
          (b) => this.getQuestCapturedSummit(b) !== 1 || this.getSummitHeldSeconds(b) < 10
        );
        if (captureAny.length > 0) {
          pool = captureAlive.length > 0 ? captureAlive : captureAny;
          this.logger.info(
            `[CAPTURE] Prioritizing ${captureAny.length} beasts for capture/10s hold quests`
          );
          pool = this.sortByCaptureQuestAndScore(pool);
        }
      }
    }

    const streakPriorityActive = streakTarget > 0 && belowStreakAny.length > 0;
    const shouldInjectDeadStreakRevive =
      streakTarget > 0 &&
      this.config.strategy.useRevivalPotions &&
      belowStreakAlive.length > 0 &&
      deadBelowStreakEligible.length > 0 &&
      this.attackCount > 0 &&
      this.attackCount % HYBRID_STREAK_REVIVE_EVERY_ATTACKS === 0;
    let forcedHybridRevival = false;
    if (shouldInjectDeadStreakRevive) {
      pool = this.sortByStreakAndRotation(deadBelowStreakEligible);
      forcedHybridRevival = true;
      this.logger.info(
        `[STREAK] Hybrid revive tick — reviving one dead beast below streak ${streakTarget} (aliveBelow=${belowStreakAlive.length}, deadBelow=${deadBelowStreakEligible.length})`
      );
    }
    const singleBeastRevivalStreakMode =
      revivalModeEnabled &&
      streakPriorityActive &&
      pool.some((beast) => !beast.isAlive);
    let attackers: ScoredBeast[];
    if (forcedHybridRevival) {
      attackers = pool.slice(0, 1);
      this.logger.info(
        "[STREAK] Hybrid mode active — injecting dead streak beast revival while alive attackers remain"
      );
    } else if (singleBeastRevivalStreakMode) {
      // Dead streak grinding is most stable when revived/attacked one-by-one.
      attackers = pool.slice(0, 1);
      this.logger.info(
        "[STREAK] Revival mode active — reviving dead streak beasts one-by-one"
      );
    } else if (this.config.strategy.sendAllBeasts) {
      const maxBeasts = Math.min(this.config.strategy.maxBeastsPerAttack, profile.maxBeasts);
      // For max-streak questing, keep pressure on the same top streaking beasts
      // instead of freshness rotation, otherwise progress stalls around mid streak.
      attackers = streakPriorityActive
        ? pool.slice(0, maxBeasts)
        : this.selectDynamicAttackers(pool, maxBeasts, summitHolder.token_id);
    } else {
      attackers = streakPriorityActive
        ? pool.slice(0, 1)
        : this.selectDynamicAttackers(pool, 1, summitHolder.token_id);
    }

    let primaryAttackCount = attackCountPerBeast;
    let primaryAttackPotions = potionsPerBeast;
    const primary = attackers[0];
    const holderExtraLives = Number(summitHolder.extra_lives ?? 0);

    // Compute attack count per primary beast, respecting revival budget.
    if (primary) {
      const maxAttackCountByBudget = this.getMaxAttackCountWithinRevivalBudget(
        Number(primary.revival_count ?? 0),
        maxRevivalPotionsPerBeast,
        primary.isAlive
      );
      primaryAttackCount = Math.max(
        1,
        Math.min(10, Math.min(attackCountPerBeast, maxAttackCountByBudget))
      );

      // Burst mode: more attacks when holder has many extra lives and we have type advantage
      const burstWindow =
        this.config.strategy.burstEnabled &&
        holderExtraLives >= this.config.strategy.burstExtraLivesThreshold &&
        primary.typeAdvantage >= this.config.strategy.burstMinTypeAdvantage;

      if (burstWindow) {
        const desiredAttackCount = Math.max(
          attackCountPerBeast,
          this.config.strategy.burstAttackCountPerBeast
        );
        primaryAttackCount = Math.max(1, Math.min(desiredAttackCount, maxAttackCountByBudget));

        if (primaryAttackCount > attackCountPerBeast) {
          this.logger.info(
            `[BURST] ${primary.fullName}: atkCount ${attackCountPerBeast}→${primaryAttackCount}, holderExtraLives=${holderExtraLives}`
          );
        }
      }
    }

    // Attack potions: always use the fixed config value (no adaptive offsets)
    const fixedAttackPotionsPerBeast = this.config.strategy.useAttackPotions
      ? Math.max(1, Math.floor(this.config.strategy.attackPotionsPerBeast))
      : 0;
    primaryAttackPotions = fixedAttackPotionsPerBeast;

    const attackingBeasts: Array<[number, number, number]> = attackers.map((b, idx) => {
      const baseAttackCount = idx === 0 ? primaryAttackCount : attackCountPerBeast;
      const perBeastAttackCount = this.getPlannedAttackCount(
        b,
        baseAttackCount,
        levelTarget
      );
      const perBeastAttackPotions = fixedAttackPotionsPerBeast;
      return [
        b.token_id,
        perBeastAttackCount,
        perBeastAttackPotions,
      ];
    });

    const revivalPotions = 0; // Set by retry layer as exact aggregate required
    const extraLifePotions = this.getPlannedExtraLifePotions(primary, isCaptureAttempt);

    for (const attacker of attackers) {
      this.beastLastSelectedAt.set(attacker.token_id, now);
    }

    this.lastAttackAt = now;
    this.attackCount++;

    const attackerNames = attackers.map((b) => `${b.fullName}(${b.type} score=${b.score.toFixed(0)})`).join(", ");
      this.logger.info(`ATTACK #${this.attackCount}: ${attackers.length} beasts → ${summitHolder.fullName}`, {
        profile: profile.id,
        attackCountPerBeast: primaryAttackCount,
        attackerCount: attackers.length,
        potionsPerBeast: primaryAttackPotions,
        extraLifePotions,
        forcedHybridRevival,
        aliveBelowStreak: belowStreakAlive.length,
        deadBelowStreak: deadBelowStreakEligible.length,
        burstApplied:
          primaryAttackCount !== attackCountPerBeast ||
          primaryAttackPotions !== potionsPerBeast,
        revivalPotions,
      holderPower: summitHolder.basePower,
      holderType: summitHolder.type,
    });

    return {
      type: "attack",
      reason: `[${profile.id}] Sending ${attackers.length} beast(s), atkCount=${primaryAttackCount}, attackPotions=${primaryAttackPotions}, extraLife=${extraLifePotions}`,
      beasts: attackers,
      payload: {
        profileId: profile.id,
        attackCountPerBeast: primaryAttackCount,
        attackPotionsPerBeast: primaryAttackPotions,
        defendingBeastTokenId: summitHolder.token_id,
        attackingBeasts,
        revivalPotions,
        extraLifePotions,
        forceRevivalMode: forcedHybridRevival,
        streakAuditAliveBelowTarget: belowStreakAlive.length,
        streakAuditDeadBelowTarget: deadBelowStreakEligible.length,
        useVrf: true,
      },
    };
  }

  private dedupeBeastsByToken<T extends { token_id: number }>(beasts: T[]): T[] {
    const seen = new Set<number>();
    const unique: T[] = [];
    for (const beast of beasts) {
      if (seen.has(beast.token_id)) continue;
      seen.add(beast.token_id);
      unique.push(beast);
    }
    return unique;
  }

  allowImmediateAttack(): void {
    this.lastAttackAt = 0;
  }

  blockHoldRotation(holderTokenId: number, durationMs = 45_000): void {
    const tokenId = Math.max(1, Math.floor(holderTokenId));
    const blockMs = Math.max(5_000, Math.floor(durationMs));
    this.holdRotationBlockedUntilByHolder.set(tokenId, Date.now() + blockMs);
    this.logger.info("[CAPTURE] Temporarily blocking holder rotation after own-beast revert", {
      holderTokenId: tokenId,
      blockMs,
    });
  }

  recordAttackOutcome(input: {
    profileId?: string;
    captured: boolean;
    attackerCount: number;
    attackCountPerBeast: number;
    attackPotionsPerBeast: number;
    revivalPotions: number;
    txHash: string;
  }): void {
    if (!this.config.strategy.experimentMode) return;

    const profileId = this.normalizeProfileId(input.profileId);
    if (!profileId) return;

    const current = this.profileStats.get(profileId) ?? {
      attempts: 0,
      captures: 0,
      lastUsedAt: Date.now(),
    };
    current.attempts += 1;
    if (input.captured) current.captures += 1;
    current.lastUsedAt = Date.now();
    this.profileStats.set(profileId, current);

    const captureRate = current.attempts > 0
      ? (current.captures / current.attempts) * 100
      : 0;

    this.logger.info(
      `[EXP] Outcome ${profileId}: captured=${input.captured ? "yes" : "no"} rate=${captureRate.toFixed(1)}% (${current.captures}/${current.attempts})`,
      {
        txHash: input.txHash,
        attackerCount: input.attackerCount,
        attackCountPerBeast: input.attackCountPerBeast,
        attackPotionsPerBeast: input.attackPotionsPerBeast,
        revivalPotions: input.revivalPotions,
      }
    );
  }

  private normalizeProfileId(value?: string): ProfileId | null {
    if (value === "focused" || value === "balanced" || value === "swarm") {
      return value;
    }
    return null;
  }

  private getProfiles(): AttackProfile[] {
    const baseAttackCount = Math.max(1, this.config.strategy.attackCountPerBeast);
    const baseAttackPotions = Math.max(0, this.config.strategy.attackPotionsPerBeast);
    const maxByConfig = this.config.strategy.maxBeastsPerAttack;
    const caps = this.config.strategy.maxBeastsProfiles;

    return [
      {
        id: "focused",
        maxBeasts: Math.min(maxByConfig, caps.focused),
        attackCountPerBeast: baseAttackCount,
        attackPotionsPerBeast: Math.min(10, baseAttackPotions + 1),
      },
      {
        id: "balanced",
        maxBeasts: Math.min(maxByConfig, caps.balanced),
        attackCountPerBeast: baseAttackCount,
        attackPotionsPerBeast: baseAttackPotions,
      },
      {
        id: "swarm",
        maxBeasts: Math.min(maxByConfig, caps.swarm),
        attackCountPerBeast: baseAttackCount,
        attackPotionsPerBeast: Math.max(0, baseAttackPotions - 1),
      },
    ];
  }

  private getProfileStats(id: ProfileId): ProfileStats {
    const existing = this.profileStats.get(id);
    if (existing) return existing;
    const created: ProfileStats = { attempts: 0, captures: 0, lastUsedAt: 0 };
    this.profileStats.set(id, created);
    return created;
  }

  private selectProfile(): AttackProfile {
    if (!this.config.strategy.experimentMode) {
      return {
        id: "balanced",
        maxBeasts: this.config.strategy.maxBeastsPerAttack,
        attackCountPerBeast: Math.max(1, this.config.strategy.attackCountPerBeast),
        attackPotionsPerBeast: Math.max(0, this.config.strategy.attackPotionsPerBeast),
      };
    }

    const profiles = this.getProfiles();
    const exploreTarget = Math.max(1, this.config.strategy.experimentExplorePerProfile);

    const exploreCandidates = profiles
      .map((p) => ({ profile: p, stats: this.getProfileStats(p.id) }))
      .filter(({ stats }) => stats.attempts < exploreTarget)
      .sort((a, b) => {
        if (a.stats.attempts !== b.stats.attempts) {
          return a.stats.attempts - b.stats.attempts;
        }
        return a.stats.lastUsedAt - b.stats.lastUsedAt;
      });

    if (exploreCandidates.length > 0) {
      const chosen = exploreCandidates[0]!.profile;
      this.logger.info(`[EXP] Exploring profile=${chosen.id}`);
      return chosen;
    }

    const ranked = profiles
      .map((p) => {
        const stats = this.getProfileStats(p.id);
        const captureRate = stats.attempts > 0 ? stats.captures / stats.attempts : 0;
        return { profile: p, captureRate, attempts: stats.attempts };
      })
      .sort((a, b) => {
        if (b.captureRate !== a.captureRate) return b.captureRate - a.captureRate;
        if (b.attempts !== a.attempts) return b.attempts - a.attempts;
        return a.profile.attackPotionsPerBeast - b.profile.attackPotionsPerBeast;
      });

    const chosen = ranked[0]!.profile;
    this.logger.info(`[EXP] Exploiting profile=${chosen.id}`, {
      captureRate: ranked[0]!.captureRate,
      attempts: ranked[0]!.attempts,
    });
    return chosen;
  }

  private tryAttackEmpty(ourBeasts: import("./types.js").EnrichedBeast[]): AgentAction {
    const alive = ourBeasts.filter((b) => b.isAlive);
    if (alive.length === 0) {
      return { type: "wait", reason: "Summit empty but no alive beasts" };
    }
    return { type: "wait", reason: "Summit empty — waiting for a holder" };
  }

  private getHoldRotationWaitReason(
    summitHolder: NonNullable<GameSnapshot["summitHolder"]>,
    ourBeasts: import("./types.js").EnrichedBeast[],
  ): string | null {
    if (!this.config.strategy.rotateWhileHoldingForQuests) {
      return "We hold the summit — earning rewards";
    }

    const holderState =
      ourBeasts.find((b) => b.token_id === summitHolder.token_id) ?? summitHolder;
    const minHoldSeconds = Math.max(0, Math.floor(this.config.strategy.rotateHoldSeconds));
    const holderHoldSeconds = this.getSummitHeldSeconds(holderState);
    const holderNeedsHoldQuest = this.getSummitHeldSeconds(holderState) < 10;

    if (holderNeedsHoldQuest && holderHoldSeconds < minHoldSeconds) {
      return `We hold summit — waiting ${Math.max(0, minHoldSeconds - holderHoldSeconds)}s before rotating holder`;
    }

    const candidates = ourBeasts.filter((b) => {
      if (b.token_id === summitHolder.token_id) return false;
      if (!this.config.strategy.useRevivalPotions && !b.isAlive) return false;
      return true;
    });
    if (candidates.length === 0) {
      return "We hold the summit — no alternate quest attackers";
    }

    const levelTarget = this.getEffectiveLevelTarget(candidates);
    const hasPendingQuestTarget = candidates.some((b) => {
      if (this.getQuestMaxAttackStreak(b) !== 1) return true;
      if (levelTarget > 0 && this.getBonusLevels(b) < levelTarget) return true;
      if (this.getQuestCapturedSummit(b) !== 1) return true;
      if (this.getSummitHeldSeconds(b) < 10) return true;
      if (Number(b.quest_used_attack_potion ?? 0) !== 1) return true;
      if (!b.isAlive && Number(b.quest_used_revival_potion ?? 0) !== 1) return true;
      return false;
    });

    if (!hasPendingQuestTarget) {
      return "We hold the summit — quests complete, defending";
    }

    return null;
  }

  private getPlannedExtraLifePotions(
    primary?: ScoredBeast,
    isCaptureAttempt = false
  ): number {
    if (!this.config.strategy.useExtraLifePotions || !primary) return 0;
    const configuredCap = Math.max(
      0,
      Math.floor(Number(this.config.strategy.extraLifePotionsPerAttack ?? 0))
    );
    const targetExtraLives = Math.min(
      HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK,
      configuredCap
    );
    if (targetExtraLives <= 0) return 0;
    const currentExtraLives = Math.max(0, Math.floor(Number(primary.extra_lives ?? 0)));
    const remainingToTarget = Math.max(0, targetExtraLives - currentExtraLives);
    if (remainingToTarget <= 0) return 0;

    return Math.min(targetExtraLives, remainingToTarget);
  }

  private getAttackStreak(beast: Pick<ScoredBeast, "attack_streak">): number {
    const value = Number(beast.attack_streak ?? 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }

  private getQuestMaxAttackStreak(
    beast: Pick<ScoredBeast, "quest_max_attack_streak">
  ): number {
    const value = Number(beast.quest_max_attack_streak ?? 0);
    return Number.isFinite(value) ? Math.floor(value) : 0;
  }

  private getQuestCapturedSummit(
    beast: Pick<ScoredBeast, "quest_captured_summit">
  ): number {
    const value = Number(beast.quest_captured_summit ?? 0);
    return Number.isFinite(value) ? Math.floor(value) : 0;
  }

  private getSummitHeldSeconds(
    beast: Pick<ScoredBeast, "summit_held_seconds">
  ): number {
    const value = Number(beast.summit_held_seconds ?? 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }

  private getBonusXp(beast: Pick<ScoredBeast, "bonus_xp">): number {
    const value = Number(beast.bonus_xp ?? 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }

  private getBonusLevels(beast: Pick<ScoredBeast, "level" | "bonus_xp">): number {
    const baseLevel = Math.max(1, Math.floor(Number(beast.level ?? 1)));
    const bonusXp = this.getBonusXp(beast);
    const currentLevel = Math.floor(Math.sqrt(baseLevel * baseLevel + bonusXp));
    return Math.max(0, currentLevel - baseLevel);
  }

  private getXpToReachBonusLevels(
    beast: Pick<ScoredBeast, "level" | "bonus_xp">,
    targetBonusLevels: number
  ): number {
    const normalizedTarget = Math.max(1, Math.floor(targetBonusLevels));
    const baseLevel = Math.max(1, Math.floor(Number(beast.level ?? 1)));
    const requiredBonusXp = (baseLevel + normalizedTarget) ** 2 - baseLevel ** 2;
    return Math.max(0, requiredBonusXp - this.getBonusXp(beast));
  }

  private estimateXpGainForAttackCount(initialStreak: number, attackCount: number): number {
    const normalizedStreak = Math.max(0, Math.floor(initialStreak));
    const normalizedAttackCount = Math.max(1, Math.floor(attackCount));

    let total = 0;
    for (let i = 0; i < normalizedAttackCount; i++) {
      total += 10 + Math.min(10, normalizedStreak + i);
    }
    return total;
  }

  private getAttacksNeededForBonusLevels(
    beast: Pick<ScoredBeast, "level" | "bonus_xp" | "attack_streak">,
    targetBonusLevels: number,
    maxAttacks = 10
  ): number {
    const remainingXp = this.getXpToReachBonusLevels(beast, targetBonusLevels);
    if (remainingXp <= 0) return 1;

    const streak = this.getAttackStreak(beast);
    const cap = Math.max(1, Math.floor(maxAttacks));

    for (let attacks = 1; attacks <= cap; attacks++) {
      if (this.estimateXpGainForAttackCount(streak, attacks) >= remainingXp) {
        return attacks;
      }
    }
    return cap;
  }

  private sortByStreakAndRotation(beasts: ScoredBeast[]): ScoredBeast[] {
    return [...beasts].sort((a, b) => {
      const questDiff = this.getQuestMaxAttackStreak(a) - this.getQuestMaxAttackStreak(b);
      if (questDiff !== 0) return questDiff;

      // Type-advantaged beasts first: fill swarm slots with 1.5x before 1.0x.
      if (a.typeAdvantage !== b.typeAdvantage) return b.typeAdvantage - a.typeAdvantage;

      // Finish beasts closest to streak 10 first.
      const streakDiff = this.getAttackStreak(b) - this.getAttackStreak(a);
      if (streakDiff !== 0) return streakDiff;

      const aLast = this.beastLastSelectedAt.get(a.token_id) ?? 0;
      const bLast = this.beastLastSelectedAt.get(b.token_id) ?? 0;
      // Prefer recently used beasts to preserve consecutive streak momentum.
      if (aLast !== bLast) return bLast - aLast;

      return b.score - a.score;
    });
  }

  private sortByCaptureQuestAndScore(beasts: ScoredBeast[]): ScoredBeast[] {
    return [...beasts].sort((a, b) => {
      const captureDiff = this.getQuestCapturedSummit(a) - this.getQuestCapturedSummit(b);
      if (captureDiff !== 0) return captureDiff;

      const holdA = this.getSummitHeldSeconds(a);
      const holdB = this.getSummitHeldSeconds(b);
      const holdQuestA = holdA >= 10 ? 1 : 0;
      const holdQuestB = holdB >= 10 ? 1 : 0;
      if (holdQuestA !== holdQuestB) return holdQuestA - holdQuestB;
      if (holdA !== holdB) return holdA - holdB;

      return b.score - a.score;
    });
  }

  private selectDynamicAttackers(
    pool: ScoredBeast[],
    maxBeasts: number,
    holderTokenId: number
  ): ScoredBeast[] {
    const normalizedMax = Math.max(1, Math.floor(maxBeasts));
    if (pool.length <= normalizedMax) {
      return pool.slice(0, normalizedMax);
    }

    const windowSize = Math.min(
      pool.length,
      Math.max(normalizedMax, Math.max(48, normalizedMax * 6))
    );
    const window = pool.slice(0, windowSize);
    const byFreshness = [...window].sort((a, b) => {
      const aLast = this.beastLastSelectedAt.get(a.token_id) ?? 0;
      const bLast = this.beastLastSelectedAt.get(b.token_id) ?? 0;
      if (aLast !== bLast) return aLast - bLast;
      return b.score - a.score;
    });

    const rawCursor = this.rotationCursorByHolder.get(holderTokenId) ?? 0;
    const start = rawCursor % byFreshness.length;
    const rotated =
      start === 0
        ? byFreshness
        : byFreshness.slice(start).concat(byFreshness.slice(0, start));
    const attackers = rotated.slice(0, normalizedMax);
    const advanceBy = Math.max(1, Math.floor(normalizedMax / 2));
    this.rotationCursorByHolder.set(
      holderTokenId,
      (start + advanceBy) % byFreshness.length
    );
    return attackers;
  }

  private getLevelQuestTiers(): number[] {
    const configured = Math.max(
      0,
      Math.min(10, this.config.strategy.growingStrongerTargetLevels)
    );
    if (configured === 0) return [];
    const base = configured;
    const tiers = [base, 3, 5, 10]
      .filter((tier) => tier >= base && tier <= 10)
      .sort((a, b) => a - b);
    return [...new Set(tiers)];
  }

  private getEffectiveLevelTarget(
    beasts: Array<Pick<ScoredBeast, "level" | "bonus_xp">>
  ): number {
    const tiers = this.getLevelQuestTiers();
    if (tiers.length === 0) return 0;

    for (const tier of tiers) {
      if (beasts.some((b) => this.getBonusLevels(b) < tier)) {
        return tier;
      }
    }

    return tiers[tiers.length - 1]!;
  }

  private sortByLevelQuestAndRotation(
    beasts: ScoredBeast[],
    targetBonusLevels: number
  ): ScoredBeast[] {
    return [...beasts].sort((a, b) => {
      const aLevels = this.getBonusLevels(a);
      const bLevels = this.getBonusLevels(b);
      if (aLevels !== bLevels) return aLevels - bLevels;

      const aRemainingXp = this.getXpToReachBonusLevels(a, targetBonusLevels);
      const bRemainingXp = this.getXpToReachBonusLevels(b, targetBonusLevels);
      if (aRemainingXp !== bRemainingXp) return aRemainingXp - bRemainingXp;

      const aLast = this.beastLastSelectedAt.get(a.token_id) ?? 0;
      const bLast = this.beastLastSelectedAt.get(b.token_id) ?? 0;
      if (aLast !== bLast) return aLast - bLast;

      return b.score - a.score;
    });
  }

  private getPlannedAttackCount(
    beast: ScoredBeast,
    fallbackCount: number,
    levelTargetOverride?: number
  ): number {
    if (!this.config.strategy.useRevivalPotions) {
      // Quest-only stable mode: keep each tx lightweight so it reliably lands.
      // Streak/level progress is accumulated across repeated transactions.
      return 1;
    }

    if (!beast.isAlive) {
      // Dead beasts can require variable revivals per sub-attack. Keeping attack_count=1
      // avoids strict "unused revival potions" reverts and stabilizes quest grinding.
      return 1;
    }

    const streakTarget = Math.max(0, Math.min(10, this.config.strategy.attackStreakTarget));
    const levelTarget = Math.max(
      0,
      Math.min(
        10,
        Number.isFinite(levelTargetOverride)
          ? Number(levelTargetOverride)
          : this.config.strategy.growingStrongerTargetLevels
      )
    );
    let planned = Math.max(1, Math.floor(fallbackCount));

    if (streakTarget > 0) {
      const streak = this.getAttackStreak(beast);
      if (streak < streakTarget) {
        const needed = streakTarget - streak;
        planned = Math.max(planned, needed);
      }
    }
    if (levelTarget > 0 && this.getBonusLevels(beast) < levelTarget) {
      const attacksNeeded = this.getAttacksNeededForBonusLevels(beast, levelTarget, 10);
      planned = Math.max(planned, attacksNeeded);
    }

    const maxByBudget = this.getMaxAttackCountWithinRevivalBudget(
      Number(beast.revival_count ?? 0),
      this.getEffectiveMaxRevivalPotionsPerBeast(),
      beast.isAlive
    );

    return Math.max(1, Math.min(10, Math.min(planned, maxByBudget)));
  }

  private estimateDeadBeastRevivalBudget(revivalCount: number, _attackCount: number): number {
    const normalizedRevivalCount = Math.max(0, Math.floor(revivalCount));
    // Summit consumes revival potions to revive dead attackers at submission time.
    // Required amount is the next single revival cost for the beast.
    return normalizedRevivalCount + 1;
  }

  private getEffectiveMaxRevivalPotionsPerBeast(): number {
    return Math.min(
      HARD_MAX_REVIVAL_POTIONS_PER_BEAST,
      Math.max(0, Math.floor(this.config.strategy.maxRevivalPotionsPerBeast))
    );
  }

  private estimateRevivalBudgetForAttackCount(
    revivalCount: number,
    attackCount: number,
    isAlive: boolean
  ): number {
    if (isAlive) return 0;
    const normalizedAttackCount = Math.max(1, Math.floor(attackCount));
    return this.estimateDeadBeastRevivalBudget(revivalCount, normalizedAttackCount);
  }

  private getMaxAttackCountWithinRevivalBudget(
    revivalCount: number,
    maxRevivalBudget: number,
    isAlive: boolean
  ): number {
    // Alive beasts need 0 revival potions — any attack count is fine.
    if (isAlive) {
      return Math.max(20, this.config.strategy.burstAttackCountPerBeast);
    }
    // Dead beasts always need (revivalCount + 1) potions regardless of attack count.
    // Either the budget covers it or it doesn't — no need to loop.
    const needed = Math.max(0, Math.floor(revivalCount)) + 1;
    const budget = Math.max(0, Math.floor(maxRevivalBudget));
    return needed <= budget
      ? Math.max(20, this.config.strategy.burstAttackCountPerBeast)
      : 1; // Can't afford revival — minimum attack count
  }
}
