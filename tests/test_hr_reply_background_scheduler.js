"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const badge = require("../plugin/hr_reply_badge.js");
const scheduler = require("../plugin/hr_reply_scheduler.js");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "../plugin/background.js"),
  "utf8",
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeHarness(options = {}) {
  const listeners = { alarm: [], installed: [], startup: [], message: [], storageChanged: [] };
  const created = [];
  const storedStates = [];
  const badgeUpdates = [];
  const removedKeys = [];
  const sentMessages = [];
  const storageData = { ...(options.stored || {}) };
  let createFailures = Number(options.createFailures || 0);
  let sendCount = 0;

  const chrome = {
    alarms: {
      onAlarm: { addListener: (listener) => listeners.alarm.push(listener) },
      get: async () => {
        if (options.alarmGetFails) throw new Error("alarm_get_failed");
        return options.existingAlarm ? { name: "job_accelerator_hr_reply_scan" } : null;
      },
      create: async (name, info) => {
        created.push({ name, info });
        if (createFailures > 0) {
          createFailures -= 1;
          throw new Error("alarm_create_failed");
        }
      },
    },
    runtime: {
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onStartup: { addListener: (listener) => listeners.startup.push(listener) },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
    },
    action: {
      setBadgeText: async (value) => badgeUpdates.push({ kind: "text", value }),
      setBadgeBackgroundColor: async (value) => badgeUpdates.push({ kind: "color", value }),
      setTitle: async (value) => badgeUpdates.push({ kind: "title", value }),
    },
    tabs: {
      query: async () => options.tabs || [{ id: 7, active: true, lastAccessed: 1 }],
      sendMessage: async (tabId, message) => {
        sendCount += 1;
        sentMessages.push({ tabId, message });
        if (options.sendDeferred) return options.sendDeferred.promise;
        if (options.sendFails) throw new Error("send_failed");
        if (options.sendHandler) return options.sendHandler(tabId, message);
        return options.response || { ok: true, skipped: false, reason: "scan_complete", count: 1 };
      },
    },
    storage: {
      onChanged: { addListener: (listener) => listeners.storageChanged.push(listener) },
      local: {
        get: async () => {
          if (options.storageGetFails) throw new Error("storage_get_failed");
          return { ...storageData };
        },
        set: async (value) => {
          storedStates.push(value);
          if (options.storageSetFails) throw new Error("storage_set_failed");
          Object.assign(storageData, value);
        },
        remove: async (key) => {
          removedKeys.push(key);
          delete storageData[key];
        },
      },
    },
  };

  const context = {
    AbortController,
    URL,
    chrome,
    clearTimeout,
    fetch: async () => { throw new Error("unexpected_fetch"); },
    importScripts: (filename) => {
      if (filename === "hr_reply_scheduler.js") context.self.HRReplyScheduler = scheduler;
      if (filename === "hr_reply_badge.js" && options.loadBadge) context.self.HRReplyBadge = badge;
    },
    self: {},
    setTimeout,
  };
  vm.runInNewContext(backgroundSource, context, { filename: "plugin/background.js" });

  return {
    created,
    badgeUpdates,
    listeners,
    removedKeys,
    sentMessages,
    storageData,
    storedStates,
    get sendCount() { return sendCount; },
  };
}

function dispatchRuntimeRequest(harness, request, sender = { tab: { id: 7 } }) {
  return new Promise((resolve) => {
    const keepChannelOpen = harness.listeners.message[0](request, sender, resolve);
    assert.equal(keepChannelOpen, true);
  });
}

async function run(name, fn) {
  await fn();
  process.stdout.write(`ok - ${name}\n`);
}

(async () => {
  await run("startup recreates alarm when alarm lookup fails", async () => {
    const harness = makeHarness({ alarmGetFails: true });
    await settle();
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].info.delayInMinutes, 1);
  });

  await run("alarm creation retries once after a transient failure", async () => {
    const harness = makeHarness({ alarmGetFails: true, createFailures: 1 });
    await settle();
    assert.equal(harness.created.length, 2);
  });

  await run("storage read and write failures do not stop alarm renewal", async () => {
    const harness = makeHarness({
      existingAlarm: true,
      storageGetFails: true,
      storageSetFails: true,
    });
    await settle();
    harness.listeners.alarm[0]({ name: "job_accelerator_hr_reply_scan" });
    await settle();
    assert.equal(harness.sendCount, 1);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].info.delayInMinutes, 1);
  });

  await run("overlapping alarm events dispatch only one page scan", async () => {
    const gate = deferred();
    const harness = makeHarness({ existingAlarm: true, sendDeferred: gate });
    await settle();
    const listener = harness.listeners.alarm[0];
    listener({ name: "job_accelerator_hr_reply_scan" });
    listener({ name: "job_accelerator_hr_reply_scan" });
    await settle();
    assert.equal(harness.sendCount, 1);
    gate.resolve({ ok: true, skipped: false, reason: "scan_complete" });
    await settle();
    assert.equal(harness.sendCount, 1);
    assert.equal(harness.created.every((item) => item.name === "job_accelerator_hr_reply_scan"), true);
  });

  await run("busy page response renews without failure backoff", async () => {
    const harness = makeHarness({
      existingAlarm: true,
      response: { ok: true, skipped: true, reason: "busy" },
    });
    await settle();
    harness.listeners.alarm[0]({ name: "job_accelerator_hr_reply_scan" });
    await settle();
    const state = harness.storedStates.at(-1).job_accelerator_hr_reply_scheduler_state;
    assert.equal(state.lastOutcome, "busy");
    assert.equal(state.delayMinutes, 1);
  });

  await run("scan failure records a failure and still renews", async () => {
    const harness = makeHarness({
      existingAlarm: true,
      response: { ok: false, reason: "storage_write_failed" },
    });
    await settle();
    harness.listeners.alarm[0]({ name: "job_accelerator_hr_reply_scan" });
    await settle();
    const state = harness.storedStates.at(-1).job_accelerator_hr_reply_scheduler_state;
    assert.equal(state.lastOutcome, "failure");
    assert.equal(state.lastReason, "storage_write_failed");
    assert.equal(harness.created.at(-1).info.delayInMinutes, 1);
  });

  await run("service worker restart restores a privacy-safe badge", async () => {
    const harness = makeHarness({
      existingAlarm: true,
      loadBadge: true,
      stored: {
        job_accelerator_hr_reply_queue: [
          { id: "pending", status: "pending", latest_hr_message: "private body" },
          { id: "done", status: "draft_filled", latest_hr_message: "other private body" },
        ],
      },
    });
    await settle();
    const badgeText = harness.badgeUpdates.find((item) => item.kind === "text");
    const title = harness.badgeUpdates.find((item) => item.kind === "title");
    assert.equal(badgeText.value.text, "1");
    assert.equal(title.value.title.includes("1"), true);
    assert.equal(JSON.stringify(harness.badgeUpdates).includes("private body"), false);
  });

  await run("queue storage changes refresh the badge immediately", async () => {
    const harness = makeHarness({ existingAlarm: true, loadBadge: true });
    await settle();
    harness.badgeUpdates.length = 0;
    harness.listeners.storageChanged[0]({
      job_accelerator_hr_reply_queue: {
        newValue: [
          { id: "one", status: "pending" },
          { id: "two", status: "needs_user" },
        ],
      },
    }, "local");
    await settle();
    assert.equal(harness.badgeUpdates.find((item) => item.kind === "text").value.text, "2");
  });

  await run("HR reply task pauses other BOSS tabs and releases only its own lock", async () => {
    const harness = makeHarness({
      existingAlarm: true,
      tabs: [{ id: 7 }, { id: 8 }, { id: 9 }],
      sendHandler: async (tabId, message) => ({
        ok: true,
        paused: message.action === "jobAccelerator.pauseAutoApplyForHrReply" && tabId === 8,
      }),
    });
    await settle();

    const [firstBegin, secondBegin] = await Promise.all([
      dispatchRuntimeRequest(harness, {
        action: "jobAccelerator.beginHrReplyTask",
      }),
      dispatchRuntimeRequest(harness, {
        action: "jobAccelerator.beginHrReplyTask",
      }, { tab: { id: 9 } }),
    ]);
    const begin = firstBegin.ok ? firstBegin : secondBegin;
    const busy = firstBegin.busy ? firstBegin : secondBegin;
    assert.equal(begin.ok, true);
    assert.equal(begin.pausedCount, 1);
    assert.equal(typeof begin.lockToken, "string");
    assert.equal(harness.sentMessages.length, 2);
    assert.deepEqual(harness.sentMessages.map((entry) => entry.tabId), [8, 9]);
    assert.equal(harness.sentMessages.every((entry) => entry.message.action === "jobAccelerator.pauseAutoApplyForHrReply"), true);
    assert.equal(harness.storageData.job_accelerator_hr_reply_global_lock.ownerTabId, 7);
    assert.equal(busy.ok, false);
    assert.equal(busy.busy, true);

    const wrongRelease = await dispatchRuntimeRequest(harness, {
      action: "jobAccelerator.endHrReplyTask",
      lockToken: "wrong-token",
    });
    assert.equal(wrongRelease.released, false);
    assert.notEqual(harness.storageData.job_accelerator_hr_reply_global_lock, undefined);

    const released = await dispatchRuntimeRequest(harness, {
      action: "jobAccelerator.endHrReplyTask",
      lockToken: begin.lockToken,
    });
    assert.equal(released.released, true);
    assert.equal(harness.storageData.job_accelerator_hr_reply_global_lock, undefined);
    assert.deepEqual(harness.removedKeys, ["job_accelerator_hr_reply_global_lock"]);
  });

  process.stdout.write("hr_reply_background_scheduler: 9 scenarios passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
