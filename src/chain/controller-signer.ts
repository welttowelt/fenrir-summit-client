/**
 * Controller signer utilities.
 * The actual session signing is handled by @cartridge/controller/session/node SessionProvider.
 * This module provides helper functions for session validation.
 */

import { readFileSync, existsSync } from "fs";

interface CartridgeSession {
  signer: { privKey: string; pubKey: string };
  session: {
    username: string;
    address: string;
    ownerGuid: string;
    transactionHash: string;
    expiresAt: string;
    guardianKeyGuid: string;
    metadataHash: string;
    sessionKeyGuid: string;
  };
}

export function loadCartridgeSession(basePath: string): CartridgeSession {
  const filePath = `${basePath}/session.json`;
  if (!existsSync(filePath)) {
    throw new Error(`Cartridge session not found at ${filePath}. Run: npx tsx src/bootstrap/create-session.ts`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (raw.signer?.privKey && raw.signer?.pubKey && !raw.session) {
    throw new Error(
      `Session auth is incomplete at ${filePath}. Finish browser approval from create-session.ts, or delete this file and retry.`
    );
  }
  if (raw.session?.ownerGuid && (!raw.signer?.privKey || !raw.signer?.pubKey)) {
    throw new Error(
      `Session signer is missing at ${filePath}. Re-register from the cockpit so both signer + session are stored together.`
    );
  }
  if (!raw.signer?.privKey || !raw.signer?.pubKey || !raw.session?.ownerGuid) {
    throw new Error(`Invalid session format at ${filePath}. Expected {signer, session} from SessionProvider.connect()`);
  }
  return raw;
}

export function isSessionExpired(session: CartridgeSession): boolean {
  const expiresAt = parseInt(session.session.expiresAt, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= expiresAt;
}

export function sessionExpiresIn(session: CartridgeSession): string {
  const expiresAt = parseInt(session.session.expiresAt, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  const remainingSec = expiresAt - nowSec;
  if (remainingSec <= 0) return "EXPIRED";
  const days = Math.floor(remainingSec / 86400);
  const hours = Math.floor((remainingSec % 86400) / 3600);
  return `${days}d ${hours}h`;
}
