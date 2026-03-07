import type { Contract } from "starknet";

export const TOKEN_ADDRESS_GETTERS = [
  "get_attack_potion_address",
  "get_revive_potion_address",
  "get_extra_life_potion_address",
  "get_poison_potion_address",
  "get_skull_token_address",
  "get_corpse_token_address",
] as const;

export const SESSION_APPROVAL_AMOUNT_DEFAULT =
  "340282366920938463463374607431768211455"; // u128 max

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === null || value === undefined) return null;

  try {
    const asBigInt = BigInt(String(value));
    if (asBigInt <= 0n) return null;
    return `0x${asBigInt.toString(16)}`;
  } catch {
    return null;
  }
}

export async function discoverPotionTokenAddresses(
  contract: Contract,
  functionNames: Set<string>,
  options?: {
    retriesPerGetter?: number;
    retryDelayMs?: number;
  }
): Promise<string[]> {
  const retriesPerGetter = Math.max(1, Math.floor(options?.retriesPerGetter ?? 4));
  const retryDelayMs = Math.max(50, Math.floor(options?.retryDelayMs ?? 250));
  const out: string[] = [];

  for (const getter of TOKEN_ADDRESS_GETTERS) {
    if (!functionNames.has(getter)) continue;
    for (let attempt = 1; attempt <= retriesPerGetter; attempt += 1) {
      try {
        const result = await contract.call(getter, []);
        const addr = normalizeAddress(result);
        if (addr) {
          out.push(addr.toLowerCase());
        }
        break;
      } catch {
        if (attempt >= retriesPerGetter) {
          break;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  return [...new Set(out)];
}
