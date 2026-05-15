# Monaco Git Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn WRB into a two-pane workbench with Explorer/Git sidebar and Monaco-powered read-only text preview plus git diff review.

**Architecture:** Keep the existing Bun HTTP service in `src/main.mjs`. Add testable backend helpers and API routes first, then add local Monaco asset serving, then replace the single-column UI with a split workbench that consumes those APIs. Git remains powered by the system `git` CLI; Monaco is used only for read-only preview and diff rendering.

**Tech Stack:** Bun/Node ESM, Node test runner, system `git`, `monaco-editor`, embedded browser HTML/CSS/JS, existing `@vscode/codicons`.

---

## File Structure

- Modify `src/main.mjs`: backend helper functions, API routes, Monaco asset route, and frontend HTML/CSS/JS.
- Modify `package.json`: add `monaco-editor`, add/correct scripts needed to copy or serve Monaco assets.
- Modify `README.md`: document the new workbench behavior and build/runtime notes.
- Create `tests/git-workbench-api.test.mjs`: temporary-repo API coverage for file preview, git status, and git diff.
- Create `tests/fixtures` only if a later task needs static binary/text fixtures; prefer temporary files inside tests first.

Implementation should preserve existing service reuse behavior and existing Wave fallback behavior.

---

### Task 1: Backend File Preview API

**Files:**
- Modify: `src/main.mjs`
- Test: `tests/git-workbench-api.test.mjs`

- [ ] **Step 1: Write failing tests for `/api/file`**

Create `tests/git-workbench-api.test.mjs` with a reusable server harness that starts WRB on a random port against a temporary root, then add file preview tests:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(repoDir, "src/main.mjs");

function randomPort() {
  return 24000 + Math.floor(Math.random() * 20000);
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Timed out waiting for WRB on ${port}`);
}

async function withServer(root, fn) {
  const port = randomPort();
  const runtimeDir = path.join(root, ".runtime");
  const child = spawn(
    "bun",
    [mainPath, "--foreground", "--service", "--no-open", "--local", "--port", String(port), root],
    {
      cwd: repoDir,
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });

  try {
    await waitForHealth(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(child.exitCode === 0 || child.exitCode === null || child.signalCode === "SIGTERM", true, output);
  }
}

test("file preview returns text content and language", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-file-api-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "main.mjs"), "export const value = 1;\n");

    await withServer(root, async (baseUrl) => {
      const url = new URL("/api/file", baseUrl);
      url.searchParams.set("root", root);
      url.searchParams.set("path", "src/main.mjs");
      const res = await fetch(url);
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.path, "src/main.mjs");
      assert.equal(data.language, "javascript");
      assert.equal(data.content, "export const value = 1;\n");
      assert.equal(data.readOnly, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file preview rejects directories, escaped paths, binary files, and oversized files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-file-api-errors-"));
  try {
    await mkdir(path.join(root, "dir"), { recursive: true });
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));

    await withServer(root, async (baseUrl) => {
      for (const [relPath, expectedStatus] of [
        ["dir", 400],
        ["../outside.txt", 403],
        ["bin.dat", 409],
        ["large.txt", 409],
      ]) {
        const url = new URL("/api/file", baseUrl);
        url.searchParams.set("root", root);
        url.searchParams.set("path", relPath);
        const res = await fetch(url);
        const data = await res.json();
        assert.equal(res.status, expectedStatus, relPath);
        assert.match(data.error, /directory|escapes|binary|large/i);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: fail with `Not found` for `/api/file`.

- [ ] **Step 3: Implement preview helpers and route**

In `src/main.mjs`, add constants and helpers near the existing filesystem helpers:

```js
const TEXT_PREVIEW_LIMIT = 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function languageForPath(filePath) {
  const ext = extensionOf(filePath);
  const name = path.basename(filePath).toLowerCase();
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (ext === "json" || ext === "jsonc" || name === "package.json") return "json";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["html", "htm"].includes(ext)) return "html";
  if (["sh", "zsh", "bash"].includes(ext)) return "shell";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (ext === "toml") return "toml";
  return "plaintext";
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

async function previewFile(root, relPath) {
  const absRoot = path.resolve(root || ".");
  const absFile = safeResolve(absRoot, relPath || "");
  const stat = await fs.lstat(absFile).catch((err) => {
    if (err?.code === "ENOENT") throw httpError(404, "File not found");
    throw err;
  });

  if (!stat.isFile()) throw httpError(400, "Path is a directory");
  if (stat.size > TEXT_PREVIEW_LIMIT) throw httpError(409, "File is too large to preview");

  const buffer = await fs.readFile(absFile);
  if (looksBinary(buffer)) throw httpError(409, "File is binary");

  return {
    path: path.relative(absRoot, absFile),
    absPath: absFile,
    language: languageForPath(absFile),
    content: buffer.toString("utf8"),
    size: stat.size,
    readOnly: true,
  };
}
```

Modify `safeResolve` so escaped paths throw a `403` error:

```js
if (!isInsideRoot(absRoot, absPath)) {
  throw httpError(403, "Path escapes browse root");
}
```

Add the route before `/api/list`:

```js
if (req.method === "GET" && url.pathname === "/api/file") {
  const root = url.searchParams.get("root") || process.cwd();
  const filePath = url.searchParams.get("path") || "";
  return sendJson(res, 200, await previewFile(root, filePath));
}
```

Update the server catch block:

```js
} catch (err) {
  sendJson(res, err.status || 500, { error: String(err.message || err) });
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: PASS for the two `/api/file` tests.

- [ ] **Step 5: Commit**

```bash
git add src/main.mjs tests/git-workbench-api.test.mjs
git commit -m "feat: add file preview api"
```

---

### Task 2: Git Status API

**Files:**
- Modify: `src/main.mjs`
- Modify: `tests/git-workbench-api.test.mjs`

- [ ] **Step 1: Add failing tests for grouped git status**

Append helpers and tests:

```js
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

async function initGitRepo(root) {
  await run("git", ["init"], root);
  await run("git", ["config", "user.email", "wrb@example.test"], root);
  await run("git", ["config", "user.name", "WRB Test"], root);
}

test("git status groups staged, unstaged, untracked, deleted, and renamed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-status-"));
  try {
    await initGitRepo(root);
    await writeFile(path.join(root, "modified.txt"), "one\n");
    await writeFile(path.join(root, "staged.txt"), "old\n");
    await writeFile(path.join(root, "deleted.txt"), "gone\n");
    await writeFile(path.join(root, "rename-old.txt"), "rename\n");
    await run("git", ["add", "."], root);
    await run("git", ["commit", "-m", "initial"], root);

    await writeFile(path.join(root, "modified.txt"), "two\n");
    await writeFile(path.join(root, "staged.txt"), "new\n");
    await run("git", ["add", "staged.txt"], root);
    await rm(path.join(root, "deleted.txt"));
    await run("git", ["mv", "rename-old.txt", "rename-new.txt"], root);
    await writeFile(path.join(root, "untracked.txt"), "fresh\n");

    await withServer(root, async (baseUrl) => {
      const url = new URL("/api/git/status", baseUrl);
      url.searchParams.set("root", root);
      const res = await fetch(url);
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.repoRoot, root);
      assert.ok(data.branch);
      assert.deepEqual(data.staged.map((item) => [item.path, item.status]), [
        ["rename-new.txt", "R"],
        ["staged.txt", "M"],
      ]);
      assert.deepEqual(data.unstaged.map((item) => [item.path, item.status]).sort(), [
        ["deleted.txt", "D"],
        ["modified.txt", "M"],
      ]);
      assert.deepEqual(data.untracked.map((item) => [item.path, item.status]), [["untracked.txt", "?"]]);
      assert.equal(data.staged.find((item) => item.path === "rename-new.txt").oldPath, "rename-old.txt");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: fail with `Not found` for `/api/git/status`.

- [ ] **Step 3: Implement git status helpers and route**

Add helpers near the existing git helpers:

```js
function gitRepoRoot(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) throw httpError(409, "Root is not a git repository");
  return result.stdout.trim();
}

function parseBranchLine(line) {
  const branch = line.replace(/^## /, "");
  const match = branch.match(/^(.+?)(?:\.\.\.[^\s]+)?(?: \[(ahead (\d+))?(?:, )?(behind (\d+))?\])?$/);
  return {
    branch: match?.[1] || branch,
    ahead: Number(match?.[3] || 0),
    behind: Number(match?.[5] || 0),
  };
}

function statusItem(repoRoot, pathValue, status, oldPath = "") {
  return {
    path: pathValue,
    oldPath,
    status,
    absPath: path.join(repoRoot, pathValue),
  };
}

function parseGitStatusGroups(output, repoRoot) {
  const records = output.split("\0").filter(Boolean);
  const branchInfo = records[0]?.startsWith("## ") ? parseBranchLine(records.shift()) : { branch: "", ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    let filePath = record.slice(3);
    let oldPath = "";

    if (indexStatus === "R" || indexStatus === "C") {
      oldPath = filePath;
      index += 1;
      filePath = records[index] || filePath;
    }

    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked.push(statusItem(repoRoot, filePath, "?"));
      continue;
    }

    if (indexStatus && indexStatus !== " ") {
      staged.push(statusItem(repoRoot, filePath, gitStatusKind(indexStatus), oldPath));
    }
    if (worktreeStatus && worktreeStatus !== " ") {
      unstaged.push(statusItem(repoRoot, filePath, gitStatusKind(worktreeStatus)));
    }
  }

  const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true });
  return {
    repoRoot,
    branch: branchInfo.branch,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    untracked: untracked.sort(byPath),
  };
}

function gitStatus(root) {
  const absRoot = path.resolve(root || ".");
  const repoRoot = gitRepoRoot(absRoot);
  const result = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--branch"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.status !== 0) throw httpError(500, (result.stderr || "git status failed").trim());
  return { root: absRoot, ...parseGitStatusGroups(result.stdout, repoRoot) };
}
```

Add route:

```js
if (req.method === "GET" && url.pathname === "/api/git/status") {
  const root = url.searchParams.get("root") || process.cwd();
  return sendJson(res, 200, gitStatus(root));
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: PASS for file API and git status tests.

- [ ] **Step 5: Commit**

```bash
git add src/main.mjs tests/git-workbench-api.test.mjs
git commit -m "feat: add git status api"
```

---

### Task 3: Git Diff API For Monaco

**Files:**
- Modify: `src/main.mjs`
- Modify: `tests/git-workbench-api.test.mjs`

- [ ] **Step 1: Add failing tests for `/api/git/diff`**

Append:

```js
test("git diff returns original and modified content for worktree, staged, and untracked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-"));
  try {
    await initGitRepo(root);
    await writeFile(path.join(root, "worktree.js"), "const value = 1;\n");
    await writeFile(path.join(root, "staged.js"), "const staged = 1;\n");
    await run("git", ["add", "."], root);
    await run("git", ["commit", "-m", "initial"], root);

    await writeFile(path.join(root, "worktree.js"), "const value = 2;\n");
    await writeFile(path.join(root, "staged.js"), "const staged = 2;\n");
    await run("git", ["add", "staged.js"], root);
    await writeFile(path.join(root, "new.js"), "const fresh = true;\n");

    await withServer(root, async (baseUrl) => {
      const worktreeUrl = new URL("/api/git/diff", baseUrl);
      worktreeUrl.searchParams.set("root", root);
      worktreeUrl.searchParams.set("path", "worktree.js");
      worktreeUrl.searchParams.set("area", "worktree");
      const worktreeRes = await fetch(worktreeUrl);
      const worktree = await worktreeRes.json();
      assert.equal(worktreeRes.status, 200);
      assert.equal(worktree.original, "const value = 1;\n");
      assert.equal(worktree.modified, "const value = 2;\n");
      assert.equal(worktree.language, "javascript");

      const stagedUrl = new URL("/api/git/diff", baseUrl);
      stagedUrl.searchParams.set("root", root);
      stagedUrl.searchParams.set("path", "staged.js");
      stagedUrl.searchParams.set("area", "staged");
      const stagedRes = await fetch(stagedUrl);
      const staged = await stagedRes.json();
      assert.equal(stagedRes.status, 200);
      assert.equal(staged.original, "const staged = 1;\n");
      assert.equal(staged.modified, "const staged = 2;\n");

      const untrackedUrl = new URL("/api/git/diff", baseUrl);
      untrackedUrl.searchParams.set("root", root);
      untrackedUrl.searchParams.set("path", "new.js");
      untrackedUrl.searchParams.set("area", "untracked");
      const untrackedRes = await fetch(untrackedUrl);
      const untracked = await untrackedRes.json();
      assert.equal(untrackedRes.status, 200);
      assert.equal(untracked.original, "");
      assert.equal(untracked.modified, "const fresh = true;\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: fail with `Not found` for `/api/git/diff`.

- [ ] **Step 3: Implement git content lookup and diff route**

Add helpers:

```js
function ensureInsideRepo(repoRoot, relPath) {
  const absPath = path.resolve(repoRoot, relPath || "");
  if (!isInsideRoot(repoRoot, absPath)) throw httpError(403, "Path escapes repo root");
  return absPath;
}

function gitShow(repoRoot, revision, relPath) {
  const result = spawnSync("git", ["-C", repoRoot, "show", `${revision}:${relPath}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.status !== 0) return "";
  return result.stdout;
}

function gitCatFile(repoRoot, revision, relPath) {
  const result = spawnSync("git", ["-C", repoRoot, "show", `${revision}:${relPath}`], {
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.status !== 0) return Buffer.from("");
  const buffer = Buffer.from(result.stdout);
  if (looksBinary(buffer)) throw httpError(409, "File is binary");
  return buffer.toString("utf8");
}

async function readWorktreeText(repoRoot, relPath) {
  const absPath = ensureInsideRepo(repoRoot, relPath);
  const stat = await fs.lstat(absPath).catch((err) => {
    if (err?.code === "ENOENT") throw httpError(404, "File not found");
    throw err;
  });
  if (!stat.isFile()) throw httpError(400, "Path is a directory");
  if (stat.size > TEXT_PREVIEW_LIMIT) throw httpError(409, "File is too large to preview");
  const buffer = await fs.readFile(absPath);
  if (looksBinary(buffer)) throw httpError(409, "File is binary");
  return buffer.toString("utf8");
}

async function gitDiffData(root, relPath, area) {
  if (!["staged", "worktree", "untracked"].includes(area)) throw httpError(400, "Invalid diff area");
  const repoRoot = gitRepoRoot(path.resolve(root || "."));
  ensureInsideRepo(repoRoot, relPath);

  if (area === "staged") {
    return {
      path: relPath,
      area,
      language: languageForPath(relPath),
      original: gitCatFile(repoRoot, "HEAD", relPath),
      modified: gitCatFile(repoRoot, ":0", relPath),
      originalLabel: "HEAD",
      modifiedLabel: "Index",
    };
  }

  if (area === "worktree") {
    return {
      path: relPath,
      area,
      language: languageForPath(relPath),
      original: gitCatFile(repoRoot, "HEAD", relPath),
      modified: await readWorktreeText(repoRoot, relPath),
      originalLabel: "HEAD",
      modifiedLabel: "Working Tree",
    };
  }

  return {
    path: relPath,
    area,
    language: languageForPath(relPath),
    original: "",
    modified: await readWorktreeText(repoRoot, relPath),
    originalLabel: "Empty",
    modifiedLabel: "Working Tree",
  };
}
```

Add route:

```js
if (req.method === "GET" && url.pathname === "/api/git/diff") {
  const root = url.searchParams.get("root") || process.cwd();
  const filePath = url.searchParams.get("path") || "";
  const area = url.searchParams.get("area") || "worktree";
  return sendJson(res, 200, await gitDiffData(root, filePath, area));
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: PASS for file, status, and diff API tests.

- [ ] **Step 5: Commit**

```bash
git add src/main.mjs tests/git-workbench-api.test.mjs
git commit -m "feat: add git diff api"
```

---

### Task 4: Monaco Dependency And Local Asset Serving

**Files:**
- Modify: `package.json`
- Modify: `src/main.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add a failing asset smoke test**

Append to `tests/git-workbench-api.test.mjs`:

```js
test("serves Monaco loader from local assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-monaco-assets-"));
  try {
    await withServer(root, async (baseUrl) => {
      const res = await fetch(new URL("/monaco/min/vs/loader.js", baseUrl));
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.match(text, /Monaco|require/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: fail with `404` for `/monaco/min/vs/loader.js`.

- [ ] **Step 3: Add dependency**

Run:

```bash
bun add monaco-editor
```

Expected: `package.json` and `bun.lock` update with `monaco-editor`.

- [ ] **Step 4: Implement local Monaco route**

In `src/main.mjs`, add:

```js
function contentTypeForAsset(filePath) {
  const ext = extensionOf(filePath);
  if (ext === "js") return "text/javascript; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (ext === "ttf") return "font/ttf";
  if (ext === "woff2") return "font/woff2";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "map") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function sendFileAsset(res, absPath) {
  const body = await fs.readFile(absPath);
  res.writeHead(200, {
    "content-type": contentTypeForAsset(absPath),
    "content-length": body.length,
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(body);
}

function monacoAssetRoot() {
  return path.resolve(import.meta.dirname, "..", "node_modules", "monaco-editor");
}
```

Add route before API routes:

```js
if (req.method === "GET" && url.pathname.startsWith("/monaco/")) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/monaco\//, ""));
  const root = monacoAssetRoot();
  const absAsset = path.resolve(root, rel);
  if (!isInsideRoot(root, absAsset)) return sendJson(res, 403, { error: "Asset path escapes Monaco root" });
  return sendFileAsset(res, absAsset);
}
```

Note: compiled binary packaging may need follow-up asset copy work after frontend verification. Keep this task focused on local dev serving.

- [ ] **Step 5: Update README build note**

Add a short note:

```markdown
WRB serves Monaco from the local `monaco-editor` package in development. When building or installing a standalone binary, verify the Monaco asset directory is available next to the installed WRB runtime.
```

- [ ] **Step 6: Run tests and verify they pass**

Run:

```bash
bun run test tests/git-workbench-api.test.mjs
```

Expected: PASS, including Monaco loader route.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/main.mjs README.md tests/git-workbench-api.test.mjs
git commit -m "feat: serve monaco assets"
```

---

### Task 5: Split Workbench Layout And Explorer Preview

**Files:**
- Modify: `src/main.mjs`

- [ ] **Step 1: Add frontend smoke expectations to the HTML manually**

Before implementation, identify strings that should exist after the change:

```text
id="activityBar"
id="explorerView"
id="sourceControlView"
id="editorPane"
id="monacoHost"
loadMonaco
openPreview
```

Run:

```bash
rg -n "activityBar|explorerView|sourceControlView|editorPane|monacoHost|loadMonaco|openPreview" src/main.mjs
```

Expected: no matches for most of these names.

- [ ] **Step 2: Replace app shell CSS and HTML structure**

In the `HTML` template, change `#app` to a two-column workbench:

```html
<div id="app">
  <div id="sidebar">
    <div id="activityBar">
      <button id="showExplorer" class="activity-btn active" title="Explorer"><span class="codicon codicon-files"></span></button>
      <button id="showSourceControl" class="activity-btn" title="Source Control"><span class="codicon codicon-source-control"></span></button>
    </div>
    <div id="sidePanel">
      <section id="explorerView" class="side-view active">
        <!-- existing header/search/tree/status controls move here -->
      </section>
      <section id="sourceControlView" class="side-view">
        <div class="view-header">
          <div class="view-title">Source Control</div>
          <button id="gitRefresh" class="icon-btn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
        </div>
        <div id="gitSummary"></div>
        <div id="gitChanges"></div>
      </section>
    </div>
  </div>
  <main id="editorPane">
    <div id="editorTitle">No file selected</div>
    <div id="monacoHost"></div>
    <div id="editorFallback" hidden></div>
  </main>
</div>
```

Add CSS with stable dimensions:

```css
#app {
  height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, 34vw) minmax(360px, 1fr);
}

#sidebar {
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  border-right: 1px solid var(--line);
  background: var(--bg);
}

#activityBar {
  background: #181818;
  border-right: 1px solid var(--line);
  padding: 6px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.activity-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
}

.activity-btn.active {
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

#sidePanel {
  min-width: 0;
  display: grid;
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

#editorPane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 35px minmax(0, 1fr);
  background: #1e1e1e;
}

#editorTitle {
  min-width: 0;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--soft-text);
}

#monacoHost,
#editorFallback {
  min-width: 0;
  min-height: 0;
}
```

- [ ] **Step 3: Add Monaco loader and preview functions**

In the frontend script:

```js
    const editorTitle = document.getElementById("editorTitle");
    const monacoHost = document.getElementById("monacoHost");
    const editorFallback = document.getElementById("editorFallback");
    const showExplorer = document.getElementById("showExplorer");
    const showSourceControl = document.getElementById("showSourceControl");
    const explorerView = document.getElementById("explorerView");
    const sourceControlView = document.getElementById("sourceControlView");

    let monacoReady = null;
    let activeEditor = null;
    let activeModels = [];

    function loadMonaco() {
      if (monacoReady) return monacoReady;
      monacoReady = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/monaco/min/vs/loader.js";
        script.onload = () => {
          window.require.config({ paths: { vs: "/monaco/min/vs" } });
          window.require(["vs/editor/editor.main"], () => resolve(window.monaco));
        };
        script.onerror = () => reject(new Error("Monaco failed to load"));
        document.head.appendChild(script);
      });
      return monacoReady;
    }

    function clearEditor() {
      if (activeEditor) activeEditor.dispose();
      for (const model of activeModels) model.dispose();
      activeEditor = null;
      activeModels = [];
      monacoHost.innerHTML = "";
      editorFallback.hidden = true;
      monacoHost.hidden = false;
    }

    async function openPreview(entry) {
      editorTitle.textContent = entry.path;
      clearEditor();
      try {
        const data = await getJson("/api/file?root=" + encodeURIComponent(rootPath) + "&path=" + encodeURIComponent(entry.path));
        const monaco = await loadMonaco();
        const model = monaco.editor.createModel(data.content, data.language);
        activeModels = [model];
        activeEditor = monaco.editor.create(monacoHost, {
          model,
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          theme: "vs-dark",
          scrollBeyondLastLine: false,
        });
        setStatus("Preview: " + data.absPath);
      } catch (err) {
        showEditorFallback(String(err), entry);
      }
    }

    function showEditorFallback(message, entry) {
      clearEditor();
      monacoHost.hidden = true;
      editorFallback.hidden = false;
      editorFallback.innerHTML = "";
      const text = document.createElement("div");
      text.className = "fallback-message";
      text.textContent = message;
      const button = document.createElement("button");
      button.className = "fallback-action";
      button.textContent = "Open in Wave";
      button.onclick = async () => openFile(selected, entry);
      editorFallback.append(text, button);
    }
```

Change file row click to open preview:

```js
row.onclick = async () => {
  closeContextMenu();
  selectRow(row);
  await openPreview(entry);
};
```

Keep double-click as `openFile(row, entry)`.

- [ ] **Step 4: Add view switching**

```js
function setActiveView(view) {
  const source = view === "source";
  showExplorer.classList.toggle("active", !source);
  showSourceControl.classList.toggle("active", source);
  explorerView.classList.toggle("active", !source);
  sourceControlView.classList.toggle("active", source);
  if (source) loadGitStatus();
}

showExplorer.onclick = () => setActiveView("explorer");
showSourceControl.onclick = () => setActiveView("source");
```

- [ ] **Step 5: Run static checks**

Run:

```bash
node --check src/main.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.mjs
git commit -m "feat: add monaco explorer preview"
```

---

### Task 6: Source Control View And Monaco DiffEditor

**Files:**
- Modify: `src/main.mjs`

- [ ] **Step 1: Verify expected frontend hooks are absent/incomplete**

Run:

```bash
rg -n "loadGitStatus|renderGitGroup|openGitDiff|createDiffEditor" src/main.mjs
```

Expected: no complete implementation yet.

- [ ] **Step 2: Add Source Control render functions**

In the frontend script:

```js
    const gitRefresh = document.getElementById("gitRefresh");
    const gitSummary = document.getElementById("gitSummary");
    const gitChanges = document.getElementById("gitChanges");

    function gitBadgeClass(status) {
      if (status === "?") return "git-U";
      return "git-" + status;
    }

    function renderGitGroup(title, area, items) {
      const section = document.createElement("section");
      section.className = "git-group";
      const header = document.createElement("div");
      header.className = "git-group-title";
      header.textContent = title + " (" + items.length + ")";
      section.appendChild(header);

      for (const item of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "git-row";
        row.title = item.absPath;
        row.innerHTML =
          '<span class="git ' + gitBadgeClass(item.status) + '">' + item.status + '</span>' +
          '<span class="git-file"><span class="git-name"></span><span class="git-path"></span></span>' +
          '<span class="codicon codicon-open-preview"></span>';
        row.querySelector(".git-name").textContent = item.path.split("/").pop();
        row.querySelector(".git-path").textContent = item.oldPath ? item.oldPath + " -> " + item.path : item.path;
        row.onclick = async () => openGitDiff(item, area);
        section.appendChild(row);
      }
      return section;
    }

    async function loadGitStatus() {
      gitSummary.textContent = "Loading...";
      gitChanges.innerHTML = "";
      try {
        const data = await getJson("/api/git/status?root=" + encodeURIComponent(rootPath || initialRoot));
        gitSummary.textContent = data.branch ? data.branch : data.repoRoot;
        gitChanges.appendChild(renderGitGroup("Staged Changes", "staged", data.staged));
        gitChanges.appendChild(renderGitGroup("Changes", "worktree", data.unstaged));
        gitChanges.appendChild(renderGitGroup("Untracked", "untracked", data.untracked));
      } catch (err) {
        gitSummary.textContent = String(err);
      }
    }
```

Add CSS:

```css
#sourceControlView {
  grid-template-rows: auto auto 1fr;
}

#gitSummary {
  padding: 8px 10px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#gitChanges {
  overflow: auto;
  padding: 4px 0 10px;
}

.git-group-title {
  height: 26px;
  padding: 6px 10px 4px;
  color: var(--soft-text);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.git-row {
  width: 100%;
  min-width: 0;
  height: 34px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 22px;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--soft-text);
  text-align: left;
  padding: 0 8px;
}

.git-row:hover {
  background: var(--hover);
}

.git-file {
  min-width: 0;
  display: grid;
}

.git-name,
.git-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-path {
  color: var(--muted);
  font-size: 11px;
}
```

- [ ] **Step 3: Add Monaco DiffEditor opening**

```js
    async function openGitDiff(item, area) {
      editorTitle.textContent = item.path + " - " + area;
      clearEditor();
      try {
        const url = new URL("/api/git/diff", window.location.origin);
        url.searchParams.set("root", rootPath || initialRoot);
        url.searchParams.set("path", item.path);
        url.searchParams.set("area", area);
        const data = await getJson(url.pathname + url.search);
        const monaco = await loadMonaco();
        const original = monaco.editor.createModel(data.original, data.language);
        const modified = monaco.editor.createModel(data.modified, data.language);
        activeModels = [original, modified];
        activeEditor = monaco.editor.createDiffEditor(monacoHost, {
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          theme: "vs-dark",
          scrollBeyondLastLine: false,
          renderSideBySide: monacoHost.clientWidth > 760,
        });
        activeEditor.setModel({ original, modified });
        setStatus(data.originalLabel + " -> " + data.modifiedLabel + ": " + data.path);
      } catch (err) {
        showEditorFallback(String(err), { path: item.path, absPath: item.absPath, isDir: false });
      }
    }

    gitRefresh.onclick = () => loadGitStatus();
```

- [ ] **Step 4: Run static checks**

Run:

```bash
node --check src/main.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.mjs
git commit -m "feat: add source control diff view"
```

---

### Task 7: Full Verification And Packaging Follow-Up

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `scripts/install-to-remote-wrb` if standalone Monaco assets need install handling.

- [ ] **Step 1: Run full automated checks**

Run:

```bash
bun run check
```

Expected: PASS for syntax, script syntax, and all Node tests.

- [ ] **Step 2: Run local WRB server for browser verification**

Run:

```bash
bun src/main.mjs --foreground --service --no-open --local --port 17877 /Users/i060912/SAPDevelop/wave-repo-browser
```

Expected: server listens on `127.0.0.1:17877`.

- [ ] **Step 3: Browser verify core flows**

Open:

```text
http://127.0.0.1:17877/?root=/Users/i060912/SAPDevelop/wave-repo-browser
```

Verify:

- Explorer renders on the left.
- Selecting `README.md` opens Monaco on the right.
- Source Control icon switches to grouped changes.
- Selecting `src/main.mjs` or another changed file opens a diff.
- Right-click `Open in Wave` still appears on Explorer file rows.
- No text overlaps at narrow and desktop widths.

- [ ] **Step 4: Build standalone binary**

Run:

```bash
bun run build
```

Expected: build succeeds and produces `dist/wrb`.

- [ ] **Step 5: Verify compiled binary can serve Monaco assets**

Run:

```bash
dist/wrb --foreground --service --no-open --local --port 17878 /Users/i060912/SAPDevelop/wave-repo-browser
```

Then request:

```bash
curl -I http://127.0.0.1:17878/monaco/min/vs/loader.js
```

Expected: HTTP `200`.

If this returns `404`, implement deterministic Monaco asset installation:

- Add a script that copies `node_modules/monaco-editor/min` into `dist/monaco/min`.
- Update `monacoAssetRoot()` to try `path.join(path.dirname(process.execPath), "monaco")` before `node_modules`.
- Update `scripts/install-to-remote-wrb` to copy the Monaco asset directory next to the installed binary.

- [ ] **Step 6: Update documentation**

Ensure `README.md` documents:

```markdown
WRB now opens a two-pane workbench. The left sidebar contains Explorer and Source Control. Text files open read-only in Monaco on the right, changed files open as read-only Monaco diffs, and non-text files can still be opened with Wave's native viewer.
```

- [ ] **Step 7: Final check**

Run:

```bash
bun run check
bun run build
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock README.md src/main.mjs scripts/install-to-remote-wrb
git commit -m "chore: verify monaco workbench packaging"
```

---

## Self-Review

- Spec coverage: The plan covers read-only Monaco preview, Monaco diff review, Explorer/Source Control sidebar, Wave fallback, backend APIs, git grouping, non-previewable fallback, tests, and build packaging checks.
- Placeholder scan: No task uses unresolved placeholder markers or vague test instructions.
- Type consistency: API names match the spec: `/api/file`, `/api/git/status`, `/api/git/diff`; diff areas are `staged`, `worktree`, and `untracked`; frontend functions use those same names.
