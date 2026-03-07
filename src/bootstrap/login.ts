#!/usr/bin/env tsx
/**
 * Simple login test — checks if the Cartridge session is valid.
 * Usage: NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/login.ts config/userprofile.json
 */

import { loadConfig } from "../config.js";
import { loadCartridgeSession, isSessionExpired, sessionExpiresIn } from "../chain/controller-signer.js";

function main() {
  const configPath = process.argv[2] || "config/userprofile.json";
  const config = loadConfig(configPath);

  const sessionDir = config.session.file.replace(/session\.json$/, config.session.dirName);

  try {
    const session = loadCartridgeSession(sessionDir);
    const expired = isSessionExpired(session);
    const expiresIn = sessionExpiresIn(session);

    console.log("=== Session Info ===");
    console.log(`Username: ${session.session.username}`);
    console.log(`Address: ${session.session.address}`);
    console.log(`Status: ${expired ? "EXPIRED" : "VALID"}`);
    console.log(`Expires in: ${expiresIn}`);
    console.log(`Owner GUID: ${session.session.ownerGuid}`);
    console.log(`Session Key GUID: ${session.session.sessionKeyGuid}`);
    console.log(`Tx Hash: ${session.session.transactionHash}`);

    if (expired) {
      console.log("\nSession expired! Run: npx tsx src/bootstrap/create-session.ts");
      process.exit(1);
    }
  } catch (err) {
    console.error("Session check failed:", err);
    console.log("\nRun: npx tsx src/bootstrap/create-session.ts");
    process.exit(1);
  }
}

main();
