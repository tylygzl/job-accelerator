// popup.js — 点击图标后切换 BOSS 页面内的分析侧栏。

const apiUrlEl = document.getElementById("apiUrl");
const popupTitleBarEl = document.getElementById("popupTitleBar") || document.getElementById("popupTitle");
const statusEl = document.getElementById("status");
const resumeTextEl = document.getElementById("resumeText");
const resumePdfEl = document.getElementById("resumePdf");
const parsePdfBtn = document.getElementById("parsePdfBtn");
const saveResumeBtn = document.getElementById("saveResumeBtn");
const resumeStatusEl = document.getElementById("resumeStatus");
const minScoreEl = document.getElementById("minScore");
const minScoreLabelEl = document.getElementById("minScoreLabel");
const excludeKeywordsEl = document.getElementById("excludeKeywords");
const dailyGoalEl = document.getElementById("dailyGoal");
const autoConfirmChatEl = document.getElementById("autoConfirmChat");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const checkBackendBtn = document.getElementById("checkBackendBtn");
const quickApplyBtn = document.getElementById("quickApplyBtn");
const smartApplyBtn = document.getElementById("smartApplyBtn");
const openPanelBtn = document.getElementById("openPanelBtn");
const checkHrReplyBtn = document.getElementById("checkHrReplyBtn");
const hrReplyCountEl = document.getElementById("hrReplyCount");
const hrReplyListEl = document.getElementById("hrReplyList");
const PLUGIN_CONFIG = window.JOB_ACCELERATOR_CONFIG || {};
const HR_REPLY_DISCOVERY = window.HRReplyDiscovery || null;
const LOCAL_DEFAULT_API = "http://127.0.0.1:8000/match";
const DEFAULT_API = normalizeApiUrl(PLUGIN_CONFIG.DEFAULT_API || LOCAL_DEFAULT_API, LOCAL_DEFAULT_API);
const DEFAULT_API_TOKEN = PLUGIN_CONFIG.API_TOKEN || "";
const DEFAULT_MIN_SCORE = 80;
const DEFAULT_DAILY_GOAL = 100;
const DEFAULT_APPLY_MODE = "fast";
const DEFAULT_AUTO_CONFIRM_CHAT = true;
const MATCH_CACHE_PREFIX = "job_match_";
const JOB_STATUS_PREFIX = "job_status_";
const PENDING_CHAT_KEY = "job_accelerator_pending_chat";
const HR_REPLY_QUEUE_KEY = "job_accelerator_hr_reply_queue";
const HR_REPLY_DEBUG_FLAG_KEY = "debug_hr_reply";
const DEBUG_TITLE_CLICK_TARGET = 5;
const DEBUG_TITLE_CLICK_WINDOW_MS = 1600;
const HEALTH_TIMEOUT_MS = 5000;
const RESUME_PARSE_TIMEOUT_MS = 45 * 1000;
const MAX_RESUME_PDF_BYTES = 5 * 1024 * 1024;
let titleClickCount = 0;
let titleClickTimer = null;

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.dataset.type = type;
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(items || {});
    });
  });
}

function saveConfig(extra = {}) {
  return storageSet({
    apiUrl: resolveApiUrl(apiUrlEl.value),
    exclude_keywords: excludeKeywordsEl.value || "",
    daily_goal: normalizeDailyGoal(dailyGoalEl.value),
    auto_confirm_chat: Boolean(autoConfirmChatEl.checked),
    ...extra,
  });
}

function resetTitleClickCount() {
  titleClickCount = 0;
  if (titleClickTimer) {
    clearTimeout(titleClickTimer);
    titleClickTimer = null;
  }
}

async function toggleHrReplyDebugMode() {
  const data = await storageGet([HR_REPLY_DEBUG_FLAG_KEY]);
  const enabled = !Boolean(data[HR_REPLY_DEBUG_FLAG_KEY]);
  await storageSet({ [HR_REPLY_DEBUG_FLAG_KEY]: enabled });
  setStatus(enabled
    ? "开发测试模式已开启：聊天页侧栏会显示测试入队按钮"
    : "开发测试模式已关闭：聊天页测试入队按钮已隐藏");
}

popupTitleBarEl?.addEventListener("click", () => {
  titleClickCount += 1;
  if (titleClickTimer) clearTimeout(titleClickTimer);
  titleClickTimer = setTimeout(resetTitleClickCount, DEBUG_TITLE_CLICK_WINDOW_MS);
  if (titleClickCount < DEBUG_TITLE_CLICK_TARGET) return;
  resetTitleClickCount();
  toggleHrReplyDebugMode().catch((error) => {
    setStatus(`开发测试开关切换失败：${error?.message || "未知错误"}`, "error");
  });
});

function normalizeApiUrl(value, fallback = LOCAL_DEFAULT_API) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    const normalized = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return new URL(normalized).toString();
  } catch (_) {
    return fallback;
  }
}

function resolveApiUrl(value) {
  const normalized = normalizeApiUrl(value, DEFAULT_API);
  return isStaleBackendUrl(normalized) ? DEFAULT_API : normalized;
}

function isStaleBackendUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch (_) {
    return false;
  }
}

function updateResumeStatus(hasResume) {
  resumeStatusEl.textContent = hasResume ? "简历已加载" : "未上传简历";
  resumeStatusEl.classList.toggle("empty", !hasResume);
}

function updateMinScore(value) {
  const score = Number(value) || DEFAULT_MIN_SCORE;
  minScoreEl.value = score;
  minScoreLabelEl.textContent = `匹配度 ≥ ${score}%`;
}

function normalizeDailyGoal(value) {
  const goal = Number.parseInt(value, 10);
  if (!Number.isFinite(goal)) return DEFAULT_DAILY_GOAL;
  return Math.max(1, Math.min(500, goal));
}

function normalizeApplyMode(value) {
  return value === "smart" ? "smart" : DEFAULT_APPLY_MODE;
}

function healthUrlFor(apiUrl) {
  return backendUrlFor(apiUrl, "/health");
}

function resumeParseUrlFor(apiUrl) {
  return backendUrlFor(apiUrl, "/resume/parse");
}

function backendUrlFor(apiUrl, pathname) {
  const normalized = resolveApiUrl(apiUrl);
  const url = new URL(normalized);
  url.pathname = url.pathname.replace(/\/match\/?$/, pathname);
  if (!url.pathname.endsWith(pathname)) url.pathname = pathname;
  url.search = "";
  return url.toString();
}

function fetchJsonWithTimeout(url, timeoutMs = HEALTH_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, headers: options.headers || authHeaders(), signal: controller.signal })
    .then(async (response) => {
      const text = await response.text();
      const data = parseJsonOrNull(text);
      if (!response.ok) {
        const detail = data?.detail || data?.message || text || "";
        throw new Error(detail ? `HTTP ${response.status}: ${String(detail).slice(0, 180)}` : `HTTP ${response.status}`);
      }
      return unwrapApiResponse(data || {});
    })
    .finally(() => clearTimeout(timeoutId));
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

function authHeaders() {
  return DEFAULT_API_TOKEN ? { "X-Job-Accelerator-Token": DEFAULT_API_TOKEN } : {};
}

function formatHealthStatus(data) {
  if (!data?.ok) return "云端服务异常：/health 没有返回 ok";
  if (!data.llm) return "云端已连接；未返回 LLM 配置，请联系开发者检查服务";

  const llm = data.llm;
  const provider = llm.provider || "unknown";
  if (llm.local_fallback) {
    return `云端已连接；当前为规则兜底（${provider}），不会调用 LLM`;
  }

  const limits = data.limits || {};
  const stats = data.runtime?.stats || {};
  const fast = limits.fast_match ? `快速 ${limits.fast_match.in_flight}/${limits.fast_match.limit}` : "";
  const smart = limits.smart_match ? `智能 ${limits.smart_match.in_flight}/${limits.smart_match.limit}` : "";
  const chat = limits.chat_reply ? `HR ${limits.chat_reply.in_flight}/${limits.chat_reply.limit}` : "";
  const pdf = limits.pdf_parse ? `PDF ${limits.pdf_parse.in_flight}/${limits.pdf_parse.limit}` : "";
  const usage = [fast, smart, chat, pdf].filter(Boolean).join("，");
  const handled = Number(stats.match_ok || 0);
  const fallback = Number(stats.match_fallback || 0);
  const rejected = Number(stats.match_rejected || 0) + Number(stats.rate_limited || 0);
  const model = llm.model || "未设置模型";
  const key = llm.api_key_configured ? "key 已配置" : "key 未配置";
  const runtimeText = usage ? `；${usage}` : "";
  const statsText = handled ? `；已处理 ${handled} 条${fallback ? `，兜底 ${fallback}` : ""}${rejected ? `，忙碌/限流 ${rejected}` : ""}` : "";
  return `云端已连接；${provider} / ${model}；${key}${runtimeText}${statsText}`;
}

function formatHealthError(error) {
  if (error?.name === "AbortError") return "检测超时：云端服务没有在 5 秒内响应";
  const message = String(error?.message || error || "");
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
    return "云端服务连接失败：请确认网络正常，或联系开发者检查服务器";
  }
  if (/Invalid URL/i.test(message)) return "云端地址格式不正确";
  return `检测失败：${message || "未知错误"}`;
}

function formatResumeParseError(error) {
  if (error?.name === "AbortError") return "PDF 解析超时：请换文字版 PDF，或稍后重试";
  const message = String(error?.message || error || "");
  if (/HTTP 400/.test(message)) return "PDF 没有提取到有效文字，可能是扫描件或图片版简历";
  if (/HTTP 413/.test(message)) return "PDF 太大，请控制在 5MB 内";
  if (/HTTP 429/.test(message)) return "云端正在忙，请等几秒后重新解析 PDF";
  if (/HTTP 401|HTTP 403/.test(message)) return "云端访问令牌失效，请联系开发者重新打包插件";
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) return "云端服务连接失败，请稍后重试或联系开发者";
  return `PDF 解析失败：${message || "未知错误"}`;
}

function clearPageSessionCache() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.id) return false;
    return chrome.tabs.sendMessage(tab.id, { action: "clearSessionCache" })
      .then(() => true)
      .catch(() => false);
  });
}

function normalizeHrReplyQueue(value) {
  if (HR_REPLY_DISCOVERY) return HR_REPLY_DISCOVERY.dedupeQueueItems(value);
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && item.id);
}

function pendingHrReplyItems(queue) {
  return HR_REPLY_DISCOVERY
    ? HR_REPLY_DISCOVERY.pendingItems(queue)
    : normalizeHrReplyQueue(queue).filter((item) => ["pending", "needs_user"].includes(item.status));
}

function renderHrReplyState(state = {}) {
  const queue = normalizeHrReplyQueue(state.queue);
  const count = Number.isFinite(Number(state.count)) ? Number(state.count) : pendingHrReplyItems(queue).length;
  if (hrReplyCountEl) hrReplyCountEl.textContent = `待回复 ${count}`;
  if (!hrReplyListEl) return;

  if (!queue.length) {
    hrReplyListEl.innerHTML = '<div class="reply-empty">暂无待回复记录。打开 BOSS 消息页后点击检查。</div>';
    return;
  }

  hrReplyListEl.innerHTML = queue.map((item) => {
    const done = item.status === "draft_filled";
    const stateText = done
      ? "草稿已填入"
      : item.status === "needs_user"
        ? "需接管"
        : item.unreadCountText
          ? `未读 ${item.unreadCountText}`
          : "待处理";
    const meta = [
      item.debug || item.source === "debug_current_chat" ? "开发测试" : "",
      item.company,
      item.hr_role,
      item.time_text,
    ].filter(Boolean).join(" · ");
    return `<div class="reply-card${done ? " done" : ""}">
  <div class="reply-title">${escapeHtml(item.hr_name || "未知 HR")}</div>
  <div class="reply-meta">${escapeHtml(meta)}</div>
  <div class="reply-last">${escapeHtml(item.latest_hr_message || "未读消息")}</div>
  <div class="reply-actions">
    <button class="btn secondary" type="button" data-hr-reply-id="${escapeHtml(item.id)}">处理回复</button>
    <span class="reply-state">${escapeHtml(stateText)}</span>
  </div>
</div>`;
  }).join("");
}

async function loadStoredHrReplyQueue() {
  try {
    const data = await storageGet([HR_REPLY_QUEUE_KEY]);
    renderHrReplyState({ queue: data[HR_REPLY_QUEUE_KEY] || [] });
  } catch (_) {
    renderHrReplyState({ queue: [] });
  }
}

async function refreshHrReplyState(scan = false) {
  const state = await sendMessageToBossPage({ action: "hrReply.getState", scan });
  if (state?.ok === false) throw new Error(state.error || "读取 HR 回复状态失败");
  renderHrReplyState(state);
  return state;
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

chrome.storage.local.get(["apiUrl", "resume_text", "min_score", "exclude_keywords", "daily_goal", "auto_confirm_chat", "apply_mode"], (data) => {
  const apiUrl = resolveApiUrl(data.apiUrl);
  apiUrlEl.value = apiUrl;
  if (apiUrl !== data.apiUrl) chrome.storage.local.set({ apiUrl });
  resumeTextEl.value = data.resume_text || "";
  excludeKeywordsEl.value = data.exclude_keywords || "";
  dailyGoalEl.value = normalizeDailyGoal(data.daily_goal);
  autoConfirmChatEl.checked = data.auto_confirm_chat === undefined ? DEFAULT_AUTO_CONFIRM_CHAT : Boolean(data.auto_confirm_chat);
  updateResumeStatus(Boolean(data.resume_text));
  updateMinScore(data.min_score || DEFAULT_MIN_SCORE);
  chrome.storage.local.set({
    auto_confirm_chat: autoConfirmChatEl.checked,
    apply_mode: normalizeApplyMode(data.apply_mode),
  });
});
loadStoredHrReplyQueue();
refreshHrReplyState(false).catch(() => {});

apiUrlEl.addEventListener("change", () => saveConfig());
excludeKeywordsEl.addEventListener("input", () => {
  chrome.storage.local.set({ exclude_keywords: excludeKeywordsEl.value || "" });
});
dailyGoalEl.addEventListener("input", () => {
  chrome.storage.local.set({ daily_goal: normalizeDailyGoal(dailyGoalEl.value) });
});
autoConfirmChatEl.addEventListener("change", () => {
  chrome.storage.local.set({ auto_confirm_chat: Boolean(autoConfirmChatEl.checked) });
});

saveResumeBtn.addEventListener("click", () => {
  const resumeText = resumeTextEl.value.trim();
  chrome.storage.local.set({ resume_text: resumeText }, () => {
    updateResumeStatus(Boolean(resumeText));
    setStatus(resumeText ? "简历已保存" : "简历已清空");
  });
});

parsePdfBtn.addEventListener("click", async () => {
  const file = resumePdfEl.files?.[0];
  if (!file) {
    setStatus("请先选择 PDF 简历", "warn");
    return;
  }
  if (file.size > MAX_RESUME_PDF_BYTES) {
    setStatus("PDF 太大，请控制在 5MB 内", "warn");
    return;
  }

  parsePdfBtn.disabled = true;
  setStatus("正在解析 PDF 简历...");
  try {
    const form = new FormData();
    form.append("file", file, file.name || "resume.pdf");
    const data = await fetchJsonWithTimeout(resumeParseUrlFor(apiUrlEl.value), RESUME_PARSE_TIMEOUT_MS, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    const resumeText = String(data.resume_text || "").trim();
    if (!resumeText) throw new Error("PDF 未提取到有效文本");
    resumeTextEl.value = resumeText;
    chrome.storage.local.set({ resume_text: resumeText }, () => {
      updateResumeStatus(true);
      const skillCount = Number(data.skill_count || 0);
      setStatus(`PDF 已解析，提取 ${data.char_count || resumeText.length} 字${skillCount ? `，识别 ${skillCount} 个技能/项目证据` : ""}`);
    });
  } catch (error) {
    setStatus(formatResumeParseError(error), "error");
  } finally {
    parsePdfBtn.disabled = false;
  }
});

minScoreEl.addEventListener("input", () => {
  updateMinScore(minScoreEl.value);
  chrome.storage.local.set({ min_score: Number(minScoreEl.value) });
});

checkBackendBtn.addEventListener("click", async () => {
  await saveConfig();
  checkBackendBtn.disabled = true;
  setStatus("正在检测云端服务...");
  try {
    const health = await fetchJsonWithTimeout(healthUrlFor(apiUrlEl.value));
    setStatus(formatHealthStatus(health));
  } catch (error) {
    setStatus(formatHealthError(error), "error");
  } finally {
    checkBackendBtn.disabled = false;
  }
});

clearCacheBtn.addEventListener("click", () => {
  const confirmed = window.confirm("清空岗位分析缓存、本页会话、已沟通/跳过/收藏状态和待填开场白；不会删除简历和配置。确定清空？");
  if (!confirmed) return;

  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) {
      setStatus(`读取缓存失败：${chrome.runtime.lastError.message}`, "error");
      return;
    }

    const cacheKeys = Object.keys(items || {}).filter((key) => key.startsWith(MATCH_CACHE_PREFIX));
    const statusKeys = Object.keys(items || {}).filter((key) => key.startsWith(JOB_STATUS_PREFIX));
    const removeKeys = [...cacheKeys, ...statusKeys, PENDING_CHAT_KEY, HR_REPLY_QUEUE_KEY];
    if (!removeKeys.length) {
      clearPageSessionCache().then((clearedPage) => {
        setStatus(clearedPage ? "已清空本页会话状态" : "没有可清理的缓存和状态");
      });
      return;
    }

    chrome.storage.local.remove(removeKeys, () => {
      if (chrome.runtime.lastError) {
        setStatus(`清理缓存失败：${chrome.runtime.lastError.message}`, "error");
        return;
      }
      clearPageSessionCache().then((clearedPage) => {
        setStatus(`已清空 ${cacheKeys.length} 条分析缓存、${statusKeys.length} 条状态${clearedPage ? "，并清空本页会话" : ""}`);
      });
    });
  });
});

async function sendMessageToBossPage(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有找到当前页面");

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["config.js", "hr_reply_discovery.js", "content.js"],
    });
    setStatus("正在连接 BOSS 页面...");
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function openPanelOnly() {
  await saveConfig();
  const result = await sendMessageToBossPage({ action: "toggle" });
  if (result?.ok === false) throw new Error(result.error || "页面脚本没有成功打开侧栏");
  window.close();
}

async function startApply(applyMode) {
  const mode = normalizeApplyMode(applyMode);
  const resumeText = resumeTextEl.value.trim();
  if (!resumeText) {
    setStatus("请先上传 PDF 简历，或粘贴简历文本后保存", "warn");
    return;
  }

  autoConfirmChatEl.checked = true;
  await saveConfig({
    resume_text: resumeText,
    apply_mode: mode,
    auto_confirm_chat: true,
  });

  const modeName = mode === "smart" ? "智能投递" : "快速投递";
  setStatus(`正在启动${modeName}...`);
  quickApplyBtn.disabled = true;
  smartApplyBtn.disabled = true;
  try {
    const result = await sendMessageToBossPage({ action: "startAutoApply", applyMode: mode });
    if (result?.ok === false) throw new Error(result.error || "页面脚本没有成功启动海投");
    window.close();
  } catch (error) {
    setStatus(`启动失败：请确认当前页面是 BOSS 岗位搜索页。${error?.message || ""}`, "error");
    quickApplyBtn.disabled = false;
    smartApplyBtn.disabled = false;
  }
}

openPanelBtn.addEventListener("click", () => {
  openPanelOnly().catch((error) => {
    setStatus(`打开失败：请确认当前页面是 BOSS 岗位搜索页。${error?.message || ""}`, "error");
  });
});

quickApplyBtn.addEventListener("click", () => {
  startApply("fast").catch((error) => {
    setStatus(`快速投递启动失败：${error?.message || "未知错误"}`, "error");
    quickApplyBtn.disabled = false;
    smartApplyBtn.disabled = false;
  });
});

smartApplyBtn.addEventListener("click", () => {
  startApply("smart").catch((error) => {
    setStatus(`智能投递启动失败：${error?.message || "未知错误"}`, "error");
    quickApplyBtn.disabled = false;
    smartApplyBtn.disabled = false;
  });
});

checkHrReplyBtn.addEventListener("click", async () => {
  await saveConfig();
  checkHrReplyBtn.disabled = true;
  setStatus("正在检查 HR 回复...");
  try {
    const state = await sendMessageToBossPage({ action: "hrReply.scanQueue" });
    if (state?.ok === false) throw new Error(state.error || "检查失败");
    renderHrReplyState(state);
    setStatus(state.message || `当前待回复 ${state.count || 0} 条`);
  } catch (error) {
    await loadStoredHrReplyQueue();
    setStatus(`检查失败：请确认当前页面是 BOSS 消息页或岗位页。${error?.message || ""}`, "error");
  } finally {
    checkHrReplyBtn.disabled = false;
  }
});

hrReplyListEl.addEventListener("click", async (event) => {
  const button = event.target?.closest?.("[data-hr-reply-id]");
  if (!button) return;
  await saveConfig();
  button.disabled = true;
  button.textContent = "处理中";
  setStatus("正在处理 HR 回复...");
  try {
    const result = await sendMessageToBossPage({
      action: "hrReply.processItem",
      itemId: button.dataset.hrReplyId,
    });
    if (result?.ok === false) throw new Error(result.error || "处理失败");
    setStatus(result.message || "草稿已填入，请用户确认发送");
    refreshHrReplyState(false).catch(() => {});
  } catch (error) {
    setStatus(`处理失败：${error?.message || "未知错误"}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "处理回复";
  }
});
