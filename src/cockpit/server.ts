import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ConfigSchema, type FenrirConfig } from "../config.js";
import { loadCartridgeSession, isSessionExpired, sessionExpiresIn } from "../chain/controller-signer.js";

type JsonBody = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const PRIVATE_CONFIG_DIR = path.join(ROOT_DIR, "config");
const PRIVATE_DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_MODE = /^(1|true|yes)$/i.test(process.env.COCKPIT_PUBLIC_MODE ?? "");
const CONFIG_DIR = PUBLIC_MODE ? path.join(ROOT_DIR, "public-config") : PRIVATE_CONFIG_DIR;
const DATA_DIR = PUBLIC_MODE ? path.join(ROOT_DIR, "public-data") : PRIVATE_DATA_DIR;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONTROLLER_ENTRY = path.join(
  ROOT_DIR,
  "node_modules/@cartridge/controller/dist/index.js",
);
const CONTROLLER_BUNDLE = path.join(
  PUBLIC_DIR,
  "vendor/cartridge-controller.bundle.js",
);
const EXAMPLE_CONFIG_PATH = path.join(PRIVATE_CONFIG_DIR, "example.json");

const HOST = process.env.COCKPIT_HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.COCKPIT_PORT ?? "8788", 10);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  applyCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, text: string): void {
  applyCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(asBuffer);
    const total = chunks.reduce((sum, next) => sum + next.length, 0);
    if (total > 1_000_000) {
      throw new Error("Request payload is too large");
    }
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as JsonBody;
}

async function runShell(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("zsh", ["-lc", command], { cwd: ROOT_DIR, env: process.env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

function sanitizeProfileId(raw: string): string {
  const profileId = raw.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    throw new Error("Profile id can only contain letters, numbers, '-' and '_'");
  }
  return profileId;
}

function configPathFor(profileId: string): string {
  return path.join(CONFIG_DIR, `${profileId}.json`);
}

function dataDirFor(profileId: string): string {
  return path.join(DATA_DIR, profileId);
}

function toRootRelative(filePath: string): string {
  return `./${path.relative(ROOT_DIR, filePath).replaceAll("\\", "/")}`;
}

function runnerScreenSessionName(profileId: string): string {
  return PUBLIC_MODE ? `fenrir-public-${profileId}` : `fenrir-${profileId}`;
}

function loginScreenSessionName(profileId: string): string {
  return PUBLIC_MODE ? `fenrir-public-login-${profileId}` : `fenrir-login-${profileId}`;
}

function sessionFileAbs(config: FenrirConfig): string {
  return path.isAbsolute(config.session.file)
    ? config.session.file
    : path.resolve(ROOT_DIR, config.session.file);
}

function sessionDirAbs(config: FenrirConfig): string {
  return sessionFileAbs(config).replace(/session\.json$/, config.session.dirName);
}

async function listProfiles(): Promise<string[]> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const files = await fs.readdir(CONFIG_DIR);
  return files
    .filter((name) => name.endsWith(".json"))
    .filter((name) => name !== "example.json")
    .map((name) => name.replace(/\.json$/, ""))
    .sort((a, b) => a.localeCompare(b));
}

async function readConfig(profileId: string): Promise<FenrirConfig> {
  const raw = await fs.readFile(configPathFor(profileId), "utf-8");
  return ConfigSchema.parse(JSON.parse(raw));
}

async function writeConfig(profileId: string, config: FenrirConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(configPathFor(profileId), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function buildDefaultConfig(profileId: string, username?: string, controllerAddress?: string): Promise<FenrirConfig> {
  const raw = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  parsed.account.username = username?.trim() || profileId;
  parsed.account.controllerAddress = controllerAddress?.trim() || "0xYOUR_CONTROLLER_ADDRESS";
  parsed.session.file = toRootRelative(path.join(dataDirFor(profileId), "session.json"));
  parsed.logging.eventsFile = toRootRelative(path.join(dataDirFor(profileId), "events.jsonl"));
  return parsed;
}

async function fetchRunnerStatus(profileId: string, lines = 100): Promise<{
  running: boolean;
  processCount: number;
  processes: Array<{ pid: number; command: string }>;
  hasScreenSession: boolean;
  screenSessionName: string;
  logPath: string;
  logTail: string;
}> {
  const configPath = configPathFor(profileId);
  const pattern = `src/index.ts ${configPath}`;
  const processResult = await runShell(`pgrep -fl ${shellQuote(pattern)} || true`);
  const processes = processResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null);

  const screenSessionName = runnerScreenSessionName(profileId);
  const screenResult = await runShell(`screen -ls 2>/dev/null | grep -F ${shellQuote(screenSessionName)} || true`);
  const hasScreenSession = screenResult.stdout.trim().length > 0;

  const logPath = path.join(dataDirFor(profileId), "run.log");
  let logTail = "";
  if (existsSync(logPath)) {
    const safeLines = Number.isFinite(lines) ? Math.min(Math.max(lines, 20), 500) : 100;
    const tail = await runShell(`tail -n ${safeLines} ${shellQuote(logPath)} || true`);
    logTail = tail.stdout;
  }

  return {
    running: processes.length > 0 || hasScreenSession,
    processCount: processes.length,
    processes,
    hasScreenSession,
    screenSessionName,
    logPath,
    logTail,
  };
}

async function ensureProfileDataDir(profileId: string): Promise<void> {
  await fs.mkdir(dataDirFor(profileId), { recursive: true });
}

async function startRunner(profileId: string): Promise<void> {
  await ensureProfileDataDir(profileId);
  const session = await sessionStatus(profileId);
  if (!session.present || session.expired) {
    throw new Error(
      `Cannot start runner without valid session. ${session.error ?? "Click Register Session in this page."}`,
    );
  }

  const status = await fetchRunnerStatus(profileId, 20);
  if (status.running) {
    return;
  }

  const configPath = configPathFor(profileId);
  const logPath = path.join(dataDirFor(profileId), "run.log");
  const innerCommand = `cd ${shellQuote(ROOT_DIR)} && NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/index.ts ${shellQuote(configPath)} >> ${shellQuote(logPath)} 2>&1`;
  const command = `screen -dmS ${runnerScreenSessionName(profileId)} bash -lc ${shellQuote(innerCommand)}`;
  const result = await runShell(command);
  if (result.code !== 0) {
    throw new Error(`Failed to start runner: ${result.stderr || result.stdout || "unknown error"}`);
  }
}

async function stopRunner(profileId: string): Promise<void> {
  await runShell(`screen -S ${runnerScreenSessionName(profileId)} -X quit || true`);
  await runShell(`pkill -f ${shellQuote(`src/index.ts ${configPathFor(profileId)}`)} || true`);
}

async function launchSessionCreation(profileId: string): Promise<void> {
  await ensureProfileDataDir(profileId);
  await runShell(`screen -S ${loginScreenSessionName(profileId)} -X quit || true`);

  const configPath = configPathFor(profileId);
  const config = await readConfig(profileId);
  const sessionDir = sessionDirAbs(config);
  const sessionFile = path.join(sessionDir, "session.json");
  await fs.mkdir(sessionDir, { recursive: true });
  if (existsSync(sessionFile)) {
    await fs.unlink(sessionFile);
  }
  await runShell(`pkill -f ${shellQuote(`src/bootstrap/create-session.ts ${configPath}`)} || true`);
  const logPath = path.join(dataDirFor(profileId), "session-bootstrap.log");
  await fs.writeFile(logPath, "", "utf-8");
  const innerCommand = `cd ${shellQuote(ROOT_DIR)} && NODE_OPTIONS='--experimental-wasm-modules --dns-result-order=ipv4first' npx tsx src/bootstrap/create-session.ts ${shellQuote(configPath)} >> ${shellQuote(logPath)} 2>&1`;
  const command = `screen -dmS ${loginScreenSessionName(profileId)} bash -lc ${shellQuote(innerCommand)}`;

  const result = await runShell(command);
  if (result.code !== 0) {
    throw new Error(`Failed to launch session creation: ${result.stderr || result.stdout || "unknown error"}`);
  }
}

async function clearSession(profileId: string): Promise<{ sessionFile: string; cleared: boolean }> {
  await ensureProfileDataDir(profileId);
  await stopRunner(profileId);
  await runShell(`screen -S ${loginScreenSessionName(profileId)} -X quit || true`);

  const configPath = configPathFor(profileId);
  await runShell(`pkill -f ${shellQuote(`src/bootstrap/create-session.ts ${configPath}`)} || true`);

  const config = await readConfig(profileId);
  const sessionDir = sessionDirAbs(config);
  const sessionFile = path.join(sessionDir, "session.json");
  if (!existsSync(sessionFile)) {
    return { sessionFile, cleared: false };
  }

  await fs.unlink(sessionFile);
  return { sessionFile, cleared: true };
}

async function waitForApprovalUrl(profileId: string, attempts = 25, delayMs = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i += 1) {
    const url = await readSessionApprovalUrl(profileId);
    if (url) {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function sessionCreationProcessCount(profileId: string): Promise<number> {
  const configPath = configPathFor(profileId);
  const pattern = `src/bootstrap/create-session.ts ${configPath}`;
  const result = await runShell(
    `ps -ef | grep -F ${shellQuote(pattern)} | grep -v grep || true`,
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

async function readSessionApprovalUrl(profileId: string): Promise<string | null> {
  const logPath = path.join(dataDirFor(profileId), "session-bootstrap.log");
  if (!existsSync(logPath)) {
    return null;
  }

  const text = await fs.readFile(logPath, "utf-8");
  const matches = Array.from(text.matchAll(/Open url to authorize session:\s*(https:\/\/\S+)/g));
  if (matches.length === 0) {
    return null;
  }
  const raw = matches[matches.length - 1]?.[1] ?? null;
  if (!raw) {
    return null;
  }
  try {
    const approval = new URL(raw);
    const redirectUri = approval.searchParams.get("redirect_uri");
    if (redirectUri) {
      const callbackUrl = new URL(redirectUri);
      if (callbackUrl.hostname === "localhost") {
        callbackUrl.hostname = "127.0.0.1";
        approval.searchParams.set("redirect_uri", callbackUrl.toString());
      }
    }
    return approval.toString();
  } catch {
    return raw;
  }
}

async function sessionStatus(profileId: string): Promise<{
  present: boolean;
  expired: boolean;
  expiresIn: string;
  username?: string;
  address?: string;
  ownerGuid?: string;
  sessionKeyGuid?: string;
  error?: string;
}> {
  const config = await readConfig(profileId);
  const sessionDir = sessionDirAbs(config);
  const sessionFile = path.join(sessionDir, "session.json");
  try {
    const session = loadCartridgeSession(sessionDir);
    return {
      present: true,
      expired: isSessionExpired(session),
      expiresIn: sessionExpiresIn(session),
      username: session.session.username,
      address: session.session.address,
      ownerGuid: session.session.ownerGuid,
      sessionKeyGuid: session.session.sessionKeyGuid,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Session auth is incomplete")) {
      const creationProcesses = await sessionCreationProcessCount(profileId);
      if (creationProcesses > 0) {
        return {
          present: false,
          expired: true,
          expiresIn: "EXPIRED",
          error: "Session approval in progress. Complete the Cartridge popup/tab.",
        };
      }
      try {
        await fs.rm(sessionFile, { force: true });
      } catch {
        // ignore cleanup failure; status remains non-fatal for UI
      }
      return {
        present: false,
        expired: true,
        expiresIn: "EXPIRED",
        error: "Session approval was not completed. Click Register Session and approve in Cartridge popup.",
      };
    }

    if (message.includes("Session signer is missing")) {
      const creationProcesses = await sessionCreationProcessCount(profileId);
      if (creationProcesses > 0) {
        return {
          present: false,
          expired: true,
          expiresIn: "EXPIRED",
          error: "Session approval in progress. Complete the Cartridge popup/tab.",
        };
      }
      try {
        await fs.rm(sessionFile, { force: true });
      } catch {
        // ignore cleanup failure; status remains non-fatal for UI
      }
      return {
        present: false,
        expired: true,
        expiresIn: "EXPIRED",
        error: "Session signer key is missing. Click Connect Wallet, then Register Session to import a full session.",
      };
    }

    if (message.includes("Cartridge session not found")) {
      return {
        present: false,
        expired: true,
        expiresIn: "EXPIRED",
        error: "No session yet. Click Register Session in this page.",
      };
    }

    if (message.includes("Invalid session format")) {
      try {
        await fs.rm(sessionFile, { force: true });
      } catch {
        // ignore cleanup failure; status remains non-fatal for UI
      }
      return {
        present: false,
        expired: true,
        expiresIn: "EXPIRED",
        error: "Stored session format is invalid. Re-register from this page to rebuild session.json.",
      };
    }

    return {
      present: false,
      expired: true,
      expiresIn: "EXPIRED",
      error: message,
    };
  }
}

type ImportedSessionPayload = {
  signer: {
    privKey: string;
    pubKey: string;
  };
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
};

function parseImportedSession(body: JsonBody): ImportedSessionPayload {
  const signerIn = body.signer as Record<string, unknown> | undefined;
  const sessionIn = body.session as Record<string, unknown> | undefined;

  const signer = {
    privKey: String(signerIn?.privKey ?? "").trim(),
    pubKey: String(signerIn?.pubKey ?? "").trim(),
  };

  const session = {
    username: String(sessionIn?.username ?? "").trim(),
    address: String(sessionIn?.address ?? "").trim(),
    ownerGuid: String(sessionIn?.ownerGuid ?? "").trim(),
    transactionHash: String(sessionIn?.transactionHash ?? "").trim(),
    expiresAt: String(sessionIn?.expiresAt ?? "").trim(),
    guardianKeyGuid: String(sessionIn?.guardianKeyGuid ?? "0x0").trim() || "0x0",
    metadataHash: String(sessionIn?.metadataHash ?? "0x0").trim() || "0x0",
    sessionKeyGuid: String(sessionIn?.sessionKeyGuid ?? "").trim(),
  };

  if (!signer.privKey || !signer.pubKey) {
    throw new Error("Invalid session import payload: missing signer keys");
  }
  if (!session.address || !session.ownerGuid || !session.expiresAt || !session.sessionKeyGuid) {
    throw new Error("Invalid session import payload: missing required session fields");
  }
  if (!/^\d+$/.test(session.expiresAt)) {
    throw new Error("Invalid session import payload: expiresAt must be unix seconds");
  }

  return { signer, session };
}

async function importSession(profileId: string, body: JsonBody): Promise<{
  sessionFile: string;
  address: string;
  username: string;
}> {
  const payload = parseImportedSession(body);
  const config = await readConfig(profileId);
  const sessionDir = sessionDirAbs(config);
  const sessionFile = path.join(sessionDir, "session.json");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  // Keep profile account identity in sync with the imported browser session
  config.account.controllerAddress = payload.session.address;
  if (payload.session.username) {
    config.account.username = payload.session.username;
  }
  await writeConfig(profileId, config);

  return {
    sessionFile,
    address: payload.session.address,
    username: payload.session.username || config.account.username,
  };
}

async function serveStatic(res: ServerResponse, fileName: string): Promise<void> {
  const safePath = path.resolve(PUBLIC_DIR, fileName);
  if (!safePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(safePath);
    const ext = path.extname(safePath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";

    applyCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

async function ensureCockpitBundles(): Promise<void> {
  await fs.mkdir(path.dirname(CONTROLLER_BUNDLE), { recursive: true });
  await build({
    entryPoints: [CONTROLLER_ENTRY],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    outfile: CONTROLLER_BUNDLE,
    logLevel: "silent",
  });
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      applyCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      await serveStatic(res, "index.html");
      return;
    }
    if (method === "GET" && pathname === "/styles.css") {
      await serveStatic(res, "styles.css");
      return;
    }
    if (method === "GET" && pathname === "/app.js") {
      await serveStatic(res, "app.js");
      return;
    }
    if (method === "GET" && pathname.startsWith("/vendor/")) {
      await serveStatic(res, pathname.slice(1));
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        rootDir: ROOT_DIR,
        publicMode: PUBLIC_MODE,
        configDir: CONFIG_DIR,
        dataDir: DATA_DIR,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/profiles") {
      const profiles = await listProfiles();
      const enriched = await Promise.all(
        profiles.map(async (profileId) => {
          const cfgPath = configPathFor(profileId);
          const stat = await fs.stat(cfgPath);
          const runner = await fetchRunnerStatus(profileId, 40);
          const session = await sessionStatus(profileId);
          return {
            profileId,
            updatedAt: stat.mtime.toISOString(),
            running: runner.running,
            sessionPresent: session.present,
            sessionExpired: session.expired,
          };
        }),
      );
      sendJson(res, 200, { profiles: enriched });
      return;
    }

    if (method === "POST" && pathname === "/api/profiles") {
      const body = await readJsonBody(req);
      const profileId = sanitizeProfileId(String(body.profileId ?? ""));
      const username = typeof body.username === "string" ? body.username : undefined;
      const controllerAddress =
        typeof body.controllerAddress === "string" ? body.controllerAddress : undefined;

      if (existsSync(configPathFor(profileId))) {
        sendJson(res, 409, { error: `Profile '${profileId}' already exists` });
        return;
      }

      const config = await buildDefaultConfig(profileId, username, controllerAddress);
      await writeConfig(profileId, config);
      await ensureProfileDataDir(profileId);

      sendJson(res, 201, { ok: true, profileId, config });
      return;
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "api" && parts[1] === "profiles" && parts[2]) {
      const profileId = sanitizeProfileId(decodeURIComponent(parts[2]));
      const cfgPath = configPathFor(profileId);

      if (!existsSync(cfgPath)) {
        sendJson(res, 404, { error: `Profile '${profileId}' does not exist` });
        return;
      }

      if (parts.length === 3 && method === "GET") {
        const config = await readConfig(profileId);
        sendJson(res, 200, { profileId, config });
        return;
      }

      if (parts.length === 3 && method === "PUT") {
        const body = await readJsonBody(req);
        const config = ConfigSchema.parse(body.config);

        config.account.username = config.account.username.trim();
        config.session.file = toRootRelative(path.join(dataDirFor(profileId), "session.json"));
        config.logging.eventsFile = toRootRelative(path.join(dataDirFor(profileId), "events.jsonl"));

        await writeConfig(profileId, config);
        await ensureProfileDataDir(profileId);
        sendJson(res, 200, { ok: true, profileId, config });
        return;
      }

      if (parts.length === 4 && parts[3] === "status" && method === "GET") {
        const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "100", 10);
        const status = await fetchRunnerStatus(profileId, linesParam);
        sendJson(res, 200, {
          profileId,
          ...status,
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "logs" && method === "GET") {
        const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "150", 10);
        const status = await fetchRunnerStatus(profileId, linesParam);
        sendJson(res, 200, {
          profileId,
          logPath: status.logPath,
          logTail: status.logTail,
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "start" && method === "POST") {
        await startRunner(profileId);
        const status = await fetchRunnerStatus(profileId, 60);
        sendJson(res, 200, { ok: true, profileId, status });
        return;
      }

      if (parts.length === 4 && parts[3] === "stop" && method === "POST") {
        await stopRunner(profileId);
        const status = await fetchRunnerStatus(profileId, 60);
        sendJson(res, 200, { ok: true, profileId, status });
        return;
      }

      if (parts.length === 5 && parts[3] === "session" && parts[4] === "create" && method === "POST") {
        await stopRunner(profileId);
        await launchSessionCreation(profileId);
        const sessionBootstrapLog = toRootRelative(path.join(dataDirFor(profileId), "session-bootstrap.log"));
        const approvalUrl = await waitForApprovalUrl(profileId);
        sendJson(res, 200, {
          ok: true,
          profileId,
          message: "Fresh session registration launched. Approve login in your browser wallet.",
          screenSession: loginScreenSessionName(profileId),
          logFile: sessionBootstrapLog,
          approvalUrl,
        });
        return;
      }

      if (parts.length === 5 && parts[3] === "session" && parts[4] === "approval-url" && method === "GET") {
        const approvalUrl = await readSessionApprovalUrl(profileId);
        const sessionBootstrapLog = toRootRelative(path.join(dataDirFor(profileId), "session-bootstrap.log"));
        sendJson(res, 200, {
          ok: true,
          profileId,
          approvalUrl,
          logFile: sessionBootstrapLog,
        });
        return;
      }

      if (parts.length === 5 && parts[3] === "session" && parts[4] === "import" && method === "POST") {
        const body = await readJsonBody(req);
        const imported = await importSession(profileId, body);
        sendJson(res, 200, {
          ok: true,
          profileId,
          sessionFile: imported.sessionFile,
          address: imported.address,
          username: imported.username,
        });
        return;
      }

      if (parts.length === 5 && parts[3] === "session" && parts[4] === "status" && method === "GET") {
        const status = await sessionStatus(profileId);
        sendJson(res, 200, {
          profileId,
          ...status,
        });
        return;
      }

      if (parts.length === 5 && parts[3] === "session" && parts[4] === "clear" && method === "POST") {
        const result = await clearSession(profileId);
        const status = await sessionStatus(profileId);
        sendJson(res, 200, {
          ok: true,
          profileId,
          ...result,
          status,
        });
        return;
      }
    }

    notFound(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
});

async function bootstrap(): Promise<void> {
  await ensureCockpitBundles();
  server.listen(PORT, HOST, () => {
    console.log(`Fenrir cockpit ready at http://${HOST}:${PORT}`);
    console.log(`Root dir: ${ROOT_DIR}`);
    console.log(`Mode: ${PUBLIC_MODE ? "public" : "private"}`);
    console.log(`Config dir: ${CONFIG_DIR}`);
    console.log(`Data dir: ${DATA_DIR}`);
  });
}

bootstrap().catch((err) => {
  console.error("Cockpit bootstrap failed:", err);
  process.exit(1);
});
