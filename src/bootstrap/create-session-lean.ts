#!/usr/bin/env tsx
/**
 * Create a lean Cartridge Controller session via browser-based auth.
 * This session only allows Summit attack + VRF flows.
 *
 * Usage: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/create-session-lean.ts config/yourprofile.json
 */

import SessionProvider from "@cartridge/controller/session/node";
import { readFileSync, writeFileSync } from "fs";
import { loadConfig } from "../config.js";
import { loadSummitAbi, extractFunctionNamesFromAbi } from "../chain/abi.js";
import { loadCartridgeSession } from "../chain/controller-signer.js";

const CHAIN_ID_MAINNET = "0x534e5f4d41494e";
const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

function syncControllerAddress(configPath: string, address?: string): void {
  if (!address) return;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (raw?.account?.controllerAddress === address) return;
    raw.account = raw.account ?? {};
    raw.account.controllerAddress = address;
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
    console.log(`Updated controllerAddress in ${configPath}: ${address}`);
  } catch (err) {
    console.warn(`Could not update controllerAddress in ${configPath}: ${err}`);
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2] || "config/yourprofile.json";
  const config = loadConfig(configPath);
  const sessionDir = config.session.file.replace(/session\.json$/, "cartridge-session-lean");

  console.log("Creating LEAN Cartridge session...");
  console.log(`  RPC: ${config.chain.rpcUrl}`);
  console.log(`  Contract: ${config.chain.summitContract}`);
  console.log(`  Session dir: ${sessionDir}`);
  console.log("");

  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const functionNames = extractFunctionNamesFromAbi(abi);
  const attackCandidates = ["attack", "attack_summit"].filter((name) => functionNames.has(name));
  if (attackCandidates.length === 0) {
    throw new Error("No attack entrypoint found in Summit ABI (expected attack or attack_summit)");
  }

  const summitMethods: Array<{ name: string; entrypoint: string }> = [
    ...attackCandidates.map((name) => ({ name, entrypoint: name })),
  ];
  if (functionNames.has("request_random")) {
    summitMethods.push({ name: "request_random", entrypoint: "request_random" });
  }
  if (functionNames.has("apply_poison")) {
    summitMethods.push({ name: "apply_poison", entrypoint: "apply_poison" });
  }

  console.log(`  Attack entrypoint preference: ${attackCandidates[0]}`);
  console.log(`  Summit request_random: ${functionNames.has("request_random") ? "yes" : "no (external VRF only)"}`);
  console.log(`  Session methods (lean): ${summitMethods.map((m) => m.entrypoint).join(", ")}`);
  console.log(`  External VRF method: request_random @ ${VRF_PROVIDER_ADDRESS}`);
  console.log("");

  const provider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_MAINNET,
    policies: {
      contracts: {
        [config.chain.summitContract]: {
          methods: summitMethods,
        },
        [VRF_PROVIDER_ADDRESS]: {
          methods: [{ name: "request_random", entrypoint: "request_random" }],
        },
      },
    },
    basePath: sessionDir,
  });

  const existing = await provider.probe();
  if (existing) {
    console.log("Existing valid lean session found.");
    console.log(`  Address: ${existing.address}`);
    syncControllerAddress(configPath, existing.address);
    return;
  }

  console.log("Opening browser for Cartridge keychain auth...");
  console.log("(Approve the LEAN policy in the browser window)");
  console.log("");

  const result = await provider.connect();
  if (!result) {
    throw new Error("Lean session creation returned no account. Approval likely timed out or did not complete.");
  }

  const persisted = loadCartridgeSession(sessionDir);
  const resolvedAddress = persisted.session.address || result.address;
  if (!resolvedAddress) {
    throw new Error("Lean session was created but no controller address was returned.");
  }

  console.log("Lean session created successfully.");
  console.log(`  Address: ${resolvedAddress}`);
  console.log(`  Stored at: ${sessionDir}/session.json`);
  syncControllerAddress(configPath, resolvedAddress);
}

main().catch((err) => {
  console.error("Lean session creation failed:", err);
  process.exit(1);
});
