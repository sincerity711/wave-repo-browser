#!/usr/bin/env bun

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
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
const DEFAULT_REMOTE_PORT = 17876;

function detectPublicHost() {
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
const listenPort = Number(options.port || (mode === "remote" ? DEFAULT_REMOTE_PORT : 0));
const publicHost = options.publicHost || (mode === "remote" ? detectPublicHost() : "127.0.0.1");

function defaultRoot() {
  const result = spawnSync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

const ROOT = path.resolve(options.root || defaultRoot());
const REPO_NAME = path.basename(ROOT);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function logPathForRoot() {
  const slug = `${REPO_NAME}-${ROOT}`.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return path.join(process.env.TMPDIR || "/tmp", `wrb-${slug || "repo"}.log`);
}

function daemonizeIfNeeded() {
  if (options.foreground) return;

  const childArgs = argv.includes("--foreground") ? [...argv] : [...argv, "--foreground"];
  const logPath = logPathForRoot();
  const command = `${shellQuote(process.execPath)} ${childArgs.map(shellQuote).join(" ")} >> ${shellQuote(logPath)} 2>&1`;

  spawn("sh", ["-lc", command], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();

  console.log(`wrb started for ${ROOT}`);
  console.log(`log: ${logPath}`);
  process.exit(0);
}

daemonizeIfNeeded();

let gitStatusCache = new Map();
let gitStatusAt = 0;
let isGitRepoCache = null;

function isInsideRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeResolve(relPath = ".") {
  const absPath = path.resolve(ROOT, relPath || ".");
  if (!isInsideRoot(absPath)) {
    throw new Error("Path escapes repo root");
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

function isGitRepo() {
  if (isGitRepoCache !== null) return isGitRepoCache;
  const result = spawnSync("git", ["-C", ROOT, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  isGitRepoCache = result.status === 0 && result.stdout.trim() === "true";
  return isGitRepoCache;
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

function refreshGitStatus(force = false) {
  if (!isGitRepo()) return new Map();
  const now = Date.now();
  if (!force && now - gitStatusAt < 1200) return gitStatusCache;

  const result = spawnSync("git", ["-C", ROOT, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });

  gitStatusAt = now;
  gitStatusCache = result.status === 0 ? parseGitStatus(result.stdout) : new Map();
  return gitStatusCache;
}

async function listDir(relPath = ".", forceGit = false) {
  const absDir = safeResolve(relPath);
  const stat = await fs.lstat(absDir);

  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }

  const gitStatus = refreshGitStatus(forceGit);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const abs = path.join(absDir, entry.name);
    const rel = path.relative(ROOT, abs);
    const itemStat = await fs.lstat(abs);
    const isDir = entry.isDirectory();
    const git = gitStatusKind(gitStatus.get(rel));

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
    root: ROOT,
    repoName: REPO_NAME,
    path: relPath || ".",
    git: isGitRepo(),
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

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      console.error(`Failed to run ${command}: ${err.message || err}`);
    });
    child.unref();
  } catch (err) {
    console.error(`Failed to run ${command}: ${err.message || err}`);
  }
}

function wshCommand() {
  const home = process.env.HOME || "";
  const fallback = home ? path.join(home, ".waveterm", "bin", "wsh") : "";

  if (fallback) {
    const result = spawnSync("test", ["-x", fallback]);
    if (result.status === 0) return fallback;
  }

  return "wsh";
}

function openWithWave(absFile) {
  spawnDetached(wshCommand(), ["view", absFile]);
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

  <script>
    const tree = document.getElementById("tree");
    const repo = document.getElementById("repo");
    const filter = document.getElementById("filter");
    const status = document.getElementById("status");
    const copyPath = document.getElementById("copyPath");
    const refresh = document.getElementById("refresh");
    const collapseAll = document.getElementById("collapseAll");
    const clearFilter = document.getElementById("clearFilter");

    let rows = [];
    let selected = null;
    let rootPath = "";

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
          selectRow(row);
          await toggleDir(row, entry, depth);
        };
      } else {
        row.onclick = () => selectRow(row);
        row.ondblclick = async () => openFile(row, entry);
      }

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
        await postJson("/api/open", { path: entry.path });
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
        const data = await getJson("/api/list?dir=" + encodeURIComponent(entry.path));
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

    clearFilter.onclick = () => {
      filter.value = "";
      applyFilter();
      filter.focus();
    };

    copyPath.onclick = async () => {
      if (!selected) return;
      await navigator.clipboard.writeText(selected.dataset.absPath || "");
      setStatus("Copied: " + selected.dataset.absPath);
    };

    refresh.onclick = () => init(true);
    collapseAll.onclick = collapseLoadedTree;

    document.addEventListener("keydown", async (ev) => {
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
      const data = await getJson("/api/list?dir=&git=" + (forceGit ? "1" : "0"));
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, HTML);
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      const dir = url.searchParams.get("dir") || ".";
      const forceGit = url.searchParams.get("git") === "1";
      return sendJson(res, 200, await listDir(dir, forceGit));
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      const payload = await readJson(req);
      const absFile = safeResolve(payload.path || "");
      const stat = await fs.lstat(absFile);

      if (!stat.isFile()) {
        return sendJson(res, 400, { error: "Not a file" });
      }

      openWithWave(absFile);
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

server.listen(listenPort, listenHost, () => {
  const addr = server.address();
  const url = "http://" + publicHost + ":" + addr.port;

  console.log("Repo:", ROOT);
  console.log("Mode:", mode);
  console.log("Listen:", listenHost + ":" + addr.port);
  console.log("URL:", url);
  if (mode === "remote") {
    console.log("Connection:", process.env.WAVETERM_CONN || "unknown");
  }

  if (shouldOpen) {
    openWebInWave(url);
  }
});
