import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(repoDir, "src/main.mjs");

function randomPort() {
  return 23000 + Math.floor(Math.random() * 20000);
}

async function waitForHealth(port) {
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

  throw lastError || new Error(`Timed out waiting for WRB on ${port}`);
}

async function waitForFile(pathname) {
  const deadline = Date.now() + 5_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await readFile(pathname, "utf8");
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw lastError || new Error(`Timed out waiting for ${pathname}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

test("daemon startup reuses an existing healthy service instead of stopping it", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-reuse-test-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const firstRoot = path.join(tempDir, "first");
  const secondRoot = path.join(tempDir, "second");
  const port = randomPort();
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
  };

  const service = spawn(
    "bun",
    [mainPath, "--foreground", "--service", "--no-open", "--local", "--port", String(port), firstRoot],
    {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });

  try {
    await waitForHealth(port);

    const second = spawn(
      "bun",
      [mainPath, "--no-open", "--daemon", "--local", "--port", String(port), secondRoot],
      {
        cwd: repoDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let secondOutput = "";
    second.stdout.on("data", (chunk) => {
      secondOutput += String(chunk);
    });
    second.stderr.on("data", (chunk) => {
      secondOutput += String(chunk);
    });

    const secondExit = await waitForExit(second);
    assert.equal(secondExit.code, 0, secondOutput);
    assert.match(secondOutput, /wrb opened /);
    assert.match(secondOutput, new RegExp(encodeURIComponent(secondRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.exitCode, null, `original service exited unexpectedly:\n${serviceOutput}`);
    await waitForHealth(port);
  } finally {
    service.kill("SIGTERM");
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("web block opens against the invoking terminal block when WAVETERM_BLOCKID is set", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-block-test-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const homeDir = path.join(tempDir, "home");
  const firstRoot = path.join(tempDir, "first");
  const secondRoot = path.join(tempDir, "second");
  const wshDir = path.join(homeDir, "Library", "Application Support", "waveterm", "bin");
  const wshPath = path.join(wshDir, "wsh");
  const argsPath = path.join(tempDir, "wsh-args.txt");
  const port = randomPort();
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    WRB_TEST_WSH_ARGS: argsPath,
    WAVETERM_BLOCKID: "block-current-tab",
    WAVETERM_JWT: "test-jwt",
  };

  await mkdir(wshDir, { recursive: true });
  await writeFile(
    wshPath,
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$WRB_TEST_WSH_ARGS"\n`,
  );
  await chmod(wshPath, 0o755);

  const service = spawn(
    "bun",
    [mainPath, "--foreground", "--service", "--no-open", "--local", "--port", String(port), firstRoot],
    {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });

  try {
    await waitForHealth(port);

    const second = spawn("bun", [mainPath, "--daemon", "--local", "--port", String(port), secondRoot], {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let secondOutput = "";
    second.stdout.on("data", (chunk) => {
      secondOutput += String(chunk);
    });
    second.stderr.on("data", (chunk) => {
      secondOutput += String(chunk);
    });

    const secondExit = await waitForExit(second);
    assert.equal(secondExit.code, 0, secondOutput);

    const args = await waitForFile(argsPath);
    assert.match(args, /^-b block-current-tab web open http:\/\/127\.0\.0\.1:/m);
  } finally {
    service.kill("SIGTERM");
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("directory listing and file opening support symlinks inside the browse root", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "wrb-symlink-test-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const homeDir = path.join(tempDir, "home");
  const root = path.join(tempDir, "repo");
  const targetDir = path.join(root, "target-dir");
  const targetFile = path.join(root, "target.txt");
  const outsideDir = path.join(tempDir, "outside");
  const wshDir = path.join(homeDir, "Library", "Application Support", "waveterm", "bin");
  const wshPath = path.join(wshDir, "wsh");
  const argsPath = path.join(tempDir, "wsh-args.txt");
  const port = randomPort();
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    WRB_TEST_WSH_ARGS: argsPath,
    WAVETERM_JWT: "test-jwt",
  };

  await mkdir(path.join(targetDir, "nested"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(targetFile, "inside\n");
  await writeFile(path.join(targetDir, "nested.txt"), "nested\n");
  await writeFile(path.join(outsideDir, "outside.txt"), "outside\n");
  await symlink("target.txt", path.join(root, "file-link.txt"));
  await symlink("target-dir", path.join(root, "dir-link"));
  await symlink(path.join(outsideDir, "outside.txt"), path.join(root, "outside-file-link.txt"));
  await symlink(outsideDir, path.join(root, "outside-dir-link"));

  await mkdir(wshDir, { recursive: true });
  await writeFile(
    wshPath,
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$WRB_TEST_WSH_ARGS"\n`,
  );
  await chmod(wshPath, 0o755);

  const service = spawn(
    "bun",
    [mainPath, "--foreground", "--service", "--no-open", "--local", "--port", String(port), root],
    {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += String(chunk);
  });

  try {
    await waitForHealth(port);

    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env }),
    });
    const sessionBody = await sessionRes.text();
    assert.equal(sessionRes.status, 200, sessionBody);
    const { session } = JSON.parse(sessionBody);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/list?root=${encodeURIComponent(root)}`);
    const listBody = await listRes.text();
    assert.equal(listRes.status, 200, listBody);
    const list = JSON.parse(listBody);
    const names = list.children.map((child) => child.name).sort();
    assert.deepEqual(names, ["dir-link", "file-link.txt", "target-dir", "target.txt"]);
    assert.equal(list.children.find((child) => child.name === "dir-link").isDir, true);
    assert.equal(list.children.find((child) => child.name === "dir-link").isSymlink, true);
    assert.equal(list.children.find((child) => child.name === "file-link.txt").isDir, false);
    assert.equal(list.children.find((child) => child.name === "file-link.txt").isSymlink, true);

    const nestedRes = await fetch(
      `http://127.0.0.1:${port}/api/list?root=${encodeURIComponent(root)}&dir=${encodeURIComponent("dir-link")}`,
    );
    const nestedBody = await nestedRes.text();
    assert.equal(nestedRes.status, 200, nestedBody);
    const nested = JSON.parse(nestedBody);
    assert.deepEqual(nested.children.map((child) => child.name), ["nested", "nested.txt"]);

    const openRes = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, path: "file-link.txt", session }),
    });
    const openBody = await openRes.text();
    assert.equal(openRes.status, 200, openBody);
    const args = await waitForFile(argsPath);
    assert.match(args, /view .*file-link\.txt/);

    const outsideOpenRes = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, path: "outside-file-link.txt", session }),
    });
    const outsideOpenBody = await outsideOpenRes.text();
    assert.equal(outsideOpenRes.status, 500, outsideOpenBody);
    assert.match(outsideOpenBody, /escapes browse root|outside browse root/);
  } finally {
    service.kill("SIGTERM");
    await rm(tempDir, { recursive: true, force: true });
  }
});
