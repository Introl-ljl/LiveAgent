# 本地更新二开设计

日期：2026-07-23
状态：已批准

## 目标

基于 LiveAgent 二开个人项目，支持频繁本地更新：
1. 版本号标记：在原版版本号后追加 `-intNNN` 标记本地修改
2. 更新来源：从本地静态文件服务（http://127.0.0.1:7878）获取更新，替换 GitHub Release

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 版本标记格式 | `-intNNN` 预发布段（3 位零填充） | semver 原生支持；3 位填充规避字典序陷阱（int099 < int100） |
| 本地服务方式 | 127.0.0.1 静态文件服务器 | 配置简单、零依赖 |
| GitHub 流程去留 | 完全替换为本地 | 二开不需要上游更新通道 |
| int 序号生成 | 扫描本地目录自增 | 不依赖 git tag，纯本地状态 |
| 基础版本来源 | 读取最近 git tag | 无需手动查 |
| update.rs 改造策略 | 方案 A：最小手术 | 保留结构，仅替换数据源，降低风险 |

## 架构

### 数据流

```
make local-release
  ├─ local-version.mjs        算版本号 v{base}-int{NNN}
  ├─ tauri build              注入版本 + 签名
  ├─ 收集 NSIS 产物 (.exe/.sig) 到 dist/local-releases/v{base}-int{NNN}/
  └─ create-local-manifest.mjs 生成 latest.json (url 指向 127.0.0.1)

make local-serve
  └─ serve.mjs                静态托管 dist/local-releases/ → http://127.0.0.1:7878

app 内 app_update_check
  ├─ update.rs: local_manifest_url()  读 http://127.0.0.1:7878/latest.json
  └─ build_updater + tauri_plugin_updater  下载安装
```

### 版本号方案

- 格式：`v{base}-int{NNN}`，如 `v1.1.8-int001`
- base：`git describe --tags --abbrev=0` 取最近 tag，去前缀 `v`
- NNN：扫描 `dist/local-releases/v{base}-int*` 目录，取最大数字 +1，从 001 开始
- 3 位零填充：覆盖 001-999，规避 semver prerelease 字典序问题
- 注入：生成 `tauri.version.generated.conf.json` overlay

### 构建与发布脚本（新增 `scripts/local-release/`）

| 文件 | 职责 |
|---|---|
| `local-version.mjs` | 算版本号，输出 JSON `{baseVersion, intNumber, fullVersion, releaseTag, outputDir}` |
| `prepare-local-release.mjs` | 调 local-version → 生成 tauri overlay → `pnpm tauri build` → 收集产物 + `.sig` 到 outputDir |
| `create-local-manifest.mjs` | 扫 outputDir 的 `.sig`，生成 `latest.json`，`url` 指向 `http://127.0.0.1:7878/{filename}` |
| `serve.mjs` | Node 原生 `http` 模块静态托管 outputDir，监听 `127.0.0.1:7878` |

### Makefile 新增目标

- `local-release`：一键执行 `prepare-local-release.mjs`
- `local-serve`：一键执行 `serve.mjs`（默认托管最新 outputDir）

### update.rs 改造（最小手术）

只改 2 处，其余全保留：

1. 新增 `fn local_manifest_url() -> Result<String, String>`：读 `LIVEAGENT_LOCAL_MANIFEST_URL`，默认 `http://127.0.0.1:7878/latest.json`
2. 改写 `select_release_manifest` 函数体：直接返回本地 manifest URL 构造的 `SelectedRelease`

GitHub feed 相关函数（~250 行）变为死代码：加 `#[allow(dead_code)]` 保留，不删除。

不动：`AppUpdateCheckResponse` / `SelectedRelease` / `AppUpdateChannel` 类型、`build_updater`、`app_update_check` / `app_update_install` / `app_restart` 主体、前端 `appUpdates.ts`。

### tauri.conf.json 配置

`plugins.updater` 增加 `"dangerousInsecureTransportProtocol": true`，允许 `http://127.0.0.1` endpoint。

### 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `LIVEAGENT_LOCAL_MANIFEST_URL` | manifest URL，默认 `http://127.0.0.1:7878/latest.json` | 否 |
| `LIVEAGENT_UPDATER_PUBLIC_KEY` | 本地签名公钥（由 local-release 写入版本 overlay） | 是 |
| `TAURI_SIGNING_PRIVATE_KEY_PATH` | 签名私钥路径（构建时签名） | 是 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令（若有） | 否 |
| `PROTOC` | protobuf 编译器路径（构建依赖） | 是 |

## 测试与验证

- `local-version.mjs` 单元测试：base 提取、int 自增、3 位填充、目录不存在时从 001 开始
- `update.rs` 现有 `is_newer_version` 测试：补充 `1.1.8-int001` < `1.1.8-int002` 用例
- 端到端：构建 int001 → 安装 → 构建 int002 → `make local-serve` → app 检测到更新并安装重启

## 已知限制

- 同一 base 版本下 int 序号上限 999（3 位填充）；超出需扩展填充位数
- `make local-serve` 需手动启动（非常驻服务）
- `release_url` / `repository` 字段填占位值，UI 上「查看 release」链接不可用
