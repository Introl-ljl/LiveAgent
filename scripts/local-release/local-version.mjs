#!/usr/bin/env node

// 计算本地发布版本号：在最近 git tag 的 base 版本上追加 -intNNN（3 位零填充）。
// NNN 序号扫描本地发布目录自增。

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
// scripts/local-release -> scripts -> 项目根目录
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const RELEASES_DIR = join(PROJECT_ROOT, "dist", "local-releases");

// 匹配目录名 v{base}-int{NNN}，捕获 base 与 int 数字
const INT_DIR_PATTERN = /^(v\d+\.\d+\.\d+)-int(\d+)$/;

/**
 * 把 git tag（如 "v1.1.8"）转换成 base 版本（如 "1.1.8"）。
 * @param {string} tag
 * @returns {string}
 */
export function parseBaseVersion(tag) {
  const raw = String(tag ?? "").trim();
  if (!raw) {
    throw new Error("git tag is empty");
  }
  if (!raw.startsWith("v")) {
    throw new Error(`git tag must start with "v". Received: ${raw}`);
  }
  const version = raw.slice(1);
  if (version.includes("-int")) {
    throw new Error(
      `git tag should not contain "-int" suffix. Received: ${raw}. Use a clean upstream tag like v1.1.8.`,
    );
  }
  return version;
}

/**
 * 根据已存在的发布目录名和当前 base 版本，计算下一个 int 序号。
 * 只统计与当前 base 版本匹配的目录，取最大值 +1；没有匹配项时返回 1。
 * @param {string[]} existingDirs 目录名数组，如 ["v1.1.8-int001", "v1.1.8-int002"]
 * @param {string} baseVersion 如 "1.1.8"
 * @returns {number}
 */
export function nextIntNumber(existingDirs, baseVersion) {
  let max = 0;
  for (const dir of existingDirs) {
    const match = INT_DIR_PATTERN.exec(dir);
    if (!match) continue;
    // match[1] 形如 "v1.1.8"，去掉 v 前缀后与 baseVersion 比较
    const dirBase = match[1].slice(1);
    if (dirBase !== baseVersion) continue;
    const num = parseInt(match[2], 10);
    // 兼容历史目录用 \d+ 匹配，但非 3 位填充的目录名跳过并告警，避免破坏排序
    const padded = String(num).padStart(3, "0");
    if (match[2] !== padded) {
      console.error(
        `Warning: directory ${dir} uses non-standard int format (expected ${padded}), ignoring.`,
      );
      continue;
    }
    if (Number.isFinite(num) && num > max) max = num;
  }
  return max + 1;
}

/**
 * 把 int 数字零填充为 3 位字符串。
 * @param {number} n
 * @returns {string}
 */
export function padInt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid int number: ${n}`);
  }
  if (n > 999) {
    throw new Error(
      `int number exceeds 999 (got ${n}). Clean up old releases or extend padding.`,
    );
  }
  return String(n).padStart(3, "0");
}

/**
 * 拼接完整版本号。
 * @param {string} baseVersion 如 "1.1.8"
 * @param {number} intNumber 如 1
 * @returns {string} 如 "1.1.8-int001"
 */
export function buildFullVersion(baseVersion, intNumber) {
  return `${baseVersion}-int${padInt(intNumber)}`;
}

function usage() {
  return [
    "Usage: local-version.mjs [--json]",
    "",
    "计算下一个本地发布版本号（基于最近的 git tag）。",
    "  --json   以 JSON 格式输出到 stdout",
  ].join("\n");
}

function listReleaseDirs() {
  if (!existsSync(RELEASES_DIR)) return [];
  return readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

function computeVersion() {
  const tag = execSync("git describe --tags --abbrev=0", {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  }).trim();
  const baseVersion = parseBaseVersion(tag);
  const intNumber = nextIntNumber(listReleaseDirs(), baseVersion);
  const fullVersion = buildFullVersion(baseVersion, intNumber);
  const releaseTag = `v${fullVersion}`;
  const outputDir = join(RELEASES_DIR, releaseTag);
  return { baseVersion, intNumber, fullVersion, releaseTag, outputDir };
}

function main(argv) {
  if (argv.length === 0) {
    const info = computeVersion();
    console.log(`baseVersion: ${info.baseVersion}`);
    console.log(`intNumber: ${info.intNumber}`);
    console.log(`fullVersion: ${info.fullVersion}`);
    console.log(`releaseTag: ${info.releaseTag}`);
    console.log(`outputDir: ${info.outputDir}`);
    return;
  }

  if (argv.length === 1 && argv[0] === "--json") {
    const info = computeVersion();
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.error(usage());
  process.exit(1);
}

// 仅在作为入口直接执行时运行主逻辑，import 时不产生副作用（便于 node --test）
const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
