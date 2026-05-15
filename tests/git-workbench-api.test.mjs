import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(repoDir, "src/main.mjs");

function randomPort() {
  return 23000 + Math.floor(Math.random() * 20000);
}

async function waitForHealth(port, output) {
  const deadline = Date.now() + 10_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for WRB on ${port}: ${lastError?.message || "no response"}\n${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function withServer(root, fn) {
  const port = randomPort();
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "wrb-git-workbench-runtime-"));
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
  };
  const child = spawn(
    "bun",
    [mainPath, "--foreground", "--service", "--no-open", "--local", "--port", String(port), root],
    {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForHealth(port, () => output);
    return await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      output: () => output,
    });
  } finally {
    await stopServer(child);
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
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

  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return { stdout, stderr };
}

async function initGitRepo(root) {
  await run("git", ["init"], root);
  await run("git", ["config", "user.email", "wrb@example.test"], root);
  await run("git", ["config", "user.name", "WRB Test"], root);
}

async function getFile(baseUrl, root, filePath) {
  const url = new URL("/api/file", baseUrl);
  url.searchParams.set("root", root);
  url.searchParams.set("path", filePath);

  const res = await fetch(url);
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Keep the raw body for assertion diagnostics.
  }

  return { res, body, json };
}

async function getGitStatus(baseUrl, root) {
  const url = new URL("/api/git/status", baseUrl);
  url.searchParams.set("root", root);

  const res = await fetch(url);
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Keep the raw body for assertion diagnostics.
  }

  return { res, body, json };
}

async function getGitDiff(baseUrl, root, filePath, area) {
  const url = new URL("/api/git/diff", baseUrl);
  url.searchParams.set("root", root);
  url.searchParams.set("path", filePath);
  url.searchParams.set("area", area);

  const res = await fetch(url);
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Keep the raw body for assertion diagnostics.
  }

  return { res, body, json };
}

function sortedEntries(entries) {
  return [...entries].sort((a, b) => {
    const pathCompare = a.path.localeCompare(b.path);
    if (pathCompare !== 0) return pathCompare;
    return (a.oldPath || "").localeCompare(b.oldPath || "");
  });
}

test("file preview returns text content and language", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-file-preview-test-"));
  const root = path.join(tempDir, "repo");
  const content = "export const value = 1;\n";

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/main.mjs"), content);

    await withServer(root, async ({ baseUrl, output }) => {
      const { res, body, json } = await getFile(baseUrl, root, "src/main.mjs");

      assert.equal(res.status, 200, `response body:\n${body}\nserver output:\n${output()}`);
      assert.equal(json.path, "src/main.mjs");
      assert.equal(json.absPath, path.join(root, "src/main.mjs"));
      assert.equal(json.language, "javascript");
      assert.equal(json.content, content);
      assert.equal(json.size, Buffer.byteLength(content));
      assert.equal(json.readOnly, true);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("serves Monaco loader from local assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-monaco-assets-test-"));

  try {
    await withServer(root, async ({ baseUrl, output }) => {
      const res = await fetch(new URL("/monaco/min/vs/loader.js", baseUrl));
      const body = await res.text();

      assert.equal(res.status, 200, `response body:\n${body}\nserver output:\n${output()}`);
      assert.match(body, /Monaco|require/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git diff returns original and modified content for worktree, staged, and untracked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-test-"));

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

    await withServer(root, async ({ baseUrl, output }) => {
      const worktree = await getGitDiff(baseUrl, root, "worktree.js", "worktree");
      assert.equal(worktree.res.status, 200, `response body:\n${worktree.body}\nserver output:\n${output()}`);
      assert.equal(worktree.json.path, "worktree.js");
      assert.equal(worktree.json.area, "worktree");
      assert.equal(worktree.json.original, "const value = 1;\n");
      assert.equal(worktree.json.modified, "const value = 2;\n");
      assert.equal(worktree.json.language, "javascript");
      assert.equal(worktree.json.originalLabel, "HEAD");
      assert.equal(worktree.json.modifiedLabel, "Working Tree");

      const staged = await getGitDiff(baseUrl, root, "staged.js", "staged");
      assert.equal(staged.res.status, 200, `response body:\n${staged.body}\nserver output:\n${output()}`);
      assert.equal(staged.json.path, "staged.js");
      assert.equal(staged.json.area, "staged");
      assert.equal(staged.json.original, "const staged = 1;\n");
      assert.equal(staged.json.modified, "const staged = 2;\n");
      assert.equal(staged.json.language, "javascript");
      assert.equal(staged.json.originalLabel, "HEAD");
      assert.equal(staged.json.modifiedLabel, "Index");

      const untracked = await getGitDiff(baseUrl, root, "new.js", "untracked");
      assert.equal(untracked.res.status, 200, `response body:\n${untracked.body}\nserver output:\n${output()}`);
      assert.equal(untracked.json.path, "new.js");
      assert.equal(untracked.json.area, "untracked");
      assert.equal(untracked.json.original, "");
      assert.equal(untracked.json.modified, "const fresh = true;\n");
      assert.equal(untracked.json.language, "javascript");
      assert.equal(untracked.json.originalLabel, "Empty");
      assert.equal(untracked.json.modifiedLabel, "Working Tree");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git diff returns empty original and index content for staged added files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-added-staged-test-"));

  try {
    await initGitRepo(root);

    await writeFile(path.join(root, "tracked.js"), "const tracked = true;\n");
    await run("git", ["add", "tracked.js"], root);
    await run("git", ["commit", "-m", "initial"], root);

    const stagedContent = "const addedStaged = true;\n";
    await writeFile(path.join(root, "added-staged.js"), stagedContent);
    await run("git", ["add", "added-staged.js"], root);

    await withServer(root, async ({ baseUrl, output }) => {
      const staged = await getGitDiff(baseUrl, root, "added-staged.js", "staged");
      assert.equal(staged.res.status, 200, `response body:\n${staged.body}\nserver output:\n${output()}`);
      assert.equal(staged.json.path, "added-staged.js");
      assert.equal(staged.json.area, "staged");
      assert.equal(staged.json.original, "");
      assert.equal(staged.json.modified, stagedContent);
      assert.equal(staged.json.language, "javascript");
      assert.equal(staged.json.originalLabel, "HEAD");
      assert.equal(staged.json.modifiedLabel, "Index");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git diff returns empty original and worktree content for indexed added files modified in worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-added-worktree-test-"));

  try {
    await initGitRepo(root);

    await writeFile(path.join(root, "tracked.js"), "const tracked = true;\n");
    await run("git", ["add", "tracked.js"], root);
    await run("git", ["commit", "-m", "initial"], root);

    const worktreeContent = "const addedWorktree = 2;\n";
    await writeFile(path.join(root, "added-worktree.js"), "const addedWorktree = 1;\n");
    await run("git", ["add", "added-worktree.js"], root);
    await writeFile(path.join(root, "added-worktree.js"), worktreeContent);

    await withServer(root, async ({ baseUrl, output }) => {
      const worktree = await getGitDiff(baseUrl, root, "added-worktree.js", "worktree");
      assert.equal(worktree.res.status, 200, `response body:\n${worktree.body}\nserver output:\n${output()}`);
      assert.equal(worktree.json.path, "added-worktree.js");
      assert.equal(worktree.json.area, "worktree");
      assert.equal(worktree.json.original, "");
      assert.equal(worktree.json.modified, worktreeContent);
      assert.equal(worktree.json.language, "javascript");
      assert.equal(worktree.json.originalLabel, "HEAD");
      assert.equal(worktree.json.modifiedLabel, "Working Tree");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git diff returns HEAD content and empty modified content for deleted files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-deleted-test-"));

  try {
    await initGitRepo(root);

    await writeFile(path.join(root, "deleted-worktree.js"), "const worktreeDeleted = true;\n");
    await writeFile(path.join(root, "deleted-staged.js"), "const stagedDeleted = true;\n");
    await run("git", ["add", "."], root);
    await run("git", ["commit", "-m", "initial"], root);

    await rm(path.join(root, "deleted-worktree.js"));
    await run("git", ["rm", "deleted-staged.js"], root);

    await withServer(root, async ({ baseUrl, output }) => {
      const worktree = await getGitDiff(baseUrl, root, "deleted-worktree.js", "worktree");
      assert.equal(worktree.res.status, 200, `response body:\n${worktree.body}\nserver output:\n${output()}`);
      assert.equal(worktree.json.path, "deleted-worktree.js");
      assert.equal(worktree.json.area, "worktree");
      assert.equal(worktree.json.original, "const worktreeDeleted = true;\n");
      assert.equal(worktree.json.modified, "");
      assert.equal(worktree.json.language, "javascript");
      assert.equal(worktree.json.originalLabel, "HEAD");
      assert.equal(worktree.json.modifiedLabel, "Working Tree");

      const staged = await getGitDiff(baseUrl, root, "deleted-staged.js", "staged");
      assert.equal(staged.res.status, 200, `response body:\n${staged.body}\nserver output:\n${output()}`);
      assert.equal(staged.json.path, "deleted-staged.js");
      assert.equal(staged.json.area, "staged");
      assert.equal(staged.json.original, "const stagedDeleted = true;\n");
      assert.equal(staged.json.modified, "");
      assert.equal(staged.json.language, "javascript");
      assert.equal(staged.json.originalLabel, "HEAD");
      assert.equal(staged.json.modifiedLabel, "Index");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git diff rejects invalid areas and escaped paths", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-git-diff-reject-test-"));
  const root = path.join(tempDir, "repo");

  try {
    await mkdir(root, { recursive: true });
    await initGitRepo(root);
    await writeFile(path.join(root, "tracked.js"), "const tracked = true;\n");
    await writeFile(path.join(tempDir, "outside.js"), "const outside = true;\n");
    await run("git", ["add", "tracked.js"], root);
    await run("git", ["commit", "-m", "initial"], root);

    await withServer(root, async ({ baseUrl, output }) => {
      const invalidArea = await getGitDiff(baseUrl, root, "tracked.js", "sideways");
      assert.equal(invalidArea.res.status, 400, `response body:\n${invalidArea.body}\nserver output:\n${output()}`);
      assert.match(invalidArea.json.error, /invalid git diff area/i);

      const escapedPath = await getGitDiff(baseUrl, root, "../outside.js", "worktree");
      assert.equal(escapedPath.res.status, 403, `response body:\n${escapedPath.body}\nserver output:\n${output()}`);
      assert.match(escapedPath.json.error, /escapes/i);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file preview rejects symlink escapes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-file-preview-symlink-test-"));
  const root = path.join(tempDir, "repo");
  const outsidePath = path.join(tempDir, "outside.txt");
  const linkPath = path.join(root, "outside-link.txt");

  try {
    await mkdir(root, { recursive: true });
    await writeFile(outsidePath, "outside\n");

    try {
      await symlink(outsidePath, linkPath);
    } catch (err) {
      if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(err?.code)) return;
      throw err;
    }

    await withServer(root, async ({ baseUrl, output }) => {
      const symlinkEscape = await getFile(baseUrl, root, "outside-link.txt");
      assert.equal(symlinkEscape.res.status, 403, `response body:\n${symlinkEscape.body}\nserver output:\n${output()}`);
      assert.match(symlinkEscape.json.error, /escapes/i);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file preview rejects missing files, directories, escaped paths, binary files, and oversized files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-file-preview-reject-test-"));
  const root = path.join(tempDir, "repo");

  try {
    await mkdir(path.join(root, "dir"), { recursive: true });
    await writeFile(path.join(tempDir, "outside.txt"), "outside\n");
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0x48, 0x00, 0x69]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));

    await withServer(root, async ({ baseUrl, output }) => {
      const missing = await getFile(baseUrl, root, "missing.txt");
      assert.equal(missing.res.status, 404, `response body:\n${missing.body}\nserver output:\n${output()}`);
      assert.match(missing.json.error, /not found|missing/i);

      const directory = await getFile(baseUrl, root, "dir");
      assert.equal(directory.res.status, 400, `response body:\n${directory.body}\nserver output:\n${output()}`);
      assert.match(directory.json.error, /directory/i);

      const escaped = await getFile(baseUrl, root, "../outside.txt");
      assert.equal(escaped.res.status, 403, `response body:\n${escaped.body}\nserver output:\n${output()}`);
      assert.match(escaped.json.error, /escapes/i);

      const binary = await getFile(baseUrl, root, "bin.dat");
      assert.equal(binary.res.status, 409, `response body:\n${binary.body}\nserver output:\n${output()}`);
      assert.match(binary.json.error, /binary/i);

      const oversized = await getFile(baseUrl, root, "large.txt");
      assert.equal(oversized.res.status, 409, `response body:\n${oversized.body}\nserver output:\n${output()}`);
      assert.match(oversized.json.error, /large/i);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("git status groups staged, unstaged, untracked, deleted, and renamed files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-git-status-test-"));
  const root = path.join(tempDir, "repo");

  try {
    await mkdir(root, { recursive: true });
    await initGitRepo(root);

    await writeFile(path.join(root, "modified.txt"), "modified initial\n");
    await writeFile(path.join(root, "staged.txt"), "staged initial\n");
    await writeFile(path.join(root, "deleted.txt"), "deleted initial\n");
    await writeFile(path.join(root, "rename-old.txt"), "rename initial\n");
    await run("git", ["add", "."], root);
    await run("git", ["commit", "-m", "initial"], root);

    await writeFile(path.join(root, "modified.txt"), "modified changed\n");
    await writeFile(path.join(root, "staged.txt"), "staged changed\n");
    await run("git", ["add", "staged.txt"], root);
    await rm(path.join(root, "deleted.txt"));
    await run("git", ["mv", "rename-old.txt", "rename-new.txt"], root);
    await writeFile(path.join(root, "untracked.txt"), "untracked\n");

    await withServer(root, async ({ baseUrl, output }) => {
      const { res, body, json } = await getGitStatus(baseUrl, root);

      assert.equal(res.status, 200, `response body:\n${body}\nserver output:\n${output()}`);
      assert.equal(json.repoRoot, root);
      assert.equal(typeof json.branch, "string");
      assert.notEqual(json.branch, "");

      assert.deepEqual(
        sortedEntries(json.staged).map(({ path, status, oldPath }) => ({ path, status, oldPath })),
        [
          { path: "rename-new.txt", status: "R", oldPath: "rename-old.txt" },
          { path: "staged.txt", status: "M", oldPath: undefined },
        ],
      );
      assert.deepEqual(
        sortedEntries(json.unstaged).map(({ path, status }) => ({ path, status })),
        [
          { path: "deleted.txt", status: "D" },
          { path: "modified.txt", status: "M" },
        ],
      );
      assert.deepEqual(
        sortedEntries(json.untracked).map(({ path, status }) => ({ path, status })),
        [{ path: "untracked.txt", status: "?" }],
      );
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
