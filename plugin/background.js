// background.js - forwards backend requests from BOSS pages.
//
// Content scripts run inside the BOSS page context. When BOSS is HTTPS but the
// demo backend is a temporary HTTP IP, direct page-side fetch can be blocked by
// the browser. The extension background worker owns the network request instead.

"use strict";

const DEFAULT_TIMEOUT_MS = 20 * 1000;

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
