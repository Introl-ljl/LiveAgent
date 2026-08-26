import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const manifestScript = join(scriptDir, "create-local-manifest.mjs");

test("local manifest recognizes Tauri NSIS artifact names", () => {
  const dir = mkdtempSync(join(tmpdir(), "liveagent-local-release-"));
  try {
    const artifact = "LiveAgent_1.1.9-int001_x64-setup.exe";
    writeFileSync(join(dir, artifact), "installer");
    writeFileSync(join(dir, `${artifact}.sig`), "signed-installer\n");

    const outputPath = join(dir, "latest.json");
    const result = spawnSync(
      process.execPath,
      [manifestScript, dir, outputPath, "1.1.9-int001"],
      { encoding: "utf8" },
    );

    assert.equal(
      result.status,
      0,
      `manifest script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(manifest.version, "1.1.9-int001");
    assert.equal(
      manifest.platforms["windows-x86_64-nsis"].url,
      `http://127.0.0.1:7878/${artifact}`,
    );
    assert.equal(
      manifest.platforms["windows-x86_64-nsis"].signature,
      "signed-installer",
    );
    assert.deepEqual(
      manifest.platforms["windows-x86_64"],
      manifest.platforms["windows-x86_64-nsis"],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
