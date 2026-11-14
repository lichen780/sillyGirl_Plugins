#!/usr/bin/env node
"use strict";

// 共享运行时冒烟测试：覆盖保留的 vortoUtils.js（其余共享模块已从库中移除）
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const memory = new Map();

class Bucket {
  constructor(name) {
    this.name = String(name);
  }
  async get(key, fallback = "") {
    const id = `${this.name}:${key}`;
    return memory.has(id) ? memory.get(id) : fallback;
  }
  async set(key, value) {
    memory.set(`${this.name}:${key}`, value);
  }
  async delete(key) {
    memory.delete(`${this.name}:${key}`);
  }
  async keys() {
    const prefix = `${this.name}:`;
    return [...memory.keys()].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  }
}

class Field {
  title() {
    return this;
  }
  description() {
    return this;
  }
  format() {
    return this;
  }
  default() {
    return this;
  }
  min() {
    return this;
  }
  max() {
    return this;
  }
  required() {
    return this;
  }
  err() {
    return this;
  }
}

class Form {
  constructor(schema) {
    this.schema = schema;
  }
  async get() {
    return {};
  }
  static string() {
    return new Field();
  }
  static integer() {
    return new Field();
  }
  static number() {
    return new Field();
  }
  static boolean() {
    return new Field();
  }
  static select() {
    return new Field();
  }
}

const sender = {
  reply: async () => undefined,
  getMsg: async () => "",
  getUserId: async () => "fixture-user",
  pushAdmin: async () => true,
  isAdmin: async () => true,
};

const fake = {
  Bucket,
  sender,
  container: {},
  Adapter: class Adapter {},
  plugin: { Form },
  console,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "sillygirl") return fake;
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const vorto = require(path.join(root, "plugins", "vortoUtils.js"));

  assert.equal(vorto.maskAccount("13800138000"), "138****8000");
  assert.deepEqual(vorto.parseBatchAccounts("a#b\nc#d"), [
    { field0: "a", field1: "b" },
    { field0: "c", field1: "d" },
  ]);
  assert.equal(typeof vorto.calculateAuthTime, "function");

  await new Bucket("auth-fixture").set("account", "2026-08-10");
  assert.match(await vorto.calculateAuthTime("auth-fixture", "account", { days: 1 }), /^\d{4}-\d{2}-\d{2}$/);

  console.log("shared_runtime_fixtures=PASS");
})();
