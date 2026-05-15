#!/usr/bin/env bun

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSE_ROOT = path.resolve(options.root || process.cwd());
const TEXT_PREVIEW_LIMIT = 1024 * 1024;

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

function sqliteCommand() {
  return firstExecutable(["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) || "sqlite3";
}

function waveDbPath() {
  const home = process.env.HOME || "";
  if (!home) return "";
  return path.join(home, "Library", "Application Support", "waveterm", "db", "waveterm.db");
}

function waveWebBlockIdForSession(sessionId, pageUrl = "") {
  if (mode !== "local" || process.platform !== "darwin" || !sessionId) return "";

  const dbPath = waveDbPath();
  if (!dbPath) return "";

  const exists = spawnSync("test", ["-f", dbPath]);
  if (exists.status !== 0) return "";

  const result = spawnSync(sqliteCommand(), ["-readonly", "-json", dbPath, "select data from db_block;"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  });
  if (result.status !== 0) return "";

  let rows = [];
  try {
    rows = JSON.parse(result.stdout || "[]");
  } catch {
    return "";
  }

  const matches = [];
  for (const row of rows) {
    let block = null;
    try {
      block = JSON.parse(row.data || "{}");
    } catch {
      continue;
    }

    const url = block?.meta?.view === "web" ? block.meta.url : "";
    if (!url || !block?.oid) continue;

    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("session") !== sessionId) continue;
      matches.push({ oid: block.oid, url });
    } catch {
      continue;
    }
  }

  return matches.find((match) => pageUrl && match.url === pageUrl)?.oid || matches[0]?.oid || "";
}

async function registerWaveSession(baseUrl, waveEnv = currentWaveEnv()) {
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
  const candidatePorts = [...new Set([state?.port, listenPort > 0 ? listenPort : 0].filter(Boolean))];

  for (const candidatePort of candidatePorts) {
    try {
      const res = await fetch(`${localServiceUrl(candidatePort)}/api/health`);
      if (!res.ok) continue;

      const data = await res.json();
      if (data.name !== "wave-repo-browser" || data.mode !== mode) continue;

      return publicServiceUrl(candidatePort);
    } catch {
      // Try the next candidate. Stale state files are expected after crashes.
    }
  }

  return "";
}

async function openExistingServiceIfAvailable() {
  if (options.host || options.publicHost) return false;

  const baseUrl = await existingServiceBaseUrl();
  if (!baseUrl) return false;

  const waveEnv = currentWaveEnv();
  const sessionId = await registerWaveSession(baseUrl, waveEnv);
  const url = browseUrl(baseUrl, BROWSE_ROOT, sessionId);
  if (shouldOpen) await openWebInWave(url, waveEnv);
  console.log(`wrb opened ${BROWSE_ROOT}`);
  console.log(`URL: ${url}`);
  return true;
}

async function daemonizeIfNeeded() {
  if (options.foreground || options.service) return;

  if (await openExistingServiceIfAvailable()) {
    process.exit(0);
  }

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
      const waveEnv = currentWaveEnv();
      const sessionId = await registerWaveSession(startedBaseUrl, waveEnv);
      const url = browseUrl(startedBaseUrl, BROWSE_ROOT, sessionId);
      if (shouldOpen) await openWebInWave(url, waveEnv);
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function safeResolve(root, relPath = ".") {
  const absRoot = path.resolve(root || ".");
  const absPath = path.resolve(absRoot, relPath || ".");
  if (!isInsideRoot(absRoot, absPath)) {
    throw httpError(403, "Path escapes browse root");
  }
  return absPath;
}

async function realPathInsideRoot(root, absPath) {
  const [realRoot, realPath] = await Promise.all([fs.realpath(path.resolve(root || ".")), fs.realpath(absPath)]);
  if (!isInsideRoot(realRoot, realPath)) {
    throw httpError(403, "Path escapes browse root");
  }
  return realPath;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name) {
  return path.extname(name).replace(/^\./, "").toLowerCase();
}

function languageForPath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = extensionOf(base);

  if (base === "package.json" || ext === "json" || ext === "jsonc") return "json";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["html", "htm"].includes(ext)) return "html";
  if (["sh", "zsh", "bash"].includes(ext)) return "shell";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (ext === "toml") return "toml";
  return "plaintext";
}

function looksBinary(buffer) {
  return buffer.includes(0);
}

function decodeTextBuffer(buffer) {
  if (looksBinary(buffer)) {
    throw httpError(409, "File appears to be binary");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw httpError(409, "File appears to be binary");
  }
}

async function previewFile(root, relPath = "") {
  const absRoot = path.resolve(root || ".");
  const absPath = safeResolve(absRoot, relPath || "");

  let realPath;
  let stat;
  try {
    realPath = await realPathInsideRoot(absRoot, absPath);
    stat = await fs.stat(realPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      throw httpError(404, "File not found");
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw httpError(400, "Path is a directory or not a file");
  }

  if (stat.size > TEXT_PREVIEW_LIMIT) {
    throw httpError(409, "File is too large to preview");
  }

  const buffer = await fs.readFile(realPath);
  const content = decodeTextBuffer(buffer);

  return {
    path: path.relative(absRoot, absPath),
    absPath,
    language: languageForPath(absPath),
    content,
    size: stat.size,
    readOnly: true,
  };
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

function gitRepoRoot(root) {
  const absRoot = path.resolve(root || ".");
  const result = spawnSync("git", ["-C", absRoot, "rev-parse", "--is-inside-work-tree", "--show-cdup"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw httpError(409, "Root is not a git repository");
  }

  const [isInside, cdup = ""] = result.stdout.split(/\r?\n/);
  if (isInside.trim() !== "true") {
    throw httpError(409, "Root is not a git repository");
  }

  return path.resolve(absRoot, cdup.trim() || ".");
}

function ensureInsideRepo(repoRoot, relPath = "") {
  const absRoot = path.resolve(repoRoot || ".");
  const absPath = path.resolve(absRoot, relPath || "");
  if (!isInsideRoot(absRoot, absPath)) {
    throw httpError(403, "Path escapes git repository");
  }
  return {
    absPath,
    relPath: path.relative(absRoot, absPath),
  };
}

async function readWorktreeDiffContent(repoRoot, relPath) {
  const { absPath } = ensureInsideRepo(repoRoot, relPath);

  let realPath;
  let stat;
  try {
    realPath = await realPathInsideRoot(repoRoot, absPath);
    stat = await fs.stat(realPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      throw httpError(404, "File not found");
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw httpError(400, "Path is a directory or not a file");
  }

  if (stat.size > TEXT_PREVIEW_LIMIT) {
    throw httpError(409, "File is too large to preview");
  }

  return decodeTextBuffer(await fs.readFile(realPath));
}

function readGitBlob(repoRoot, objectSpec, { missingAsEmpty = false } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, "show", objectSpec], {
    encoding: "buffer",
    maxBuffer: TEXT_PREVIEW_LIMIT + 1,
  });

  if (result.error?.code === "ENOBUFS" || result.stdout.length > TEXT_PREVIEW_LIMIT) {
    throw httpError(409, "File is too large to preview");
  }

  if (result.status !== 0) {
    const exists = gitBlobExists(repoRoot, objectSpec);
    if (!exists) {
      if (missingAsEmpty) return "";
      throw httpError(404, "Git blob not found");
    }
    throw httpError(500, "Failed to read git blob");
  }

  return decodeTextBuffer(result.stdout);
}

function gitBlobExists(repoRoot, objectSpec) {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", objectSpec], {
    encoding: "utf8",
  });

  if (result.error) {
    throw httpError(500, "Failed to inspect git blob");
  }

  if (result.status === 0) return true;

  const stderr = result.stderr || "";
  if (
    /does not exist/i.test(stderr) ||
    /invalid object name 'HEAD'/i.test(stderr) ||
    /exists on disk, but not in 'HEAD'/i.test(stderr)
  ) {
    return false;
  }

  throw httpError(500, "Failed to inspect git blob");
}

async function gitDiff(root, relPath, area) {
  const validAreas = new Set(["staged", "worktree", "untracked"]);
  if (!validAreas.has(area)) {
    throw httpError(400, "Invalid git diff area");
  }

  const repoRoot = gitRepoRoot(root);
  const { relPath: repoRelPath } = ensureInsideRepo(repoRoot, relPath);
  const response = {
    path: repoRelPath,
    area,
    language: languageForPath(repoRelPath),
    original: "",
    modified: "",
    originalLabel: "",
    modifiedLabel: "",
  };

  if (area === "staged") {
    const headSpec = `HEAD:${repoRelPath}`;
    const indexSpec = `:0:${repoRelPath}`;
    const hasHead = gitBlobExists(repoRoot, headSpec);
    const hasIndex = gitBlobExists(repoRoot, indexSpec);
    response.original = hasHead ? readGitBlob(repoRoot, headSpec) : "";
    response.modified = hasIndex ? readGitBlob(repoRoot, indexSpec) : "";
    if (!hasHead && !hasIndex) {
      response.modified = readGitBlob(repoRoot, indexSpec);
    }
    response.originalLabel = "HEAD";
    response.modifiedLabel = "Index";
    return response;
  }

  if (area === "worktree") {
    const headSpec = `HEAD:${repoRelPath}`;
    const hasHead = gitBlobExists(repoRoot, headSpec);
    response.original = hasHead ? readGitBlob(repoRoot, headSpec) : "";
    try {
      response.modified = await readWorktreeDiffContent(repoRoot, repoRelPath);
    } catch (err) {
      if (err?.status === 404 && hasHead) {
        response.modified = "";
      } else {
        throw err;
      }
    }
    response.originalLabel = "HEAD";
    response.modifiedLabel = "Working Tree";
    return response;
  }

  response.modified = await readWorktreeDiffContent(repoRoot, repoRelPath);
  response.originalLabel = "Empty";
  response.modifiedLabel = "Working Tree";
  return response;
}

function parseBranchLine(line) {
  const branch = {
    name: "",
    ahead: 0,
    behind: 0,
  };
  if (!line.startsWith("## ")) return branch;

  const body = line.slice(3).trim();
  const match = body.match(/^(.*?)(?:\.\.\..*?)?(?: \[(.*)\])?$/);
  branch.name = (match?.[1] || body).trim();

  const counts = match?.[2] || "";
  const ahead = counts.match(/ahead (\d+)/);
  const behind = counts.match(/behind (\d+)/);
  branch.ahead = ahead ? Number(ahead[1]) : 0;
  branch.behind = behind ? Number(behind[1]) : 0;

  return branch;
}

function statusItem(repoRoot, pathValue, status, oldPath) {
  return {
    path: pathValue,
    ...(oldPath ? { oldPath } : {}),
    status,
    absPath: path.join(repoRoot, pathValue),
  };
}

function gitPorcelainStatusKind(code) {
  if (!code || code === " ") return "";
  if (code === "?") return "?";
  return gitStatusKind(code);
}

function parseGitStatusGroups(output, repoRoot) {
  const records = output.split("\0").filter(Boolean);
  const groups = {
    branch: "",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("## ")) {
      const branch = parseBranchLine(record);
      groups.branch = branch.name;
      groups.ahead = branch.ahead;
      groups.behind = branch.behind;
      continue;
    }

    const indexStatus = record[0] || " ";
    const worktreeStatus = record[1] || " ";
    let pathValue = record.slice(3);
    let oldPath = "";
    if (!pathValue) continue;

    if (indexStatus === "?" && worktreeStatus === "?") {
      groups.untracked.push(statusItem(repoRoot, pathValue, "?"));
      continue;
    }

    if (indexStatus === "R" || indexStatus === "C") {
      oldPath = records[index + 1] || "";
      if (oldPath) index += 1;
    }

    if (indexStatus !== " ") {
      groups.staged.push(statusItem(repoRoot, pathValue, gitPorcelainStatusKind(indexStatus), oldPath));
    }

    if (worktreeStatus !== " ") {
      groups.unstaged.push(statusItem(repoRoot, pathValue, gitPorcelainStatusKind(worktreeStatus), oldPath));
    }
  }

  for (const key of ["staged", "unstaged", "untracked"]) {
    groups[key].sort((a, b) => a.path.localeCompare(b.path));
  }

  return groups;
}

function gitStatus(root) {
  const absRoot = path.resolve(root || ".");
  const repoRoot = gitRepoRoot(absRoot);
  const result = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--branch"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });

  if (result.status !== 0) {
    throw httpError(500, (result.stderr || "Unable to read git status").trim());
  }

  const groups = parseGitStatusGroups(result.stdout, repoRoot);
  return {
    root: absRoot,
    repoRoot,
    branch: groups.branch,
    ahead: groups.ahead,
    behind: groups.behind,
    staged: groups.staged,
    unstaged: groups.unstaged,
    untracked: groups.untracked,
  };
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
  await realPathInsideRoot(absRoot, absDir);
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

    const abs = path.join(absDir, entry.name);
    const rel = path.relative(absRoot, abs);
    let itemStat;
    let realAbs;
    try {
      itemStat = await fs.stat(abs);
      realAbs = await realPathInsideRoot(absRoot, abs);
    } catch {
      continue;
    }

    const isDir = itemStat.isDirectory();
    const isSymlink = entry.isSymbolicLink();
    const gitRel = state.repoRoot ? path.relative(state.repoRoot, abs) : rel;
    const git = gitStatusKind(gitStatus.get(gitRel));

    children.push({
      name: entry.name,
      path: rel,
      absPath: abs,
      realPath: realAbs,
      ext: isDir ? "" : extensionOf(entry.name),
      isDir,
      isSymlink,
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

function assetContentType(absPath) {
  switch (extensionOf(absPath)) {
    case "js":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "ttf":
      return "font/ttf";
    case "woff2":
      return "font/woff2";
    case "json":
    case "map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function sendFileAsset(res, absPath) {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      throw httpError(404, "Asset not found");
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw httpError(404, "Asset not found");
  }

  const body = await fs.readFile(absPath);
  res.writeHead(200, {
    "content-type": assetContentType(absPath),
    "content-length": body.length,
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(body);
}

async function existingDirectory(...candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Try the next asset location.
    }
  }

  return "";
}

async function monacoRoot() {
  const executableDir = path.dirname(process.execPath);
  const envRoot = process.env.WRB_MONACO_ROOT || "";
  return existingDirectory(
    envRoot,
    path.resolve(executableDir, "monaco-editor"),
    path.resolve(executableDir, "..", "monaco-editor"),
    path.resolve(APP_ROOT, "monaco-editor"),
    path.resolve(APP_ROOT, "node_modules", "monaco-editor"),
    path.resolve(process.cwd(), "dist", "monaco-editor"),
    path.resolve(process.cwd(), "node_modules", "monaco-editor"),
  );
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

async function openWithWave(absFile, waveEnv = {}, targetBlockId = "") {
  const args = targetBlockId ? ["-b", targetBlockId, "view", absFile] : ["view", absFile];
  const result = await runCommand(wshCommand(), args, { ...process.env, ...waveEnv });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `wsh exited with status ${result.status}`).trim();
    throw new Error(message);
  }
}

function waveBlockId(env = process.env) {
  return env.WAVETERM_BLOCKID || env.WAVETERM_BLOCK_ID || env.WAVETERM_BLOCK || "";
}

async function openWebInWave(url, env = process.env) {
  const blockId = waveBlockId(env);
  const args = blockId ? ["-b", blockId, "web", "open", url] : ["web", "open", url];
  const result = await runCommand(wshCommand(), args, { ...process.env, ...env });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `wsh exited with status ${result.status}`).trim();
    console.error(`Failed to open WRB web block: ${message}`);
  }
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
      grid-template-columns: minmax(280px, 34vw) minmax(360px, 1fr);
      min-width: 640px;
      overflow: hidden;
    }

    #sidebar {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      border-right: 1px solid var(--line);
      background: var(--bg);
    }

    #activityBar {
      display: grid;
      grid-auto-rows: 48px;
      align-content: start;
      justify-items: center;
      padding: 4px 0;
      background: #181818;
      border-right: 1px solid var(--line);
    }

    .activity-btn {
      width: 48px;
      height: 48px;
      display: grid;
      place-items: center;
      border: 0;
      border-left: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: default;
      font-size: 22px;
    }

    .activity-btn:hover,
    .activity-btn.active {
      color: var(--text);
    }

    .activity-btn.active {
      border-left-color: var(--accent);
      background: rgba(255, 255, 255, .04);
    }

    #sidePanel {
      min-width: 0;
      min-height: 0;
      display: grid;
      background: var(--bg);
    }

    .side-view {
      min-width: 0;
      min-height: 0;
      display: none;
      grid-template-rows: auto auto 1fr auto;
    }

    .side-view.active {
      display: grid;
    }

    #sourceControlView {
      grid-template-rows: auto 1fr;
    }

    .source-control-body {
      min-height: 0;
      overflow: auto;
      padding: 12px;
      color: var(--muted);
    }

    #gitSummary {
      margin-bottom: 10px;
      color: var(--soft-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #gitChanges {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    .git-group-title {
      height: 24px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--soft-text);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .35px;
      text-transform: uppercase;
    }

    .git-row {
      width: 100%;
      height: 38px;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 24px;
      align-items: center;
      gap: 7px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--soft-text);
      font: inherit;
      text-align: left;
      padding: 0 6px 0 4px;
      cursor: default;
      user-select: none;
    }

    .git-row:hover,
    .git-row:focus {
      outline: none;
      background: var(--hover);
    }

    .git-row.active {
      background: var(--selected);
      box-shadow: inset 2px 0 0 var(--selected-line);
    }

    .git-file {
      min-width: 0;
      display: grid;
      gap: 1px;
    }

    .git-name,
    .git-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .git-name {
      color: var(--soft-text);
      line-height: 17px;
    }

    .git-path {
      color: var(--muted);
      font-size: 11px;
      line-height: 15px;
    }

    .git-preview {
      width: 22px;
      height: 22px;
      display: inline-grid;
      place-items: center;
      color: var(--muted);
      font-size: 14px;
    }

    .git-row:hover .git-preview,
    .git-row:focus .git-preview,
    .git-row.active .git-preview {
      color: var(--text);
    }

    .git-empty {
      height: 24px;
      display: flex;
      align-items: center;
      color: var(--muted);
      padding-left: 31px;
      font-size: 12px;
    }

    .placeholder {
      color: var(--muted);
    }

    #header,
    .panel-header {
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

    #editorPane {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: 35px 1fr;
      background: #1e1e1e;
    }

    #editorTitle {
      min-width: 0;
      display: flex;
      align-items: center;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      background: #202020;
      color: var(--soft-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .editor-body {
      position: relative;
      min-width: 0;
      min-height: 0;
    }

    #monacoHost {
      position: absolute;
      inset: 0;
      display: none;
    }

    #editorFallback {
      position: absolute;
      inset: 0;
      display: grid;
      place-content: center;
      gap: 12px;
      padding: 24px;
      color: var(--muted);
      text-align: center;
    }

    #editorFallback[hidden] {
      display: none;
    }

    .fallback-actions {
      display: flex;
      justify-content: center;
    }

    .text-btn {
      min-height: 28px;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      background: #2d2d2d;
      color: var(--soft-text);
      padding: 4px 10px;
      font: inherit;
      cursor: default;
    }

    .text-btn:hover,
    .text-btn:focus {
      outline: none;
      border-color: var(--accent);
      color: var(--text);
      background: #22272e;
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
    <div id="sidebar">
      <div id="activityBar" aria-label="Activity bar">
        <button id="showExplorer" class="activity-btn active" type="button" title="Explorer" aria-label="Explorer">
          <span class="codicon codicon-files"></span>
        </button>
        <button id="showSourceControl" class="activity-btn" type="button" title="Source Control" aria-label="Source Control">
          <span class="codicon codicon-source-control"></span>
        </button>
      </div>
      <div id="sidePanel">
        <div id="explorerView" class="side-view active">
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
        <div id="sourceControlView" class="side-view" hidden>
          <div class="panel-header">
            <div>Source Control</div>
            <button id="gitRefresh" class="icon-btn" title="Refresh source control"><span class="codicon codicon-refresh"></span></button>
          </div>
          <div class="source-control-body">
            <div id="gitSummary">Source Control will load in Task 6.</div>
            <div id="gitChanges" class="placeholder">No changes loaded.</div>
          </div>
        </div>
      </div>
    </div>
    <div id="editorPane">
      <div id="editorTitle">No file selected</div>
      <div class="editor-body">
        <div id="monacoHost"></div>
        <div id="editorFallback">
          <div>Select a file to preview it.</div>
        </div>
      </div>
    </div>
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
    const showExplorer = document.getElementById("showExplorer");
    const showSourceControl = document.getElementById("showSourceControl");
    const explorerView = document.getElementById("explorerView");
    const sourceControlView = document.getElementById("sourceControlView");
    const gitRefresh = document.getElementById("gitRefresh");
    const gitSummary = document.getElementById("gitSummary");
    const gitChanges = document.getElementById("gitChanges");
    const editorTitle = document.getElementById("editorTitle");
    const monacoHost = document.getElementById("monacoHost");
    const editorFallback = document.getElementById("editorFallback");

    let rows = [];
    let selected = null;
    let contextRow = null;
    let rootPath = "";
    let activeEditor = null;
    let activeModel = null;
    let monacoPromise = null;
    let previewRequest = 0;
    let gitStatusRequest = 0;
    let gitStatusLoaded = false;
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

    function setActiveView(view) {
      const isSourceControl = view === "sourceControl";
      explorerView.classList.toggle("active", !isSourceControl);
      explorerView.hidden = isSourceControl;
      sourceControlView.classList.toggle("active", isSourceControl);
      sourceControlView.hidden = !isSourceControl;
      showExplorer.classList.toggle("active", !isSourceControl);
      showSourceControl.classList.toggle("active", isSourceControl);

      if (isSourceControl) {
        loadGitStatus();
      } else {
        setStatus(selected?.dataset.absPath || rootPath || "");
      }
    }

    function loadMonaco() {
      if (window.monaco) return Promise.resolve(window.monaco);
      if (monacoPromise) return monacoPromise;

      monacoPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/monaco/min/vs/loader.js";
        script.onload = () => {
          window.require.config({ paths: { vs: "/monaco/min/vs" } });
          window.require(
            ["vs/editor/editor.main"],
            () => resolve(window.monaco),
            (err) => reject(err || new Error("Unable to load Monaco editor")),
          );
        };
        script.onerror = () => reject(new Error("Unable to load Monaco loader"));
        document.head.appendChild(script);
      });

      return monacoPromise;
    }

    function clearEditor() {
      if (activeEditor) {
        activeEditor.dispose();
        activeEditor = null;
      }

      if (window.monaco?.editor) {
        for (const model of window.monaco.editor.getModels()) {
          model.dispose();
        }
      } else if (activeModel) {
        activeModel.dispose();
      }

      activeModel = null;
      monacoHost.replaceChildren();
    }

    function showEditorFallback(message, row, entry) {
      clearEditor();
      monacoHost.style.display = "none";
      editorFallback.hidden = false;
      editorFallback.replaceChildren();

      const text = document.createElement("div");
      text.textContent = message;
      editorFallback.appendChild(text);

      if (entry && !entry.isDir) {
        const actions = document.createElement("div");
        actions.className = "fallback-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-btn";
        button.textContent = "Open in Wave";
        button.onclick = async () => {
          await openFile(row, entry);
        };
        actions.appendChild(button);
        editorFallback.appendChild(actions);
      }
    }

    async function openPreview(row, entry) {
      if (!entry || entry.isDir) return;

      const requestId = ++previewRequest;
      editorTitle.textContent = entry.path;
      editorTitle.title = entry.absPath || entry.path;
      showEditorFallback("Loading preview...", null, null);

      try {
        const data = await getJson(
          "/api/file?root=" + encodeURIComponent(rootPath) + "&path=" + encodeURIComponent(entry.path),
        );
        if (requestId !== previewRequest) return;

        const monaco = await loadMonaco();
        if (requestId !== previewRequest) return;

        clearEditor();
        editorFallback.hidden = true;
        monacoHost.style.display = "block";
        activeModel = monaco.editor.createModel(data.content, data.language || "plaintext");
        activeEditor = monaco.editor.create(monacoHost, {
          model: activeModel,
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          theme: "vs-dark",
          scrollBeyondLastLine: false,
        });
        setStatus("Previewing: " + data.absPath);
      } catch (err) {
        if (requestId !== previewRequest) return;
        showEditorFallback(String(err.message || err), row, entry);
        setStatus("Preview unavailable: " + entry.absPath);
      }
    }

    function pathBaseName(filePath) {
      const normalized = String(filePath || "").replace(/\/+$/, "");
      const parts = normalized.split("/");
      return parts.pop() || normalized || "(unknown)";
    }

    function pathDirName(filePath) {
      const normalized = String(filePath || "").replace(/\/+$/, "");
      const index = normalized.lastIndexOf("/");
      return index > 0 ? normalized.slice(0, index) : "";
    }

    function gitStatusClass(statusText) {
      return statusText === "?" ? "U" : String(statusText || "").replace(/[^A-Z]/g, "") || "U";
    }

    function gitAreaLabel(area) {
      if (area === "staged") return "Staged Changes";
      if (area === "worktree") return "Changes";
      return "Untracked";
    }

    function gitSecondaryText(item) {
      if (item.oldPath) return item.oldPath + " -> " + item.path;
      return pathDirName(item.path) || item.path;
    }

    function formatGitSummary(data) {
      const stagedCount = data.staged?.length || 0;
      const unstagedCount = data.unstaged?.length || 0;
      const untrackedCount = data.untracked?.length || 0;
      const total = stagedCount + unstagedCount + untrackedCount;
      const branch = data.branch || "detached HEAD";
      const sync = [
        data.ahead ? "ahead " + data.ahead : "",
        data.behind ? "behind " + data.behind : "",
      ].filter(Boolean).join(", ");
      const counts = total
        ? total + " change" + (total === 1 ? "" : "s") + " (" + stagedCount + " staged, " + unstagedCount + " changed, " + untrackedCount + " untracked)"
        : "No changes";
      return branch + (sync ? " (" + sync + ")" : "") + " - " + counts;
    }

    function renderGitGroup(title, area, items) {
      const group = document.createElement("section");
      group.className = "git-group";

      const header = document.createElement("div");
      header.className = "git-group-title";
      header.textContent = title + " (" + items.length + ")";
      group.appendChild(header);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "git-empty";
        empty.textContent = "No files";
        group.appendChild(empty);
        return group;
      }

      for (const item of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "git-row";
        row.title = item.oldPath ? item.oldPath + " -> " + item.path : item.path;

        const badge = document.createElement("span");
        badge.className = "git git-" + gitStatusClass(item.status);
        badge.textContent = item.status || "?";

        const file = document.createElement("span");
        file.className = "git-file";

        const name = document.createElement("span");
        name.className = "git-name";
        name.textContent = pathBaseName(item.path);

        const secondary = document.createElement("span");
        secondary.className = "git-path";
        secondary.textContent = gitSecondaryText(item);

        const preview = document.createElement("span");
        preview.className = "git-preview codicon codicon-diff";
        preview.setAttribute("aria-hidden", "true");

        file.appendChild(name);
        file.appendChild(secondary);
        row.appendChild(badge);
        row.appendChild(file);
        row.appendChild(preview);

        row.onclick = async () => {
          closeContextMenu();
          gitChanges.querySelectorAll(".git-row.active").forEach((el) => el.classList.remove("active"));
          row.classList.add("active");
          await openGitDiff(item, area);
        };

        group.appendChild(row);
      }

      return group;
    }

    function renderGitStatus(data) {
      gitStatusLoaded = true;
      gitSummary.textContent = formatGitSummary(data);
      gitSummary.title = data.repoRoot || data.root || "";
      gitChanges.classList.remove("placeholder");
      gitChanges.replaceChildren(
        renderGitGroup(gitAreaLabel("staged"), "staged", data.staged || []),
        renderGitGroup(gitAreaLabel("worktree"), "worktree", data.unstaged || []),
        renderGitGroup(gitAreaLabel("untracked"), "untracked", data.untracked || []),
      );
      setStatus("Source Control: " + (data.repoRoot || data.root || rootPath));
    }

    async function loadGitStatus(force = false) {
      if (gitStatusLoaded && !force) {
        setStatus("Source Control: " + (rootPath || initialRoot || ""));
        return;
      }

      const requestId = ++gitStatusRequest;
      gitSummary.textContent = "Loading Source Control...";
      gitChanges.classList.add("placeholder");
      gitChanges.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "loading";
      loading.textContent = "Loading changes...";
      gitChanges.appendChild(loading);
      setStatus("Loading Source Control...");

      try {
        const requestedRoot = rootPath || initialRoot;
        const data = await getJson("/api/git/status?root=" + encodeURIComponent(requestedRoot));
        if (requestId !== gitStatusRequest) return;
        rootPath = data.root || rootPath || requestedRoot;
        renderGitStatus(data);
      } catch (err) {
        if (requestId !== gitStatusRequest) return;
        gitStatusLoaded = false;
        const message = String(err.message || err);
        gitSummary.textContent = "Unable to load Source Control";
        gitChanges.classList.add("placeholder");
        gitChanges.replaceChildren();
        const error = document.createElement("div");
        error.className = "error";
        error.textContent = message;
        gitChanges.appendChild(error);
        setStatus("Source Control unavailable: " + message);
      }
    }

    async function openGitDiff(item, area) {
      const requestId = ++previewRequest;
      const label = item.oldPath ? item.oldPath + " -> " + item.path : item.path;
      editorTitle.textContent = "Diff: " + label;
      editorTitle.title = label;
      showEditorFallback("Loading diff...", null, null);
      setStatus("Loading diff: " + label);

      try {
        const data = await getJson(
          "/api/git/diff?root=" + encodeURIComponent(rootPath || initialRoot) +
            "&path=" + encodeURIComponent(item.path) +
            "&area=" + encodeURIComponent(area),
        );
        if (requestId !== previewRequest) return;

        const monaco = await loadMonaco();
        if (requestId !== previewRequest) return;

        clearEditor();
        editorFallback.hidden = true;
        monacoHost.style.display = "block";

        const language = data.language || "plaintext";
        const originalModel = monaco.editor.createModel(data.original || "", language);
        const modifiedModel = monaco.editor.createModel(data.modified || "", language);
        activeEditor = monaco.editor.createDiffEditor(monacoHost, {
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          theme: "vs-dark",
          scrollBeyondLastLine: false,
          renderSideBySide: monacoHost.clientWidth > 760,
        });
        activeEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        });
        activeModel = modifiedModel;

        const title = data.path + " (" + (data.originalLabel || "Original") + " -> " + (data.modifiedLabel || "Modified") + ")";
        editorTitle.textContent = title;
        editorTitle.title = title;
        setStatus("Diff: " + data.path + " [" + gitAreaLabel(data.area || area) + "]");
      } catch (err) {
        if (requestId !== previewRequest) return;
        const message = String(err.message || err);
        editorTitle.textContent = "Diff unavailable: " + label;
        editorTitle.title = label;
        showEditorFallback(message, null, null);
        setStatus("Diff unavailable: " + message);
      }
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
      if (entry.isSymlink && entry.isDir) return "codicon-file-symlink-directory";
      if (entry.isSymlink) return "codicon-file-symlink-file";
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
      row.dataset.realPath = entry.realPath || "";
      row.dataset.name = entry.name.toLowerCase();
      row.dataset.isDir = String(entry.isDir);
      row.dataset.isSymlink = String(Boolean(entry.isSymlink));
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
        row.onclick = async () => {
          closeContextMenu();
          selectRow(row);
          await openPreview(row, entry);
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
        await postJson("/api/open", { root: rootPath, path: entry.path, session: sessionId, pageUrl: window.location.href });
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
        box.replaceChildren();
        const error = document.createElement("div");
        error.className = "error";
        error.textContent = String(err);
        box.appendChild(error);
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

    showExplorer.onclick = () => {
      closeContextMenu();
      setActiveView("explorer");
    };

    showSourceControl.onclick = () => {
      closeContextMenu();
      setActiveView("sourceControl");
    };

    gitRefresh.onclick = () => {
      closeContextMenu();
      loadGitStatus(true);
    };

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
      tree.replaceChildren();
      const error = document.createElement("div");
      error.className = "error";
      error.textContent = String(err);
      tree.appendChild(error);
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

    if (req.method === "GET" && url.pathname.startsWith("/monaco/")) {
      let assetPath;
      try {
        assetPath = decodeURIComponent(url.pathname.slice("/monaco/".length));
      } catch {
        throw httpError(400, "Invalid Monaco asset path");
      }

      const root = await monacoRoot();
      if (!root) throw httpError(404, "Monaco assets not found");

      const absRoot = path.resolve(root);
      const absPath = path.resolve(absRoot, assetPath);
      if (!isInsideRoot(absRoot, absPath)) {
        return sendJson(res, 403, { error: "Path escapes Monaco assets" });
      }

      await sendFileAsset(res, absPath);
      return;
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

    if (req.method === "GET" && url.pathname === "/api/file") {
      const root = url.searchParams.get("root") || process.cwd();
      const filePath = url.searchParams.get("path") || "";
      return sendJson(res, 200, await previewFile(root, filePath));
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      const root = url.searchParams.get("root") || process.cwd();
      const dir = url.searchParams.get("dir") || ".";
      const forceGit = url.searchParams.get("git") === "1";
      return sendJson(res, 200, await listDir(root, dir, forceGit));
    }

    if (req.method === "GET" && url.pathname === "/api/git/status") {
      const root = url.searchParams.get("root") || process.cwd();
      return sendJson(res, 200, gitStatus(root));
    }

    if (req.method === "GET" && url.pathname === "/api/git/diff") {
      const root = url.searchParams.get("root") || process.cwd();
      const filePath = url.searchParams.get("path") || "";
      const area = url.searchParams.get("area") || "";
      return sendJson(res, 200, await gitDiff(root, filePath, area));
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      const payload = await readJson(req);
      const absFile = safeResolve(payload.root || process.cwd(), payload.path || "");
      try {
        await realPathInsideRoot(payload.root || process.cwd(), absFile);
      } catch (err) {
        if (err?.status === 403) throw new Error(err.message);
        throw err;
      }
      const stat = await fs.stat(absFile);

      if (!stat.isFile()) {
        return sendJson(res, 400, { error: "Not a file" });
      }

      const session = waveSessions.get(payload.session || "");
      const waveEnv = session?.env || currentWaveEnv();
      if (!waveEnv.WAVETERM_JWT) {
        return sendJson(res, 409, { error: "Missing Wave session. Reopen WRB from a Wave terminal and try again." });
      }

      const targetBlockId = waveWebBlockIdForSession(payload.session || "", payload.pageUrl || "");
      await openWithWave(absFile, waveEnv, targetBlockId);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, err.status || 500, { error: String(err.message || err) });
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
    await openWebInWave(browseUrl(url, BROWSE_ROOT, sessionId));
  }
});
