import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { RpcProvider } from "starknet";

const ABI_CACHE_DIR = "./data/abi-cache";

function getAbiCachePath(contractAddress: string): string {
  const normalized = contractAddress
    .trim()
    .toLowerCase()
    .replace(/^0x/, "")
    .replace(/^0+/, "") || "0";
  return `${ABI_CACHE_DIR}/summit_${normalized}.json`;
}

export async function loadSummitAbi(rpcUrl: string, contractAddress: string): Promise<any[]> {
  const cachePath = getAbiCachePath(contractAddress);

  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch {
      // cache corrupted, re-fetch
    }
  }

  const provider = new RpcProvider({ nodeUrl: rpcUrl, blockIdentifier: "latest" });
  const classAt = await provider.getClassAt(contractAddress);
  const abi = (classAt as any).abi;
  if (!abi || !Array.isArray(abi)) {
    throw new Error("Failed to fetch Summit ABI from RPC");
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(abi, null, 2));
  return abi;
}

export function extractFunctionNamesFromAbi(abi: any[]): Set<string> {
  const names = new Set<string>();

  for (const entry of abi) {
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "function" && typeof entry.name === "string") {
      names.add(entry.name);
    }

    if (entry.type === "interface" && Array.isArray(entry.items)) {
      for (const item of entry.items) {
        if (item?.type === "function" && typeof item.name === "string") {
          names.add(item.name);
        }
      }
    }
  }

  return names;
}
