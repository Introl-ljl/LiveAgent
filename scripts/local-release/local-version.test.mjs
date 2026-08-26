import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBaseVersion,
  nextIntNumber,
  padInt,
  buildFullVersion,
} from "./local-version.mjs";

test("parseBaseVersion strips v prefix", () => {
  assert.equal(parseBaseVersion("v1.1.8"), "1.1.8");
  assert.equal(parseBaseVersion("v0.1.0"), "0.1.0");
});

test("parseBaseVersion rejects empty tag", () => {
  assert.throws(() => parseBaseVersion(""), /empty/);
  assert.throws(() => parseBaseVersion(null), /empty/);
});

test("parseBaseVersion rejects tag without v prefix", () => {
  assert.throws(() => parseBaseVersion("1.1.8"), /must start with "v"/);
});

test("parseBaseVersion rejects tag with -int suffix", () => {
  assert.throws(() => parseBaseVersion("v1.1.8-int001"), /should not contain "-int"/);
});

test("padInt zero-pads to 3 digits", () => {
  assert.equal(padInt(1), "001");
  assert.equal(padInt(10), "010");
  assert.equal(padInt(100), "100");
  assert.equal(padInt(999), "999");
});

test("padInt rejects values over 999", () => {
  assert.throws(() => padInt(1000), /exceeds 999/);
});

test("padInt rejects negative and non-integer", () => {
  assert.throws(() => padInt(-1), /invalid/);
  assert.throws(() => padInt(1.5), /invalid/);
});

test("nextIntNumber returns 1 for empty directory list", () => {
  assert.equal(nextIntNumber([], "1.1.8"), 1);
});

test("nextIntNumber increments max int", () => {
  const dirs = ["v1.1.8-int001", "v1.1.8-int002", "v1.1.8-int003"];
  assert.equal(nextIntNumber(dirs, "1.1.8"), 4);
});

test("nextIntNumber ignores different base versions", () => {
  const dirs = ["v1.1.8-int001", "v1.1.8-int002", "v1.1.9-int001"];
  assert.equal(nextIntNumber(dirs, "1.1.8"), 3);
});

test("nextIntNumber ignores non-standard int format", () => {
  const dirs = ["v1.1.8-int001", "v1.1.8-int1", "v1.1.8-int002"];
  // int1 非标准 3 位填充被跳过，max 是 2，返回 3
  assert.equal(nextIntNumber(dirs, "1.1.8"), 3);
});

test("buildFullVersion combines base and int", () => {
  assert.equal(buildFullVersion("1.1.8", 1), "1.1.8-int001");
  assert.equal(buildFullVersion("1.1.8", 42), "1.1.8-int042");
});
