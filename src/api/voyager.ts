/**
 * Voyager Starknet Explorer API client.
 *
 * Provides decoded on-chain event lookups (poison spikes, battles, beast
 * updates) via Voyager's indexed API — faster and cheaper than scanning
 * raw RPC events.
 *
 * Auth: `X-API-KEY` header (not `x-apikey`, not query-param).
 * Base URL: https://api.voyager.online/beta/
 */

import { retry } from "../utils/time.js";
import { Logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface VoyagerEvent<T = Record<string, string>> {
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
  name: string;
  dataDecoded: Array<{ name: string; value: string | string[]; type: string }>;
}

export interface VoyagerEventsResponse {
  items: VoyagerEvent[];
  lastPage: number;
}

export interface DecodedPoisonEvent {
  beastTokenId: number;
  count: number;
  player: string;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
}

export interface DecodedBattleEvent {
  attackingBeastTokenId: number;
  attackIndex: number;
  defendingBeastTokenId: number;
  attackCount: number;
  attackDamage: number;
  criticalAttackCount: number;
  criticalAttackDamage: number;
  counterAttackCount: number;
  counterAttackDamage: number;
  criticalCounterAttackCount: number;
  criticalCounterAttackDamage: number;
  attackPotions: number;
  revivePotions: number;
  xpGained: number;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
}

export interface DecodedRewardsEarnedEvent {
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
  dataDecoded: Array<{ name: string; value: string; type: string }>;
}

// ── Client ─────────────────────────────────────────────────────────

export class VoyagerClient {
  private baseUrl: string;
  private apiKey: string;
  private summitContract: string;
  private logger: Logger;

  constructor(opts: {
    apiKey: string;
    summitContract: string;
    logger: Logger;
    baseUrl?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.summitContract = opts.summitContract;
    this.logger = opts.logger;
    this.baseUrl = (opts.baseUrl ?? "https://api.voyager.online/beta").replace(
      /\/$/,
      ""
    );
  }

  // ── Low-level fetch ────────────────────────────────────────────

  private async fetchEvents(params: {
    name?: string;
    pageSize?: number;
    page?: number;
    contract?: string;
  }): Promise<VoyagerEventsResponse> {
    const qs = new URLSearchParams();
    qs.set("contract", params.contract ?? this.summitContract);
    if (params.name) qs.set("name", params.name);
    qs.set("ps", String(params.pageSize ?? 25));
    if (params.page != null) qs.set("p", String(params.page));

    const url = `${this.baseUrl}/events?${qs}`;
    const res = await retry(() =>
      fetch(url, {
        headers: { "X-API-KEY": this.apiKey },
      })
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Voyager API ${res.status}: ${res.statusText} ${body.substring(0, 200)}`
      );
    }

    return res.json() as Promise<VoyagerEventsResponse>;
  }

  // ── Poison events ──────────────────────────────────────────────

  /**
   * Get recent PoisonEvents for a specific beast, ordered newest-first.
   * Returns the decoded poison count from the most recent event.
   *
   * This replaces the expensive RPC-based getRecentPoisonAppliedCountForBeast
   * which scans blocks via starknet_getEvents.
   */
  async getRecentPoisonForBeast(
    beastTokenId: number,
    maxEvents = 50
  ): Promise<number> {
    const tokenId = Math.max(1, Math.floor(Number(beastTokenId)));
    if (!Number.isFinite(tokenId) || tokenId <= 0) return 0;

    const tokenIdHex = "0x" + tokenId.toString(16);
    let latestCount = 0;
    let latestBlock = -1;

    try {
      const data = await this.fetchEvents({
        name: "PoisonEvent",
        pageSize: Math.min(maxEvents, 100),
      });

      for (const event of data.items) {
        const decoded = event.dataDecoded;
        if (!decoded || decoded.length < 2) continue;

        const eventTokenId = parseInt(String(decoded[0]?.value), 16);
        if (eventTokenId !== tokenId) continue;

        const count = parseInt(String(decoded[1]?.value), 16);
        if (event.blockNumber > latestBlock) {
          latestBlock = event.blockNumber;
          latestCount = count;
        } else if (event.blockNumber === latestBlock) {
          latestCount = count;
        }
      }
    } catch (err) {
      this.logger.debug(
        `[VOYAGER] Poison lookup failed for token=${beastTokenId}: ${String(err).substring(0, 200)}`
      );
    }

    return latestCount;
  }

  /**
   * Get all recent poison events (not filtered by beast), decoded.
   */
  async getRecentPoisonEvents(
    pageSize = 25
  ): Promise<DecodedPoisonEvent[]> {
    const data = await this.fetchEvents({
      name: "PoisonEvent",
      pageSize,
    });

    const result: DecodedPoisonEvent[] = [];
    for (const event of data.items) {
      const decoded = event.dataDecoded;
      if (!decoded || decoded.length < 3) continue;

      result.push({
        beastTokenId: parseInt(String(decoded[0]?.value), 16),
        count: parseInt(String(decoded[1]?.value), 16),
        player: String(decoded[2]?.value),
        blockNumber: event.blockNumber,
        timestamp: event.timestamp,
        transactionHash: event.transactionHash,
      });
    }

    return result;
  }

  // ── Battle events ──────────────────────────────────────────────

  /**
   * Get recent battle events. These show who attacked whom, damage dealt,
   * counter-attacks, potions used, and XP gained.
   */
  async getRecentBattles(pageSize = 25): Promise<DecodedBattleEvent[]> {
    const data = await this.fetchEvents({
      name: "BattleEvent",
      pageSize,
    });

    const result: DecodedBattleEvent[] = [];
    for (const event of data.items) {
      const d = event.dataDecoded;
      if (!d || d.length < 14) continue;

      result.push({
        attackingBeastTokenId: parseInt(String(d[0]?.value), 16),
        attackIndex: parseInt(String(d[1]?.value), 16),
        defendingBeastTokenId: parseInt(String(d[2]?.value), 16),
        attackCount: parseInt(String(d[3]?.value), 16),
        attackDamage: parseInt(String(d[4]?.value), 16),
        criticalAttackCount: parseInt(String(d[5]?.value), 16),
        criticalAttackDamage: parseInt(String(d[6]?.value), 16),
        counterAttackCount: parseInt(String(d[7]?.value), 16),
        counterAttackDamage: parseInt(String(d[8]?.value), 16),
        criticalCounterAttackCount: parseInt(String(d[9]?.value), 16),
        criticalCounterAttackDamage: parseInt(String(d[10]?.value), 16),
        attackPotions: parseInt(String(d[11]?.value), 16),
        revivePotions: parseInt(String(d[12]?.value), 16),
        xpGained: parseInt(String(d[13]?.value), 16),
        blockNumber: event.blockNumber,
        timestamp: event.timestamp,
        transactionHash: event.transactionHash,
      });
    }

    return result;
  }

  /**
   * Get recent battles targeting a specific defender beast.
   */
  async getBattlesForDefender(
    defenderTokenId: number,
    pageSize = 50
  ): Promise<DecodedBattleEvent[]> {
    const battles = await this.getRecentBattles(pageSize);
    return battles.filter((b) => b.defendingBeastTokenId === defenderTokenId);
  }

  /**
   * Get recent battles by a specific attacker beast.
   */
  async getBattlesForAttacker(
    attackerTokenId: number,
    pageSize = 50
  ): Promise<DecodedBattleEvent[]> {
    const battles = await this.getRecentBattles(pageSize);
    return battles.filter((b) => b.attackingBeastTokenId === attackerTokenId);
  }

  // ── All events (unfiltered) ────────────────────────────────────

  /**
   * Get recent events of any type from the summit contract.
   */
  async getRecentEvents(
    pageSize = 25
  ): Promise<VoyagerEventsResponse> {
    return this.fetchEvents({ pageSize });
  }

  // ── Contract info ──────────────────────────────────────────────

  /**
   * Get contract metadata (class hash, alias, timestamps, etc.)
   */
  async getContractInfo(address?: string): Promise<Record<string, any>> {
    const addr = address ?? this.summitContract;
    const url = `${this.baseUrl}/contracts/${addr}`;

    const res = await retry(() =>
      fetch(url, {
        headers: { "X-API-KEY": this.apiKey },
      })
    );

    if (!res.ok) {
      throw new Error(`Voyager API ${res.status}: ${res.statusText}`);
    }

    return res.json();
  }
}
