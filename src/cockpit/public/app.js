const els = {
  messageBar: document.getElementById("messageBar"),
  profileBadge: document.getElementById("profileBadge"),
  profileSelect: document.getElementById("profileSelect"),
  createProfileBtn: document.getElementById("createProfileBtn"),
  reloadProfilesBtn: document.getElementById("reloadProfilesBtn"),
  saveConfigBtn: document.getElementById("saveConfigBtn"),
  startRunnerBtn: document.getElementById("startRunnerBtn"),
  stopRunnerBtn: document.getElementById("stopRunnerBtn"),
  connectWalletBtn: document.getElementById("connectWalletBtn"),
  disconnectWalletBtn: document.getElementById("disconnectWalletBtn"),
  registerSessionBtn: document.getElementById("registerSessionBtn"),
  checkSessionBtn: document.getElementById("checkSessionBtn"),
  refreshStatusBtn: document.getElementById("refreshStatusBtn"),
  refreshRawBtn: document.getElementById("refreshRawBtn"),
  applyRawBtn: document.getElementById("applyRawBtn"),
  saveRawBtn: document.getElementById("saveRawBtn"),
  rawConfigEditor: document.getElementById("rawConfigEditor"),
  addFriendlyBtn: document.getElementById("addFriendlyBtn"),
  friendlyPlayersList: document.getElementById("friendlyPlayersList"),
  friendlyPlayerTemplate: document.getElementById("friendlyPlayerTemplate"),
  runnerState: document.getElementById("runnerState"),
  runnerMeta: document.getElementById("runnerMeta"),
  sessionState: document.getElementById("sessionState"),
  sessionMeta: document.getElementById("sessionMeta"),
  walletState: document.getElementById("walletState"),
  walletMeta: document.getElementById("walletMeta"),
  logPath: document.getElementById("logPath"),
  logOutput: document.getElementById("logOutput"),
};

const state = {
  profileId: "",
  config: null,
  pollTimer: null,
  publicMode: false,
  apiBaseUrl: "",
  sessionRegistering: false,
  controller: null,
  wallet: {
    connected: false,
    username: "",
    address: "",
  },
};

const DEFAULT_RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_9";
const DEFAULT_SUMMIT_CONTRACT = "0x01aa95ea66e7e01acf7dc3fda8be0d8661230c4c36b0169e2bab8ab4d6700dfc";
const STARKNET_MAINNET_CHAIN_ID_HEX = "0x534e5f4d41494e";
const DEFAULT_PROFILE_ID = "runner";
const API_BASE_STORAGE_KEY = "fenrir.cockpitApiBaseUrl";
const AUTO_API_BASE_CANDIDATES = ["", "http://127.0.0.1:8788", "http://localhost:8788"];
const CONTROLLER_METHODS = [
  "attack",
  "attack_summit",
  "request_random",
  "claim_rewards",
  "claim_quest_rewards",
  "apply_poison",
  "add_extra_life",
];

let controllerClassPromise = null;

function setMessage(text, type = "info") {
  els.messageBar.textContent = text;
  els.messageBar.classList.remove("error", "success");
  if (type === "error") {
    els.messageBar.classList.add("error");
  } else if (type === "success") {
    els.messageBar.classList.add("success");
  }
}

function normalizeApiBaseUrl(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return "";
  }
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("Cockpit API URL must start with http:// or https://");
  }
  return raw.replace(/\/+$/, "");
}

function resolveApiUrl(url) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const path = url.startsWith("/") ? url : `/${url}`;
  if (!state.apiBaseUrl) {
    return path;
  }
  return `${state.apiBaseUrl}${path}`;
}

function persistApiBaseUrl() {
  if (state.apiBaseUrl) {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, state.apiBaseUrl);
  } else {
    window.localStorage.removeItem(API_BASE_STORAGE_KEY);
  }
}

function apiBaseLabel(baseUrl) {
  return baseUrl || "same-origin";
}

function buildApiCandidates() {
  const params = new URLSearchParams(window.location.search);
  const queryApi = params.get("api");
  const storedApi = window.localStorage.getItem(API_BASE_STORAGE_KEY) ?? "";
  const candidates = [];
  const seen = new Set();

  function pushCandidate(value) {
    try {
      const normalized = normalizeApiBaseUrl(value);
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      candidates.push(normalized);
    } catch {
      // Ignore malformed values and continue fallback discovery.
    }
  }

  if (queryApi) {
    pushCandidate(queryApi);
  }
  if (storedApi) {
    pushCandidate(storedApi);
  }
  for (const candidate of AUTO_API_BASE_CANDIDATES) {
    pushCandidate(candidate);
  }

  return candidates;
}

async function requestJsonAtBase(baseUrl, path, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = resolveApiUrlWithBase(baseUrl, path);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function resolveApiUrlWithBase(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!baseUrl) {
    return normalizedPath;
  }
  return `${baseUrl}${normalizedPath}`;
}

async function connectApiAutomatically() {
  const candidates = buildApiCandidates();
  for (const candidate of candidates) {
    const health = await requestJsonAtBase(candidate, "/api/health");
    if (health && typeof health === "object") {
      state.apiBaseUrl = candidate;
      persistApiBaseUrl();
      return health;
    }
  }
  return null;
}

function setApiDependentControlsDisabled(disabled) {
  const controls = [
    els.profileSelect,
    els.createProfileBtn,
    els.reloadProfilesBtn,
    els.saveConfigBtn,
    els.startRunnerBtn,
    els.stopRunnerBtn,
    els.connectWalletBtn,
    els.disconnectWalletBtn,
    els.registerSessionBtn,
    els.checkSessionBtn,
    els.refreshStatusBtn,
    els.refreshRawBtn,
    els.applyRawBtn,
    els.saveRawBtn,
    els.addFriendlyBtn,
    els.rawConfigEditor,
  ];

  for (const control of controls) {
    if (
      control instanceof HTMLButtonElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement
    ) {
      control.disabled = disabled;
    }
  }

  for (const field of allFields()) {
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement ||
      field instanceof HTMLTextAreaElement
    ) {
      field.disabled = disabled;
    }
  }
}

function resetUiForUnavailableApi() {
  state.profileId = "";
  state.config = null;
  els.profileBadge.textContent = "No API";
  els.profileSelect.innerHTML = "";

  const option = document.createElement("option");
  option.value = "";
  option.textContent = "Backend API unavailable";
  els.profileSelect.appendChild(option);
  els.profileSelect.value = "";

  setRunnerChip("Unavailable", "off");
  setSessionChip("Unavailable", "off");
  els.runnerMeta.textContent = "Run local backend and reload.";
  els.sessionMeta.textContent = "Runner and session controls need local backend.";
  els.logPath.textContent = "No backend connected";
  els.logOutput.textContent = "Start local backend with: npm run cockpit:user";
  renderFriendlyPlayers([]);
  if (els.rawConfigEditor instanceof HTMLTextAreaElement) {
    els.rawConfigEditor.value = "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openApprovalPopup() {
  const width = 520;
  const height = 760;
  const left = Math.max(0, Math.round((window.screen.width - width) / 2));
  const top = Math.max(0, Math.round((window.screen.height - height) / 2));
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    "menubar=no",
    "toolbar=no",
    "status=no",
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
  return window.open("about:blank", "_blank", features);
}

async function resolveApprovalUrl(profileId, attempts = 10, delayMs = 600) {
  for (let i = 0; i < attempts; i += 1) {
    const probe = await requestJson(
      `/api/profiles/${encodeURIComponent(profileId)}/session/approval-url`,
    );
    if (probe.approvalUrl) {
      return probe.approvalUrl;
    }
    await sleep(delayMs);
  }
  return "";
}

async function waitForSessionValid(profileId, timeoutMs = 90_000, intervalMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await requestJson(
        `/api/profiles/${encodeURIComponent(profileId)}/session/status`,
      );
      if (status.present && !status.expired) {
        return status;
      }
    } catch {
      // keep polling until timeout
    }
    await sleep(intervalMs);
  }
  return null;
}

function allFields() {
  return Array.from(document.querySelectorAll("[data-path]"));
}

function getByPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  if (!last) {
    return;
  }

  let target = obj;
  for (const part of parts) {
    if (typeof target[part] !== "object" || target[part] === null) {
      target[part] = {};
    }
    target = target[part];
  }
  target[last] = value;
}

function applyValueToField(field, value) {
  if (field.dataset.kind === "array") {
    field.value = Array.isArray(value) ? value.join("\n") : "";
    return;
  }

  if (field.type === "checkbox") {
    field.checked = Boolean(value);
    return;
  }

  field.value = value ?? "";
}

function readValueFromField(field) {
  if (field.dataset.kind === "array") {
    return field.value
      .split(/[\n,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (field.type === "checkbox") {
    return field.checked;
  }

  if (field.dataset.kind === "number") {
    const numberValue = Number(field.value);
    if (!Number.isFinite(numberValue)) {
      return 0;
    }
    return numberValue;
  }

  return field.value;
}

function normalizeFriendlyPlayers(players) {
  if (!Array.isArray(players)) {
    return [];
  }

  return players
    .map((player) => {
      if (!player || typeof player !== "object") {
        return null;
      }
      const name = typeof player.name === "string" ? player.name.trim() : "";
      const address = typeof player.address === "string" ? player.address.trim() : "";
      if (!address) {
        return null;
      }
      return { name, address };
    })
    .filter(Boolean);
}

function createFriendlyRow(player = { name: "", address: "" }) {
  if (!(els.friendlyPlayerTemplate instanceof HTMLTemplateElement)) {
    throw new Error("Friendly player template is missing.");
  }
  const fragment = els.friendlyPlayerTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".friendly-row");
  if (!row) {
    throw new Error("Friendly player row template is invalid.");
  }

  const nameInput = row.querySelector('input[data-friendly="name"]');
  const addressInput = row.querySelector('input[data-friendly="address"]');
  if (nameInput) {
    nameInput.value = player.name || "";
  }
  if (addressInput) {
    addressInput.value = player.address || "";
  }
  return row;
}

function renderFriendlyPlayers(players) {
  if (!(els.friendlyPlayersList instanceof HTMLElement)) {
    return;
  }

  els.friendlyPlayersList.innerHTML = "";
  for (const player of players) {
    els.friendlyPlayersList.appendChild(createFriendlyRow(player));
  }

  if (players.length === 0) {
    els.friendlyPlayersList.appendChild(createFriendlyRow({ name: "", address: "" }));
  }
}

function readFriendlyPlayersFromRows() {
  if (!(els.friendlyPlayersList instanceof HTMLElement)) {
    return [];
  }

  const players = [];
  const rows = els.friendlyPlayersList.querySelectorAll(".friendly-row");
  for (const row of rows) {
    const nameInput = row.querySelector('input[data-friendly="name"]');
    const addressInput = row.querySelector('input[data-friendly="address"]');
    const name = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : "";
    const address = addressInput instanceof HTMLInputElement ? addressInput.value.trim() : "";
    if (!address) {
      continue;
    }
    players.push({ name, address });
  }

  const dedup = new Map();
  for (const player of players) {
    const key = player.address.toLowerCase();
    if (!dedup.has(key)) {
      dedup.set(key, player);
    }
  }
  return Array.from(dedup.values());
}

function setRawEditorFromConfig(config) {
  if (!(els.rawConfigEditor instanceof HTMLTextAreaElement)) {
    return;
  }
  els.rawConfigEditor.value = JSON.stringify(config, null, 2);
}

function readRawEditorConfig() {
  if (!(els.rawConfigEditor instanceof HTMLTextAreaElement)) {
    throw new Error("Raw config editor is not available.");
  }

  const text = els.rawConfigEditor.value.trim();
  if (!text) {
    throw new Error("Raw config JSON is empty.");
  }
  return JSON.parse(text);
}

function populateForm(config) {
  for (const field of allFields()) {
    const path = field.dataset.path;
    if (!path) continue;
    applyValueToField(field, getByPath(config, path));
  }

  const configuredFriendlies = normalizeFriendlyPlayers(config?.strategy?.friendlyPlayers);
  const fallbackFromProtectedOwners = Array.isArray(config?.strategy?.protectedOwners)
    ? config.strategy.protectedOwners.map((address) => ({ name: "", address }))
    : [];
  const effectiveFriendlies = configuredFriendlies.length > 0 ? configuredFriendlies : fallbackFromProtectedOwners;
  renderFriendlyPlayers(effectiveFriendlies);
  setRawEditorFromConfig(config);
}

function collectConfig() {
  if (!state.config) {
    throw new Error("No profile loaded");
  }

  const next = structuredClone(state.config);
  for (const field of allFields()) {
    const path = field.dataset.path;
    if (!path) continue;
    setByPath(next, path, readValueFromField(field));
  }

  const friendlyPlayers = readFriendlyPlayersFromRows();
  next.strategy.friendlyPlayers = friendlyPlayers;
  next.strategy.protectedOwners = friendlyPlayers.map((player) => player.address);

  return next;
}

function profileLabel(profile) {
  const run = profile.running ? "RUN" : "STOP";
  const session = profile.sessionPresent
    ? profile.sessionExpired
      ? "SESSION EXPIRED"
      : "SESSION OK"
    : "NO SESSION";
  return `${profile.profileId} • ${run} • ${session}`;
}

async function requestJson(url, options = {}) {
  const targetUrl = resolveApiUrl(url);
  const response = await fetch(targetUrl, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  let data = null;

  if (contentType.includes("application/json")) {
    data = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => "");
    data = text ? { error: text.slice(0, 240) } : null;
  }

  if (!response.ok) {
    const errorText =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `${response.status} ${response.statusText}`;
    throw new Error(`${errorText} (${targetUrl})`);
  }

  if (!data || typeof data !== "object") {
    throw new Error(`Invalid JSON response from ${targetUrl}`);
  }

  return data;
}

async function getControllerClass() {
  if (!controllerClassPromise) {
    controllerClassPromise = import("/vendor/cartridge-controller.bundle.js")
      .then((module) => module.default)
      .catch((error) => {
        controllerClassPromise = null;
        throw error;
      });
  }
  return controllerClassPromise;
}

function buildWalletPolicies() {
  const summitContract = state.config?.chain?.summitContract || DEFAULT_SUMMIT_CONTRACT;
  return {
    contracts: {
      [summitContract]: {
        methods: CONTROLLER_METHODS.map((entrypoint) => ({
          name: entrypoint,
          entrypoint,
        })),
      },
    },
  };
}

function refreshWalletCard() {
  if (state.wallet.connected) {
    setWalletChip("Connected", "on");
    const username = state.wallet.username ? `@${state.wallet.username}` : "username unavailable";
    const address = state.wallet.address || "address unavailable";
    els.walletMeta.textContent = `${username} | ${address}`;
    return;
  }

  setWalletChip("Disconnected", "off");
  els.walletMeta.textContent = "Connect Cartridge to bind a user wallet.";
}

function isBenignDisconnectErrorMessage(message) {
  return /cannot read properties of undefined/i.test(message) && /tolowercase/i.test(message);
}

async function clearProfileSession() {
  if (!state.profileId) {
    return;
  }
  await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/session/clear`, {
    method: "POST",
  });
}

async function connectWallet() {
  const Controller = await getControllerClass();
  const rpcUrl = state.config?.chain?.rpcUrl || DEFAULT_RPC_URL;
  const policies = buildWalletPolicies();

  const controller = new Controller({
    chains: [{ rpcUrl }],
    defaultChainId: STARKNET_MAINNET_CHAIN_ID_HEX,
    policies,
    namespace: "summit",
    slot: "pg-mainnet-10",
  });

  let account;
  try {
    account = await controller.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout waiting for keychain/i.test(message)) {
      try {
        controller.open({ redirectUrl: window.location.href });
      } catch {
        // ignore open fallback failure
      }
      throw new Error(
        "Cartridge keychain timed out. A keychain tab was opened; finish login there, then click Register Session again.",
      );
    }
    throw err;
  }

  if (!account) {
    throw new Error("Cartridge connection did not return an account.");
  }

  const username = (await controller.username()) || "";
  state.controller = controller;
  state.wallet = {
    connected: true,
    username,
    address: account.address || "",
  };
  refreshWalletCard();

  if (state.config) {
    const usernameField = document.querySelector('[data-path=\"account.username\"]');
    const addressField = document.querySelector('[data-path=\"account.controllerAddress\"]');
    if (usernameField instanceof HTMLInputElement && username) {
      usernameField.value = username;
    }
    if (addressField instanceof HTMLInputElement && account.address) {
      addressField.value = account.address;
    }
  }

  if (state.profileId) {
    const session = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/session/status`);
    const connectedAddress = String(account.address || "").trim().toLowerCase();
    const sessionAddress = String(session.address || "").trim().toLowerCase();
    if (session.present && !session.expired && connectedAddress && sessionAddress && connectedAddress !== sessionAddress) {
      await clearProfileSession();
      await Promise.all([refreshSessionStatus(), refreshRunnerStatus()]);
      setMessage("Connected wallet differs from stored session. Old session was cleared; register a new session.", "success");
      return;
    }
  }

  setMessage(`Connected wallet ${account.address}`, "success");
}

async function disconnectWallet() {
  let disconnectError = null;
  if (state.controller && typeof state.controller.disconnect === "function") {
    try {
      await state.controller.disconnect();
    } catch (err) {
      disconnectError = err;
    }
  }

  let sessionClearError = null;
  try {
    await clearProfileSession();
  } catch (err) {
    sessionClearError = err;
  }

  try {
    localStorage.removeItem("session");
    localStorage.removeItem("sessionSigner");
  } catch {
    // ignore storage cleanup failure
  }

  state.controller = null;
  state.wallet = {
    connected: false,
    username: "",
    address: "",
  };
  refreshWalletCard();
  await Promise.all([refreshSessionStatus(), refreshRunnerStatus()]);

  if (disconnectError) {
    const message = disconnectError instanceof Error ? disconnectError.message : String(disconnectError);
    if (isBenignDisconnectErrorMessage(message)) {
      if (sessionClearError) {
        throw sessionClearError;
      }
      setMessage("Wallet disconnected and profile session cleared.", "success");
      return;
    }
    throw disconnectError;
  }

  if (sessionClearError) {
    throw sessionClearError;
  }

  setMessage("Wallet disconnected and profile session cleared.", "success");
}

function readBrowserSessionFromStorage() {
  const signerRaw = localStorage.getItem("sessionSigner");
  const sessionRaw = localStorage.getItem("session");
  if (!signerRaw || !sessionRaw) {
    throw new Error("No Cartridge session found in browser storage. Connect and approve first.");
  }

  let signerParsed;
  let sessionParsed;
  try {
    signerParsed = JSON.parse(signerRaw);
    sessionParsed = JSON.parse(sessionRaw);
  } catch {
    throw new Error("Cartridge session storage is malformed. Reconnect and approve again.");
  }

  const signer = {
    privKey: String(signerParsed?.privKey ?? "").trim(),
    pubKey: String(signerParsed?.pubKey ?? "").trim(),
  };
  const session = {
    username: String(
      sessionParsed?.username ?? state.wallet.username ?? state.config?.account?.username ?? "",
    ).trim(),
    address: String(sessionParsed?.address ?? state.wallet.address ?? "").trim(),
    ownerGuid: String(sessionParsed?.ownerGuid ?? "").trim(),
    transactionHash: String(sessionParsed?.transactionHash ?? "").trim(),
    expiresAt: String(sessionParsed?.expiresAt ?? "").trim(),
    guardianKeyGuid: String(sessionParsed?.guardianKeyGuid ?? "0x0").trim() || "0x0",
    metadataHash: String(sessionParsed?.metadataHash ?? "0x0").trim() || "0x0",
    sessionKeyGuid: String(sessionParsed?.sessionKeyGuid ?? "").trim(),
  };

  if (!signer.privKey || !signer.pubKey) {
    throw new Error("Missing signer keys in browser session storage.");
  }
  if (!session.address || !session.ownerGuid || !session.expiresAt || !session.sessionKeyGuid) {
    throw new Error("Browser session is incomplete. Approve registration again in Cartridge.");
  }

  return { signer, session };
}

async function importBrowserSessionToProfile(profileId) {
  const payload = readBrowserSessionFromStorage();
  return requestJson(`/api/profiles/${encodeURIComponent(profileId)}/session/import`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function setRunnerChip(text, mode) {
  els.runnerState.textContent = text;
  els.runnerState.className = "status-chip";
  els.runnerState.classList.add(mode === "on" ? "status-on" : mode === "warn" ? "status-warn" : "status-off");
}

function setSessionChip(text, mode) {
  els.sessionState.textContent = text;
  els.sessionState.className = "status-chip";
  els.sessionState.classList.add(mode === "on" ? "status-on" : mode === "warn" ? "status-warn" : "status-off");
}

function setWalletChip(text, mode) {
  els.walletState.textContent = text;
  els.walletState.className = "status-chip";
  els.walletState.classList.add(mode === "on" ? "status-on" : mode === "warn" ? "status-warn" : "status-off");
}

async function loadProfiles(preferredProfileId) {
  const data = await requestJson("/api/profiles");
  let profiles = data.profiles || [];

  if (profiles.length === 0) {
    await requestJson("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        profileId: DEFAULT_PROFILE_ID,
        username: DEFAULT_PROFILE_ID,
        controllerAddress: "0xYOUR_CONTROLLER_ADDRESS",
      }),
    });
    const seeded = await requestJson("/api/profiles");
    profiles = seeded.profiles || [];
  }

  els.profileSelect.innerHTML = "";
  if (profiles.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No profiles yet";
    els.profileSelect.appendChild(opt);
    state.profileId = "";
    state.config = null;
    els.profileBadge.textContent = "No profile";
    setRunnerChip("No profile", "off");
    setSessionChip("No profile", "off");
    els.runnerMeta.textContent = "Create one to begin.";
    els.sessionMeta.textContent = "Create one to begin.";
    els.logPath.textContent = "No log path";
    els.logOutput.textContent = "No logs loaded.";
    renderFriendlyPlayers([]);
    if (els.rawConfigEditor instanceof HTMLTextAreaElement) {
      els.rawConfigEditor.value = "";
    }
    refreshWalletCard();
    return;
  }

  for (const profile of profiles) {
    const opt = document.createElement("option");
    opt.value = profile.profileId;
    opt.textContent = profileLabel(profile);
    els.profileSelect.appendChild(opt);
  }

  const chosen =
    (preferredProfileId && profiles.some((p) => p.profileId === preferredProfileId) && preferredProfileId) ||
    (state.profileId && profiles.some((p) => p.profileId === state.profileId) && state.profileId) ||
    profiles[0].profileId;

  if (chosen !== state.profileId || !state.config) {
    els.profileSelect.value = chosen;
    await loadProfile(chosen);
  } else {
    els.profileSelect.value = chosen;
  }
}

async function loadHealth() {
  const health = await connectApiAutomatically();
  if (!health) {
    state.publicMode = false;
    setApiDependentControlsDisabled(true);
    resetUiForUnavailableApi();
    setMessage(
      "No local backend detected. Run `npm run cockpit:user` on your machine, then refresh.",
      "error",
    );
    return false;
  }

  state.publicMode = Boolean(health.publicMode);
  setApiDependentControlsDisabled(false);

  if (state.publicMode) {
    setMessage(`Connected backend: ${apiBaseLabel(state.apiBaseUrl)} (public user mode).`, "success");
  } else {
    setMessage(`Connected backend: ${apiBaseLabel(state.apiBaseUrl)}.`, "success");
  }
  return true;
}

async function loadProfile(profileId) {
  if (!profileId) {
    return;
  }

  const data = await requestJson(`/api/profiles/${encodeURIComponent(profileId)}`);
  state.profileId = profileId;
  state.config = data.config;
  els.profileBadge.textContent = profileId;
  populateForm(state.config);

  await Promise.all([refreshRunnerStatus(), refreshSessionStatus()]);
  startPolling();
  setMessage(`Loaded profile ${profileId}`, "success");
}

async function saveConfig() {
  if (!state.profileId) {
    setMessage("No profile selected.", "error");
    return;
  }

  const nextConfig = collectConfig();
  const result = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}`, {
    method: "PUT",
    body: JSON.stringify({ config: nextConfig }),
  });

  state.config = result.config;
  populateForm(state.config);
  setMessage(`Saved ${state.profileId} config`, "success");
  await loadProfiles(state.profileId);
}

async function saveRawConfig() {
  if (!state.profileId) {
    setMessage("No profile selected.", "error");
    return;
  }

  const rawConfig = readRawEditorConfig();
  const result = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}`, {
    method: "PUT",
    body: JSON.stringify({ config: rawConfig }),
  });

  state.config = result.config;
  populateForm(state.config);
  setMessage(`Saved raw JSON for ${state.profileId}`, "success");
  await loadProfiles(state.profileId);
}

async function createProfile() {
  const profileIdRaw = window.prompt("Profile id (letters, numbers, -, _)");
  if (!profileIdRaw) {
    return;
  }

  const usernameRaw = window.prompt("Cartridge username (optional)", profileIdRaw) || profileIdRaw;
  const controllerAddressRaw =
    window.prompt("Controller address (optional)", "0xYOUR_CONTROLLER_ADDRESS") ||
    "0xYOUR_CONTROLLER_ADDRESS";

  const profileId = profileIdRaw.trim();
  if (!profileId) {
    setMessage("Profile id is required", "error");
    return;
  }

  await requestJson("/api/profiles", {
    method: "POST",
    body: JSON.stringify({
      profileId,
      username: usernameRaw.trim(),
      controllerAddress: controllerAddressRaw.trim(),
    }),
  });

  await loadProfiles(profileId);
  setMessage(`Created profile ${profileId}`, "success");
}

async function refreshRunnerStatus() {
  if (!state.profileId) {
    return;
  }

  const status = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/status?lines=140`);

  if (status.running) {
    setRunnerChip("Running", "on");
  } else {
    setRunnerChip("Stopped", "off");
  }

  const pidText = status.processes.length
    ? status.processes.map((proc) => proc.pid).join(", ")
    : "none";
  const screenText = status.hasScreenSession ? status.screenSessionName : "none";
  els.runnerMeta.textContent = `PIDs: ${pidText} | Screen: ${screenText}`;

  els.logPath.textContent = status.logPath;
  if (status.logTail?.trim()) {
    const shouldStickToBottom =
      els.logOutput.scrollTop + els.logOutput.clientHeight >= els.logOutput.scrollHeight - 16;
    els.logOutput.textContent = status.logTail;
    if (shouldStickToBottom) {
      els.logOutput.scrollTop = els.logOutput.scrollHeight;
    }
  } else {
    els.logOutput.textContent = "No logs yet for this profile.";
  }
}

async function refreshSessionStatus() {
  if (!state.profileId) {
    return;
  }

  const status = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/session/status`);

  if (status.present && !status.expired) {
    setSessionChip("Session Valid", "on");
    els.sessionMeta.textContent = `User: ${status.username} | Expires in: ${status.expiresIn}`;
    return;
  }

  if (status.present && status.expired) {
    setSessionChip("Session Expired", "warn");
    els.sessionMeta.textContent = `Session exists but expired (${status.expiresIn}). Re-register.`;
    return;
  }

  setSessionChip("No Session", "off");
  els.sessionMeta.textContent = status.error || "No session file available";
}

async function startRunner() {
  if (!state.profileId) {
    return;
  }
  await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/start`, { method: "POST" });
  setMessage(`Runner started for ${state.profileId}`, "success");
  await refreshRunnerStatus();
  await loadProfiles(state.profileId);
}

async function stopRunner() {
  if (!state.profileId) {
    return;
  }
  await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/stop`, { method: "POST" });
  setMessage(`Runner stopped for ${state.profileId}`, "success");
  await refreshRunnerStatus();
  await loadProfiles(state.profileId);
}

async function registerSession() {
  if (!state.profileId) {
    return;
  }
  if (state.sessionRegistering) {
    setMessage("Session registration already in progress. Complete approval in the browser popup.", "error");
    return;
  }
  state.sessionRegistering = true;
  const button = els.registerSessionBtn;
  const previousLabel = button?.textContent || "Register Session";
  if (button) {
    button.disabled = true;
    button.textContent = "Registering…";
  }

  try {
    const create = await requestJson(`/api/profiles/${encodeURIComponent(state.profileId)}/session/create`, {
      method: "POST",
    });
    const approvalUrl = (await resolveApprovalUrl(state.profileId, 20, 500)) || create.approvalUrl;
    if (!approvalUrl) {
      throw new Error(`Could not get approval URL. Log: ${create.logFile}`);
    }

    const popup = openApprovalPopup();
    if (popup) {
      popup.location.href = approvalUrl;
    } else {
      window.open(approvalUrl, "_blank");
    }
    setMessage("Approval opened in browser. Complete it there.", "success");

    const valid = await waitForSessionValid(state.profileId, 120_000, 2_000);
    if (valid) {
      await loadProfile(state.profileId);
      setMessage(`Session active for ${valid.username || state.profileId}`, "success");
      return;
    }
    setMessage("Waiting for approval completion. After approving in browser, click Check Session.", "error");
  } finally {
    state.sessionRegistering = false;
    if (button) {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
}

function startPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }

  state.pollTimer = setInterval(async () => {
    if (!state.profileId) {
      return;
    }
    try {
      await Promise.all([refreshRunnerStatus(), refreshSessionStatus()]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  }, 4000);
}

function bindUi() {
  els.profileSelect.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    if (target.value) {
      try {
        await loadProfile(target.value);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err), "error");
      }
    }
  });

  els.createProfileBtn.addEventListener("click", async () => {
    try {
      await createProfile();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.reloadProfilesBtn.addEventListener("click", async () => {
    try {
      await loadProfiles(state.profileId);
      setMessage("Profiles refreshed", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.saveConfigBtn.addEventListener("click", async () => {
    try {
      await saveConfig();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.startRunnerBtn.addEventListener("click", async () => {
    try {
      await startRunner();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.stopRunnerBtn.addEventListener("click", async () => {
    try {
      await stopRunner();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.connectWalletBtn.addEventListener("click", async () => {
    try {
      await connectWallet();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.disconnectWalletBtn.addEventListener("click", async () => {
    try {
      await disconnectWallet();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.registerSessionBtn.addEventListener("click", async () => {
    try {
      await registerSession();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.checkSessionBtn.addEventListener("click", async () => {
    try {
      await refreshSessionStatus();
      setMessage("Session status refreshed", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.refreshStatusBtn.addEventListener("click", async () => {
    try {
      await refreshRunnerStatus();
      setMessage("Runner status refreshed", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.refreshRawBtn?.addEventListener("click", () => {
    try {
      const cfg = collectConfig();
      setRawEditorFromConfig(cfg);
      setMessage("Raw JSON refreshed from form values", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.applyRawBtn?.addEventListener("click", () => {
    try {
      const raw = readRawEditorConfig();
      state.config = raw;
      populateForm(raw);
      setMessage("Raw JSON applied to form", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.saveRawBtn?.addEventListener("click", async () => {
    try {
      await saveRawConfig();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), "error");
    }
  });

  els.addFriendlyBtn?.addEventListener("click", () => {
    if (!(els.friendlyPlayersList instanceof HTMLElement)) {
      return;
    }
    els.friendlyPlayersList.appendChild(createFriendlyRow({ name: "", address: "" }));
  });

  els.friendlyPlayersList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const removeButton = target.closest(".friendly-remove");
    if (!removeButton) {
      return;
    }

    const row = target.closest(".friendly-row");
    if (row instanceof HTMLElement) {
      row.remove();
    }

    if (
      els.friendlyPlayersList instanceof HTMLElement &&
      els.friendlyPlayersList.querySelectorAll(".friendly-row").length === 0
    ) {
      els.friendlyPlayersList.appendChild(createFriendlyRow({ name: "", address: "" }));
    }
  });
}

async function init() {
  bindUi();
  refreshWalletCard();
  setMessage("Loading profiles...");

  try {
    const healthOk = await loadHealth();
    if (!healthOk) {
      return;
    }
    await loadProfiles();
    if (!state.publicMode) {
      setMessage("Cockpit ready", "success");
    }
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), "error");
  }
}

window.addEventListener("beforeunload", () => {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
});

void init();
