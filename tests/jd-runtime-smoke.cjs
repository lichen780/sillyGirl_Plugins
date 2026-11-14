#!/usr/bin/env node
"use strict";

// 京东公共模块冒烟测试：只覆盖保留的 jdLegacyCore.js（其余京东插件已从库中移除）
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const core = require(path.join(root, "plugins", "jdLegacyCore.js"));

assert.equal(core.normalizeCookie("x=1; pt_key=K; pt_pin=P;"), "pt_key=K;pt_pin=P;");
assert.deepEqual(core.parseCookies("pt_key=A;pt_pin=one;\npt_key=B;pt_pin=two;"), [
  "pt_key=A;pt_pin=one;",
  "pt_key=B;pt_pin=two;",
]);
assert.equal(core.ptKey("pt_key=K;pt_pin=P;"), "K");
assert.equal(core.ptPin("pt_key=K;pt_pin=P;"), "P");
assert.equal(core.wskeyPin("pin=abc;wskey=xyz;"), "abc");
assert.deepEqual(core.unwrap({ data: { list: [{ id: 1 }] } }), [{ id: 1 }]);

console.log("jd_runtime_fixtures=PASS");
