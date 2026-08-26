#!/usr/bin/env node

// 扫描指定目录中的 .sig 文件，生成 Tauri updater 的 latest.json manifest。
// 与原版 create-tauri-updater-manifest.mjs 的区别：
//   - url 指向本地静态服务 http://127.0.0.1:7878/{filename}
//   - version 从命令行参数或环境变量获取
//   - 不需要 GITHUB_REPOSITORY

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const LOCAL_SERVER_BASE =
  process.env.LIVEAGENT_LOCAL_SERVE_BASE?.trim() || "http://127.0.0.1:7878";

const [assetDir, outputPath, versionArg, notesPath] = process.argv.slice(2);

if (!assetDir || !outputPath || !versionArg) {
  console.error(
    "Usage: create-local-manifest.mjs <asset-dir> <output-path> <version> [notes-file]",
  );
  process.exit(1);
}

// 版本号优先使用命令行参数，其次环境变量
const version = versionArg || process.env.LIVEAGENT_APP_VERSION;
if (!version) {
  console.error("version is required (positional arg or LIVEAGENT_APP_VERSION).");
  process.exit(1);
}

const files = new Set(readdirSync(assetDir));
const platforms = {};

// 复用原版 create-tauri-updater-manifest.mjs 的 target 映射逻辑（独立内联，不 import）
function targetForArtifact(filename) {
  if (/macOS-x64\.app\.tar\.gz$/i.test(filename)) return "darwin-x86_64-app";
  if (/macOS-aarch64\.app\.tar\.gz$/i.test(filename)) return "darwin-aarch64-app";
  if (/Windows-x64-Setup\.exe$/i.test(filename)) return "windows-x86_64-nsis";
  if (/_x64-setup\.exe$/i.test(filename)) return "windows-x86_64-nsis";
  if (/Windows-x64\.msi$/i.test(filename)) return "windows-x86_64-msi";
  if (/_x64(?:_[A-Za-z-]+)?\.msi$/i.test(filename)) return "windows-x86_64-msi";
  if (/Windows-x64-nsis\.zip$/i.test(filename)) return "windows-x86_64-nsis";
  if (/Windows-x64-msi\.zip$/i.test(filename)) return "windows-x86_64-msi";
  if (/Linux-x86_64\.AppImage$/i.test(filename)) return "linux-x86_64-appimage";
  if (/Linux-x86_64\.deb$/i.test(filename)) return "linux-x86_64-deb";
  if (/Linux-x86_64\.rpm$/i.test(filename)) return "linux-x86_64-rpm";
  return null;
}

function localAssetUrl(filename) {
  return `${LOCAL_SERVER_BASE}/${encodeURIComponent(filename)}`;
}

function releaseNotes() {
  if (!notesPath) return `LiveAgent v${version}`;
  const notes = readFileSync(notesPath, "utf8").trim();
  return notes || `LiveAgent v${version}`;
}

for (const file of files) {
  if (!file.endsWith(".sig")) continue;

  const artifact = basename(file.slice(0, -".sig".length));
  if (!files.has(artifact)) continue;

  const target = targetForArtifact(artifact);
  if (!target) continue;

  const signature = readFileSync(join(assetDir, file), "utf8").trim();
  if (!signature) {
    console.error(`Signature file is empty: ${file}`);
    process.exit(1);
  }

  platforms[target] = {
    signature,
    url: localAssetUrl(artifact),
  };

  if (target === "darwin-x86_64-app") {
    platforms["darwin-x86_64"] = platforms[target];
  } else if (target === "darwin-aarch64-app") {
    platforms["darwin-aarch64"] = platforms[target];
  }
}

if (platforms["windows-x86_64-nsis"]) {
  platforms["windows-x86_64"] = platforms["windows-x86_64-nsis"];
} else if (platforms["windows-x86_64-msi"]) {
  platforms["windows-x86_64"] = platforms["windows-x86_64-msi"];
}

// 裸 {os}-{arch} key 在缺失 bundle 类型标记时会回退，其未知 bundle 安装路径
// 会把 payload 当作 AppImage 处理，因此裸 key 必须指向 AppImage 产物。
if (platforms["linux-x86_64-appimage"]) {
  platforms["linux-x86_64"] = platforms["linux-x86_64-appimage"];
}

if (Object.keys(platforms).length === 0) {
  console.error("No updater artifacts with matching .sig files were found.");
  process.exit(1);
}

const manifest = {
  version,
  notes: releaseNotes(),
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Wrote local updater manifest with ${Object.keys(platforms).length} platform entries: ${outputPath}`,
);
