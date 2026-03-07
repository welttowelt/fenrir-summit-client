import { retry } from "../utils/time.js";
import type { ApiBeast, ApiBeastsResponse, ApiTopBeast } from "./types.js";

export class SummitApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private normalizeAddress(addr: string): string {
    if (!/^0x[0-9a-fA-F]+$/.test(addr)) {
      throw new Error(
        `Invalid controllerAddress "${addr}". Expected a Starknet hex address like 0x0123...`
      );
    }
    const hex = addr.replace(/^0x/i, "").toLowerCase();
    const normalized = "0x" + hex.padStart(64, "0");
    if (/^0x0{64}$/.test(normalized)) {
      throw new Error(
        "controllerAddress is unset (all zeros). Run bootstrap/create-session and use the returned account address."
      );
    }
    return normalized;
  }

  async health(): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  async getOwnerBeasts(ownerAddress: string): Promise<ApiBeast[]> {
    const addr = this.normalizeAddress(ownerAddress);
    const all: ApiBeast[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const res = await retry(() =>
        fetch(`${this.baseUrl}/beasts/all?owner=${addr}&limit=${limit}&offset=${offset}`)
      );
      const json: ApiBeastsResponse = await res.json();
      all.push(...json.data);
      if (!json.pagination.has_more) break;
      offset += limit;
    }
    return all;
  }

  async getSummitHolder(): Promise<ApiBeast | null> {
    const res = await retry(() =>
      fetch(`${this.baseUrl}/beasts/stats/top?limit=1`)
    );
    const json = await res.json() as { data: Array<{ token_id: number; owner: string }> };
    const top = json.data[0];
    if (!top) return null;

    const ownerBeasts = await this.getOwnerBeasts(top.owner);
    return ownerBeasts.find((b) => b.token_id === top.token_id) ?? null;
  }

  async getTopBeasts(limit = 25): Promise<ApiTopBeast[]> {
    const res = await retry(() =>
      fetch(`${this.baseUrl}/beasts/stats/top?limit=${limit}`)
    );
    const json = await res.json() as { data: ApiTopBeast[] };
    return json.data;
  }

  async getBeastCounts(): Promise<{ alive: number; dead: number }> {
    const res = await retry(() =>
      fetch(`${this.baseUrl}/beasts/stats/counts`)
    );
    return res.json();
  }

  async getLogs(opts: { limit?: number; category?: string; player?: string } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.category) params.set("category", opts.category);
    if (opts.player) params.set("player", opts.player);
    const res = await retry(() =>
      fetch(`${this.baseUrl}/logs?${params}`)
    );
    return res.json();
  }
}
