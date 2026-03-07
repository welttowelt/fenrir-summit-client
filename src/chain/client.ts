import { RpcProvider, Contract, hash } from "starknet";
import SessionProvider from "@cartridge/controller/session/node";
import type { FenrirConfig } from "../config.js";
import { loadSummitAbi, extractFunctionNamesFromAbi } from "./abi.js";
import {
  discoverPotionTokenAddresses,
  SESSION_APPROVAL_AMOUNT_DEFAULT,
  TOKEN_ADDRESS_GETTERS,
} from "./token-addresses.js";
import { Logger } from "../utils/logger.js";
import type { ApiBeast } from "../api/types.js";

const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";
const HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK = 5;
const ALLOWANCE_ENSURE_COOLDOWN_MS = 5 * 60 * 1000;

type LiveStatsRow = {
  health: number;
  bonus_health: number;
  last_death_timestamp: number;
  spirit: number;
  extra_lives: number;
  revival_count: number;
  attack_streak: number;
  bonus_xp: number;
  summit_held_seconds: number;
  rewards_earned: number;
  rewards_claimed: number;
  quest_captured_summit: number;
  quest_used_revival_potion: number;
  quest_used_attack_potion: number;
  quest_max_attack_streak: number;
};

type AllowanceEnsureResult = {
  attempted: boolean;
  success: boolean;
  txHash?: string;
  reason?: string;
};

export class ChainClient {
  private config: FenrirConfig;
  private logger: Logger;
  private provider!: RpcProvider;
  private sessionAccount!: any; // WalletAccount from Cartridge SessionProvider.probe()
  private contract!: Contract;
  private attackEntrypoint = "attack_summit";
  private hasRequestRandom = false;
  private hasApplyPoison = false;
  private hasAddExtraLife = false;
  private poisonEventSelector = hash.getSelectorFromName("PoisonEvent");
  private functionNames = new Set<string>();
  private potionTokenAddresses: string[] = [];
  private sessionApprovalAmount = SESSION_APPROVAL_AMOUNT_DEFAULT;
  private allowanceEnsureInFlight: Promise<AllowanceEnsureResult> | null = null;
  private allowanceEnsureCooldownUntil = 0;
  private extraLifePotionPerTxCap = HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK;

  constructor(config: FenrirConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.extraLifePotionPerTxCap = Math.max(
      0,
      Math.min(
        HARD_MAX_EXTRA_LIFE_POTIONS_PER_ATTACK,
        Math.floor(Number(config.strategy.extraLifePotionsPerAttack ?? 0))
      )
    );
  }

  async init(): Promise<void> {
    this.provider = new RpcProvider({
      nodeUrl: this.config.chain.rpcUrl,
      blockIdentifier: "latest",
    });

    // Load ABI
    const abi = await loadSummitAbi(this.config.chain.rpcUrl, this.config.chain.summitContract);
    this.functionNames = extractFunctionNamesFromAbi(abi);
    this.logger.info(`ABI loaded: ${abi.length} entries`);

    const attackCandidates = ["attack", "attack_summit"].filter((name) =>
      this.functionNames.has(name)
    );
    if (attackCandidates.length === 0) {
      throw new Error("No attack entrypoint found in Summit ABI (expected attack or attack_summit)");
    }
    this.attackEntrypoint = attackCandidates[0]!;
    this.hasRequestRandom = this.functionNames.has("request_random");
    this.hasApplyPoison = this.functionNames.has("apply_poison");
    this.hasAddExtraLife = this.functionNames.has("add_extra_life");

    // Contract uses positional args in starknet.js v6
    this.contract = new Contract(abi, this.config.chain.summitContract, this.provider);

    const summitMethods: Array<{ name: string; entrypoint: string }> = [
      ...attackCandidates.map((name) => ({ name, entrypoint: name })),
    ];
    if (this.hasRequestRandom) {
      summitMethods.push({ name: "request_random", entrypoint: "request_random" });
    }
    if (this.functionNames.has("claim_rewards")) {
      summitMethods.push({ name: "claim_rewards", entrypoint: "claim_rewards" });
    }
    if (this.functionNames.has("claim_quest_rewards")) {
      summitMethods.push({ name: "claim_quest_rewards", entrypoint: "claim_quest_rewards" });
    }
    if (this.hasApplyPoison) {
      summitMethods.push({ name: "apply_poison", entrypoint: "apply_poison" });
    }
    if (this.hasAddExtraLife) {
      summitMethods.push({ name: "add_extra_life", entrypoint: "add_extra_life" });
    }
    const potionTokenAddresses = await discoverPotionTokenAddresses(
      this.contract,
      this.functionNames,
      { retriesPerGetter: 6, retryDelayMs: 250 }
    );
    const sessionApprovalAmount =
      process.env.FENRIR_SESSION_APPROVAL_AMOUNT ?? SESSION_APPROVAL_AMOUNT_DEFAULT;
    this.potionTokenAddresses = potionTokenAddresses;
    this.sessionApprovalAmount = sessionApprovalAmount;

    this.logger.info("Detected Summit entrypoints", {
      attackEntrypoint: this.attackEntrypoint,
      hasRequestRandom: this.hasRequestRandom,
      hasAddExtraLife: this.hasAddExtraLife,
      sessionMethods: summitMethods.map((m) => m.entrypoint),
      approvalTokens: potionTokenAddresses.length,
      extraLifePotionCap: this.extraLifePotionPerTxCap,
    });
    if (potionTokenAddresses.length === 0) {
      this.logger.warn(
        "[ALLOWANCE] Potion token address discovery returned 0 entries; allowance auto-repair may require retry"
      );
    }

    const contracts: Record<string, { methods: any[] }> = {
      [this.config.chain.summitContract]: {
        methods: summitMethods,
      },
      [VRF_PROVIDER_ADDRESS]: {
        methods: [
          { name: "request_random", entrypoint: "request_random" },
        ],
      },
    };
    for (const tokenAddress of potionTokenAddresses) {
      if (contracts[tokenAddress]) continue;
      contracts[tokenAddress] = {
        methods: [
          {
            name: "approve",
            entrypoint: "approve",
            spender: this.config.chain.summitContract,
            amount: sessionApprovalAmount,
            authorized: true,
          },
        ],
      };
    }

    // Initialize Cartridge session
    const sessionDir = this.config.session.file.replace(/session\.json$/, this.config.session.dirName);
    const sessionProvider = new SessionProvider({
      rpc: this.config.chain.rpcUrl,
      chainId: "0x534e5f4d41494e", // SN_MAIN
      policies: {
        contracts,
      },
      basePath: sessionDir,
    });

    // probe() returns a WalletAccount if session is valid
    const account = await sessionProvider.probe();
    if (!account) {
      throw new Error(
        "Cartridge session invalid/expired. Run: NODE_OPTIONS='--experimental-wasm-modules --dns-result-order=ipv4first' npx tsx src/bootstrap/create-session.ts",
      );
    }
    this.sessionAccount = account;
    this.logger.info("Cartridge session loaded and valid");
  }

  private async refreshPotionTokenAddresses(): Promise<string[]> {
    const refreshed = await discoverPotionTokenAddresses(
      this.contract,
      this.functionNames,
      { retriesPerGetter: 6, retryDelayMs: 250 }
    );
    if (refreshed.length > 0) {
      this.potionTokenAddresses = refreshed;
    }
    return this.potionTokenAddresses;
  }

  private async readAllowance(
    tokenAddress: string,
    owner: string,
    spender: string
  ): Promise<bigint | null> {
    try {
      const raw = await this.provider.callContract({
        contractAddress: tokenAddress as any,
        entrypoint: "allowance",
        calldata: [owner, spender],
      } as any);
      const parts = Array.isArray(raw) ? raw : [];
      if (parts.length === 0) return null;
      const low = BigInt(String(parts[0]));
      const high = parts.length > 1 ? BigInt(String(parts[1])) : 0n;
      if (low < 0n || high < 0n) return null;
      return low + (high << 128n);
    } catch {
      return null;
    }
  }

  async ensurePotionAllowances(options?: {
    force?: boolean;
    reason?: string;
  }): Promise<AllowanceEnsureResult> {
    const force = options?.force === true;
    const reason = options?.reason ?? "unspecified";
    if (!force && Date.now() < this.allowanceEnsureCooldownUntil) {
      return {
        attempted: false,
        success: true,
        reason: "cooldown",
      };
    }
    if (this.allowanceEnsureInFlight) {
      return this.allowanceEnsureInFlight;
    }

    this.allowanceEnsureInFlight = (async (): Promise<AllowanceEnsureResult> => {
      const expectedGetterCount = TOKEN_ADDRESS_GETTERS.filter((name) =>
        this.functionNames.has(name)
      ).length;
      const tokens =
        this.potionTokenAddresses.length > 0
          ? this.potionTokenAddresses
          : await this.refreshPotionTokenAddresses();
      if (tokens.length === 0) {
        return {
          attempted: false,
          success: false,
          reason: `no_token_addresses (expected_getters=${expectedGetterCount})`,
        };
      }

      const owner = String(this.sessionAccount?.address ?? this.config.account.controllerAddress);
      const spender = this.config.chain.summitContract;
      const targetAmount = BigInt(this.sessionApprovalAmount);
      const needsApproval: string[] = [];

      for (const tokenAddress of tokens) {
        const allowance = await this.readAllowance(tokenAddress, owner, spender);
        if (allowance === null || allowance < targetAmount) {
          needsApproval.push(tokenAddress);
        }
      }

      if (needsApproval.length === 0) {
        this.allowanceEnsureCooldownUntil = Date.now() + ALLOWANCE_ENSURE_COOLDOWN_MS;
        return {
          attempted: false,
          success: true,
          reason: "already_sufficient",
        };
      }

      const low = (targetAmount & ((1n << 128n) - 1n)).toString();
      const high = (targetAmount >> 128n).toString();
      const calls = needsApproval.map((tokenAddress) => ({
        contractAddress: tokenAddress,
        entrypoint: "approve",
        calldata: [spender, low, high],
      }));

      this.logger.warn(
        `[ALLOWANCE] Refreshing summit allowances for ${needsApproval.length}/${tokens.length} tokens (${reason})`
      );
      const result = await this.sessionAccount.execute(calls);
      const txHash = (result as any)?.transaction_hash ?? (result as any)?.transactionHash;
      if (!txHash) {
        throw new Error("Allowance approval execute returned no transaction hash");
      }
      this.logger.info(`[ALLOWANCE] Approval tx submitted: ${txHash}`);

      const receipt = await this.provider.waitForTransaction(txHash, {
        retryInterval: this.config.chain.txWaitIntervalMs,
      });
      if ((receipt as any).execution_status === "REVERTED") {
        const revertReason = (receipt as any).revert_reason || "unknown";
        throw new Error(`Allowance approval reverted: ${revertReason}`);
      }

      this.allowanceEnsureCooldownUntil = Date.now() + ALLOWANCE_ENSURE_COOLDOWN_MS;
      return {
        attempted: true,
        success: true,
        txHash,
      };
    })()
      .catch((err: unknown) => {
        return {
          attempted: true,
          success: false,
          reason: String(err),
        };
      })
      .finally(() => {
        this.allowanceEnsureInFlight = null;
      });

    return this.allowanceEnsureInFlight;
  }

  async getSummitHolder(): Promise<any> {
    try {
      const result = await this.contract.call("get_summit_beast");
      return result;
    } catch (err) {
      this.logger.debug(`get_summit_beast call failed: ${err}`);
      return null;
    }
  }

  async getBeastOwner(tokenId: number): Promise<string | null> {
    const result = (await this.provider.callContract({
      contractAddress: this.config.chain.beastContract,
      entrypoint: "owner_of",
      calldata: [String(tokenId), "0"],
    })) as string[];
    if (!result?.[0]) return null;
    const hex = result[0].replace(/^0x/i, "").toLowerCase().replace(/^0+/, "");
    return `0x${hex.length > 0 ? hex : "0"}`;
  }

  private extractPoisonCount(rawHolder: unknown): number {
    const root = (rawHolder as any)?.live ?? rawHolder;
    if (!root || typeof root !== "object") return 0;

    const seen = new Set<unknown>();
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let maxPoison = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const { value, depth } = current;
      if (!value || typeof value !== "object") continue;
      if (depth > 5) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") {
            stack.push({ value: item, depth: depth + 1 });
          }
        }
        continue;
      }

      for (const [keyRaw, inner] of Object.entries(value as Record<string, unknown>)) {
        const key = keyRaw.toLowerCase();
        const keyLooksLikePoison =
          key.includes("poison") && !key.includes("potion") && !key.includes("address");
        if (keyLooksLikePoison) {
          const numeric = Number(inner);
          if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100_000) {
            maxPoison = Math.max(maxPoison, Math.floor(numeric));
          }
        }
        if (inner && typeof inner === "object") {
          stack.push({ value: inner, depth: depth + 1 });
        }
      }
    }

    return maxPoison;
  }

  private feltToNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    try {
      const big = BigInt(String(value));
      if (big <= 0n) return 0;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
      return Number(big);
    } catch {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      return Math.floor(numeric);
    }
  }

  async getRecentPoisonAppliedCountForBeast(
    beastTokenId: number,
    lookbackBlocks = 300
  ): Promise<number> {
    const normalizedTokenId = Math.max(1, Math.floor(Number(beastTokenId)));
    if (!Number.isFinite(normalizedTokenId) || normalizedTokenId <= 0) return 0;

    const latestBlock = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - Math.max(20, Math.floor(lookbackBlocks)));
    let continuationToken: string | undefined;
    let latestPoisonCount = 0;
    let latestPoisonBlock = -1;
    let page = 0;
    const maxPages = 6;

    do {
      const chunk = await this.provider.getEvents({
        address: this.config.chain.summitContract as any,
        from_block: { block_number: fromBlock } as any,
        to_block: { block_number: latestBlock } as any,
        keys: [[this.poisonEventSelector]],
        continuation_token: continuationToken,
        chunk_size: 128,
      } as any);
      const events = Array.isArray((chunk as any).events) ? (chunk as any).events : [];
      for (const event of events) {
        const data = Array.isArray((event as any).data) ? (event as any).data : [];
        const tokenId = this.feltToNumber(data[0]);
        if (tokenId !== normalizedTokenId) continue;
        const poisonCount = this.feltToNumber(data[1]);
        const blockNumber = this.feltToNumber((event as any).block_number);
        if (blockNumber > latestPoisonBlock) {
          latestPoisonBlock = blockNumber;
          latestPoisonCount = poisonCount;
        } else if (blockNumber === latestPoisonBlock) {
          // Keep the last event seen in the most recent block.
          latestPoisonCount = poisonCount;
        }
      }
      continuationToken = (chunk as any).continuation_token ?? undefined;
      page += 1;
    } while (continuationToken && page < maxPages);

    return latestPoisonCount;
  }

  async getSummitHolderApiShape(): Promise<ApiBeast | null> {
    const raw = await this.getSummitHolder();
    if (!raw || typeof raw !== "object") return null;

    const fixed = (raw as any).fixed ?? {};
    const live = (raw as any).live ?? {};
    const stats = live.stats ?? {};
    const quest = live.quest ?? {};
    const tokenId = Number(live.token_id ?? 0);
    if (!Number.isFinite(tokenId) || tokenId <= 0) return null;

    const currentHealth = Number(live.current_health ?? fixed.health ?? 0);

    return {
      token_id: tokenId,
      beast_id: Number(fixed.id ?? 0),
      prefix: Number(fixed.prefix ?? 0),
      suffix: Number(fixed.suffix ?? 0),
      level: Number(fixed.level ?? 0),
      health: currentHealth,
      current_health: currentHealth,
      bonus_health: Number(live.bonus_health ?? 0),
      owner: "0x0",
      extra_lives: Number(live.extra_lives ?? 0),
      revival_count: Number(live.revival_count ?? 0),
      bonus_xp: Number(live.bonus_xp ?? 0),
      last_death_timestamp: Number(live.last_death_timestamp ?? 0),
      summit_held_seconds: Number(live.summit_held_seconds ?? 0),
      rewards_earned: Number(live.rewards_earned ?? 0),
      rewards_claimed: Number(live.rewards_claimed ?? 0),
      quest_captured_summit: Number(quest.captured_summit ?? 0),
      quest_used_revival_potion: Number(quest.used_revival_potion ?? 0),
      quest_used_attack_potion: Number(quest.used_attack_potion ?? 0),
      quest_max_attack_streak: Number(quest.max_attack_streak ?? 0),
      poison_count: this.extractPoisonCount(raw),
      spirit: Number(stats.spirit ?? 0),
      luck: Number(stats.luck ?? 0),
    };
  }

  async getLiveStats(tokenIds: number[]): Promise<Map<number, LiveStatsRow>> {
    const normalizedTokenIds = [...new Set(
      tokenIds
        .map((id) => Math.floor(Number(id)))
        .filter((id) => Number.isFinite(id) && id > 0)
    )];
    const stats = new Map<number, LiveStatsRow>();
    if (normalizedTokenIds.length === 0) {
      return stats;
    }

    const upsertRows = (rows: any[]): void => {
      for (const row of rows) {
        const tokenId = Number(row?.token_id ?? 0);
        if (!tokenId) continue;
        const quest = row?.quest ?? {};
        const rowStats = row?.stats ?? {};
        stats.set(tokenId, {
          health: Number(row?.current_health ?? row?.health ?? 0),
          bonus_health: Number(row?.bonus_health ?? 0),
          last_death_timestamp: Number(row?.last_death_timestamp ?? 0),
          spirit: Number(rowStats?.spirit ?? row?.spirit ?? 0),
          extra_lives: Number(row?.extra_lives ?? 0),
          revival_count: Number(row?.revival_count ?? 0),
          attack_streak: Number(row?.attack_streak ?? 0),
          bonus_xp: Number(row?.bonus_xp ?? 0),
          summit_held_seconds: Number(row?.summit_held_seconds ?? 0),
          rewards_earned: Number(row?.rewards_earned ?? 0),
          rewards_claimed: Number(row?.rewards_claimed ?? 0),
          quest_captured_summit: Number(quest?.captured_summit ?? 0),
          quest_used_revival_potion: Number(quest?.used_revival_potion ?? 0),
          quest_used_attack_potion: Number(quest?.used_attack_potion ?? 0),
          quest_max_attack_streak: Number(quest?.max_attack_streak ?? 0),
        });
      }
    };

    if (this.functionNames.has("get_live_stats")) {
      try {
        const configuredBatchSize = Number(process.env.FENRIR_LIVE_STATS_BATCH ?? 120);
        const batchSize = Math.max(1, Math.floor(configuredBatchSize));
        const configuredConcurrency = Number(process.env.FENRIR_LIVE_STATS_CONCURRENCY ?? 4);
        const concurrency = Math.max(1, Math.floor(configuredConcurrency));

        const batches: number[][] = [];
        for (let i = 0; i < normalizedTokenIds.length; i += batchSize) {
          batches.push(normalizedTokenIds.slice(i, i + batchSize));
        }

        if (batches.length > 1) {
          this.logger.debug(
            `[CHAIN] get_live_stats batching tokenIds=${normalizedTokenIds.length} batchSize=${batchSize} batches=${batches.length} concurrency=${concurrency}`
          );
        }

        for (let i = 0; i < batches.length; i += concurrency) {
          const group = batches.slice(i, i + concurrency);
          const rowsByBatch = await Promise.all(
            group.map(async (batch) => {
              const result: any = await this.contract.call("get_live_stats", [batch]);
              const rows =
                Array.isArray(result) ? result :
                Array.isArray(result?.snapshot) ? result.snapshot :
                [];
              return rows as any[];
            })
          );
          for (const rows of rowsByBatch) {
            upsertRows(rows);
          }
        }

        if (stats.size > 0) {
          return stats;
        }
      } catch {
        // Fall back to get_beast_stats on older ABIs or transient batch failures.
      }
    }

    if (!this.functionNames.has("get_beast_stats")) {
      return stats;
    }

    for (const id of normalizedTokenIds) {
      if (stats.has(id)) continue;
      try {
        const result = await this.contract.call("get_beast_stats", [id]);
        stats.set(id, {
          health: Number((result as any).health ?? 0),
          bonus_health: Number((result as any).bonus_health ?? 0),
          last_death_timestamp: Number((result as any).last_death_timestamp ?? 0),
          spirit: Number((result as any).stats?.spirit ?? (result as any).spirit ?? 0),
          extra_lives: Number((result as any).extra_lives ?? 0),
          revival_count: Number((result as any).revival_count ?? 0),
          attack_streak: Number((result as any).attack_streak ?? 0),
          bonus_xp: Number((result as any).bonus_xp ?? 0),
          summit_held_seconds: Number((result as any).summit_held_seconds ?? 0),
          rewards_earned: Number((result as any).rewards_earned ?? 0),
          rewards_claimed: Number((result as any).rewards_claimed ?? 0),
          quest_captured_summit: Number((result as any).quest?.captured_summit ?? 0),
          quest_used_revival_potion: Number((result as any).quest?.used_revival_potion ?? 0),
          quest_used_attack_potion: Number((result as any).quest?.used_attack_potion ?? 0),
          quest_max_attack_streak: Number((result as any).quest?.max_attack_streak ?? 0),
        });
      } catch {
        // Beast might not exist on-chain
      }
    }
    return stats;
  }

  async getLiveStat(tokenId: number): Promise<LiveStatsRow | null> {
    const normalizedId = Math.floor(Number(tokenId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      return null;
    }

    if (this.functionNames.has("get_beast")) {
      try {
        const result: any = await this.contract.call("get_beast", [normalizedId]);
        const fixed = result?.fixed ?? {};
        const live = result?.live ?? result ?? {};
        const stats = live?.stats ?? {};
        const quest = live?.quest ?? {};
        return {
          health: Number(live?.current_health ?? live?.health ?? 0),
          bonus_health: Number(live?.bonus_health ?? fixed?.bonus_health ?? 0),
          last_death_timestamp: Number(live?.last_death_timestamp ?? 0),
          spirit: Number(stats?.spirit ?? live?.spirit ?? 0),
          extra_lives: Number(live?.extra_lives ?? 0),
          revival_count: Number(live?.revival_count ?? 0),
          attack_streak: Number(live?.attack_streak ?? 0),
          bonus_xp: Number(live?.bonus_xp ?? 0),
          summit_held_seconds: Number(live?.summit_held_seconds ?? 0),
          rewards_earned: Number(live?.rewards_earned ?? 0),
          rewards_claimed: Number(live?.rewards_claimed ?? 0),
          quest_captured_summit: Number(quest?.captured_summit ?? 0),
          quest_used_revival_potion: Number(quest?.used_revival_potion ?? 0),
          quest_used_attack_potion: Number(quest?.used_attack_potion ?? 0),
          quest_max_attack_streak: Number(quest?.max_attack_streak ?? 0),
        };
      } catch {
        // Fall through to get_beast_stats
      }
    }

    if (this.functionNames.has("get_beast_stats")) {
      try {
        const result = await this.contract.call("get_beast_stats", [normalizedId]);
        return {
          health: Number((result as any).health ?? 0),
          bonus_health: Number((result as any).bonus_health ?? 0),
          last_death_timestamp: Number((result as any).last_death_timestamp ?? 0),
          spirit: Number((result as any).stats?.spirit ?? (result as any).spirit ?? 0),
          extra_lives: Number((result as any).extra_lives ?? 0),
          revival_count: Number((result as any).revival_count ?? 0),
          attack_streak: Number((result as any).attack_streak ?? 0),
          bonus_xp: Number((result as any).bonus_xp ?? 0),
          summit_held_seconds: Number((result as any).summit_held_seconds ?? 0),
          rewards_earned: Number((result as any).rewards_earned ?? 0),
          rewards_claimed: Number((result as any).rewards_claimed ?? 0),
          quest_captured_summit: Number((result as any).quest?.captured_summit ?? 0),
          quest_used_revival_potion: Number((result as any).quest?.used_revival_potion ?? 0),
          quest_used_attack_potion: Number((result as any).quest?.used_attack_potion ?? 0),
          quest_max_attack_streak: Number((result as any).quest?.max_attack_streak ?? 0),
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  async getQuestRewardsClaimed(tokenIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (!this.functionNames.has("get_quest_rewards_claimed")) return result;

    const normalizedIds = [...new Set(
      tokenIds
        .map((id) => Math.floor(Number(id)))
        .filter((id) => Number.isFinite(id) && id > 0)
    )];
    if (normalizedIds.length === 0) return result;

    const configuredConcurrency = Number(
      process.env.FENRIR_QUEST_CLAIM_QUERY_CONCURRENCY ?? 12
    );
    const concurrency = Math.max(1, Math.floor(configuredConcurrency));

    for (let i = 0; i < normalizedIds.length; i += concurrency) {
      const group = normalizedIds.slice(i, i + concurrency);
      const rows = await Promise.all(
        group.map(async (id) => {
          try {
            const raw = await this.contract.call("get_quest_rewards_claimed", [id]);
            const claimed = Number(
              Array.isArray(raw) ? raw[0] :
              (raw as any)?.value ?? raw
            );
            return {
              id,
              claimed: Number.isFinite(claimed) ? Math.max(0, Math.floor(claimed)) : null,
            };
          } catch {
            return { id, claimed: null };
          }
        })
      );

      for (const row of rows) {
        if (row.claimed === null) continue;
        result.set(row.id, row.claimed);
      }
    }
    return result;
  }

  async claimQuestRewards(beastTokenIds: number[]): Promise<{ txHash: string; receipt: any }> {
    if (beastTokenIds.length === 0) {
      throw new Error("No beast token ids provided for claimQuestRewards");
    }
    if (!this.functionNames.has("claim_quest_rewards")) {
      throw new Error("claim_quest_rewards not available in Summit ABI");
    }

    const call = this.contract.populate("claim_quest_rewards", {
      beast_token_ids: beastTokenIds,
    } as any);
    const calldata = (call.calldata ?? []) as string[];
    if (calldata.length === 0) {
      throw new Error("Failed to encode calldata for claim_quest_rewards");
    }

    this.logger.debug(`Executing claim_quest_rewards for ${beastTokenIds.length} beasts`);
    const result = await this.sessionAccount.execute([
      {
        contractAddress: this.config.chain.summitContract,
        entrypoint: "claim_quest_rewards",
        calldata,
      },
    ]);
    const txHash = result.transaction_hash;
    this.logger.info(`Quest claim tx submitted: ${txHash}`);

    const receipt = await this.provider.waitForTransaction(txHash, {
      retryInterval: this.config.chain.txWaitIntervalMs,
    });
    const execStatus = (receipt as any).execution_status;
    if (execStatus === "REVERTED") {
      const revertReason = (receipt as any).revert_reason || "unknown";
      throw new Error(`Quest claim REVERTED: ${revertReason}`);
    }
    return { txHash, receipt };
  }

  async attack(payload: {
    defendingBeastTokenId: number;
    attackingBeasts: Array<[number, number, number]>; // [tokenId, attackCount, attackPotions]
    revivalPotions: number;
    extraLifePotions: number;
    useVrf: boolean;
  }): Promise<{ txHash: string; receipt: any }> {
    const { defendingBeastTokenId, attackingBeasts, revivalPotions, extraLifePotions, useVrf } = payload;
    const effectiveVrf = useVrf;
    const normalizedExtraLifePotions = Math.max(
      0,
      Math.min(this.extraLifePotionPerTxCap, Math.floor(Number(extraLifePotions ?? 0)))
    );

    const attackArgs = this.attackEntrypoint === "attack"
      ? {
          defending_beast_token_id: defendingBeastTokenId,
          attacking_beasts: attackingBeasts,
          revival_potions: revivalPotions,
          extra_life_potions: normalizedExtraLifePotions,
          vrf: effectiveVrf,
        }
      : {
          beast_token_id: defendingBeastTokenId,
          attacking_beasts: attackingBeasts.map(([tokenId, atkPots, revPots]) => ({
            token_id: tokenId,
            attack_potions: atkPots,
            revival_potions: revPots,
          })),
          revival_potions: revivalPotions,
          extra_life_potions: normalizedExtraLifePotions,
        };
    const attackCall = this.contract.populate(this.attackEntrypoint, attackArgs as any);
    const compiledAttackCalldata = (attackCall.calldata ?? []) as string[];
    if (compiledAttackCalldata.length === 0) {
      throw new Error(`Failed to encode calldata for ${this.attackEntrypoint}`);
    }

    // Build calls array — if VRF, prepend request_random
    const calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }> = [];

    if (effectiveVrf && this.hasRequestRandom) {
      const requestRandomCall = this.contract.populate("request_random", []);
      const requestRandomCalldata = (requestRandomCall.calldata ?? []) as string[];
      calls.push({
        contractAddress: this.config.chain.summitContract,
        entrypoint: "request_random",
        calldata: requestRandomCalldata,
      });
    } else if (effectiveVrf) {
      const accountAddress = this.sessionAccount?.address ?? this.config.account.controllerAddress;
      // request_random(caller=Summit, source=Nonce(account)) on external VRF provider.
      // Summit later consumes with Source::Nonce(tx caller), so caller must be summitContract.
      calls.push({
        contractAddress: VRF_PROVIDER_ADDRESS,
        entrypoint: "request_random",
        calldata: [this.config.chain.summitContract, "0", accountAddress],
      });
    }

    calls.push({
      contractAddress: this.config.chain.summitContract,
      entrypoint: this.attackEntrypoint,
      calldata: compiledAttackCalldata,
    });

    this.logger.debug(
      `Executing ${calls.length} calls (VRF=${effectiveVrf}, attack=${this.attackEntrypoint}, requestRandom=${this.hasRequestRandom}, revivalPotions=${revivalPotions}, extraLifePotions=${normalizedExtraLifePotions})`,
      {
        attackingBeasts,
      }
    );

    // Execute via session account (WalletAccount from probe())
    const result = await this.sessionAccount.execute(calls);
    const txHash = result.transaction_hash;

    this.logger.info(`Tx submitted: ${txHash}`);

    // Wait for transaction to be included
    const receipt = await this.provider.waitForTransaction(txHash, {
      retryInterval: this.config.chain.txWaitIntervalMs,
    });

    // Critical: Check for reverted transactions
    const execStatus = (receipt as any).execution_status;
    if (execStatus === "REVERTED") {
      const revertReason = (receipt as any).revert_reason || "unknown";
      throw new Error(`Transaction REVERTED: ${revertReason}`);
    }

    return { txHash, receipt };
  }

  async applyPoison(beastTokenId: number, count: number): Promise<{ txHash: string; receipt: any }> {
    if (!this.hasApplyPoison) {
      throw new Error("apply_poison not available in Summit ABI");
    }
    const normalizedBeastId = Math.max(1, Math.floor(beastTokenId));
    const normalizedCount = Math.max(1, Math.floor(count));

    const call = this.contract.populate("apply_poison", {
      beast_token_id: normalizedBeastId,
      count: normalizedCount,
    } as any);
    const calldata = (call.calldata ?? []) as string[];
    if (calldata.length === 0) {
      throw new Error("Failed to encode calldata for apply_poison");
    }

    this.logger.debug(`Executing apply_poison beast=${normalizedBeastId} count=${normalizedCount}`);
    const result = await this.sessionAccount.execute([
      {
        contractAddress: this.config.chain.summitContract,
        entrypoint: "apply_poison",
        calldata,
      },
    ]);
    const txHash = result.transaction_hash;
    this.logger.info(`Poison tx submitted: ${txHash}`);

    const receipt = await this.provider.waitForTransaction(txHash, {
      retryInterval: this.config.chain.txWaitIntervalMs,
    });
    const execStatus = (receipt as any).execution_status;
    if (execStatus === "REVERTED") {
      const revertReason = (receipt as any).revert_reason || "unknown";
      throw new Error(`Poison transaction REVERTED: ${revertReason}`);
    }
    return { txHash, receipt };
  }

  canAddExtraLife(): boolean {
    return this.hasAddExtraLife;
  }

  async addExtraLife(beastTokenId: number, extraLifePotions: number): Promise<{ txHash: string; receipt: any }> {
    if (!this.hasAddExtraLife) {
      throw new Error("add_extra_life not available in Summit ABI");
    }
    const normalizedBeastId = Math.max(1, Math.floor(beastTokenId));
    const normalizedPotions = Math.max(
      1,
      Math.min(this.extraLifePotionPerTxCap, Math.floor(extraLifePotions))
    );

    const call = this.contract.populate("add_extra_life", {
      beast_token_id: normalizedBeastId,
      extra_life_potions: normalizedPotions,
    } as any);
    const calldata = (call.calldata ?? []) as string[];
    if (calldata.length === 0) {
      throw new Error("Failed to encode calldata for add_extra_life");
    }

    this.logger.debug(
      `Executing add_extra_life beast=${normalizedBeastId} extraLifePotions=${normalizedPotions}`
    );
    const result = await this.sessionAccount.execute([
      {
        contractAddress: this.config.chain.summitContract,
        entrypoint: "add_extra_life",
        calldata,
      },
    ]);
    const txHash = result.transaction_hash;
    this.logger.info(`Extra-life tx submitted: ${txHash}`);

    const receipt = await this.provider.waitForTransaction(txHash, {
      retryInterval: this.config.chain.txWaitIntervalMs,
    });
    const execStatus = (receipt as any).execution_status;
    if (execStatus === "REVERTED") {
      const revertReason = (receipt as any).revert_reason || "unknown";
      throw new Error(`Extra-life transaction REVERTED: ${revertReason}`);
    }
    return { txHash, receipt };
  }
}
