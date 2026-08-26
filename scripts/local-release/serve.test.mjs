import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const serveScript = join(scriptDir, "serve.mjs");

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function startServer(rootDir, port) {
  return spawn(process.execPath, [serveScript, rootDir], {
    env: { ...process.env, LIVEAGENT_LOCAL_SERVE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(port, expectedPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.liveagent-local-serve`);
      const instance = await response.json();
      if (instance.pid === expectedPid) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.fail(`server PID ${expectedPid} did not start on port ${port}`);
}

test("starting local-serve replaces the previous local-serve process", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "liveagent-local-serve-"));
  writeFileSync(join(rootDir, "latest.json"), "{}\n");
  const port = await freePort();
  const first = startServer(rootDir, port);
  let second;

  try {
    await waitForServer(port, first.pid);
    second = startServer(rootDir, port);
    await waitForServer(port, second.pid);
    if (first.exitCode === null) {
      await new Promise((resolveExit) => first.once("exit", resolveExit));
    }
    assert.notEqual(first.exitCode, null);
  } finally {
    if (first.exitCode === null) first.kill();
    if (second?.exitCode === null) second.kill();
    rmSync(rootDir, { force: true, recursive: true });
  }
});

test(
  "starting local-serve replaces a legacy server after verifying its page marker",
  { skip: process.platform !== "win32" },
  async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "liveagent-local-serve-legacy-"));
    writeFileSync(join(rootDir, "latest.json"), "{}\n");
    const port = await freePort();
    const legacy = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((req,res)=>{res.end("<title>LiveAgent local releases</title>")}).listen(${port},"127.0.0.1")`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let replacement;

    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if ((await response.text()).includes("LiveAgent local releases")) break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      replacement = startServer(rootDir, port);
      await waitForServer(port, replacement.pid);
      if (legacy.exitCode === null) {
        await new Promise((resolveExit) => legacy.once("exit", resolveExit));
      }
      assert.notEqual(legacy.exitCode, null);
    } finally {
      if (legacy.exitCode === null) legacy.kill();
      if (replacement?.exitCode === null) replacement.kill();
      rmSync(rootDir, { force: true, recursive: true });
    }
  },
);
