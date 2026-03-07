#!/usr/bin/env tsx
/**
 * Create a Cartridge Controller session via browser-based auth.
 * Opens a browser window for Cartridge keychain login.
 *
 * Usage: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/create-session.ts config/userprofile.json
 */

import SessionProvider from "@cartridge/controller/session/node";
import { readFileSync, writeFileSync } from "fs";
import { Contract, RpcProvider } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi, extractFunctionNamesFromAbi } from "../chain/abi.js";
import { loadCartridgeSession } from "../chain/controller-signer.js";
import {
  discoverPotionTokenAddresses,
  SESSION_APPROVAL_AMOUNT_DEFAULT,
} from "../chain/token-addresses.js";

const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

function syncControllerAddress(configPath: string, address?: string) {
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

async function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const config = loadConfig(configPath);

  const sessionDir = config.session.file.replace(/session\.json$/, config.session.dirName);

  console.log("Creating Cartridge session...");
  console.log(`  RPC: ${config.chain.rpcUrl}`);
  console.log(`  Contract: ${config.chain.summitContract}`);
  console.log(`  Session dir: ${sessionDir}`);
  console.log("");

  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const functionNames = extractFunctionNamesFromAbi(abi);
  const attackCandidates = ["attack", "attack_summit"].filter((name) =>
    functionNames.has(name)
  );
  if (attackCandidates.length === 0) {
    throw new Error("No attack entrypoint found in Summit ABI (expected attack or attack_summit)");
  }

  const methods: Array<{ name: string; entrypoint: string }> = [
    ...attackCandidates.map((name) => ({ name, entrypoint: name })),
  ];
  if (functionNames.has("request_random")) {
    methods.push({ name: "request_random", entrypoint: "request_random" });
  }
  if (functionNames.has("claim_rewards")) {
    methods.push({ name: "claim_rewards", entrypoint: "claim_rewards" });
  }
  if (functionNames.has("claim_quest_rewards")) {
    methods.push({ name: "claim_quest_rewards", entrypoint: "claim_quest_rewards" });
  }
  if (functionNames.has("apply_poison")) {
    methods.push({ name: "apply_poison", entrypoint: "apply_poison" });
  }
  if (functionNames.has("add_extra_life")) {
    methods.push({ name: "add_extra_life", entrypoint: "add_extra_life" });
  }

  const provider = new RpcProvider({
    nodeUrl: config.chain.rpcUrl,
    blockIdentifier: "latest",
  });
  const summitContract = new Contract(abi, config.chain.summitContract, provider);
  const potionTokenAddresses = await discoverPotionTokenAddresses(
    summitContract,
    functionNames,
    { retriesPerGetter: 6, retryDelayMs: 250 },
  );
  const sessionApprovalAmount =
    process.env.FENRIR_SESSION_APPROVAL_AMOUNT ?? SESSION_APPROVAL_AMOUNT_DEFAULT;

  const contracts: Record<string, { methods: any[] }> = {
    [config.chain.summitContract]: {
      methods,
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
          spender: config.chain.summitContract,
          amount: sessionApprovalAmount,
          authorized: true,
        },
      ],
    };
  }

  console.log(`  Attack entrypoint: ${attackCandidates[0]}`);
  console.log(`  request_random: ${functionNames.has("request_random") ? "yes" : "no (using vrf arg on attack)"}`);
  console.log(`  Session methods: ${methods.map((m) => m.entrypoint).join(", ")}`);
  console.log(`  VRF provider method: request_random @ ${VRF_PROVIDER_ADDRESS}`);
  console.log(`  Approval tokens: ${potionTokenAddresses.length}`);
  console.log(`  Session approval amount: ${sessionApprovalAmount}`);
  console.log("");

  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: "0x534e5f4d41494e", // SN_MAIN
    policies: {
      contracts,
    },
    basePath: sessionDir,
  });

  // Check for existing valid session
  const existing = await sessionProvider.probe();
  if (existing) {
    console.log("Existing valid session found!");
    console.log(`  Address: ${existing.address}`);
    console.log("  Session is still valid. Delete cartridge-session/session.json to force re-auth.");
    syncControllerAddress(configPath, existing.address);
    return;
  }

  console.log("Opening browser for Cartridge keychain auth...");
  console.log("(Log in with your Cartridge account in the browser window)");
  console.log("");

  const result = await sessionProvider.connect();
  if (!result) {
    throw new Error("Session creation returned no account. Approval likely timed out or did not complete.");
  }

  const persisted = loadCartridgeSession(sessionDir);
  const resolvedAddress = persisted.session.address || result.address;
  if (!resolvedAddress) {
    throw new Error("Session was created but no controller address was returned.");
  }

  console.log("Session created successfully!");
  console.log(`  Address: ${resolvedAddress}`);
  console.log(`  Stored at: ${sessionDir}/session.json`);
  syncControllerAddress(configPath, resolvedAddress);
}

main().catch((err) => {
  console.error("Session creation failed:", err);
  process.exit(1);
});
