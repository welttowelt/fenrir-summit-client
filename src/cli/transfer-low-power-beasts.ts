#!/usr/bin/env tsx
import SessionProvider from "@cartridge/controller/session/node";
import { RpcProvider } from "starknet";
import { loadConfig } from "../config.js";

const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";
const DEFAULT_TORII_URL = "https://api.cartridge.gg/x/pg-mainnet-10/torii/sql";
const DEFAULT_MAX_POWER = 200;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_QUERY_PAGE_SIZE = 500;

type Candidate = {
  tokenIdRaw: string;
  tokenIdDecimal: string;
  power: number;
};

type FailedTransfer = {
  tokenIdDecimal: string;
  power: number;
  error: string;
};

type SkippedTransfer = {
  tokenIdDecimal: string;
  power: number;
  reason: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeHexAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Invalid hex address: ${value}`);
  }
  const normalized = hex.replace(/^0+/, "") || "0";
  return `0x${normalized}`;
}

function padAddressForTorii(value: string): string {
  const norm = normalizeHexAddress(value);
  const hex = norm.slice(2);
  if (hex.length > 64) {
    throw new Error(`Address too long: ${value}`);
  }
  return `0x${hex.padStart(64, "0")}`;
}

function toPositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (!raw || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return n;
}

function parseTokenId(tokenIdRaw: string, expectedContract: string): string {
  const parts = tokenIdRaw.split(":");
  if (parts.length !== 2) {
    throw new Error(`Unexpected token_id format: ${tokenIdRaw}`);
  }
  const contract = normalizeHexAddress(parts[0]!);
  if (contract !== expectedContract) {
    throw new Error(`Token contract mismatch in token_id: got ${contract}, expected ${expectedContract}`);
  }
  return BigInt(parts[1]!).toString(10);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function fetchCandidates(params: {
  toriiSqlUrl: string;
  ownerAddress: string;
  beastContract: string;
  maxPowerExclusive: number;
  pageSize: number;
}): Promise<Candidate[]> {
  const ownerPadded = padAddressForTorii(params.ownerAddress);
  const contractPadded = padAddressForTorii(params.beastContract);
  const out: Candidate[] = [];
  let offset = 0;

  while (true) {
    const query = `
SELECT DISTINCT tb.token_id AS token_id, ta.trait_value AS power
FROM token_balances tb
JOIN token_attributes ta ON ta.token_id = tb.token_id
WHERE lower(tb.contract_address) = lower('${contractPadded}')
  AND lower(tb.account_address) = lower('${ownerPadded}')
  AND ta.trait_name = 'Power'
  AND CAST(ta.trait_value AS INTEGER) < ${Math.max(1, Math.floor(params.maxPowerExclusive))}
ORDER BY tb.token_id ASC
LIMIT ${Math.max(1, Math.floor(params.pageSize))} OFFSET ${Math.max(0, Math.floor(offset))}
`;

    const url = new URL(params.toriiSqlUrl);
    url.searchParams.set("query", query);
    let rows: Array<{ token_id?: string; power?: string | number }> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Torii SQL failed (${response.status} ${response.statusText})`);
        }
        rows = (await response.json()) as Array<{ token_id?: string; power?: string | number }>;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 5) {
          await sleep(800 * attempt);
        }
      }
    }
    if (!rows) {
      throw new Error(`Torii SQL request failed after retries: ${String(lastErr)}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      const tokenIdRaw = typeof row.token_id === "string" ? row.token_id : null;
      const powerRaw = row.power;
      const powerNum = Number(powerRaw);
      if (!tokenIdRaw || !Number.isFinite(powerNum)) continue;
      out.push({
        tokenIdRaw,
        tokenIdDecimal: parseTokenId(tokenIdRaw, params.beastContract),
        power: Math.floor(powerNum),
      });
    }

    if (rows.length < params.pageSize) break;
    offset += params.pageSize;
  }

  return out;
}

async function ownerOf(provider: RpcProvider, beastContract: string, tokenIdDecimal: string): Promise<string | null> {
  try {
    const result = (await provider.callContract({
      contractAddress: beastContract,
      entrypoint: "owner_of",
      calldata: [tokenIdDecimal, "0"],
    })) as string[];
    if (!result?.[0]) return null;
    return normalizeHexAddress(result[0]);
  } catch {
    return null;
  }
}

async function waitTx(provider: RpcProvider, txHash: string, retryIntervalMs: number) {
  const receipt = await provider.waitForTransaction(txHash, { retryInterval: retryIntervalMs });
  if ((receipt as any)?.execution_status === "REVERTED") {
    throw new Error(`Tx reverted ${txHash}: ${(receipt as any)?.revert_reason ?? "unknown revert reason"}`);
  }
}

async function transferSingle(params: {
  sessionAccount: any;
  provider: RpcProvider;
  beastContract: string;
  from: string;
  to: string;
  token: Candidate;
  retryIntervalMs: number;
}): Promise<string> {
  const tx = await params.sessionAccount.execute([
    {
      contractAddress: params.beastContract,
      entrypoint: "transfer_from",
      calldata: [params.from, params.to, params.token.tokenIdDecimal, "0"],
    },
  ]);
  const txHash = (tx as any)?.transaction_hash as string | undefined;
  if (!txHash) {
    throw new Error(`Missing tx hash for token ${params.token.tokenIdDecimal}`);
  }
  await waitTx(params.provider, txHash, params.retryIntervalMs);
  return txHash;
}

async function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const toRaw = process.argv[3] || process.env.TRANSFER_TO;
  if (!toRaw) {
    throw new Error("Usage: npx tsx src/cli/transfer-low-power-beasts.ts <configPath> <toAddress>");
  }

  const maxPowerExclusive = toPositiveInt(process.env.MAX_POWER, DEFAULT_MAX_POWER, "MAX_POWER");
  const batchSize = toPositiveInt(process.env.TRANSFER_BATCH_SIZE, DEFAULT_BATCH_SIZE, "TRANSFER_BATCH_SIZE");
  const queryPageSize = toPositiveInt(process.env.TRANSFER_QUERY_PAGE_SIZE, DEFAULT_QUERY_PAGE_SIZE, "TRANSFER_QUERY_PAGE_SIZE");
  const transferLimit = process.env.TRANSFER_LIMIT
    ? toPositiveInt(process.env.TRANSFER_LIMIT, 1, "TRANSFER_LIMIT")
    : null;
  const toriiSqlUrl = (process.env.TORII_SQL_URL || DEFAULT_TORII_URL).trim();
  const sessionDirName = (process.env.SESSION_DIR_NAME || "cartridge-session-transfer").trim();

  const config = loadConfig(configPath);
  const beastContract = normalizeHexAddress(config.chain.beastContract);
  const from = normalizeHexAddress(config.account.controllerAddress);
  const to = normalizeHexAddress(toRaw);
  if (from === to) {
    throw new Error("Source and destination addresses are the same");
  }

  const provider = new RpcProvider({ nodeUrl: config.chain.rpcUrl, blockIdentifier: "latest" });

  console.log("Scanning candidates from Torii SQL...");
  const all = await fetchCandidates({
    toriiSqlUrl,
    ownerAddress: from,
    beastContract,
    maxPowerExclusive,
    pageSize: queryPageSize,
  });
  const candidates = transferLimit ? all.slice(0, transferLimit) : all;

  console.log(
    `Candidates found: ${all.length}${transferLimit ? ` (capped to ${candidates.length} by TRANSFER_LIMIT)` : ""}`
  );
  if (candidates.length === 0) {
    console.log("Nothing to transfer.");
    return;
  }

  const sessionDir = config.session.file.replace(/session\.json$/, sessionDirName);
  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_SN_MAIN,
    policies: {
      contracts: {
        [beastContract]: {
          methods: [{ name: "transfer_from", entrypoint: "transfer_from" }],
        },
      },
    },
    basePath: sessionDir,
  });

  let sessionAccount = await sessionProvider.probe();
  if (!sessionAccount) {
    console.log("Approve transfer session in browser...");
    sessionAccount = await sessionProvider.connect();
  }
  if (!sessionAccount) {
    throw new Error("Unable to establish cartridge session account");
  }

  const transferBatches = chunk(candidates, batchSize);
  const transferred: Candidate[] = [];
  const failed: FailedTransfer[] = [];
  const skipped: SkippedTransfer[] = [];
  const txHashes: string[] = [];

  console.log(
    `Starting transfer: batches=${transferBatches.length}, batchSize=${batchSize}, from=${from}, to=${to}, maxPower<${maxPowerExclusive}`
  );

  for (let idx = 0; idx < transferBatches.length; idx += 1) {
    const batch = transferBatches[idx]!;
    const ownedBatch: Candidate[] = [];
    for (const token of batch) {
      const currentOwner = await ownerOf(provider, beastContract, token.tokenIdDecimal);
      if (currentOwner && currentOwner !== from) {
        skipped.push({
          tokenIdDecimal: token.tokenIdDecimal,
          power: token.power,
          reason: `owner is ${currentOwner}`,
        });
      } else {
        ownedBatch.push(token);
      }
    }
    if (ownedBatch.length === 0) {
      console.log(`[${idx + 1}/${transferBatches.length}] skipped batch (no tokens currently owned)`);
      continue;
    }

    const calls = ownedBatch.map((token) => ({
      contractAddress: beastContract,
      entrypoint: "transfer_from",
      calldata: [from, to, token.tokenIdDecimal, "0"],
    }));

    try {
      const tx = await sessionAccount.execute(calls);
      const txHash = (tx as any)?.transaction_hash as string | undefined;
      if (!txHash) {
        throw new Error("missing tx hash");
      }
      await waitTx(provider, txHash, config.chain.txWaitIntervalMs);
      txHashes.push(txHash);
      transferred.push(...ownedBatch);
      console.log(`[${idx + 1}/${transferBatches.length}] multicall success tokens=${ownedBatch.length} tx=${txHash}`);
    } catch (error) {
      console.warn(
        `[${idx + 1}/${transferBatches.length}] multicall failed (${formatError(error)}), retrying single calls for ${ownedBatch.length} tokens`
      );
      for (const token of ownedBatch) {
        try {
          const currentOwner = await ownerOf(provider, beastContract, token.tokenIdDecimal);
          if (currentOwner && currentOwner !== from) {
            skipped.push({
              tokenIdDecimal: token.tokenIdDecimal,
              power: token.power,
              reason: `owner changed before transfer (${currentOwner})`,
            });
            continue;
          }
          const txHash = await transferSingle({
            sessionAccount,
            provider,
            beastContract,
            from,
            to,
            token,
            retryIntervalMs: config.chain.txWaitIntervalMs,
          });
          txHashes.push(txHash);
          transferred.push(token);
          console.log(`[${idx + 1}/${transferBatches.length}] single success token=${token.tokenIdDecimal} tx=${txHash}`);
        } catch (singleError) {
            failed.push({
              tokenIdDecimal: token.tokenIdDecimal,
              power: token.power,
              error: formatError(singleError),
            });
          console.error(
            `[${idx + 1}/${transferBatches.length}] single failed token=${token.tokenIdDecimal} power=${token.power}: ${formatError(singleError)}`
          );
        }
      }
    }
  }

  const summary = {
    from,
    to,
    beastContract,
    maxPowerExclusive,
    requested: candidates.length,
    transferred: transferred.length,
    skipped: skipped.length,
    failed: failed.length,
    sampleTransferredTokenIds: transferred.slice(0, 20).map((x) => x.tokenIdDecimal),
    skippedDetails: skipped.slice(0, 20),
    failedDetails: failed.slice(0, 20),
    txHashes: txHashes.slice(-20),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error("transfer-low-power-beasts failed:", error);
  process.exit(1);
});
