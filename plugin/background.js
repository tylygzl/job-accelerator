// background.js - forwards backend requests from BOSS pages.
//
// Content scripts run inside the BOSS page context. When BOSS is HTTPS but the
// demo backend is a temporary HTTP IP, direct page-side fetch can be blocked by
// the browser. The extension background worker owns the network request instead.

"use strict";

try {
  importScripts("hr_reply_scheduler.js");
} catch (_) {
  // Backend forwarding must keep working even if the optional scheduler fails to load.
}

try {
  importScripts("hr_reply_badge.js");
} catch (_) {
  // Badge updates are optional and must never block backend forwarding or scans.
}

const DEFAULT_TIMEOUT_MS = 20 * 1000;
const HR_REPLY_SCHEDULER = self.HRReplyScheduler || null;
const HR_REPLY_BADGE = self.HRReplyBadge || null;
const HR_REPLY_ALARM_NAME = "job_accelerator_hr_reply_scan";
const HR_REPLY_SCHEDULER_STATE_KEY = "job_accelerator_hr_reply_scheduler_state";
const HR_REPLY_QUEUE_KEY = "job_accelerator_hr_reply_queue";
const BOSS_CHAT_TAB_PATTERN = "*://*.zhipin.com/web/geek/chat*";
let hrReplyAlarmRunning = false;

if (HR_REPLY_SCHEDULER && chrome.alarms && chrome.tabs && chrome.storage?.local) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== HR_REPLY_ALARM_NAME) return;
    if (hrReplyAlarmRunning) {
      scheduleHrReplyAlarm(1).catch(() => {});
      return;
    }

    hrReplyAlarmRunning = true;
    runScheduledHrReplyScan()
      .catch(() =>
        recordAndScheduleHrReplyResult({
          outcome: HR_REPLY_SCHEDULER.OUTCOMES.FAILURE,
          reason: "scheduler_failed",
        })
      )
      .catch(() => {})
      .finally(() => {
        hrReplyAlarmRunning = false;
      });
  });

  chrome.runtime.onInstalled.addListener(() => {
    ensureHrReplyAlarm().catch(() => {});
  });

  chrome.runtime.onStartup.addListener(() => {
    ensureHrReplyAlarm().catch(() => {});
  });

  ensureHrReplyAlarm().catch(() => {});
}

if (HR_REPLY_BADGE && chrome.action && chrome.storage?.local) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[HR_REPLY_QUEUE_KEY]) return;
    updateHrReplyBadge(changes[HR_REPLY_QUEUE_KEY].newValue).catch(() => {});
  });
  chrome.runtime.onInstalled.addListener(() => updateHrReplyBadgeFromStorage().catch(() => {}));
  chrome.runtime.onStartup.addListener(() => updateHrReplyBadgeFromStorage().catch(() => {}));
  updateHrReplyBadgeFromStorage().catch(() => {});
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "jobAccelerator.match") {
    handleMatchRequest(request)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: formatBackgroundError(error),
        });
      });

    return true;
  }

  if (request?.action === "jobAccelerator.chatReply") {
    handleChatReplyRequest(request)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: formatBackgroundError(error),
        });
      });

    return true;
  }

  return false;
});

async function ensureHrReplyAlarm() {
  if (!HR_REPLY_SCHEDULER || !chrome.alarms) return false;
  let existing = null;
  try {
    existing = await chrome.alarms.get(HR_REPLY_ALARM_NAME);
  } catch (_) {
    // Recreate below. A transient read failure must not stop future scans.
  }
  if (existing) return true;
  await scheduleHrReplyAlarm(1);
  return true;
}

async function scheduleHrReplyAlarm(delayMinutes) {
  const delay = Number.isFinite(Number(delayMinutes)) ? Math.max(1, Number(delayMinutes)) : 1;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await chrome.alarms.create(HR_REPLY_ALARM_NAME, { delayInMinutes: delay });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("alarm_schedule_failed");
}

async function runScheduledHrReplyScan() {
  const tabs = await chrome.tabs.query({ url: BOSS_CHAT_TAB_PATTERN });
  const chatTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  if (!chatTabs.length) {
    return recordAndScheduleHrReplyResult(
      HR_REPLY_SCHEDULER.classifyDispatchResult({ hasChatTab: false })
    );
  }

  const target = selectChatTab(chatTabs);
  let response = null;
  let transportFailed = false;
  try {
    response = await chrome.tabs.sendMessage(target.id, { action: "hrReply.scheduledScan" });
  } catch (_) {
    transportFailed = true;
  }

  return recordAndScheduleHrReplyResult(
    HR_REPLY_SCHEDULER.classifyDispatchResult({
      hasChatTab: true,
      response,
      transportFailed,
    })
  );
}

function selectChatTab(tabs) {
  return [...tabs].sort((left, right) => {
    const activeDifference = Number(Boolean(right.active)) - Number(Boolean(left.active));
    if (activeDifference) return activeDifference;
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  })[0];
}

async function recordAndScheduleHrReplyResult(result) {
  if (!HR_REPLY_SCHEDULER) return null;
  let previous = null;
  try {
    const stored = await chrome.storage.local.get([HR_REPLY_SCHEDULER_STATE_KEY]);
    previous = stored[HR_REPLY_SCHEDULER_STATE_KEY] || null;
  } catch (_) {
    // Use a fresh state. Scheduling must continue even if storage is unavailable.
  }

  const next = HR_REPLY_SCHEDULER.nextState(previous, result);
  try {
    await chrome.storage.local.set({ [HR_REPLY_SCHEDULER_STATE_KEY]: next });
  } catch (_) {
    // The diagnostic state is best-effort; the next alarm is the critical path.
  }
  await scheduleHrReplyAlarm(next.delayMinutes);
  return next;
}

async function updateHrReplyBadgeFromStorage() {
  if (!HR_REPLY_BADGE || !chrome.storage?.local) return false;
  const stored = await chrome.storage.local.get([HR_REPLY_QUEUE_KEY]);
  return updateHrReplyBadge(stored[HR_REPLY_QUEUE_KEY]);
}

async function updateHrReplyBadge(queue) {
  if (!HR_REPLY_BADGE || !chrome.action?.setBadgeText) return false;
  const model = HR_REPLY_BADGE.buildBadgeModel(queue);
  await chrome.action.setBadgeText({ text: model.text });
  if (chrome.action.setBadgeBackgroundColor) {
    await chrome.action.setBadgeBackgroundColor({ color: model.color });
  }
  if (chrome.action.setTitle) {
    await chrome.action.setTitle({ title: `求职加速器 · ${model.title}` });
  }
  return true;
}

async function handleMatchRequest(request) {
  const apiUrl = normalizeUrl(request.apiUrl);
  const payload = request.payload || {};
  const apiToken = String(request.apiToken || "").trim();
  const timeoutMs = normalizeTimeout(request.timeoutMs);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiToken) headers["X-Job-Accelerator-Token"] = apiToken;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jd_text: String(payload.jd_text || ""),
        resume_text: String(payload.resume_text || ""),
        mode: normalizeMode(payload.mode),
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const data = parseJsonOrNull(text);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: formatHttpError(response.status, data, text),
      };
    }

    return {
      ok: true,
      status: response.status,
      request_id: data?.request_id || "",
      data: unwrapApiResponse(data),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatBackgroundError(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleChatReplyRequest(request) {
  const apiUrl = normalizeUrl(request.apiUrl);
  const payload = request.payload || {};
  const apiToken = String(request.apiToken || "").trim();
  const timeoutMs = normalizeTimeout(request.timeoutMs);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiToken) headers["X-Job-Accelerator-Token"] = apiToken;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(normalizeChatReplyPayload(payload)),
      signal: controller.signal,
    });

    const text = await response.text();
    const data = parseJsonOrNull(text);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: formatHttpError(response.status, data, text),
      };
    }

    return {
      ok: true,
      status: response.status,
      request_id: data?.request_id || "",
      data: unwrapApiResponse(data),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatBackgroundError(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("云端地址为空");
  const normalized = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return new URL(normalized).toString();
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, timeout));
}

function normalizeMode(value) {
  return value === "smart" ? "smart" : "fast";
}

function normalizeChatReplyPayload(payload) {
  return {
    hr_message: String(payload.hr_message || ""),
    conversation: normalizeConversation(payload.conversation),
    job_title: String(payload.job_title || ""),
    company: String(payload.company || ""),
    city: String(payload.city || ""),
    salary: String(payload.salary || ""),
    jd_text: String(payload.jd_text || ""),
    resume_text: String(payload.resume_text || ""),
    resume_profile: payload.resume_profile || undefined,
    evidence_context: String(payload.evidence_context || ""),
    evidence_sources: Array.isArray(payload.evidence_sources) ? payload.evidence_sources.map(String) : [],
  };
}

function normalizeConversation(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((item) => ({
    role: String(item?.role || ""),
    content: String(item?.content || ""),
  }));
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function unwrapApiResponse(data) {
  if (data && typeof data === "object" && "success" in data && "data" in data) {
    if (data.success === false) throw new Error(data.message || "Backend request failed");
    return data.data || {};
  }
  return data || {};
}

function formatHttpError(status, data, rawText) {
  const detail = data?.detail || data?.message || rawText || "";
  return detail ? `HTTP ${status}: ${String(detail).slice(0, 300)}` : `HTTP ${status}`;
}

function formatBackgroundError(error) {
  if (error?.name === "AbortError") return "AbortError";
  return String(error?.message || error || "Unknown background request error");
}
