"use strict";

const assert = require("node:assert/strict");
const scheduler = require("../plugin/hr_reply_scheduler.js");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok - ${name}\n`);
}

test("success schedules the next scan in about one minute", () => {
  const state = scheduler.nextState({ failureCount: 4 }, { outcome: "success", reason: "scan_complete" }, 1000);
  assert.equal(state.delayMinutes, 1);
  assert.equal(state.failureCount, 0);
  assert.equal(state.nextRunAt, 61000);
});

test("missing chat tab schedules a three minute retry", () => {
  const result = scheduler.classifyDispatchResult({ hasChatTab: false });
  const state = scheduler.nextState({}, result, 2000);
  assert.equal(result.outcome, "no_chat_tab");
  assert.equal(state.delayMinutes, 3);
  assert.equal(state.failureCount, 0);
});

test("busy content script is not counted as a failure", () => {
  const result = scheduler.classifyDispatchResult({
    hasChatTab: true,
    response: { ok: true, skipped: true, reason: "busy" },
  });
  const state = scheduler.nextState({ failureCount: 3 }, result, 3000);
  assert.equal(result.outcome, "busy");
  assert.equal(state.delayMinutes, 1);
  assert.equal(state.failureCount, 0);
});

test("successful scan resets failure backoff", () => {
  const result = scheduler.classifyDispatchResult({
    hasChatTab: true,
    response: { ok: true, skipped: false, reason: "scan_complete" },
  });
  const state = scheduler.nextState({ failureCount: 8 }, result, 4000);
  assert.equal(result.outcome, "success");
  assert.equal(state.failureCount, 0);
});

test("transport errors use exponential backoff", () => {
  const result = scheduler.classifyDispatchResult({ hasChatTab: true, transportFailed: true });
  let state = {};
  const delays = [];
  for (let index = 0; index < 6; index += 1) {
    state = scheduler.nextState(state, result, index * 1000);
    delays.push(state.delayMinutes);
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 15, 15]);
});

test("scan errors use the same bounded backoff", () => {
  const result = scheduler.classifyDispatchResult({
    hasChatTab: true,
    response: { ok: false, reason: "scan_failed" },
  });
  const state = scheduler.nextState({ failureCount: 4 }, result, 5000);
  assert.equal(result.outcome, "failure");
  assert.equal(state.delayMinutes, 15);
  assert.equal(state.failureCount, 5);
});

test("unknown outcomes fail closed", () => {
  const state = scheduler.nextState({}, { outcome: "surprise", reason: "unexpected value" }, 6000);
  assert.equal(state.lastOutcome, "failure");
  assert.equal(state.lastReason, "unspecified");
  assert.equal(state.delayMinutes, 1);
});

test("stored scheduler state contains no free-form message body", () => {
  const state = scheduler.nextState({}, { outcome: "failure", reason: "HR said secret text" }, 7000);
  assert.deepEqual(Object.keys(state).sort(), [
    "delayMinutes",
    "failureCount",
    "lastOutcome",
    "lastReason",
    "lastRunAt",
    "nextRunAt",
    "version",
  ]);
  assert.equal(state.lastReason, "unspecified");
  assert.equal(JSON.stringify(state).includes("secret"), false);
});

process.stdout.write(`hr_reply_scheduler: ${passed} scenarios passed\n`);
