#!/usr/bin/env node

// 一键准备本地发布：
//   算版本号 -> 生成 tauri 配置 overlay -> 构建 -> 收集产物 -> 生成 manifest。
//
// 需要 Tauri 签名密钥：环境变量 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH。
// 如果设置了 TAURI_SIGNING_PRIVATE_KEY_PATH，会把其文件内容读取到 TAURI_SIGNING_PRIVATE_KEY。

import { execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");

const AGENT_GUI_DIR = join(PROJECT_ROOT, "crates", "agent-gui");
const SRC_TAURI_DIR = join(AGENT_GUI_DIR, "src-tauri");
const VERSION_CONFIG_PATH = join(SRC_TAURI_DIR, "tauri.version.generated.conf.json");
const WINDOWS_TAURI_CONFIG = "src-tauri/tauri.windows.conf.json";
const LOCAL_TAURI_CONFIG = "src-tauri/tauri.local.conf.json";
const NSIS_BUNDLE_DIR = join(PROJECT_ROOT, "target", "release", "bundle", "nsis");
const MSI_BUNDLE_DIR = join(PROJECT_ROOT, "target", "release", "bundle", "msi");

// 运行子命令，捕获 stdout（失败时抛出并打印 stderr）
function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    throw new Error(`Failed to spawn "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`);
  }
  return result.stdout;
}

// 解析 Tauri 签名密钥，返回传给构建进程的环境变量
function resolveSigningEnv() {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    if (!keyPath) {
      throw new Error(
        "Tauri signing key is required. Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.",
      );
    }
    if (!existsSync(keyPath)) {
      throw new Error(`TAURI_SIGNING_PRIVATE_KEY_PATH does not exist: ${keyPath}`);
    }

    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
  }

  // Tauri otherwise prompts interactively even when the key has no password.
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

  const updaterPublicKey = env.LIVEAGENT_UPDATER_PUBLIC_KEY?.trim();
  if (!updaterPublicKey) {
    throw new Error(
      "Tauri updater public key is required. Set LIVEAGENT_UPDATER_PUBLIC_KEY.",
    );
  }
  env.LIVEAGENT_UPDATER_PUBLIC_KEY = updaterPublicKey;
  return env;
}

function isArtifact(name) {
  return /\.(exe|msi)(\.sig)?$/.test(name);
}

function main() {
  // 1. 计算版本号
  console.log("[1/5] 计算本地版本号...");
  const versionJson = runCapture("node", [
    "scripts/local-release/local-version.mjs",
    "--json",
  ]).trim();
  const { fullVersion, releaseTag, outputDir } = JSON.parse(versionJson);
  console.log(`      fullVersion=${fullVersion} releaseTag=${releaseTag}`);
  console.log(`      outputDir=${outputDir}`);

  const buildEnv = resolveSigningEnv();

  // 2. 生成 tauri 本地版本 overlay：版本号与当前签名密钥的公钥必须一起固化。
  // 否则 updater 会退回主配置的上游公钥，安装阶段将拒绝本地签名。
  console.log("[2/5] 生成 Tauri 版本与更新公钥 overlay...");
  try {
    writeFileSync(
      VERSION_CONFIG_PATH,
      `${JSON.stringify(
        {
          version: fullVersion,
          plugins: {
            updater: {
              pubkey: buildEnv.LIVEAGENT_UPDATER_PUBLIC_KEY,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`      wrote ${VERSION_CONFIG_PATH}`);

    // 3. 清理旧安装包产物并构建（继承 stdio 以便看到构建进度）
    console.log("[3/5] 清理旧构建产物并构建 Windows 安装包...");
    if (existsSync(NSIS_BUNDLE_DIR)) {
      rmSync(NSIS_BUNDLE_DIR, { recursive: true, force: true });
      console.log(`      cleaned ${NSIS_BUNDLE_DIR}`);
    }
    if (existsSync(MSI_BUNDLE_DIR)) {
      rmSync(MSI_BUNDLE_DIR, { recursive: true, force: true });
      console.log(`      cleaned ${MSI_BUNDLE_DIR}`);
    }

    // 注意：--config 可重复叠加，后者覆盖前者的字段；
    // tauri.local.conf.json 仅在本地发布启用 insecure transport，不污染主配置。
    // Windows 下 pnpm 只有 .cmd 垫片（无 shell 直接 spawn 会 EINVAL），因此必须
    // shell:true；使用字符串命令而不是 args 数组，避免 Node DEP0190
    // （args + shell 存在拼接注入风险，且会在每次发布时向 stderr 打印警告）。
    // 路径均为相对 PROJECT_ROOT 且不含空格，字符串拼接是安全的。
    const buildCommand = [
      "pnpm",
      "--dir",
      "crates/agent-gui",
      "tauri",
      "build",
      "--config",
      WINDOWS_TAURI_CONFIG,
      "--config",
      LOCAL_TAURI_CONFIG,
      "--config",
      "src-tauri/tauri.version.generated.conf.json",
    ].join(" ");
    const buildResult = spawnSync(buildCommand, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: buildEnv,
      shell: true,
    });
    if (buildResult.error) {
      throw new Error(`Failed to spawn "pnpm": ${buildResult.error.message}`);
    }
    if (buildResult.status !== 0) {
      throw new Error(
        `tauri build failed (exit ${buildResult.status ?? "unknown"}). ` +
          "检查上方构建输出；若为签名/打包阶段失败，请确认 TAURI_SIGNING_PRIVATE_KEY_PATH 与 LIVEAGENT_UPDATER_PUBLIC_KEY 配置正确。",
      );
    }

    // 4. 收集构建产物到 outputDir。本地 -intNNN 版本仅构建 NSIS；
    // MSI 的 ProductVersion 不接受非数字 prerelease 标识。
    console.log("[4/5] 收集构建产物...");
    if (!existsSync(NSIS_BUNDLE_DIR)) {
      throw new Error(`nsis bundle dir not found: ${NSIS_BUNDLE_DIR}`);
    }
    mkdirSync(outputDir, { recursive: true });
    const collected = [];
    for (const name of readdirSync(NSIS_BUNDLE_DIR).filter(isArtifact)) {
      copyFileSync(join(NSIS_BUNDLE_DIR, name), join(outputDir, name));
      collected.push(name);
      console.log(`      copied ${name}`);
    }
    // 保留防御性 MSI 收集，兼容未来改用纯数字本地版本的情况。
    if (existsSync(MSI_BUNDLE_DIR)) {
      for (const name of readdirSync(MSI_BUNDLE_DIR).filter(isArtifact)) {
        copyFileSync(join(MSI_BUNDLE_DIR, name), join(outputDir, name));
        collected.push(name);
        console.log(`      copied ${name}`);
      }
    }
    if (collected.length === 0) {
      throw new Error(`no local release artifacts found in ${NSIS_BUNDLE_DIR}`);
    }
  } finally {
    // 清理生成的版本配置，避免污染工作区
    if (existsSync(VERSION_CONFIG_PATH)) {
      unlinkSync(VERSION_CONFIG_PATH);
    }
  }

  // 5. 生成 manifest
  console.log("[5/5] 生成 latest.json manifest...");
  const manifestPath = join(outputDir, "latest.json");
  runCapture("node", [
    "scripts/local-release/create-local-manifest.mjs",
    outputDir,
    manifestPath,
    fullVersion,
  ]);
  console.log(`      wrote ${manifestPath}`);

  console.log("\n本地发布准备完成:");
  console.log(`  版本: ${fullVersion}`);
  console.log(`  产物目录: ${outputDir}`);
  console.log(`  manifest: ${manifestPath}`);
  console.log(`  启动服务: make local-serve`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
