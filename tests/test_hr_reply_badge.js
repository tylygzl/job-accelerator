"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const badge = require("../plugin/hr_reply_badge.js");
const discovery = require("../plugin/hr_reply_discovery.js");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok - ${name}\n`);
}

function queueOfSize(size) {
  return Array.from({ length: size }, (_, index) => ({
    id: `reply-${index}`,
    status: "pending",
  }));
}

test("empty queue produces an empty badge", () => {
  assert.deepEqual(badge.buildBadgeModel([]), {
    count: 0,
    text: "",
    color: "#d93025",
    title: "暂无待处理 HR 回复",
  });
});

test("only pending and needs_user are counted", () => {
  const model = badge.buildBadgeModel([
    { id: "pending", status: "pending" },
    { id: "needs-user", status: "needs_user" },
    { id: "draft", status: "draft_filled" },
    { id: "handled", status: "handled" },
    { id: "ignored", status: "ignored" },
    { id: "done", status: "done" },
    { id: "unknown", status: "other" },
  ]);

  assert.equal(model.count, 2);
  assert.equal(model.text, "2");
});

test("fingerprint pairs take priority when deduplicating", () => {
  const queue = [
    {
      id: "old-id",
      conversationFingerprint: "conversation-a",
      messageFingerprint: "message-a",
      status: "pending",
    },
    {
      id: "new-id",
      conversationFingerprint: "conversation-a",
      messageFingerprint: "message-a",
      status: "needs_user",
    },
    {
      id: "old-id",
      conversationFingerprint: "conversation-a",
      messageFingerprint: "message-b",
      status: "pending",
    },
  ];
  const model = badge.buildBadgeModel(queue);

  assert.equal(model.count, 2);
  assert.equal(discovery.pendingItems(queue).length, model.count);
});

test("terminal duplicate state wins before counting", () => {
  const queue = [
    {
      id: "draft-copy",
      conversationFingerprint: "conversation-terminal",
      messageFingerprint: "message-terminal",
      status: "draft_filled",
    },
    {
      id: "pending-copy",
      conversationFingerprint: "conversation-terminal",
      messageFingerprint: "message-terminal",
      status: "pending",
    },
  ];

  assert.equal(badge.buildBadgeModel(queue).count, 0);
  assert.equal(discovery.pendingItems(queue).length, 0);
});

test("id is the fallback when either fingerprint is missing", () => {
  const model = badge.buildBadgeModel([
    { id: "legacy-a", conversationFingerprint: "conversation-a", status: "pending" },
    { id: "legacy-a", messageFingerprint: "message-a", status: "needs_user" },
    { id: "legacy-b", status: "pending" },
    { status: "pending" },
  ]);

  assert.equal(model.count, 2);
});

test("99 remains numeric and 100 is capped at 99+", () => {
  assert.equal(badge.buildBadgeModel(queueOfSize(99)).text, "99");
  const hundred = badge.buildBadgeModel(queueOfSize(100));
  assert.equal(hundred.count, 100);
  assert.equal(hundred.text, "99+");
});

test("badge model cannot retain sensitive queue fields", () => {
  const secretMessage = "请把完整简历和手机号发给我";
  const model = badge.buildBadgeModel([{
    id: "sensitive-entry",
    status: "pending",
    latest_hr_message: secretMessage,
    hr_name: "敏感姓名",
    company: "敏感公司",
  }]);
  const serialized = JSON.stringify(model);

  assert.deepEqual(Object.keys(model).sort(), ["color", "count", "text", "title"]);
  assert.equal(serialized.includes(secretMessage), false);
  assert.equal(serialized.includes("敏感姓名"), false);
  assert.equal(serialized.includes("敏感公司"), false);
});

test("bad inputs fail closed", () => {
  for (const input of [null, undefined, {}, "pending", 1, [null, "bad", [], {}]]) {
    assert.equal(badge.buildBadgeModel(input).count, 0);
    assert.equal(badge.buildBadgeModel(input).text, "");
  }

  const unreadable = {};
  Object.defineProperty(unreadable, "status", {
    get() {
      throw new Error("unreadable queue item");
    },
  });
  assert.equal(badge.buildBadgeModel([{ id: "valid", status: "pending" }, unreadable]).count, 0);
});

test("browser build exposes the HRReplyBadge global", () => {
  const source = fs.readFileSync(path.join(__dirname, "../plugin/hr_reply_badge.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);

  assert.equal(typeof context.HRReplyBadge.buildBadgeModel, "function");
  assert.equal(context.HRReplyBadge.buildBadgeModel([]).count, 0);
});

test("popup fallback injects content script dependencies in manifest order", () => {
  const popupSource = fs.readFileSync(path.join(__dirname, "../plugin/popup.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin/manifest.json"), "utf8"));
  const bossContentScript = manifest.content_scripts.find((entry) => entry.matches.includes("*://*.zhipin.com/*"));
  const fallbackMatch = popupSource.match(/chrome\.scripting\.executeScript\(\{[\s\S]*?files:\s*(\[[^\]]+\])/);

  assert.ok(bossContentScript, "BOSS content script manifest entry is missing");
  assert.ok(fallbackMatch, "popup fallback executeScript files array is missing");
  assert.deepEqual(JSON.parse(fallbackMatch[1]), bossContentScript.js);
});

process.stdout.write(`hr_reply_badge: ${passed} scenarios passed\n`);
