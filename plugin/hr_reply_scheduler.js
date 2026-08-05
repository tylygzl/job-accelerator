(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HRReplyScheduler = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const STATE_VERSION = 1;
  const SUCCESS_DELAY_MINUTES = 1;
  const NO_CHAT_TAB_DELAY_MINUTES = 3;
  const MAX_FAILURE_DELAY_MINUTES = 15;
  const OUTCOMES = Object.freeze({
    SUCCESS: "success",
    NO_CHAT_TAB: "no_chat_tab",
    BUSY: "busy",
    FAILURE: "failure",
  });

  function normalizeFailureCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) return 0;
    return Math.max(0, Math.min(30, Math.floor(count)));
  }

  function failureDelayMinutes(failureCount) {
    const count = Math.max(1, normalizeFailureCount(failureCount));
    return Math.min(MAX_FAILURE_DELAY_MINUTES, 2 ** (count - 1));
  }

  function delayMinutesFor(outcome, failureCount) {
    if (outcome === OUTCOMES.NO_CHAT_TAB) return NO_CHAT_TAB_DELAY_MINUTES;
    if (outcome === OUTCOMES.FAILURE) return failureDelayMinutes(failureCount);
    return SUCCESS_DELAY_MINUTES;
  }

  function normalizeReason(value) {
    const reason = String(value || "").trim().toLowerCase();
    if (!reason) return "none";
    return /^[a-z0-9_]{1,48}$/.test(reason) ? reason : "unspecified";
  }

  function nextState(previous, result, now = Date.now()) {
    const prior = previous && typeof previous === "object" ? previous : {};
    const rawOutcome = String(result?.outcome || "");
    const outcome = Object.values(OUTCOMES).includes(rawOutcome) ? rawOutcome : OUTCOMES.FAILURE;
    const failureCount = outcome === OUTCOMES.FAILURE
      ? normalizeFailureCount(prior.failureCount) + 1
      : 0;
    const delayMinutes = delayMinutesFor(outcome, failureCount);
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();

    return {
      version: STATE_VERSION,
      lastOutcome: outcome,
      lastReason: normalizeReason(result?.reason),
      failureCount,
      delayMinutes,
      lastRunAt: timestamp,
      nextRunAt: timestamp + delayMinutes * 60 * 1000,
    };
  }

  function classifyDispatchResult({ hasChatTab, response, transportFailed } = {}) {
    if (!hasChatTab) return { outcome: OUTCOMES.NO_CHAT_TAB, reason: "no_chat_tab" };
    if (transportFailed) return { outcome: OUTCOMES.FAILURE, reason: "send_failed" };
    if (!response || response.ok === false) {
      return { outcome: OUTCOMES.FAILURE, reason: response?.reason || "scan_failed" };
    }
    if (response.skipped) return { outcome: OUTCOMES.BUSY, reason: response.reason || "busy" };
    return { outcome: OUTCOMES.SUCCESS, reason: response.reason || "scan_complete" };
  }

  return Object.freeze({
    OUTCOMES,
    STATE_VERSION,
    SUCCESS_DELAY_MINUTES,
    NO_CHAT_TAB_DELAY_MINUTES,
    MAX_FAILURE_DELAY_MINUTES,
    normalizeFailureCount,
    failureDelayMinutes,
    delayMinutesFor,
    normalizeReason,
    nextState,
    classifyDispatchResult,
  });
});
