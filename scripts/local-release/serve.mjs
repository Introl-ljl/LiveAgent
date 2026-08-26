#!/usr/bin/env node

// 本地静态文件服务器，用 Node 原生 http 模块。
// 默认托管 dist/local-releases/ 下最新版本子目录，监听 127.0.0.1:7878。

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.LIVEAGENT_LOCAL_SERVE_PORT || "7878", 10);
const INSTANCE_ID = "liveagent-local-release-server-v1";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const RELEASES_DIR = join(PROJECT_ROOT, "dist", "local-releases");

// 匹配版本子目录名 v{base}-int{NNN}
const VERSION_DIR_PATTERN = /^v\d+\.\d+\.\d+-int\d+$/;

const MIME_TYPES = {
  ".json": "application/json",
  ".exe": "application/octet-stream",
  ".sig": "text/plain",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

// 扫描 dist/local-releases 下所有 v*-int* 目录，按目录名排序取最后一个作为最新版本
function latestReleaseDir() {
  if (!existsSync(RELEASES_DIR)) return null;
  const dirs = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && VERSION_DIR_PATTERN.test(dirent.name))
    .map((dirent) => dirent.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  if (dirs.length === 0) return null;
  return join(RELEASES_DIR, dirs[dirs.length - 1]);
}

function directoryListing(rootDir, urlPath) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const lines = entries.map((entry) => {
    const suffix = entry.isDirectory() ? "/" : "";
    return `<li><a href="${encodeURIComponent(entry.name)}${suffix}">${entry.name}${suffix}</a></li>`;
  });
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>LiveAgent local releases</title></head>",
    `<body><h1>Index of ${urlPath}</h1><ul>`,
    ...lines,
    "</ul></body></html>",
  ].join("\n");
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsListeningPid(port) {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const linePattern = new RegExp(
      `^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`,
      "mi",
    );
    const match = output.match(linePattern);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function stopPreviousServer() {
  let pid = null;
  try {
    const response = await fetch(`http://${HOST}:${PORT}/.liveagent-local-serve`, {
      signal: AbortSignal.timeout(750),
    });
    if (response.ok) {
      const instance = await response.json();
      const candidatePid = Number(instance.pid);
      if (instance.id === INSTANCE_ID && Number.isSafeInteger(candidatePid)) {
        pid = candidatePid;
      }
    }
  } catch {
    // The previous version did not expose the identity endpoint.
  }

  // Compatibility with serve.mjs versions before the identity endpoint was
  // added. Their generated directory page has this stable, project-specific
  // title. Only after verifying it do we resolve the exact Windows listener.
  if (pid === null && process.platform === "win32") {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/`, {
        signal: AbortSignal.timeout(750),
      });
      const body = await response.text();
      if (response.ok && body.includes("<title>LiveAgent local releases</title>")) {
        pid = windowsListeningPid(PORT);
      }
    } catch {
      // A foreign or unavailable service must not be terminated.
    }
  }

  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;

  console.log(`Stopping previous local update server (PID ${pid})...`);
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30 && isProcessRunning(pid); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function serve() {
  const [customDir] = process.argv.slice(2);
  const rootDir = customDir
    ? resolve(process.cwd(), customDir)
    : latestReleaseDir();

  if (!rootDir) {
    console.error(
      `No version directory found under ${RELEASES_DIR}. Run "make local-release" first, or pass a directory as argument.`,
    );
    process.exit(1);
  }
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    console.error(`Directory does not exist: ${rootDir}`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    if (reqUrl.pathname === "/.liveagent-local-serve") {
      const body = JSON.stringify({ id: INSTANCE_ID, pid: process.pid });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    // 解码并规范化路径，阻止目录穿越
    const requestedPath = decodeURIComponent(reqUrl.pathname);
    const safeRelative = normalize(requestedPath).replace(/^([/\\])+/, "");
    const filePath = join(rootDir, safeRelative);

    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("403 Forbidden");
      return;
    }

    // 根路径返回目录列表
    if (requestedPath === "/" || requestedPath === "") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(directoryListing(rootDir, "/"));
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(directoryListing(filePath, requestedPath));
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": stat.size,
    });
    // 用流式读取避免大文件全量加载进内存
    createReadStream(filePath).pipe(res);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the other process or change the port.`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  await stopPreviousServer();
  server.listen(PORT, HOST, () => {
    console.log(`Serving ${rootDir} at http://${HOST}:${PORT}/`);
  });
}

serve().catch((err) => {
  console.error(`Failed to start local update server: ${err.message}`);
  process.exit(1);
});
