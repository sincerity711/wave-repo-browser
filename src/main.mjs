#!/usr/bin/env bun

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { CODICON_CSS } from "./codicons-embedded.mjs";

const SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".DS_Store",
]);

const argv = process.argv.slice(2);

function parseArgs(args) {
  const options = {
    host: "",
    port: "",
    publicHost: "",
    mode: "",
    open: true,
    foreground: false,
    root: "",
    service: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      options.open = false;
      options.foreground = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--foreground") {
      options.foreground = true;
    } else if (arg === "--daemon") {
      options.foreground = false;
    } else if (arg === "--service") {
      options.service = true;
    } else if (arg === "--local") {
      options.mode = "local";
    } else if (arg === "--remote") {
      options.mode = "remote";
    } else if (arg === "--host") {
      options.host = args[++index] || "";
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      options.port = args[++index] || "";
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--public-host") {
      options.publicHost = args[++index] || "";
    } else if (arg.startsWith("--public-host=")) {
      options.publicHost = arg.slice("--public-host=".length);
    } else if (!arg.startsWith("--") && !options.root) {
      options.root = arg;
    }
  }

  return options;
}

const options = parseArgs(argv);
const isWaveRemote = Boolean(process.env.WAVETERM_CONN);
const mode = options.mode || (isWaveRemote ? "remote" : "local");
const shouldOpen = options.open;
const DEFAULT_PORT = 17876;

function configuredPublicHost() {
  const home = process.env.HOME || "";
  if (!home) return "";

  const configPath = path.join(home, ".config", "wave-repo-browser", "public-host");
  try {
    return String(spawnSync("cat", [configPath], { encoding: "utf8" }).stdout || "").trim();
  } catch {
    return "";
  }
}

function firstExecutable(paths) {
  for (const candidate of paths.filter(Boolean)) {
    const result = spawnSync("test", ["-x", candidate]);
    if (result.status === 0) return candidate;
  }

  return "";
}

function detectPublicHost() {
  const configured = configuredPublicHost();
  if (configured) return configured;

  const conn = process.env.WAVETERM_CONN || "";
  const connHost = conn.includes("@") ? conn.split("@").pop() : conn;
  if (connHost && !connHost.includes("/") && connHost !== "local") return connHost;

  const route = spawnSync("sh", ["-lc", "ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i == \"src\") {print $(i+1); exit}}'"], {
    encoding: "utf8",
  });
  const routeHost = route.stdout.trim();
  if (route.status === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(routeHost)) return routeHost;

  const hostname = spawnSync("sh", ["-lc", "hostname -I 2>/dev/null | tr ' ' '\\n' | awk '/^[0-9]+(\\.[0-9]+){3}$/ {print; exit}'"], {
    encoding: "utf8",
  });
  const hostnameHost = hostname.stdout.trim();
  if (hostname.status === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(hostnameHost)) return hostnameHost;

  return "127.0.0.1";
}

const listenHost = options.host || (mode === "remote" ? "0.0.0.0" : "127.0.0.1");
const listenPort = Number(options.port || DEFAULT_PORT);
const publicHost = options.publicHost || (mode === "remote" ? detectPublicHost() : "127.0.0.1");

const BROWSE_ROOT = path.resolve(options.root || process.cwd());

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runtimeDir() {
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp";
  return path.join(base, "wave-repo-browser");
}

function statePath() {
  const host = listenHost.replace(/[^a-zA-Z0-9._-]+/g, "-") || "host";
  return path.join(runtimeDir(), `service-${mode}-${host}-${listenPort || "auto"}.json`);
}

function logPath() {
  return path.join(runtimeDir(), `wrb-service-${mode}.log`);
}

function localServiceUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function publicServiceUrl(port) {
  return `http://${publicHost}:${port}`;
}

function browseUrl(baseUrl, root = BROWSE_ROOT, sessionId = "") {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.searchParams.set("root", root);
  if (sessionId) url.searchParams.set("session", sessionId);
  return url.toString();
}

function currentWaveEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WAVETERM_") && value) env[key] = value;
  }
  return env;
}

async function registerWaveSession(baseUrl) {
  const waveEnv = currentWaveEnv();
  if (!waveEnv.WAVETERM_JWT) return "";

  try {
    const port = Number(new URL(baseUrl).port);
    if (!port) return "";

    const res = await fetch(`${localServiceUrl(port)}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: waveEnv }),
    });
    if (!res.ok) return "";

    const data = await res.json();
    return data.session || "";
  } catch {
    return "";
  }
}

async function readServiceState() {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8"));
  } catch {
    return null;
  }
}

async function writeServiceState(port) {
  await fs.mkdir(runtimeDir(), { recursive: true });
  await fs.writeFile(
    statePath(),
    JSON.stringify(
      {
        mode,
        listenHost,
        publicHost,
        port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function looksLikeWrbProcess(command) {
  return /(^|[/ ])wrb($|[ ])/.test(command) || command.includes("wrb-bin") || command.includes("wave-repo-browser");
}

function killIfWrb(pid, reason, signal = "SIGTERM") {
  if (!pid || Number(pid) === process.pid) return false;

  const command = processCommand(pid);
  if (!command || !looksLikeWrbProcess(command)) return false;

  try {
    process.kill(Number(pid), signal);
    console.log(`Stopped old wrb process ${pid}${reason ? ` (${reason})` : ""}`);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port) {
  const lsof = spawnSync("lsof", ["-ti", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (lsof.status === 0) {
    return lsof.stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter(Boolean);
  }

  const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], {
    encoding: "utf8",
  });
  if (fuser.status !== 0) return [];
  return `${fuser.stdout}\n${fuser.stderr}`
    .split(/\s+/)
    .map((value) => Number(value))
    .filter(Boolean);
}

async function cleanupExistingService() {
  const state = await readServiceState();
  if (state?.pid) killIfWrb(state.pid, "state file");

  for (const pid of listenerPids(listenPort)) {
    killIfWrb(pid, `port ${listenPort}`);
  }

  try {
    await fs.rm(statePath(), { force: true });
  } catch {
    // Best-effort cleanup; startup will still fail clearly if the port remains busy.
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  for (const pid of listenerPids(listenPort)) {
    killIfWrb(pid, `port ${listenPort}`, "SIGKILL");
  }
}

async function existingServiceBaseUrl() {
  const state = await readServiceState();
  const candidatePort = state?.port || (listenPort > 0 ? listenPort : 0);
  if (!candidatePort) return "";

  try {
    const res = await fetch(`${localServiceUrl(candidatePort)}/api/health`);
    if (!res.ok) return "";

    const data = await res.json();
    if (data.name !== "wave-repo-browser") return "";

    return publicServiceUrl(candidatePort);
  } catch {
    return "";
  }
}

async function daemonizeIfNeeded() {
  if (options.foreground || options.service) return;

  await cleanupExistingService();

  const childArgs = [];
  if (options.mode) childArgs.push(`--${options.mode}`);
  if (options.host) childArgs.push("--host", options.host);
  if (options.port) childArgs.push("--port", options.port);
  if (options.publicHost) childArgs.push("--public-host", options.publicHost);
  childArgs.push("--foreground", "--service", "--no-open");
  const serviceLogPath = logPath();
  await fs.mkdir(runtimeDir(), { recursive: true });
  const command = `${shellQuote(process.execPath)} ${childArgs.map(shellQuote).join(" ")} >> ${shellQuote(serviceLogPath)} 2>&1`;

  spawn("sh", ["-lc", command], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();

  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedBaseUrl = await existingServiceBaseUrl();
    if (startedBaseUrl) {
      const sessionId = await registerWaveSession(startedBaseUrl);
      const url = browseUrl(startedBaseUrl, BROWSE_ROOT, sessionId);
      if (shouldOpen) openWebInWave(url);
      console.log(`wrb opened ${BROWSE_ROOT}`);
      console.log(`URL: ${url}`);
      process.exit(0);
    }
  }

  console.log("wrb service starting");
  console.log(`browse: ${BROWSE_ROOT}`);
  console.log(`log: ${serviceLogPath}`);
  process.exit(0);
}

await daemonizeIfNeeded();

function isInsideRoot(root, absPath) {
  const rel = path.relative(root, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeResolve(root, relPath = ".") {
  const absRoot = path.resolve(root || ".");
  const absPath = path.resolve(absRoot, relPath || ".");
  if (!isInsideRoot(absRoot, absPath)) {
    throw new Error("Path escapes browse root");
  }
  return absPath;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name) {
  return path.extname(name).replace(/^\./, "").toLowerCase();
}

const gitStateByRoot = new Map();

function gitState(root) {
  const absRoot = path.resolve(root || ".");
  let state = gitStateByRoot.get(absRoot);
  if (!state) {
    state = {
      statusCache: new Map(),
      statusAt: 0,
      isRepo: null,
      repoRoot: "",
    };
    gitStateByRoot.set(absRoot, state);
  }
  return state;
}

function isGitRepo(root) {
  const state = gitState(root);
  if (state.isRepo !== null) return state.isRepo;

  const result = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  state.isRepo = result.status === 0 && result.stdout.trim() === "true";
  if (state.isRepo) {
    const topLevel = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    state.repoRoot = topLevel.status === 0 ? topLevel.stdout.trim() : root;
  }
  return state.isRepo;
}

function parseGitStatus(output) {
  const status = new Map();
  const records = output.split("\0").filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const rel = record.slice(3);
    if (!rel) continue;

    status.set(rel, code);

    if (code.includes("R") || code.includes("C")) {
      index += 1;
      if (records[index]) status.set(records[index], code);
    }
  }

  return status;
}

function gitStatusKind(code) {
  if (!code) return "";
  if (code.includes("?")) return "U";
  if (code.includes("A")) return "A";
  if (code.includes("M")) return "M";
  if (code.includes("D")) return "D";
  if (code.includes("R")) return "R";
  if (code.includes("C")) return "C";
  return code.trim();
}

function refreshGitStatus(root, force = false) {
  if (!isGitRepo(root)) return new Map();

  const state = gitState(root);
  const now = Date.now();
  if (!force && now - state.statusAt < 1200) return state.statusCache;

  const result = spawnSync("git", ["-C", state.repoRoot || root, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });

  state.statusAt = now;
  state.statusCache = result.status === 0 ? parseGitStatus(result.stdout) : new Map();
  return state.statusCache;
}

async function listDir(root, relPath = ".", forceGit = false) {
  const absRoot = path.resolve(root || ".");
  const repoName = path.basename(absRoot);
  const absDir = safeResolve(absRoot, relPath);
  const stat = await fs.stat(absDir);

  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }

  const gitStatus = refreshGitStatus(absRoot, forceGit);
  const state = gitState(absRoot);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const abs = path.join(absDir, entry.name);
    const rel = path.relative(absRoot, abs);
    const itemStat = await fs.lstat(abs);
    const isDir = entry.isDirectory();
    const gitRel = state.repoRoot ? path.relative(state.repoRoot, abs) : rel;
    const git = gitStatusKind(gitStatus.get(gitRel));

    children.push({
      name: entry.name,
      path: rel,
      absPath: abs,
      ext: isDir ? "" : extensionOf(entry.name),
      isDir,
      git,
      size: isDir ? "" : formatBytes(itemStat.size),
      mtime: itemStat.mtime.toISOString(),
    });
  }

  children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return {
    root: absRoot,
    repoName,
    path: relPath || ".",
    git: isGitRepo(absRoot),
    children,
  };
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function sendHtml(res, html) {
  const body = Buffer.from(html);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function spawnDetached(command, args, env = process.env) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", (err) => {
      console.error(`Failed to run ${command}: ${err.message || err}`);
    });
    child.unref();
  } catch (err) {
    console.error(`Failed to run ${command}: ${err.message || err}`);
  }
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({ status: -1, stdout, stderr: String(err.message || err) });
    });
    child.on("close", (status) => {
      resolve({ status: status ?? 0, stdout, stderr });
    });
  });
}

function wshCommand() {
  const home = process.env.HOME || "";
  return (
    firstExecutable([
      home ? path.join(home, "Library", "Application Support", "waveterm", "bin", "wsh") : "",
      home ? path.join(home, ".waveterm", "bin", "wsh") : "",
    ]) || "wsh"
  );
}

async function openWithWave(absFile, waveEnv = {}) {
  const result = await runCommand(wshCommand(), ["view", absFile], { ...process.env, ...waveEnv });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `wsh exited with status ${result.status}`).trim();
    throw new Error(message);
  }
}

function openWebInWave(url) {
  spawnDetached(wshCommand(), ["web", "open", url]);
}

const HTML = String.raw`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wave Repo Browser</title>
  <style>
    ${CODICON_CSS}

    :root {
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #181818;
      color: #ffffff;
      --bg: #181818;
      --panel: #202020;
      --panel-2: #242424;
      --line: #303030;
      --hover: #2a2f36;
      --selected: rgba(51, 156, 255, .17);
      --selected-line: #339cff;
      --text: #ffffff;
      --soft-text: #d7d7d7;
      --muted: #9a9a9a;
      --accent: #339cff;
      --modified: #f0c674;
      --added: #40c977;
      --deleted: #fa423e;
      --unknown: #ad7bf9;
      --folder: #6bb8ff;
      --js: #f7df6e;
      --ts: #64b5f6;
      --json: #f0c674;
      --md: #8fd0ff;
      --style: #ad7bf9;
      --html: #ff8f66;
      --image: #40c977;
      --config: #b6a8ff;
      --shell: #6ee7b7;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-width: 260px;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      overflow: hidden;
    }

    #app {
      height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
    }

    #header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 2px;
      align-items: center;
      min-height: 35px;
      padding: 0 8px 0 12px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      box-shadow: inset 0 -1px 0 rgba(255, 255, 255, .03);
    }

    #repo {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .4px;
      text-transform: uppercase;
      color: var(--soft-text);
    }

    .icon-btn {
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--soft-text);
      cursor: default;
      font-size: 15px;
    }

    .icon-btn:hover {
      background: var(--hover);
      color: var(--text);
    }

    #searchbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 6px;
      align-items: center;
      padding: 7px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
    }

    #searchbar .codicon {
      color: var(--muted);
    }

    #filter {
      width: 100%;
      min-width: 0;
      border: 1px solid #3c3c3c;
      border-radius: 3px;
      background: #2d2d2d;
      color: #ffffff;
      outline: none;
      padding: 4px 6px;
      font: inherit;
      font-size: 12px;
    }

    #filter:focus {
      border-color: var(--accent);
      background: #22272e;
    }

    #tree {
      overflow: auto;
      padding: 6px 0 10px;
    }

    .row {
      display: grid;
      grid-template-columns: 16px 22px minmax(40px, 1fr) auto;
      align-items: center;
      gap: 5px;
      height: 24px;
      line-height: 24px;
      padding-right: 8px;
      white-space: nowrap;
      user-select: none;
      outline: none;
    }

    .row:hover {
      background: var(--hover);
    }

    .row.selected {
      background: var(--selected);
      box-shadow: inset 2px 0 0 var(--selected-line);
    }

    .row.hidden {
      display: none;
    }

    .twisty {
      width: 16px;
      color: var(--muted);
      text-align: center;
      font-size: 13px;
    }

    .file-icon,
    .folder-icon {
      width: 20px;
      height: 20px;
      display: inline-grid;
      place-items: center;
      border-radius: 5px;
      color: var(--folder);
      background: rgba(107, 184, 255, .13);
      text-align: center;
      font-size: 15px;
    }

    .file-icon {
      color: #d4d4d4;
      background: rgba(255, 255, 255, .06);
      font-size: 14px;
    }

    .type-js {
      color: var(--js);
      background: rgba(247, 223, 110, .14);
    }

    .type-ts {
      color: var(--ts);
      background: rgba(100, 181, 246, .15);
    }

    .type-json {
      color: var(--json);
      background: rgba(240, 198, 116, .13);
    }

    .type-md {
      color: var(--md);
      background: rgba(143, 208, 255, .14);
    }

    .type-style {
      color: var(--style);
      background: rgba(173, 123, 249, .16);
    }

    .type-html {
      color: var(--html);
      background: rgba(255, 143, 102, .15);
    }

    .type-image {
      color: var(--image);
      background: rgba(64, 201, 119, .14);
    }

    .type-config {
      color: var(--config);
      background: rgba(182, 168, 255, .15);
    }

    .type-shell {
      color: var(--shell);
      background: rgba(110, 231, 183, .14);
    }

    .name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--soft-text);
    }

    .dir .name {
      color: var(--text);
      font-weight: 600;
    }

    .row.selected .name {
      color: var(--text);
    }

    .row.selected .file-icon,
    .row.selected .folder-icon {
      filter: saturate(1.18) brightness(1.12);
    }

    .meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .git {
      min-width: 12px;
      text-align: center;
      font-weight: 700;
      border-radius: 4px;
      padding: 0 3px;
      line-height: 16px;
    }

    .git-M { color: var(--modified); }
    .git-A { color: var(--added); }
    .git-D { color: var(--deleted); }
    .git-U { color: var(--unknown); }
    .git-R, .git-C { color: var(--accent); }

    .children {
      margin: 0;
    }

    .empty,
    .loading,
    .error {
      height: 24px;
      line-height: 24px;
      color: var(--muted);
      padding-left: 36px;
    }

    #status {
      min-height: 28px;
      padding: 6px 10px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      background: var(--panel);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    #contextMenu {
      position: fixed;
      z-index: 20;
      min-width: 178px;
      padding: 4px;
      border: 1px solid #3f3f3f;
      border-radius: 6px;
      background: #252526;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
      display: none;
    }

    #contextMenu.open {
      display: block;
    }

    .menu-item {
      width: 100%;
      height: 28px;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--soft-text);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: default;
    }

    .menu-item:hover,
    .menu-item:focus {
      outline: none;
      background: var(--hover);
      color: var(--text);
    }

    .menu-item .codicon {
      color: var(--muted);
      font-size: 14px;
    }

    .menu-separator {
      height: 1px;
      margin: 4px 6px;
      background: var(--line);
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="header">
      <div id="repo">Explorer</div>
      <button id="collapseAll" class="icon-btn" title="Collapse all"><span class="codicon codicon-collapse-all"></span></button>
      <button id="copyPath" class="icon-btn" title="Copy selected path"><span class="codicon codicon-copy"></span></button>
      <button id="refresh" class="icon-btn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
    </div>
    <div id="searchbar">
      <span class="codicon codicon-search"></span>
      <input id="filter" placeholder="Filter loaded files" />
      <button id="clearFilter" class="icon-btn" title="Clear filter"><span class="codicon codicon-close"></span></button>
    </div>
    <div id="tree"></div>
    <div id="status">Enter opens files. Right/Left expands and collapses folders.</div>
  </div>
  <div id="contextMenu" role="menu" aria-hidden="true"></div>

  <script>
    const tree = document.getElementById("tree");
    const repo = document.getElementById("repo");
    const filter = document.getElementById("filter");
    const status = document.getElementById("status");
    const copyPath = document.getElementById("copyPath");
    const refresh = document.getElementById("refresh");
    const collapseAll = document.getElementById("collapseAll");
    const clearFilter = document.getElementById("clearFilter");
    const contextMenu = document.getElementById("contextMenu");

    let rows = [];
    let selected = null;
    let contextRow = null;
    let rootPath = "";
    const initialParams = new URLSearchParams(window.location.search);
    const initialRoot = initialParams.get("root") || "";
    const sessionId = initialParams.get("session") || "";

    async function getJson(url) {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      return data;
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      return data;
    }

    function setStatus(text) {
      status.textContent = text;
    }

    function visibleRows() {
      return rows.filter((row) => row.isConnected && !row.classList.contains("hidden"));
    }

    function selectRow(row) {
      if (!row) return;
      document.querySelectorAll(".row.selected").forEach((el) => el.classList.remove("selected"));
      row.classList.add("selected");
      selected = row;
      row.scrollIntoView({ block: "nearest" });
      setStatus(row.dataset.absPath || "");
    }

    function closeContextMenu() {
      contextMenu.classList.remove("open");
      contextMenu.setAttribute("aria-hidden", "true");
      contextMenu.innerHTML = "";
      contextRow = null;
    }

    function menuButton(label, icon, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitem");
      button.innerHTML = '<span class="codicon ' + icon + '"></span><span>' + label + '</span>';
      button.onclick = async () => {
        closeContextMenu();
        await action();
      };
      return button;
    }

    function menuSeparator() {
      const separator = document.createElement("div");
      separator.className = "menu-separator";
      separator.setAttribute("role", "separator");
      return separator;
    }

    function positionContextMenu(x, y) {
      contextMenu.style.left = "0px";
      contextMenu.style.top = "0px";
      contextMenu.classList.add("open");
      contextMenu.setAttribute("aria-hidden", "false");

      const rect = contextMenu.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - rect.width - 6);
      const top = Math.min(y, window.innerHeight - rect.height - 6);
      contextMenu.style.left = Math.max(6, left) + "px";
      contextMenu.style.top = Math.max(6, top) + "px";
    }

    function showContextMenu(ev, row, entry) {
      ev.preventDefault();
      ev.stopPropagation();
      selectRow(row);
      closeContextMenu();
      contextRow = row;

      if (entry.isDir) {
        const isOpen = row.dataset.open === "true";
        contextMenu.appendChild(menuButton(
          isOpen ? "Collapse folder" : "Expand folder",
          isOpen ? "codicon-chevron-up" : "codicon-chevron-down",
          async () => toggleDir(row, entry, Number(row.dataset.depth || 0)),
        ));
      } else {
        contextMenu.appendChild(menuButton("Open in Wave", "codicon-go-to-file", async () => openFile(row, entry)));
      }

      contextMenu.appendChild(menuButton("Copy path", "codicon-copy", async () => {
        await navigator.clipboard.writeText(row.dataset.absPath || "");
        setStatus("Copied: " + row.dataset.absPath);
      }));
      contextMenu.appendChild(menuSeparator());
      contextMenu.appendChild(menuButton("Refresh", "codicon-refresh", async () => init(true)));
      contextMenu.appendChild(menuButton("Collapse all", "codicon-collapse-all", async () => collapseLoadedTree()));

      positionContextMenu(ev.clientX, ev.clientY);
      const firstItem = contextMenu.querySelector(".menu-item");
      if (firstItem) firstItem.focus();
    }

    function codiconFor(entry) {
      if (entry.isDir) return "codicon-folder";
      const name = entry.name.toLowerCase();
      const ext = entry.ext.toLowerCase();
      if (name === "package.json") return "codicon-package";
      if (["js", "mjs", "cjs", "ts", "tsx", "jsx"].includes(ext)) return "codicon-symbol-method";
      if (["json", "jsonc"].includes(ext)) return "codicon-json";
      if (["md", "mdx"].includes(ext)) return "codicon-markdown";
      if (["css", "scss", "sass", "less"].includes(ext)) return "codicon-symbol-color";
      if (["html", "htm"].includes(ext)) return "codicon-code";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return "codicon-file-media";
      if (["lock", "toml", "yaml", "yml", "ini", "env"].includes(ext)) return "codicon-settings-gear";
      if (["sh", "zsh", "bash"].includes(ext)) return "codicon-terminal";
      return "codicon-file";
    }

    function typeClassFor(entry) {
      if (entry.isDir) return "";
      const name = entry.name.toLowerCase();
      const ext = entry.ext.toLowerCase();
      if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "type-js";
      if (["ts", "tsx"].includes(ext)) return "type-ts";
      if (["json", "jsonc", "lock"].includes(ext) || name === "package.json") return "type-json";
      if (["md", "mdx"].includes(ext)) return "type-md";
      if (["css", "scss", "sass", "less"].includes(ext)) return "type-style";
      if (["html", "htm"].includes(ext)) return "type-html";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return "type-image";
      if (["toml", "yaml", "yml", "ini", "env"].includes(ext) || name.startsWith(".")) return "type-config";
      if (["sh", "zsh", "bash"].includes(ext)) return "type-shell";
      return "";
    }

    function removeNestedRows(box) {
      for (const nested of box.querySelectorAll(".row")) {
        const index = rows.indexOf(nested);
        if (index !== -1) rows.splice(index, 1);
      }
    }

    function makeRow(entry, depth) {
      const row = document.createElement("div");
      row.className = "row " + (entry.isDir ? "dir" : "file");
      row.style.paddingLeft = (depth * 12 + 4) + "px";
      row.dataset.path = entry.path.toLowerCase();
      row.dataset.rawPath = entry.path;
      row.dataset.absPath = entry.absPath;
      row.dataset.name = entry.name.toLowerCase();
      row.dataset.isDir = String(entry.isDir);
      row.dataset.depth = String(depth);
      row.tabIndex = 0;

      const twisty = document.createElement("span");
      twisty.className = "twisty codicon " + (entry.isDir ? "codicon-chevron-right" : "");

      const icon = document.createElement("span");
      icon.className = [
        entry.isDir ? "folder-icon" : "file-icon",
        typeClassFor(entry),
        "codicon",
        codiconFor(entry),
      ].filter(Boolean).join(" ");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;

      const meta = document.createElement("span");
      meta.className = "meta";

      if (entry.git) {
        const git = document.createElement("span");
        git.className = "git git-" + entry.git;
        git.textContent = entry.git;
        meta.appendChild(git);
      }

      if (!entry.isDir) {
        const size = document.createElement("span");
        size.textContent = entry.size;
        meta.appendChild(size);
      }

      row.appendChild(twisty);
      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(meta);
      rows.push(row);

      if (entry.isDir) {
        row.dataset.open = "false";
        row.onclick = async () => {
          closeContextMenu();
          selectRow(row);
          await toggleDir(row, entry, depth);
        };
      } else {
        row.onclick = () => {
          closeContextMenu();
          selectRow(row);
        };
        row.ondblclick = async () => openFile(row, entry);
      }

      row.oncontextmenu = (ev) => showContextMenu(ev, row, entry);
      row.onpointerdown = (ev) => {
        if (ev.button === 2) selectRow(row);
      };

      row.onkeydown = async (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (entry.isDir) await toggleDir(row, entry, depth);
          else await openFile(row, entry);
        }
      };

      return row;
    }

    async function openFile(row, entry) {
      selectRow(row);
      const old = row.querySelector(".meta").textContent;
      row.querySelector(".meta").textContent = "opening";
      try {
        await postJson("/api/open", { root: rootPath, path: entry.path, session: sessionId });
        setStatus("Opened in Wave: " + entry.absPath);
      } catch (err) {
        alert(String(err));
      } finally {
        row.querySelector(".meta").textContent = old;
      }
    }

    async function toggleDir(row, entry, depth, forceOpen = false) {
      const isOpen = row.dataset.open === "true";
      if (isOpen && forceOpen) return;

      if (isOpen) {
        row.dataset.open = "false";
        row.querySelector(".twisty").className = "twisty codicon codicon-chevron-right";
        row.querySelector(".folder-icon").className = "folder-icon codicon codicon-folder";
        const next = row.nextSibling;
        if (next && next.classList && next.classList.contains("children")) {
          removeNestedRows(next);
          next.remove();
        }
        applyFilter();
        return;
      }

      row.dataset.open = "true";
      row.querySelector(".twisty").className = "twisty codicon codicon-chevron-down";
      row.querySelector(".folder-icon").className = "folder-icon codicon codicon-folder-opened";

      const box = document.createElement("div");
      box.className = "children";
      box.innerHTML = '<div class="loading">Loading...</div>';
      row.after(box);

      try {
        const data = await getJson(
          "/api/list?root=" + encodeURIComponent(rootPath) + "&dir=" + encodeURIComponent(entry.path),
        );
        box.innerHTML = "";

        if (!data.children.length) {
          box.innerHTML = '<div class="empty">Empty</div>';
          return;
        }

        for (const child of data.children) {
          box.appendChild(makeRow(child, depth + 1));
        }

        applyFilter();
      } catch (err) {
        box.innerHTML = '<div class="error">' + String(err) + '</div>';
      }
    }

    function applyFilter() {
      const q = filter.value.trim().toLowerCase();
      for (const row of rows) {
        if (!q) {
          row.classList.remove("hidden");
          continue;
        }
        row.classList.toggle("hidden", !(row.dataset.path || "").includes(q));
      }
    }

    function moveSelection(delta) {
      const visible = visibleRows();
      if (!visible.length) return;
      const current = selected ? visible.indexOf(selected) : -1;
      const nextIndex = Math.max(0, Math.min(visible.length - 1, current + delta));
      selectRow(visible[nextIndex]);
    }

    async function activateSelected() {
      if (!selected) return;
      selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    }

    async function expandSelected() {
      if (!selected || selected.dataset.isDir !== "true") return;
      if (selected.dataset.open === "false") selected.click();
    }

    function collapseSelected() {
      if (!selected || selected.dataset.isDir !== "true") return;
      if (selected.dataset.open === "true") selected.click();
    }

    function collapseLoadedTree() {
      for (const row of [...rows].reverse()) {
        if (row.dataset.isDir === "true" && row.dataset.open === "true") {
          row.click();
        }
      }
    }

    filter.addEventListener("input", applyFilter);

    tree.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      closeContextMenu();
      contextMenu.appendChild(menuButton("Refresh", "codicon-refresh", async () => init(true)));
      contextMenu.appendChild(menuButton("Collapse all", "codicon-collapse-all", async () => collapseLoadedTree()));
      positionContextMenu(ev.clientX, ev.clientY);
    });

    document.addEventListener("pointerdown", (ev) => {
      if (!contextMenu.contains(ev.target)) closeContextMenu();
    });

    clearFilter.onclick = () => {
      closeContextMenu();
      filter.value = "";
      applyFilter();
      filter.focus();
    };

    copyPath.onclick = async () => {
      closeContextMenu();
      if (!selected) return;
      await navigator.clipboard.writeText(selected.dataset.absPath || "");
      setStatus("Copied: " + selected.dataset.absPath);
    };

    refresh.onclick = () => {
      closeContextMenu();
      init(true);
    };
    collapseAll.onclick = () => {
      closeContextMenu();
      collapseLoadedTree();
    };

    document.addEventListener("keydown", async (ev) => {
      if (ev.key === "Escape" && contextMenu.classList.contains("open")) {
        ev.preventDefault();
        const rowToFocus = contextRow;
        closeContextMenu();
        if (rowToFocus) rowToFocus.focus();
        return;
      }

      if (ev.target === filter) {
        if (ev.key === "Escape") {
          filter.blur();
          filter.value = "";
          applyFilter();
        }
        return;
      }

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveSelection(1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveSelection(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        await expandSelected();
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        collapseSelected();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        await activateSelected();
      } else if (ev.key === "/" || ev.key === "f") {
        ev.preventDefault();
        filter.focus();
        filter.select();
      }
    });

    async function init(forceGit = false) {
      const requestedRoot = rootPath || initialRoot;
      const data = await getJson(
        "/api/list?root=" + encodeURIComponent(requestedRoot) + "&dir=&git=" + (forceGit ? "1" : "0"),
      );
      rootPath = data.root;
      repo.textContent = data.repoName || data.root;
      repo.title = data.root;
      tree.innerHTML = "";
      rows = [];
      selected = null;

      for (const child of data.children) {
        tree.appendChild(makeRow(child, 0));
      }

      applyFilter();
      selectRow(visibleRows()[0]);
      setStatus(data.git ? "Git status enabled: " + rootPath : rootPath);
    }

    init().catch((err) => {
      tree.innerHTML = '<div class="error">' + String(err) + '</div>';
    });
  </script>
</body>
</html>
`;

const waveSessions = new Map();

function createWaveSession(env) {
  const session = randomUUID();
  waveSessions.set(session, {
    env,
    createdAt: Date.now(),
  });
  return session;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, HTML);
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        name: "wave-repo-browser",
        mode,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      const remote = req.socket.remoteAddress || "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        return sendJson(res, 403, { error: "Session registration is only allowed locally" });
      }

      const payload = await readJson(req);
      const env = payload.env && typeof payload.env === "object" ? payload.env : {};
      if (!env.WAVETERM_JWT) {
        return sendJson(res, 400, { error: "Missing Wave session" });
      }

      return sendJson(res, 200, { session: createWaveSession(env) });
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      const root = url.searchParams.get("root") || process.cwd();
      const dir = url.searchParams.get("dir") || ".";
      const forceGit = url.searchParams.get("git") === "1";
      return sendJson(res, 200, await listDir(root, dir, forceGit));
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      const payload = await readJson(req);
      const absFile = safeResolve(payload.root || process.cwd(), payload.path || "");
      const stat = await fs.lstat(absFile);

      if (!stat.isFile()) {
        return sendJson(res, 400, { error: "Not a file" });
      }

      const session = waveSessions.get(payload.session || "");
      const waveEnv = session?.env || currentWaveEnv();
      if (!waveEnv.WAVETERM_JWT) {
        return sendJson(res, 409, { error: "Missing Wave session. Reopen WRB from a Wave terminal and try again." });
      }

      await openWithWave(absFile, waveEnv);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${listenPort} is already in use on ${listenHost}.`);
    console.error("Stop the existing wrb process or pass --port <other-port>.");
    process.exit(1);
  }

  console.error(String(err.message || err));
  process.exit(1);
});

server.listen(listenPort, listenHost, async () => {
  const addr = server.address();
  const url = publicServiceUrl(addr.port);

  await writeServiceState(addr.port);
  console.log("Mode:", mode);
  console.log("Listen:", listenHost + ":" + addr.port);
  console.log("URL:", url);
  if (mode === "remote") {
    console.log("Connection:", process.env.WAVETERM_CONN || "unknown");
  }

  if (shouldOpen) {
    const sessionId = currentWaveEnv().WAVETERM_JWT ? createWaveSession(currentWaveEnv()) : "";
    openWebInWave(browseUrl(url, BROWSE_ROOT, sessionId));
  }
});
