// content.js — 求职加速器 BOSS 侧边栏。
(function () {
  "use strict";

  const HR_REPLY_DISCOVERY_QUEUE_LIMIT = 30;
  const HR_REPLY_DISCOVERY = window.HRReplyDiscovery || null;

  const PLUGIN_CONFIG = window.JOB_ACCELERATOR_CONFIG || {};
  const LOCAL_DEFAULT_API = "http://127.0.0.1:8000/match";
  const DEFAULT_API = normalizeApiUrl(PLUGIN_CONFIG.DEFAULT_API || LOCAL_DEFAULT_API, LOCAL_DEFAULT_API);
  const DEFAULT_API_TOKEN = PLUGIN_CONFIG.API_TOKEN || "";
  const DEFAULT_DAILY_GOAL = 100;
  const DEFAULT_APPLY_MODE = "fast";
  const DEFAULT_AUTO_CONFIRM_CHAT = true;
  const ALL_MATCH_CACHE_PREFIX = "job_match_";
  const MATCH_CACHE_PREFIX = "job_match_v7_";
  const JOB_STATUS_PREFIX = "job_status_";
  const PENDING_CHAT_KEY = "job_accelerator_pending_chat";
  const HR_REPLY_QUEUE_KEY = "job_accelerator_hr_reply_queue";
  const HR_REPLY_ACTIVE_TASK_KEY = "job_accelerator_hr_reply_active_task";
  const HR_REPLY_DEBUG_FLAG_KEY = "debug_hr_reply";
  const HR_REPLY_DEBUG_SOURCE = "debug_current_chat";
  const DEBUG_FLAG_READ_MAX_ATTEMPTS = 3;
  const DEBUG_FLAG_RETRY_DELAY_MS = 200;
  const CHAT_HELPER_ID = "job-accelerator-chat-helper";
  const AUTO_OPEN_KEY = "job_accelerator_auto";
  const AUTO_APPLY_KEY = "job_accelerator_auto_apply";
  const BOSS_CHAT_URL = "https://www.zhipin.com/web/geek/chat";
  const MATCH_CACHE_LIMIT = 500;
  const HR_REPLY_QUEUE_LIMIT = HR_REPLY_DISCOVERY_QUEUE_LIMIT;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const AUTO_OPEN_TTL_MS = 2 * 60 * 1000;
  const AUTO_APPLY_TTL_MS = 4 * 60 * 60 * 1000;
  const TASK_LOCK_STALE_MS = 3 * 60 * 1000;
  const FAST_REQUEST_TIMEOUT_MS = 8 * 1000;
  const SMART_REQUEST_TIMEOUT_MS = 15 * 1000;
  const CHAT_REPLY_TIMEOUT_MS = 20 * 1000;
  const REQUEST_TIMEOUT_MS = SMART_REQUEST_TIMEOUT_MS;
  const CHAT_CONFIRM_WAIT_MS = 90 * 1000;
  const AUTO_CHAT_STEP_DELAY_MS = 1000;
  const AUTO_LOOP_STEP_DELAY_MS = 700;
  const AUTO_LOOP_MAX_ROUNDS = 60;
  const AUTO_LOOP_IDLE_ROUNDS = 2;
  const DETAIL_SCAN_TIMEOUT_MS = 5 * 1000;
  const DETAIL_SCAN_INTERVAL_MS = 200;
  const DETAIL_SCAN_COOLDOWN_MS = 1000;
  const DETAIL_SCAN_BATCH_LIMIT = 50;
  const JOB_SCAN_LIMIT = 500;
  const SEARCH_SCROLL_STEPS = 5;
  const SEARCH_SCROLL_STEP_MS = 160;
  const SEARCH_SCROLL_SETTLE_MS = 700;
  const SESSION_JOBS_KEY = "job_accelerator_session_jobs";
  const SESSION_JOBS_VERSION = MATCH_CACHE_PREFIX;
  const SESSION_JOBS_TTL_MS = 4 * 60 * 60 * 1000;
  const DETAIL_READY_RE = /职位描述|岗位职责|工作职责|任职要求|岗位要求|任职资格|工作内容/;
  const JOB_CARD_SELECTOR = ".job-card-box,.job-card-wrapper";
  const DETAIL_TEXT_SELECTORS = [
    ".job-detail .job-sec-text",
    ".job-detail-box .job-sec-text",
    ".job-detail-section .job-sec-text",
    ".job-detail",
    ".job-sec-text",
    ".job-detail-box",
    ".job-detail-section",
    ".detail-content",
    ".job-detail-container",
    "[class*='job-sec']",
    "[class*='job-desc']",
    "[class*='jobDesc']",
    "[class*='description']",
    "[class*='require']",
    "[class*='responsib']",
  ];
  let panel = null;
  let visible = false;
  let paused = false;
  let resumeWaiter = null;
  let activeMinScore = 80;
  let activeDailyGoal = 0;
  let activeApplyMode = DEFAULT_APPLY_MODE;
  let activeTitleKeywords = [];
  let activeLocationKeywords = [];
  let activeAutoConfirmChat = false;
  let hideLowMatches = false;
  let panelMode = "jobs";
  const statuses = {};
  const renderedJobs = new Map();
  let sessionJobs = new Map();
  let latestJobs = [];
  let scanSummary = emptyScanSummary();
  let analyzing = false;
  let scanningMore = false;
  let autoApplyInProgress = false;
  let autoApplyLoopRunning = false;
  let autoApplyArmed = false;
  let sentDialogGuardRunning = false;
  let hrReplyProcessing = false;
  let hrReplyScheduledScanRunning = false;
  let debugHrReplyEnabled = false;
  let debugFlagLoadState = "idle";
  let debugFlagLoadAttempt = 0;
  let debugFlagSyncRunId = 0;
  let taskLock = null;
  let analysisRunId = 0;
  const activeFetchControllers = new Set();
  const runtimeState = {
    counts: { analyzed: 0, ready: 0, done: 0, skip: 0, failed: 0 },
    lastAction: "等待操作",
    nextSuggestion: "先在 BOSS 选择筛选条件，再启动海投。",
    lastError: "",
    lastRequestId: "",
    pendingHrQueueCount: 0,
    hrReplyDiscoveryDiagnostics: {
      cardCount: 0,
      queuedCount: 0,
      rejectedCount: 0,
      rejectReasons: "",
      unreadSources: "",
      singleCardUnreadCount: 0,
      numericUnreadMissingStableHintCount: 0,
    },
    chatMessageDiagnostics: {
      messageNodeCount: 0,
      messageContainerCount: 0,
      visibleMessageContainerCount: 0,
      candidateMessageContainerCount: 0,
      selectedMessageContainerIndex: -1,
      selectedMessageContainerTextCount: 0,
      selectedMessageContainerReason: "",
      hrMessageCount: 0,
      myMessageCount: 0,
      textMessageCount: 0,
      tailMessageRoles: "",
      latestMessageRole: "",
    },
  };

  hydrateStatuses().catch(() => {});
  autoFillPendingChat().catch(() => {});
  watchChatRoute();
  loadDebugHrReplyFlag().catch(() => {});
  resumeHrReplyTaskIfNeeded().catch(() => {});

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "toggle") {
      visible ? hide() : show();
      sendResponse({ ok: true });
    }
    if (request.action === "clearSessionCache") {
      disableAutoApplyTask();
      Object.keys(statuses).forEach((key) => delete statuses[key]);
      clearSessionJobs();
      forgetHrReplyTask();
      sendResponse({ ok: true });
    }
    if (request.action === "startAutoApply") {
      startAutoApplyFromMessage(request.applyMode)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (request.action === "hrReply.getState") {
      getHrReplyState({ scan: Boolean(request.scan) })
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (request.action === "hrReply.scanQueue") {
      scanHrReplyQueue({ source: "popup", render: true })
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (request.action === "hrReply.scheduledScan") {
      runScheduledHrReplyScan()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, reason: "scan_failed", error: error?.message || String(error) }));
      return true;
    }
    if (request.action === "hrReply.processItem") {
      processHrReplyItem(request.itemId)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let shouldRefresh = false;
    if (changes.min_score) {
      activeMinScore = normalizeMinScore(changes.min_score.newValue);
      shouldRefresh = true;
    }
    if (changes.daily_goal) {
      activeDailyGoal = normalizeDailyGoal(changes.daily_goal.newValue);
      shouldRefresh = true;
    }
    if (changes.apply_mode) {
      activeApplyMode = normalizeApplyMode(changes.apply_mode.newValue);
      updatePanelMode();
    }
    if (changes.apply_title_keywords) {
      activeTitleKeywords = parseFilterKeywords(changes.apply_title_keywords.newValue);
    }
    if (changes.apply_location_keywords) {
      activeLocationKeywords = parseFilterKeywords(changes.apply_location_keywords.newValue);
    }
    if (changes.auto_confirm_chat) {
      activeAutoConfirmChat = Boolean(changes.auto_confirm_chat.newValue);
    }
    if (changes[HR_REPLY_DEBUG_FLAG_KEY]) {
      debugFlagSyncRunId += 1;
      const nextValue = changes[HR_REPLY_DEBUG_FLAG_KEY].newValue;
      debugHrReplyEnabled = Boolean(nextValue);
      debugFlagLoadState = nextValue === undefined ? "missing" : "loaded";
      debugFlagLoadAttempt = 1;
      refreshDebugHrReplyButton();
      renderRuntimeState();
    }
    if (shouldRefresh && panel && panelMode === "jobs") {
      const jobs = latestJobs.length ? latestJobs : sessionJobList();
      if (jobs.length) render(jobs);
      else refreshStats([]);
    }
  });

  async function show(options = {}) {
    if (panel) return;
    await hydrateStatuses();
    await loadDebugHrReplyFlag();
    hideLowMatches = false;
    scanSummary = emptyScanSummary();
    sessionJobs = isBossSearchPage() ? loadSessionJobs() : new Map();
    latestJobs = sessionJobList();
    panelMode = getBossPageMode() === "job" ? "jobs" : "chat";
    panel = document.createElement("div");
    panel.id = "job-accelerator-panel";
    panel.innerHTML = panelMode === "chat"
      ? chatShellHtml()
      : shellHtml(0, "先在 BOSS 选好城市、薪资等条件，再点击“启动海投”。");
    document.body.appendChild(panel);
    visible = true;
    refreshPendingHrQueueCount().catch(() => {});
    renderRuntimeState();
    if (panelMode === "chat") {
      bindChatShell();
      syncDebugHrReplyFlagForOpenPanel().catch(() => {});
      await renderChatAssistant("已进入 HR 回复助手。");
      return;
    }

    bindShell();
    await hydrateJobPanelControls();
    refreshStats(latestJobs);
    renderScanSummary("先在 BOSS 选好城市、薪资等条件，再点击“启动海投”。");
    if (options.autoStart) {
      await refreshVisibleJobs("已返回，扫描当前补位新增。");
      if (isAutoApplyTaskActive()) await startNextAutoChat("返回后继续海投。");
    }
  }

  function hide() {
    if (!panel) return;
    disableAutoApplyTask();
    cancelActiveAnalysis();
    setPaused(false);
    panel.remove();
    panel = null;
    visible = false;
  }

  function cancelActiveAnalysis() {
    analysisRunId += 1;
    activeFetchControllers.forEach((controller) => controller.abort());
    activeFetchControllers.clear();
    analyzing = false;
    scanningMore = false;
    autoApplyInProgress = false;
    autoApplyLoopRunning = false;
    if (resumeWaiter) {
      resumeWaiter();
      resumeWaiter = null;
    }
    setContinueButtonBusy(false);
  }

  function rememberAutoOpenPanel() {
    try {
      sessionStorage.setItem(AUTO_OPEN_KEY, JSON.stringify({ expiresAt: Date.now() + AUTO_OPEN_TTL_MS }));
    } catch (_) {
      sessionStorage.setItem(AUTO_OPEN_KEY, "1");
    }
  }

  function consumeAutoOpenPanel() {
    const raw = sessionStorage.getItem(AUTO_OPEN_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(AUTO_OPEN_KEY);
    if (raw === "1") return true;
    try {
      const data = JSON.parse(raw);
      return Number(data?.expiresAt || 0) > Date.now();
    } catch (_) {
      return false;
    }
  }

  function enableAutoApplyTask() {
    autoApplyArmed = true;
    try {
      sessionStorage.setItem(AUTO_APPLY_KEY, JSON.stringify({ expiresAt: Date.now() + AUTO_APPLY_TTL_MS }));
    } catch (_) {
      sessionStorage.setItem(AUTO_APPLY_KEY, "1");
    }
  }

  function disableAutoApplyTask() {
    autoApplyArmed = false;
    try {
      sessionStorage.removeItem(AUTO_APPLY_KEY);
    } catch (_) {}
  }

  function isAutoApplyTaskActive() {
    if (autoApplyArmed) return true;
    const raw = sessionStorage.getItem(AUTO_APPLY_KEY);
    if (!raw) return false;
    if (raw === "1") {
      autoApplyArmed = true;
      return true;
    }
    try {
      const data = JSON.parse(raw);
      const active = Number(data?.expiresAt || 0) > Date.now();
      if (active) autoApplyArmed = true;
      else disableAutoApplyTask();
      return active;
    } catch (_) {
      return false;
    }
  }

  function scheduleAutoShow() {
    if (visible || panel) return;
    const wait = setInterval(() => {
      if (document.querySelectorAll(JOB_CARD_SELECTOR).length > 0) {
        clearInterval(wait);
        show({ autoStart: true });
      }
    }, 300);
    setTimeout(() => clearInterval(wait), 10000);
  }

  if (isBossSearchPage() && consumeAutoOpenPanel()) {
    scheduleAutoShow();
  }

  function emptyScanSummary() {
    return {
      visible: 0,
      total: 0,
      added: 0,
      cached: 0,
      fresh: 0,
      loadedBefore: 0,
      loadedAfter: 0,
      scrolled: false,
    };
  }

  function setLastAction(action, nextSuggestion = "") {
    const value = String(action || "").trim();
    if (value) runtimeState.lastAction = value;
    if (nextSuggestion) runtimeState.nextSuggestion = nextSuggestion;
    renderRuntimeState();
  }

  function setNextSuggestion(nextSuggestion) {
    runtimeState.nextSuggestion = String(nextSuggestion || "").trim() || defaultNextSuggestion();
    renderRuntimeState();
  }

  function setLastError(error) {
    runtimeState.lastError = String(error?.message || error || "").trim();
    if (runtimeState.lastError) {
      runtimeState.nextSuggestion = "按错误提示处理后重试；如果正在海投，建议先暂停再排查。";
    }
    renderRuntimeState();
  }

  function clearLastError() {
    runtimeState.lastError = "";
    renderRuntimeState();
  }

  function setLastRequestId(requestId) {
    const value = String(requestId || "").trim();
    if (value) {
      runtimeState.lastRequestId = value;
      renderRuntimeState();
    }
  }

  function updateRuntimeCounts(counts = {}) {
    runtimeState.counts = {
      analyzed: Number(counts.analyzed || 0),
      ready: Number(counts.ready || 0),
      done: Number(counts.done || 0),
      skip: Number(counts.skip || 0),
      failed: Number(counts.failed || 0),
    };
    renderRuntimeState();
  }

  function updatePendingHrQueueCount(queue) {
    runtimeState.pendingHrQueueCount = pendingHrReplyItems(queue || []).length;
    renderRuntimeState();
  }

  async function refreshPendingHrQueueCount() {
    const items = await storageGet([HR_REPLY_QUEUE_KEY]);
    updatePendingHrQueueCount(items[HR_REPLY_QUEUE_KEY]);
  }

  function renderRuntimeState() {
    const root = panel?.querySelector("#job-runtime-state");
    if (!root) return;
    const snapshot = runtimeSnapshot();
    setRuntimeText(root, "mode", snapshot.mode);
    setRuntimeText(root, "task", snapshot.task);
    setRuntimeText(root, "progress", snapshot.progress);
    setRuntimeText(root, "lastAction", snapshot.lastAction);
    setRuntimeText(root, "nextSuggestion", snapshot.nextSuggestion);
    setRuntimeText(root, "debug", snapshot.debug);

    const errorRow = root.querySelector("[data-runtime-row='lastError']");
    if (errorRow) errorRow.hidden = !snapshot.lastError;
    setRuntimeText(root, "lastError", snapshot.lastError);
  }

  function setRuntimeText(root, name, value) {
    const node = root.querySelector(`[data-runtime-field="${name}"]`);
    if (node) node.textContent = value || "";
  }

  function runtimeSnapshot() {
    return {
      mode: pageModeShortLabel(getBossPageMode()),
      task: currentTaskLabel(),
      progress: runtimeProgressText(),
      lastAction: runtimeState.lastAction || "等待操作",
      nextSuggestion: runtimeState.nextSuggestion || defaultNextSuggestion(),
      lastError: runtimeState.lastError || "",
      debug: runtimeDebugText(),
    };
  }

  function runtimeProgressText() {
    const counts = runtimeState.counts || {};
    return `已分析 ${counts.analyzed || 0} | 达标 ${counts.ready || 0} | 已沟通 ${counts.done || 0} | 跳过 ${counts.skip || 0} | 失败 ${counts.failed || 0}`;
  }

  function currentTaskLabel() {
    if (hrReplyProcessing || taskLock?.owner === "hr_reply") return "HR 回复处理";
    if (autoApplyInProgress) return "海投沟通";
    if (analyzing || scanningMore || autoApplyLoopRunning || taskLock?.owner === "auto_apply" || taskLock?.owner === "job_scan") {
      return "岗位扫描";
    }
    return "空闲";
  }

  function runtimeDebugText() {
    const lock = taskLockSnapshot();
    const messageDiagnostics = runtimeState.chatMessageDiagnostics || {};
    return [
      `taskLock owner: ${lock?.owner || "-"}`,
      `taskLock label: ${lock?.label || "-"}`,
      `autoApplyActive: ${peekAutoApplyActive()}`,
      `autoApplyLoopRunning: ${autoApplyLoopRunning}`,
      `autoApplyInProgress: ${autoApplyInProgress}`,
      `analyzing: ${analyzing}`,
      `scanningMore: ${scanningMore}`,
      `hrReplyProcessing: ${hrReplyProcessing}`,
      `debugHrReplyEnabled: ${debugHrReplyEnabled}`,
      `debugFlagLoadState: ${debugFlagLoadState}${debugFlagLoadAttempt ? ` (${debugFlagLoadAttempt}/${DEBUG_FLAG_READ_MAX_ATTEMPTS})` : ""}`,
      `pendingHrQueueCount: ${runtimeState.pendingHrQueueCount || 0}`,
      `hrDiscoveryCards: ${runtimeState.hrReplyDiscoveryDiagnostics?.cardCount || 0}`,
      `hrDiscoveryQueued: ${runtimeState.hrReplyDiscoveryDiagnostics?.queuedCount || 0}`,
      `hrDiscoveryRejected: ${runtimeState.hrReplyDiscoveryDiagnostics?.rejectedCount || 0}`,
      `hrDiscoveryRejectReasons: ${runtimeState.hrReplyDiscoveryDiagnostics?.rejectReasons || "-"}`,
      `hrDiscoveryUnreadSources: ${runtimeState.hrReplyDiscoveryDiagnostics?.unreadSources || "-"}`,
      `hrDiscoverySingleCardUnread: ${runtimeState.hrReplyDiscoveryDiagnostics?.singleCardUnreadCount || 0}`,
      `hrDiscoveryNumericUnreadMissingStableHint: ${runtimeState.hrReplyDiscoveryDiagnostics?.numericUnreadMissingStableHintCount || 0}`,
      `messageContainerCount: ${messageDiagnostics.messageContainerCount || 0}`,
      `visibleMessageContainerCount: ${messageDiagnostics.visibleMessageContainerCount || 0}`,
      `candidateMessageContainerCount: ${messageDiagnostics.candidateMessageContainerCount || 0}`,
      `selectedMessageContainerIndex: ${messageDiagnostics.selectedMessageContainerIndex ?? -1}`,
      `selectedMessageContainerTextCount: ${messageDiagnostics.selectedMessageContainerTextCount || 0}`,
      `selectedMessageContainerReason: ${messageDiagnostics.selectedMessageContainerReason || "-"}`,
      `messageNodeCount: ${messageDiagnostics.messageNodeCount || 0}`,
      `hrMessageCount: ${messageDiagnostics.hrMessageCount || 0}`,
      `myMessageCount: ${messageDiagnostics.myMessageCount || 0}`,
      `textMessageCount: ${messageDiagnostics.textMessageCount || 0}`,
      `tailMessageRoles: ${messageDiagnostics.tailMessageRoles || "-"}`,
      `latestMessageRole: ${messageDiagnostics.latestMessageRole || "-"}`,
      `lastError: ${runtimeState.lastError || "-"}`,
      `lastRequestId: ${runtimeState.lastRequestId || "-"}`,
    ].join("\n");
  }

  function defaultNextSuggestion() {
    const mode = getBossPageMode();
    if (mode === "job") return peekAutoApplyActive() ? "等待本轮扫描完成，或手动暂停。" : "可以启动海投，或点击继续扫描。";
    if (mode === "message") return "点击检查 HR 回复，或选择会话后处理当前会话。";
    if (mode === "chat") return "确认当前会话后，可处理回复或只检查待回复队列。";
    return "打开 BOSS 岗位页或消息页后再使用插件。";
  }

  function runtimeStateHtml() {
    return `<div class="runtime-state" id="job-runtime-state">
  <div class="runtime-grid">
    <div><span>页面</span><strong data-runtime-field="mode"></strong></div>
    <div><span>任务</span><strong data-runtime-field="task"></strong></div>
  </div>
  <div class="runtime-line" data-runtime-field="progress"></div>
  <div class="runtime-line">最近：<span data-runtime-field="lastAction"></span></div>
  <div class="runtime-line">建议：<span data-runtime-field="nextSuggestion"></span></div>
  <div class="runtime-error" data-runtime-row="lastError" hidden>错误：<span data-runtime-field="lastError"></span></div>
  <details class="runtime-debug">
    <summary>开发调试状态</summary>
    <pre data-runtime-field="debug"></pre>
  </details>
</div>`;
  }

  function runtimeStateStyles(theme = "dark") {
    const light = theme === "light";
    const bg = light ? "#fff" : "#202636";
    const border = light ? "#d6efdc" : "#384255";
    const textColor = light ? "#40534a" : "#c5ccda";
    const muted = light ? "#6b7b72" : "#aeb6c8";
    const accent = light ? "#17944f" : "#8fb8ff";
    const error = light ? "#b6482f" : "#ff9a94";
    return `
#job-accelerator-panel .runtime-state{background:${bg};border:1px solid ${border};border-radius:8px;padding:10px;margin:0 0 12px;color:${textColor};font-size:12px;line-height:1.45}
#job-accelerator-panel .runtime-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}
#job-accelerator-panel .runtime-grid span{display:block;color:${muted};font-size:10px;margin-bottom:2px}
#job-accelerator-panel .runtime-grid strong{font-size:12px;color:${accent};font-weight:700}
#job-accelerator-panel .runtime-line{color:${textColor};margin-top:3px}
#job-accelerator-panel .runtime-error{color:${error};margin-top:4px}
#job-accelerator-panel .runtime-debug{margin-top:6px;border-top:1px solid ${border};padding-top:6px}
#job-accelerator-panel .runtime-debug summary{cursor:pointer;color:${accent};font-size:11px}
#job-accelerator-panel .runtime-debug pre{white-space:pre-wrap;font-size:11px;line-height:1.45;color:${muted};margin:6px 0 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`;
  }

  function acquireTaskLock(owner, options = {}) {
    const priority = taskPriority(owner);
    const now = Date.now();
    clearStaleTaskLock(now);
    if (!taskLock) {
      const token = makeTaskToken(owner);
      taskLock = {
        owner,
        token,
        priority,
        label: options.label || taskLabel(owner),
        acquiredAt: now,
      };
      renderRuntimeState();
      return { ok: true, owner, token };
    }
    if (taskLock.owner === owner && owner === "hr_reply") {
      return { ok: false, current: taskLock };
    }
    if (taskLock.owner === owner) {
      return { ok: true, owner, token: taskLock.token, reentrant: true };
    }
    if (options.preempt && priority > taskLock.priority) {
      const preempted = taskLock;
      const token = makeTaskToken(owner);
      taskLock = {
        owner,
        token,
        priority,
        label: options.label || taskLabel(owner),
        acquiredAt: now,
      };
      renderRuntimeState();
      return { ok: true, owner, token, preempted };
    }
    return { ok: false, current: taskLock };
  }

  function clearStaleTaskLock(now = Date.now()) {
    if (
      !taskLock
      || taskLockOwnerIsActive(taskLock.owner)
      || now - Number(taskLock.acquiredAt || 0) <= TASK_LOCK_STALE_MS
    ) return false;
    taskLock = null;
    renderRuntimeState();
    return true;
  }

  function taskLockOwnerIsActive(owner) {
    if (owner === "hr_reply") return hrReplyProcessing;
    if (owner === "auto_apply") {
      return autoApplyLoopRunning || autoApplyInProgress || analyzing || scanningMore;
    }
    if (owner === "job_scan") return analyzing || scanningMore;
    return false;
  }

  function releaseTaskLock(lock) {
    if (!lock?.ok || lock.reentrant) return;
    if (taskLock?.token === lock.token) taskLock = null;
    renderRuntimeState();
  }

  function taskLockAllows(owner) {
    return !taskLock || taskLock.owner === owner;
  }

  function taskPriority(owner) {
    if (owner === "manual") return 3;
    if (owner === "hr_reply") return 2;
    return 1;
  }

  function taskLabel(owner) {
    return {
      manual: "用户手动操作",
      hr_reply: "HR 回复处理",
      auto_apply: "海投扫描",
      job_scan: "岗位扫描",
    }[owner] || "页面任务";
  }

  function makeTaskToken(owner) {
    return `${owner}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function taskLockSnapshot() {
    return taskLock
      ? {
        owner: taskLock.owner,
        label: taskLock.label,
        acquiredAt: taskLock.acquiredAt,
      }
      : null;
  }

  function peekAutoApplyActive() {
    if (autoApplyArmed) return true;
    try {
      const raw = sessionStorage.getItem(AUTO_APPLY_KEY);
      if (!raw) return false;
      if (raw === "1") return true;
      const data = JSON.parse(raw);
      return Number(data?.expiresAt || 0) > Date.now();
    } catch (_) {
      return false;
    }
  }

  function sessionJobList() {
    return Array.from(sessionJobs.values());
  }

  function mergeSessionJobs(jobs) {
    const added = [];
    jobs.forEach((job) => {
      const key = cacheKeyFor(job);
      const existing = sessionJobs.get(key);
      if (existing) {
        sessionJobs.set(key, mergeJobSnapshot(existing, job));
        return;
      }
      sessionJobs.set(key, job);
      added.push(job);
    });
    saveSessionJobs();
    return added;
  }

  function mergeJobSnapshot(existing, fresh) {
    return {
      ...fresh,
      ...existing,
      listIndex: fresh.listIndex,
      url: fresh.url || existing.url,
      jd_text: existing.detailLoaded ? existing.jd_text : fresh.jd_text || existing.jd_text,
      detailSource: existing.detailLoaded ? existing.detailSource : fresh.detailSource || existing.detailSource,
    };
  }

  function loadSessionJobs() {
    try {
      const raw = sessionStorage.getItem(SESSION_JOBS_KEY);
      if (!raw) return new Map();
      const data = JSON.parse(raw);
      if (data?.version !== SESSION_JOBS_VERSION) {
        sessionStorage.removeItem(SESSION_JOBS_KEY);
        return new Map();
      }
      const sameSearch = data?.signature === searchSignature();
      const fresh = Date.now() - Number(data?.savedAt || 0) < SESSION_JOBS_TTL_MS;
      if (!sameSearch || !fresh || !Array.isArray(data.jobs)) return new Map();
      return new Map(data.jobs.map((job) => [cacheKeyFor(job), job]));
    } catch (_) {
      return new Map();
    }
  }

  function saveSessionJobs() {
    try {
      const jobs = sessionJobList().slice(-JOB_SCAN_LIMIT);
      sessionStorage.setItem(SESSION_JOBS_KEY, JSON.stringify({
        version: SESSION_JOBS_VERSION,
        signature: searchSignature(),
        savedAt: Date.now(),
        jobs,
      }));
    } catch (_) {}
  }

  function clearSessionJobs() {
    try {
      sessionStorage.removeItem(SESSION_JOBS_KEY);
    } catch (_) {}
    sessionJobs = new Map();
    latestJobs = [];
    renderedJobs.clear();
    scanSummary = emptyScanSummary();
    if (!panel) return;
    renderScanSummary("已清空本页会话结果。");
    const results = panel.querySelector("#job-accelerator-results");
    if (results) results.innerHTML = '<div class="empty">已清空本页会话结果，重新打开面板可重新分析</div>';
    refreshStats([]);
  }

  function searchSignature() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("page");
      return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
    } catch (_) {
      return location.href;
    }
  }

  function findJobListScroller() {
    const cards = Array.from(document.querySelectorAll(JOB_CARD_SELECTOR));
    const candidates = [];
    cards.forEach((card) => {
      let node = card.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const canScroll = node.scrollHeight > node.clientHeight + 80;
        if (canScroll && /auto|scroll|overlay/.test(style.overflowY)) candidates.push(node);
        node = node.parentElement;
      }
    });

    const unique = uniqueElements(candidates);
    unique.sort((a, b) => countCardsInside(b) - countCardsInside(a) || scrollRoom(b) - scrollRoom(a));
    if (unique[0]) return unique[0];

    const pageScroller = document.scrollingElement || document.documentElement;
    return pageScroller && pageScroller.scrollHeight > pageScroller.clientHeight + 80 ? pageScroller : null;
  }

  async function scrollJobListOneScreen() {
    const scroller = findJobListScroller();
    if (!scroller) return false;
    const maxScrollTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const beforeTop = scroller.scrollTop;
    if (beforeTop >= maxScrollTop() - 5) return false;
    const distance = Math.max(scroller.clientHeight * 0.85, 520);
    const stepDistance = distance / SEARCH_SCROLL_STEPS;
    scanSummary.scrolled = true;
    renderScanSummary("正在慢速下滑加载下一批...");
    for (let step = 0; step < SEARCH_SCROLL_STEPS; step += 1) {
      scroller.scrollTop = Math.min(scroller.scrollTop + stepDistance, maxScrollTop());
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(SEARCH_SCROLL_STEP_MS);
    }
    await sleep(SEARCH_SCROLL_SETTLE_MS);
    scanSummary.loadedAfter = document.querySelectorAll(JOB_CARD_SELECTOR).length;
    return scroller.scrollTop > beforeTop + 2 || scroller.scrollHeight > beforeTop + scroller.clientHeight + 5;
  }

  async function startAutoApplyFromMessage(applyMode) {
    if (!isBossSearchPage()) throw new Error("当前不是 BOSS 岗位搜索页");
    clearLastError();
    setLastAction(`准备启动${applyModeTitle(applyMode)}`, "等待海投扫描当前页面。");
    activeApplyMode = normalizeApplyMode(applyMode);
    activeAutoConfirmChat = true;
    await storageSet({
      apply_mode: activeApplyMode,
      auto_confirm_chat: true,
    });

    if (!panel) {
      await show();
    } else if (panelMode !== "jobs") {
      hide();
      await show();
    }

    const autoConfirmInput = document.getElementById("job-accelerator-auto-confirm");
    if (autoConfirmInput) autoConfirmInput.checked = true;
    updatePanelMode();
    enableAutoApplyTask();
    await saveJobPanelControls();
    runAutoApplyLoop(`${applyModeTitle(activeApplyMode)}：扫描当前可见岗位。`).catch((error) => {
      disableAutoApplyTask();
      setLastError(error);
      renderScanSummary(`自动海投启动后中断：${error?.message || "未知错误"}`);
      setContinueButtonBusy(false);
    });
    return { ok: true, applyMode: activeApplyMode };
  }

  function countCardsInside(node) {
    return node.querySelectorAll?.(JOB_CARD_SELECTOR).length || 0;
  }

  function scrollRoom(node) {
    return Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0));
  }

  async function buildScanSummary(resumeKey, visibleCount = 0, addedCount = 0, applyMode = activeApplyMode) {
    const jobs = sessionJobList();
    const keys = jobs.map((job) => cacheKeyFor(job));
    const items = keys.length ? await storageGet(keys) : {};
    let cached = 0;
    jobs.forEach((job) => {
      const value = items[cacheKeyFor(job)];
      if (value && cacheIsUsable(value, resumeKey, applyMode)) cached += 1;
    });
    return {
      ...scanSummary,
      visible: visibleCount,
      total: jobs.length,
      added: addedCount,
      cached,
      fresh: Math.max(0, jobs.length - cached),
    };
  }

  function renderScanSummary(prefix = "") {
    if (prefix) setLastAction(prefix, runtimeState.lastError ? runtimeState.nextSuggestion : defaultNextSuggestion());
    const node = panel?.querySelector("#job-accelerator-scan-summary");
    if (!node) return;
    const visible = scanSummary.visible || document.querySelectorAll(JOB_CARD_SELECTOR).length;
    const textValue = `页面可见 ${visible} 个 | 已收集 ${scanSummary.total} 个 | 本次新增 ${scanSummary.added} 个 | 缓存可用 ${scanSummary.cached} | 待分析 ${scanSummary.fresh}`;
    node.textContent = `${prefix ? `${prefix} ` : ""}${textValue}`;
  }

  async function refreshVisibleJobs(prefix = "扫描当前可见岗位。", options = {}) {
    if (analyzing) {
      renderScanSummary("正在分析中，暂不加入新岗位。");
      return 0;
    }
    const cfg = await storageGet([
      "exclude_keywords",
      "resume_text",
      "min_score",
      "daily_goal",
      "apply_title_keywords",
      "apply_location_keywords",
      "apply_mode",
    ]);
    activeMinScore = normalizeMinScore(cfg.min_score);
    activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
    activeApplyMode = normalizeApplyMode(cfg.apply_mode);
    activeTitleKeywords = parseFilterKeywords(cfg.apply_title_keywords);
    activeLocationKeywords = parseFilterKeywords(cfg.apply_location_keywords);
    const resumeKey = String(cfg.resume_text || "") ? simpleHash(String(cfg.resume_text || "")) : "";
    const jobs = extractJobs(scanFiltersFromConfig(cfg));
    const newJobs = mergeSessionJobs(jobs);
    const unfinishedJobs = jobs
      .map((job) => sessionJobs.get(cacheKeyFor(job)) || job)
      .filter((job) => !job.match && (!job.error || job.retryable));
    const jobsToAnalyze = uniqueJobs([...newJobs, ...unfinishedJobs]);
    scanSummary = await buildScanSummary(resumeKey, jobs.length, newJobs.length);
    renderScanSummary(prefix);

    const results = panel?.querySelector("#job-accelerator-results");
    if (results && !sessionJobs.size) {
      results.innerHTML = '<div class="empty">未检测到岗位</div>';
    }
    refreshStats(sessionJobList());

    if (jobsToAnalyze.length) {
      await analyze(jobsToAnalyze, { autoApply: Boolean(options.autoApply || isAutoApplyTaskActive()) });
      return jobsToAnalyze.length;
    }
    render(sessionJobList());
    return 0;
  }

  function extractJobs(filters = {}) {
    const normalizedFilters = Array.isArray(filters)
      ? { excludeKeywords: filters }
      : {
        excludeKeywords: filters.excludeKeywords || [],
        titleKeywords: filters.titleKeywords || activeTitleKeywords,
        locationKeywords: filters.locationKeywords || activeLocationKeywords,
      };
    const isDetailPage = location.href.includes("/job_detail/");
    const isSearchPage = location.href.includes("geek/jobs");
    if (isDetailPage || !isSearchPage) {
      const detail = extractDetailJob();
      if (detail) return [detail];
    }

    const jobs = [];
    document.querySelectorAll(JOB_CARD_SELECTOR).forEach((card, listIndex) => {
      if (jobs.length >= JOB_SCAN_LIMIT) return;
      const cardText = inlineText(card);
      if (matchesExcludeKeyword(cardText, normalizedFilters.excludeKeywords)) return;
      const activeDays = extractHrActiveDays(card);
      if (activeDays !== null && activeDays > 7) return;

      const title = text(card, ".job-name") || text(card, ".job-title");
      const company = text(card, ".boss-name") || text(card, ".company-name");
      const salary = text(card, ".job-salary") || text(card, ".salary") || "未标注";
      const tags = Array.from(card.querySelectorAll(".tag-list li,.job-card-footer li"))
        .map((item) => inlineText(item))
        .filter(Boolean);
      const locationText = extractLocation(card);
      if (!matchesIncludeKeyword(`${title} ${tags.join(" ")} ${cardText}`, normalizedFilters.titleKeywords)) return;
      if (!matchesIncludeKeyword(`${locationText} ${cardText}`, normalizedFilters.locationKeywords)) return;
      const jobUrl = extractJobUrl(card);
      const detailText = extractDomJdText(card);
      const job = {
        title,
        company,
        salary,
        location: locationText,
        tags,
        url: jobUrl,
        listIndex,
        detailSource: detailText ? "card" : "",
      };
      const jdText = buildJdText(job, detailText);
      if (title && company) jobs.push({ ...job, jd_text: jdText });
    });
    return jobs;
  }

  function extractDetailJob() {
    const jd = extractDomJdText(document);
    if (jd.length < 40) return null;
    const title = text(document, ".job-name") || text(document, "h1") || "当前岗位";
    const company = text(document, ".boss-name") || text(document, ".company-name") || "未知公司";
    const salary = text(document, ".job-salary") || text(document, ".salary") || "未标注";
    const locationText = text(document, ".job-area-wrapper") || text(document, ".job-area") || "";
    const tags = Array.from(document.querySelectorAll(".tag-list li,.job-keyword-list li,.job-tags span"))
      .map((item) => inlineText(item))
      .filter(Boolean);
    const job = {
      title,
      company,
      salary,
      location: locationText,
      tags,
      url: location.href,
      listIndex: -1,
      detailSource: "detail_page",
    };
    return {
      ...job,
      jd_text: buildJdText(job, jd),
    };
  }

  async function analyze(jobs, options = {}) {
    const container = panel?.querySelector("#job-accelerator-results");
    if (!container) return;
    if (!jobs.length) {
      if (sessionJobs.size) render(sessionJobList());
      else container.innerHTML = '<div class="empty">未检测到岗位卡片或 JD 详情</div>';
      return;
    }
    if (analyzing) return;
    const lockOwner = Boolean(options.autoApply || isAutoApplyTaskActive()) ? "auto_apply" : "job_scan";
    const lock = acquireTaskLock(lockOwner, { label: lockOwner === "auto_apply" ? "海投扫描" : "岗位扫描" });
    if (!lock.ok) {
      renderScanSummary(`当前正在${lock.current?.label || "执行其他页面任务"}，暂不扫描岗位。`);
      return;
    }
    analyzing = true;
    setContinueButtonBusy(true);
    const runId = analysisRunId;
    let resumeKeyForSummary = "";

    try {
      const cfg = await storageGet(["apiUrl", "resume_text", "min_score", "daily_goal", "apply_mode"]);
      const api = resolveApiUrl(cfg.apiUrl);
      const resumeText = String(cfg.resume_text || "");
      const resumeKey = resumeText ? simpleHash(resumeText) : "";
      resumeKeyForSummary = resumeKey;
      activeMinScore = normalizeMinScore(cfg.min_score);
      activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
      activeApplyMode = normalizeApplyMode(cfg.apply_mode);
      const autoApplyForRun = Boolean(options.autoApply || isAutoApplyTaskActive());
      jobs.forEach((job) => sessionJobs.set(cacheKeyFor(job), mergeJobSnapshot(sessionJobs.get(cacheKeyFor(job)) || {}, job)));
      saveSessionJobs();
      let scannedInBatch = 0;
      let batchStartIndex = 0;

      const analyzeOne = async (job, cachedEntry = null) => {
        const cacheKey = cacheKeyFor(job);
        const usableCachedEntry = cachedEntry || await getUsableCachedEntry(job, resumeKey, activeApplyMode);
        if (usableCachedEntry) {
          const entry = normalizeCacheEntry(usableCachedEntry, job);
          return { ...job, ...entry.job, match: entry.match, cached: true };
        }

        try {
          const data = await requestMatch(api, { jd_text: job.jd_text, resume_text: resumeText, mode: activeApplyMode });
          clearLastError();
          await storageSet({ [cacheKey]: makeCacheEntry(job, data, resumeKey, activeApplyMode) });
          pruneMatchCache().catch(() => {});
          return { ...job, match: data };
        } catch (error) {
          const formatted = formatAnalyzeError(error, api);
          setLastError(formatted);
          return { ...job, error: formatted, retryable: isRetryableAnalyzeError(error) };
        }
      };

      for (let index = 0; index < jobs.length; index += 1) {
        if (runId !== analysisRunId || !panel) return;
        await waitIfPaused();
        let job = jobs[index];
        let cachedEntry = await getUsableCachedEntry(job, resumeKey, activeApplyMode);
        if (cachedEntry) {
          updateScanProgress(index + 1, jobs.length, job, "命中缓存，准备判断是否沟通");
        } else if (isBossSearchPage()) {
          if (!sourceCardForJob(job)) {
            updateScanProgress(index + 1, jobs.length, job, "左侧岗位已变化，跳过当前轮");
            continue;
          }

          if (scannedInBatch >= DETAIL_SCAN_BATCH_LIMIT) {
            await pauseScanBatch(index, jobs.length);
            scannedInBatch = 0;
            batchStartIndex = index;
            await waitIfPaused();
          }

          const batchTotal = Math.min(DETAIL_SCAN_BATCH_LIMIT, jobs.length - batchStartIndex);
          updateScanProgress(index + 1, jobs.length, job, "读取 JD 并匹配", scannedInBatch + 1, batchTotal);
          const detailText = await readRightDetailForJob(job);
          scannedInBatch += 1;
          job = detailText
            ? { ...job, jd_text: buildJdText(job, detailText), detailLoaded: true, detailSource: "detail" }
            : { ...job, detailLoaded: false, detailSource: "summary" };
          sessionJobs.set(cacheKeyFor(job), mergeJobSnapshot(sessionJobs.get(cacheKeyFor(job)) || {}, job));
          saveSessionJobs();
        }

        if (runId !== analysisRunId || !panel) return;
        const result = await analyzeOne(job, cachedEntry);
        if (runId !== analysisRunId || !panel) return;
        sessionJobs.set(cacheKeyFor(job), result);
        saveSessionJobs();
        render(sessionJobList());
        const autoChatted = await maybeAutoChatAnalyzedJob(result, { force: autoApplyForRun });
        if (!autoChatted && !cachedEntry && isBossSearchPage()) {
          await sleep(DETAIL_SCAN_COOLDOWN_MS);
        }
      }
    } finally {
      if (runId === analysisRunId) {
        scanSummary = await buildScanSummary(resumeKeyForSummary, scanSummary.visible, 0);
        renderScanSummary("本批分析完成。");
        analyzing = false;
        setContinueButtonBusy(false);
      }
      releaseTaskLock(lock);
    }
  }

  async function pauseScanBatch(index, total) {
    setPaused(true);
    const container = panel?.querySelector("#job-accelerator-results");
    if (container) {
      container.innerHTML = `<div class="loading">已读取本批上限 ${DETAIL_SCAN_BATCH_LIMIT} 个右侧 JD，本次处理 ${index}/${total}。<br>自动暂停保护页面，稍等几秒后点击“继续”扫描下一批。</div>`;
    }
  }

  function updateScanProgress(current, total, job, action, batchCurrent = 0, batchTotal = 0) {
    setLastAction(`${action}：${job.title || "当前岗位"} · ${job.company || ""}`, "等待当前步骤完成。");
    const container = panel?.querySelector("#job-accelerator-results");
    if (!container) return;
    const parts = [];
    if (batchTotal) parts.push(`当前批次 ${Math.min(batchCurrent, batchTotal)}/${batchTotal}`);
    parts.push(`本次处理 ${current}/${total}`);
    container.innerHTML = `<div class="loading">${esc(action)}<br>${esc(parts.join(" · "))}<br>${esc(job.title || "")} · ${esc(job.company || "")}</div>`;
  }

  async function readRightDetailForJob(job) {
    const card = sourceCardForJob(job);
    if (!card) return "";
    const before = detailSignature();
    selectJobCard(card);
    return waitForDetailText(before, job);
  }

  function sourceCardForJob(job) {
    const cards = Array.from(document.querySelectorAll(JOB_CARD_SELECTOR));
    const index = Number(job.listIndex);
    const indexed = Number.isInteger(index) && index >= 0 ? cards[index] : null;
    if (indexed && cardMatchesJob(indexed, job)) return indexed;
    return cards.find((card) => cardMatchesJob(card, job)) || null;
  }

  function selectJobCard(card) {
    card.scrollIntoView({ block: "center", inline: "nearest" });
    const target = card.querySelector(".job-name,.job-title") || card;
    clickElement(target);
  }

  async function waitForDetailText(beforeSignature, job) {
    const deadline = Date.now() + DETAIL_SCAN_TIMEOUT_MS;
    let latest = "";
    while (Date.now() < deadline) {
      latest = extractDomJdText(document);
      const detailText = selectedDetailPanelText();
      const changed = detailSignature(latest) !== beforeSignature;
      if (latest.length >= 40 && (changed || detailMatchesJob(job, detailText))) {
        return latest;
      }
      await sleep(DETAIL_SCAN_INTERVAL_MS);
    }
    latest = extractDomJdText(document);
    const detailText = selectedDetailPanelText();
    const changed = detailSignature(latest) !== beforeSignature;
    return latest.length >= 40 && (changed || detailMatchesJob(job, detailText)) ? latest : "";
  }

  function selectedDetailPanelText() {
    const root = findDetailRoot();
    return root ? inlineText(root) : "";
  }

  function findDetailRoot() {
    const selectors = [
      ...DETAIL_TEXT_SELECTORS,
      "[class*='job-detail']",
      "[class*='detail-content']",
      "[class*='detail-box']",
    ];
    const candidates = uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
      .filter(isVisible)
      .map((node) => ({ node, value: inlineText(node) }))
      .filter((item) => item.value.length >= 40)
      .sort((a, b) => {
        const aReady = DETAIL_READY_RE.test(a.value) ? 1 : 0;
        const bReady = DETAIL_READY_RE.test(b.value) ? 1 : 0;
        return bReady - aReady || b.value.length - a.value.length;
      });
    return candidates[0]?.node || null;
  }

  function detailMatchesJob(job, detailText) {
    const detail = compactForMatch(detailText);
    const title = compactForMatch(job.title).slice(0, 8);
    const company = compactForMatch(job.company).slice(0, 8);
    return Boolean((title && detail.includes(title)) || (company && detail.includes(company)));
  }

  function cardMatchesJob(card, job) {
    const cardUrl = extractJobUrl(card);
    if (job.url && cardUrl && cardUrl === job.url) return true;
    const cardText = compactForMatch(inlineText(card));
    const title = compactForMatch(job.title).slice(0, 8);
    const company = compactForMatch(job.company).slice(0, 8);
    return Boolean(title && company && cardText.includes(title) && cardText.includes(company));
  }

  function detailSignature(detailText = extractDomJdText(document)) {
    return simpleHash(String(detailText || "").slice(0, 800));
  }

  async function getUsableCachedEntry(job, resumeKey, applyMode = activeApplyMode) {
    const cacheKey = cacheKeyFor(job);
    const cached = await storageGet(cacheKey);
    return cached[cacheKey] && cacheIsUsable(cached[cacheKey], resumeKey, applyMode) ? cached[cacheKey] : null;
  }

  function isBossSearchPage() {
    return location.href.includes("geek/jobs") && !location.href.includes("/job_detail/");
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function compactForMatch(value) {
    return String(value || "").replace(/\s|…|\.\.\.|（.*?）|\(.*?\)/g, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function render(jobs) {
    const container = panel?.querySelector("#job-accelerator-results");
    if (!container) return;
    latestJobs = jobs;
    const sorted = sortJobsForDisplay(jobs);
    const visibleJobs = sorted.filter((job) => !shouldHideLowMatch(job));
    renderedJobs.clear();
    sorted.forEach((job) => renderedJobs.set(cacheKeyFor(job), job));
    container.innerHTML = visibleJobs.length
      ? visibleJobs.map((job) => cardHtml(job)).join("")
      : '<div class="empty">本页未达标岗位已隐藏</div>';
    bindCards();
    refreshStats(sorted);
  }

  function sortJobsForDisplay(jobs) {
    return [...jobs].sort((a, b) => {
      const aStatus = statusName(statuses[statusKeyFor(a)] || "");
      const bStatus = statusName(statuses[statusKeyFor(b)] || "");
      const aSkipped = aStatus === "skip" ? 1 : 0;
      const bSkipped = bStatus === "skip" ? 1 : 0;
      if (aSkipped !== bSkipped) return aSkipped - bSkipped;
      const aActionable = isJobCurrentlyActionable(a) ? 1 : 0;
      const bActionable = isJobCurrentlyActionable(b) ? 1 : 0;
      if (aActionable !== bActionable) return bActionable - aActionable;
      const aReady = scoreOf(a) >= activeMinScore ? 1 : 0;
      const bReady = scoreOf(b) >= activeMinScore ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      return scoreOf(b) - scoreOf(a);
    });
  }

  function shouldHideLowMatch(job) {
    return hideLowMatches && job.match && !job.error && scoreOf(job) < activeMinScore;
  }

  function cardHtml(job) {
    const statusKey = statusKeyFor(job);
    const cacheKey = cacheKeyFor(job);
    const dataAttrs = `data-list-index="${esc(job.listIndex ?? "")}" data-url="${esc(job.url || "")}" data-key="${esc(statusKey)}" data-cache-key="${esc(cacheKey)}"`;
    if (job.error) {
      return `<div class="card low" ${dataAttrs}>
        <div class="title">请求失败 | ${esc(job.title)}</div>
        <div class="meta">${esc(job.error)}</div>
        <div class="chat-info">${esc(analyzeErrorHint(job))}</div>
      </div>`;
    }
    const match = job.match || {};
    const score = scoreOf(job);
    const level = score >= 75 ? "high" : score >= 50 ? "mid" : "low";
    const status = statusName(statuses[statusKey] || "");
    const opacity = status === "skip" ? "opacity:.45;" : "";
    const handled = status === "done" || status === "skip";
    const doneLabel = status === "done" ? "已沟通" : "标记沟通";
    const skipLabel = status === "skip" ? "已跳过" : "跳过";
    const saveLabel = status === "save" ? "已收藏" : "收藏";
    const matched = (match.matched_skills || []).slice(0, 4);
    const missing = (match.missing_skills || []).slice(0, 3);
    const opening = String(match.opening_message || "").trim();
    const actionable = isJobCurrentlyActionable(job);
    const canChat = score >= activeMinScore && actionable && !handled;
    const sourceLabel = jdSourceLabel(job);

    return `<div class="card ${level}" ${dataAttrs} style="${opacity}">
      <div class="title">${score}% | ${esc(match.role || job.title)}</div>
      <div class="meta">${esc(job.company)} | ${esc(job.salary)} ${job.cached ? "| 已缓存" : ""} ${sourceLabel ? `| ${sourceLabel}` : ""}</div>
      <div class="risk">风险：${esc(match.risk_level || "待分析")}</div>
      ${matched.length ? `<div>${matched.map((item) => `<span class="badge good">${esc(item.skill)} · ${esc(item.level)}</span>`).join("")}</div>` : ""}
      ${missing.length ? `<div>${missing.map((item) => `<span class="badge warn">${esc(item.skill)}</span>`).join("")}</div>` : ""}
      ${opening ? `<div class="opening">📩 ${esc(opening)}</div>` : ""}
      ${score >= activeMinScore && !actionable ? '<div class="chat-info">当前左侧列表已找不到这个岗位，可能已沟通后被 BOSS 移走；继续扫描会处理新补位岗位。</div>' : ""}
      <div class="actions">
        ${canChat ? '<button data-chat="1">沟通</button>' : ""}
        <button data-act="done" class="${status === "done" ? "on" : ""}">${doneLabel}</button>
        <button data-act="skip" class="${status === "skip" ? "on" : ""}">${skipLabel}</button>
        <button data-act="save" class="${status === "save" ? "on" : ""}">${saveLabel}</button>
      </div>
    </div>`;
  }

  function jdSourceLabel(job) {
    if (job.detailSource === "detail_page") return "详情页JD";
    if (job.detailSource === "detail") return "深读JD";
    if (job.detailSource === "summary") return "摘要JD";
    if (job.detailSource === "card") return "卡片JD";
    return "";
  }

  function shellHtml(_count, loadingText = "正在分析...") {
    return `<style>
#job-accelerator-panel{position:fixed;top:0;right:0;width:390px;height:100vh;background:#151820;color:#e6e8ee;z-index:999999;box-shadow:-4px 0 24px #0008;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:18px}
#job-accelerator-panel h3{margin:0 0 12px;font-size:16px;color:#fff}
${runtimeStateStyles("dark")}
#job-accelerator-panel .close{position:absolute;top:12px;right:14px;background:transparent;border:0;color:#b8c0d4;font-size:20px;cursor:pointer}
#job-accelerator-panel .control-box{background:#202636;border:1px solid #384255;border-radius:8px;padding:12px;margin-bottom:12px}
#job-accelerator-panel .single-control{margin-bottom:10px}
#job-accelerator-panel .control-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
#job-accelerator-panel label{display:block;font-size:11px;color:#aeb6c8;margin-bottom:5px}
#job-accelerator-panel input,#job-accelerator-panel select{width:100%;padding:7px 8px;font-size:12px;background:#151820;border:1px solid #384255;border-radius:6px;color:#e6e8ee}
#job-accelerator-panel input[type="range"]{padding:0;accent-color:#2f80ed}
#job-accelerator-panel .primary-action{width:100%;padding:9px 10px;border:0;border-radius:7px;background:#2f80ed;color:#fff;font-size:13px;font-weight:700;cursor:pointer}
#job-accelerator-panel .primary-action:disabled{opacity:.45;cursor:not-allowed}
#job-accelerator-panel .mode-note{font-size:11px;line-height:1.45;color:#8fb8ff;margin-top:8px}
#job-accelerator-panel .mode-summary{font-size:12px;line-height:1.45;color:#d8deea;background:#151820;border:1px solid #384255;border-radius:7px;padding:8px 10px;margin:8px 0}
#job-accelerator-panel .mode-summary strong{color:#8fb8ff}
#job-accelerator-panel .advanced-filter{margin-top:10px;border-top:1px solid #384255;padding-top:9px}
#job-accelerator-panel .advanced-filter summary{font-size:12px;color:#d8deea;cursor:pointer}
#job-accelerator-panel .advanced-body{margin-top:9px}
#job-accelerator-panel .score-line{display:flex;align-items:center;justify-content:space-between;gap:8px}
#job-accelerator-panel .check-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.45;color:#c5ccda;margin-top:10px}
#job-accelerator-panel .check-row input{width:auto;margin-top:2px}
#job-accelerator-panel .check-row small{display:block;color:#8fb8ff;margin-top:2px}
#job-accelerator-panel .pager{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
#job-accelerator-panel .pager button{padding:6px 10px;font-size:12px;background:#202636;border:1px solid #384255;color:#d8deea;border-radius:6px;cursor:pointer}
#job-accelerator-panel .pager button:disabled{opacity:.35;cursor:not-allowed}
#job-accelerator-panel .pager button.danger{border-color:#6b3f47;color:#ffb3bb}
#job-accelerator-panel .pager span{font-size:12px;color:#aeb6c8}
#job-accelerator-panel .stats{font-size:12px;line-height:1.55;color:#c5ccda;background:#202636;border:1px solid #384255;border-radius:7px;padding:8px 10px;margin-bottom:12px}
#job-accelerator-panel .scan-summary{font-size:11px;line-height:1.45;color:#8fb8ff;margin:-4px 0 12px}
#job-accelerator-panel .card{background:#202636;padding:12px;margin:10px 0;border-radius:8px;border-left:4px solid #e5534b;cursor:pointer}
#job-accelerator-panel .card.high{border-left-color:#25b47e}
#job-accelerator-panel .card.mid{border-left-color:#e6b84a}
#job-accelerator-panel .card:hover{background:#283145}
#job-accelerator-panel .title{font-size:14px;font-weight:700;margin-bottom:5px;color:#fff}
#job-accelerator-panel .meta,#job-accelerator-panel .risk{font-size:11px;color:#aeb6c8;margin:4px 0}
#job-accelerator-panel .badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;margin:3px 3px 0 0}
#job-accelerator-panel .good{background:#25b47e22;color:#7ce0b0}
#job-accelerator-panel .warn{background:#e5534b22;color:#ff9a94}
#job-accelerator-panel .questions{font-size:11px;line-height:1.45;color:#c5ccda;margin-top:7px}
#job-accelerator-panel .opening{font-size:11px;line-height:1.5;color:#66d9ef;margin-top:8px}
#job-accelerator-panel .chat-error{font-size:11px;line-height:1.45;color:#ff9a94;margin-top:7px}
#job-accelerator-panel .chat-info{font-size:11px;line-height:1.45;color:#8fb8ff;margin-top:7px}
#job-accelerator-panel .actions{display:flex;gap:6px;margin-top:8px}
#job-accelerator-panel .actions button{font-size:11px;padding:4px 8px;border:1px solid #48536a;border-radius:5px;background:transparent;color:#c5ccda;cursor:pointer}
#job-accelerator-panel .actions button:disabled{opacity:.55;cursor:wait}
#job-accelerator-panel .actions button.on{background:#2f80ed33;border-color:#2f80ed}
#job-accelerator-panel .footer{position:sticky;bottom:0;background:#151820;padding:10px 0 0;margin-top:12px}
#job-accelerator-panel .export{width:100%;padding:9px 10px;font-size:13px;font-weight:700;background:#2f80ed;border:0;border-radius:7px;color:#fff;cursor:pointer}
#job-accelerator-panel .export:disabled{opacity:.45;cursor:not-allowed}
#job-accelerator-panel .loading,#job-accelerator-panel .empty{text-align:center;color:#aeb6c8;padding:30px 0;font-size:12px}
</style>
<button class="close" id="job-accelerator-close">×</button>
<h3>求职加速器</h3>
${runtimeStateHtml()}
<div class="control-box">
  <div class="single-control">
    <label for="job-accelerator-daily-goal">今日目标沟通数</label>
    <input id="job-accelerator-daily-goal" type="number" min="1" max="500" step="1" value="${activeDailyGoal || DEFAULT_DAILY_GOAL}">
  </div>
  <button class="primary-action" id="job-accelerator-start">启动海投</button>
  <div class="mode-summary" id="job-accelerator-mode-summary"></div>
  <div class="mode-note">请先在 BOSS 页面选择城市、薪资、经验等筛选条件；插件负责扫描、兜底过滤和批量点击立即沟通。</div>
  <details class="advanced-filter">
    <summary>高级兜底过滤（可不填）</summary>
    <div class="advanced-body">
      <div class="control-grid">
        <div>
          <label for="job-accelerator-title-filter">职位名包含</label>
          <input id="job-accelerator-title-filter" type="text" placeholder="如：AI,Agent,产品">
        </div>
        <div>
          <label for="job-accelerator-location-filter">工作地包含</label>
          <input id="job-accelerator-location-filter" type="text" placeholder="如：深圳,广州">
        </div>
      </div>
      <div class="single-control">
        <label for="job-accelerator-exclude-filter">排除关键词</label>
        <input id="job-accelerator-exclude-filter" type="text" placeholder="如：培训,保险,销售">
      </div>
      <div class="single-control">
        <div class="score-line">
          <label for="job-accelerator-min-score" id="job-accelerator-min-score-label">匹配度 ≥ ${activeMinScore}%</label>
        </div>
        <input id="job-accelerator-min-score" type="range" min="50" max="100" step="5" value="${activeMinScore}">
      </div>
      <label class="check-row" for="job-accelerator-auto-confirm">
        <input id="job-accelerator-auto-confirm" type="checkbox">
        <span>自动留在此页继续海投<small>开启后点立即沟通，再自动点“留在此页”，避免跳到聊天页。</small></span>
      </label>
    </div>
  </details>
</div>
<div class="pager">
  <button id="job-accelerator-next">继续扫描</button>
  <button id="job-accelerator-refresh">刷新</button>
  <button id="job-accelerator-pause">暂停</button>
  <button id="job-accelerator-clear-low">隐藏未达标</button>
  <button class="danger" id="job-accelerator-clear-cache">清空记录</button>
</div>
<div class="stats" id="job-accelerator-stats">今日目标 ${activeDailyGoal || DEFAULT_DAILY_GOAL} | 已分析 0 | 达标 0 | 已沟通 0 | 跳过 0 | 失败 0</div>
<div class="scan-summary" id="job-accelerator-scan-summary">${esc(loadingText)}</div>
<div id="job-accelerator-results"><div class="loading">${esc(loadingText)}</div></div>
<div class="footer"><button class="export" id="job-accelerator-export">导出 CSV</button></div>`;
  }

  function chatShellHtml() {
    return `<style>
#job-accelerator-panel{position:fixed;top:0;right:0;width:380px;height:100vh;background:#f7fbf8;color:#22302a;z-index:999999;box-shadow:-4px 0 24px #0002;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:18px}
#job-accelerator-panel .close{position:absolute;top:12px;right:14px;background:transparent;border:0;color:#6b7b72;font-size:20px;cursor:pointer}
#job-accelerator-panel h3{margin:0 0 2px;font-size:17px;color:#17944f}
${runtimeStateStyles("light")}
#job-accelerator-panel .subtitle{font-size:12px;color:#6b7b72;margin-bottom:14px}
#job-accelerator-panel .chat-box{background:#eef9f1;border:1px solid #d6efdc;border-radius:8px;padding:12px;margin-bottom:12px}
#job-accelerator-panel .chat-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
#job-accelerator-panel .chat-primary,#job-accelerator-panel .chat-secondary{width:100%;padding:9px 10px;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer}
#job-accelerator-panel .chat-primary{border:0;background:#2eae62;color:#fff}
#job-accelerator-panel .chat-secondary{border:1px solid #c9dfd0;background:#fff;color:#28563d}
#job-accelerator-panel button:disabled{opacity:.55;cursor:wait}
#job-accelerator-panel .debug-actions{margin:0 0 10px}
#job-accelerator-panel .debug-button{width:100%;padding:8px 10px;border:1px dashed #d19b3f;border-radius:7px;background:#fff8e8;color:#7a4e11;font-size:12px;font-weight:700;cursor:pointer}
#job-accelerator-panel .chat-status{font-size:12px;line-height:1.5;color:#40534a;background:#fff;border:1px solid #d6efdc;border-radius:7px;padding:8px 10px;white-space:pre-wrap}
#job-accelerator-panel .chat-count{font-size:12px;color:#17944f;font-weight:700;margin-bottom:8px}
#job-accelerator-panel .reply-list{display:flex;flex-direction:column;gap:8px}
#job-accelerator-panel .reply-item{background:#fff;border:1px solid #d6efdc;border-radius:8px;padding:10px}
#job-accelerator-panel .reply-item.done{opacity:.68}
#job-accelerator-panel .reply-title{font-size:13px;font-weight:700;color:#22302a;margin-bottom:4px}
#job-accelerator-panel .reply-meta{font-size:11px;line-height:1.4;color:#6b7b72;margin-bottom:6px}
#job-accelerator-panel .reply-last{font-size:12px;line-height:1.45;color:#40534a;margin-bottom:8px}
#job-accelerator-panel .reply-actions{display:flex;gap:6px;align-items:center}
#job-accelerator-panel .reply-actions button{font-size:12px;padding:6px 8px;border:1px solid #c9dfd0;border-radius:6px;background:#eef9f1;color:#28563d;cursor:pointer}
#job-accelerator-panel .reply-state{font-size:11px;color:#6b7b72}
#job-accelerator-panel .empty-reply{font-size:12px;color:#6b7b72;padding:14px 0;text-align:center}
</style>
<button class="close" id="job-chat-close">×</button>
<h3>HR 回复助手</h3>
<div class="subtitle">同一个求职加速器插件内运行；只填草稿，不自动发送。</div>
${runtimeStateHtml()}
<div class="chat-box">
  <div class="chat-actions">
    <button class="chat-secondary" id="job-chat-scan" type="button">检查 HR 回复</button>
    <button class="chat-primary" id="job-chat-current" type="button">处理当前会话</button>
  </div>
  <div id="job-chat-debug-slot">${debugHrReplyButtonHtml()}</div>
  <div class="chat-status" id="job-chat-log">等待检查...</div>
</div>
<div class="chat-count" id="job-chat-count">待回复 0</div>
<div class="reply-list" id="job-chat-reply-list"></div>`;
  }

  function bindChatShell() {
    document.getElementById("job-chat-close")?.addEventListener("click", hide);
    document.getElementById("job-chat-scan")?.addEventListener("click", async () => {
      await scanHrReplyQueue({ source: "side_panel", render: true });
    });
    document.getElementById("job-chat-current")?.addEventListener("click", async () => {
      const button = document.getElementById("job-chat-current");
      if (button) {
        button.disabled = true;
        button.textContent = "处理中";
      }
      try {
        await processCurrentConversationReply();
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "处理当前会话";
        }
      }
    });
    bindDebugHrReplyButton();
    document.getElementById("job-chat-reply-list")?.addEventListener("click", async (event) => {
      const button = event.target?.closest?.("[data-hr-reply-id]");
      if (!button) return;
      button.disabled = true;
      button.textContent = "处理中";
      try {
        await processHrReplyItem(button.dataset.hrReplyId);
      } finally {
        button.disabled = false;
        button.textContent = "处理回复";
      }
    });
  }

  function refreshDebugHrReplyButton() {
    const slot = document.getElementById("job-chat-debug-slot");
    if (!slot) return;
    slot.innerHTML = debugHrReplyButtonHtml();
    bindDebugHrReplyButton();
  }

  function bindDebugHrReplyButton() {
    const button = document.getElementById("job-chat-debug-add");
    if (!button || button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "加入中";
      try {
        await addCurrentChatToDebugQueue();
      } finally {
        button.disabled = false;
        button.textContent = "开发测试：将当前会话加入测试队列";
      }
    });
  }

  function debugHrReplyButtonHtml() {
    return debugHrReplyButtonHtmlFor(isHrReplyDebugEnabled(), getBossPageMode());
  }

  function debugHrReplyButtonHtmlFor(debugEnabled, pageMode) {
    if (!debugEnabled || pageMode !== "chat") return "";
    return `<div class="debug-actions">
  <button class="debug-button" id="job-chat-debug-add" type="button">开发测试：将当前会话加入测试队列</button>
</div>`;
  }

  function isHrReplyDebugEnabled() {
    return debugHrReplyEnabled === true;
  }

  async function addCurrentChatToDebugQueue() {
    if (getBossPageMode() !== "chat") {
      const message = "开发测试入口只在已选中聊天会话时可用。";
      await renderChatAssistant(message);
      return { ok: false, error: message };
    }

    const evidence = extractCurrentChatEvidence(null);
    if (currentChatAlreadyReplied(evidence)) {
      const message = "当前会话最后一条是你发送的消息，无需重复回复";
      await renderChatAssistant(message);
      return { ok: false, error: message };
    }
    if (!evidence.latest_hr_message) {
      const message = "当前聊天详情没有读到最新 HR 文本消息，未加入测试队列。";
      await renderChatAssistant(message);
      return { ok: false, error: message };
    }

    const item = makeDebugHrReplyQueueItem(evidence);
    const stored = await storageGet([HR_REPLY_QUEUE_KEY]);
    const queue = mergeHrReplyQueue(stored[HR_REPLY_QUEUE_KEY], [item]);
    await storageSet({ [HR_REPLY_QUEUE_KEY]: queue });
    updatePendingHrQueueCount(queue);
    await renderChatAssistant("开发测试队列已加入当前会话；请手动点击“处理回复”继续。");
    return { ok: true, item, count: pendingHrReplyItems(queue).length };
  }

  function makeDebugHrReplyQueueItem(evidence) {
    const now = new Date().toISOString();
    const dataHint = evidence.selected_unique_id_hint || "";
    const id = `debug_hr_reply_${simpleHash([
      dataHint,
      evidence.hr_name,
      evidence.company,
      evidence.latest_hr_message,
    ].filter(Boolean).join("|"))}`;
    return {
      id,
      debug: true,
      source: HR_REPLY_DEBUG_SOURCE,
      hr_name: evidence.hr_name || "当前 HR",
      hr_role: evidence.hr_role || "",
      company: evidence.company || "",
      job_title: evidence.job_title || "",
      salary: evidence.salary || "",
      city: evidence.city || "",
      latest_hr_message: clipText(evidence.latest_hr_message, 220),
      time_text: "开发测试",
      unread: false,
      unreadCountText: "debug",
      selected: true,
      domIndex: -1,
      dataHint,
      shouldQueue: true,
      status: "pending",
      firstSeenAt: now,
      updatedAt: now,
    };
  }

  async function renderChatAssistant(prefix = "") {
    if (prefix) setLastAction(prefix, runtimeState.lastError ? runtimeState.nextSuggestion : defaultNextSuggestion());
    const log = document.getElementById("job-chat-log");
    const countNode = document.getElementById("job-chat-count");
    const listNode = document.getElementById("job-chat-reply-list");
    if (!log && !listNode) return;
    const items = await storageGet([PENDING_CHAT_KEY, HR_REPLY_QUEUE_KEY]);
    const pending = items[PENDING_CHAT_KEY];
    const queue = normalizeHrReplyQueue(items[HR_REPLY_QUEUE_KEY]);
    updatePendingHrQueueCount(queue);
    const pendingReplies = pendingHrReplyItems(queue);
    const lines = [];
    if (prefix) lines.push(`[${timeText()}] ${prefix}`);
    lines.push(`页面模式：${bossPageModeLabel(getBossPageMode())}`);
    if (taskLock) lines.push(`当前任务：${taskLock.label}`);
    if (pending && !isStalePendingChat(pending)) {
      lines.push(`[${timeText()}] 待处理岗位：${pending.company || "未知公司"} · ${pending.title || "未知岗位"}`);
      lines.push(pending.filledAt ? "开场白已填入输入框，请确认发送。" : "检测到待填开场白，点击开始会尝试填入。");
    }
    if (!pendingReplies.length) lines.push("当前没有识别到带未读标记的 HR 回复。");
    if (log) log.textContent = lines.join("\n");
    if (countNode) countNode.textContent = `待回复 ${pendingReplies.length}`;
    if (listNode) renderHrReplyList(listNode, queue);
  }

  function renderHrReplyList(container, queue) {
    const items = normalizeHrReplyQueue(queue);
    if (!items.length) {
      container.innerHTML = '<div class="empty-reply">暂无待回复会话</div>';
      return;
    }
    container.innerHTML = items.map((item) => {
      const done = item.status === "draft_filled";
      const state = done
        ? "草稿已填入"
        : item.status === "needs_user"
          ? "需用户接管"
          : item.unreadCountText
            ? `未读 ${item.unreadCountText}`
            : "待处理";
      const meta = [
        item.debug || item.source === HR_REPLY_DEBUG_SOURCE ? "开发测试" : "",
        item.company,
        item.hr_role,
        item.time_text,
      ].filter(Boolean).join(" · ");
      return `<div class="reply-item${done ? " done" : ""}">
  <div class="reply-title">${esc(item.hr_name || "未知 HR")}</div>
  <div class="reply-meta">${esc(meta)}</div>
  <div class="reply-last">${esc(item.latest_hr_message || "未读消息")}</div>
  <div class="reply-actions">
    <button type="button" data-hr-reply-id="${esc(item.id)}">处理回复</button>
    <span class="reply-state">${esc(state)}</span>
  </div>
</div>`;
    }).join("");
  }

  async function getHrReplyState(options = {}) {
    if (options.scan) await scanHrReplyQueue({ source: "popup_state", render: false });
    const items = await storageGet([HR_REPLY_QUEUE_KEY]);
    const queue = normalizeHrReplyQueue(items[HR_REPLY_QUEUE_KEY]);
    const message = appendHrReplyDiscoveryDiagnostics(hrReplyStateMessage(queue));
    return {
      ok: true,
      mode: getBossPageMode(),
      modeLabel: bossPageModeLabel(getBossPageMode()),
      count: pendingHrReplyItems(queue).length,
      queue,
      lock: taskLockSnapshot(),
      autoApplyActive: isAutoApplyBusy(),
      discovery: discoveryDiagnosticsSnapshot(),
      message,
    };
  }

  async function scanHrReplyQueue(options = {}) {
    if (!isBossMessagePage()) {
      const state = await getHrReplyState({ scan: false });
      const message = getBossPageMode() === "job"
        ? "当前在岗位搜索页；海投运行中不会跳转消息页。请打开 BOSS 消息页后检查 HR 回复。"
        : "当前不是 BOSS 消息页，请先打开消息页。";
      if (options.render) await renderChatAssistant(message);
      return { ...state, ok: true, message };
    }

    if (!HR_REPLY_DISCOVERY) {
      const baseMessage = "HR 未读发现模块未加载；可继续手动处理当前会话，海投功能不受影响。";
      runtimeState.hrReplyDiscoveryDiagnostics = {
        cardCount: 0,
        queuedCount: 0,
        rejectedCount: 0,
        rejectReasons: "module_missing:1",
        unreadSources: "",
        singleCardUnreadCount: 0,
        numericUnreadMissingStableHintCount: 0,
      };
      const message = appendHrReplyDiscoveryDiagnostics(baseMessage);
      const state = await getHrReplyState({ scan: false });
      if (options.render || panelMode === "chat") await renderChatAssistant(message);
      return { ...state, ok: false, discoveryUnavailable: true, message };
    }

    const cards = await waitForConversationCards();
    const discovered = cards.map((card, index) => extractHrReplyQueueItem(card, index, cards));
    const fresh = discovered.filter((item) => item?.shouldQueue);
    const rejected = discovered.filter((item) => item && !item.shouldQueue);
    const rejectCounts = rejected.reduce((counts, item) => {
      const reason = item.reject_reason || "unknown";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    const sourceCounts = discovered.reduce((counts, item) => {
      const source = item?.unreadEvidenceSource || "none";
      counts[source] = (counts[source] || 0) + 1;
      return counts;
    }, {});
    const singleCardUnreadCount = discovered.filter((item) => (
      item?.unreadEvidenceSource && item.unreadEvidenceSource !== "none"
    )).length;
    const numericUnreadMissingStableHintCount = discovered.filter((item) => (
      /numeric/.test(item?.unreadEvidenceSource || "")
      && item?.reject_reason === "missing_stable_hint"
    )).length;
    runtimeState.hrReplyDiscoveryDiagnostics = {
      cardCount: cards.length,
      queuedCount: fresh.length,
      rejectedCount: rejected.length,
      rejectReasons: Object.entries(rejectCounts).map(([reason, count]) => `${reason}:${count}`).join(","),
      unreadSources: Object.entries(sourceCounts).map(([source, count]) => `${source}:${count}`).join(","),
      singleCardUnreadCount,
      numericUnreadMissingStableHintCount,
    };
    const stored = await storageGetChecked([HR_REPLY_QUEUE_KEY]);
    if (!stored.ok) {
      const message = appendHrReplyDiscoveryDiagnostics("待回复队列读取失败，本轮未更新；稍后会自动重试。");
      setLastError(message);
      if (options.render || panelMode === "chat") await renderChatAssistant(message);
      return { ok: false, reason: "storage_read_failed", message };
    }

    const queue = mergeHrReplyQueue(stored.items[HR_REPLY_QUEUE_KEY], fresh);
    const saved = await storageSet({ [HR_REPLY_QUEUE_KEY]: queue });
    if (!saved) {
      const message = appendHrReplyDiscoveryDiagnostics("待回复队列保存失败，本轮发现未落盘；稍后会自动重试。");
      setLastError(message);
      if (options.render || panelMode === "chat") await renderChatAssistant(message);
      return { ok: false, reason: "storage_write_failed", message };
    }
    updatePendingHrQueueCount(queue);
    const count = pendingHrReplyItems(queue).length;
    const baseMessage = fresh.length
      ? `已检查消息列表，发现 ${fresh.length} 条可见待回复。`
      : "已检查消息列表，暂未看到带未读标记的 HR 回复。";
    const message = appendHrReplyDiscoveryDiagnostics(baseMessage);
    if (options.render || panelMode === "chat") await renderChatAssistant(message);
    return {
      ok: true,
      mode: getBossPageMode(),
      modeLabel: bossPageModeLabel(getBossPageMode()),
      count,
      queue,
      lock: taskLockSnapshot(),
      autoApplyActive: isAutoApplyBusy(),
      discovery: runtimeState.hrReplyDiscoveryDiagnostics,
      message,
    };
  }

  async function waitForConversationCards() {
    const deadline = Date.now() + 6 * 1000;
    while (Date.now() < deadline) {
      const cards = conversationCards();
      if (cards.length) return cards;
      await sleep(250);
    }
    return conversationCards();
  }

  function conversationCards() {
    return uniqueElements(Array.from(document.querySelectorAll(".friend-content-warp .friend-content,.friend-content")))
      .filter(isVisible)
      .filter((card) => !card.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((card) => !card.classList.contains("drawer"));
  }

  function selectedConversationCard() {
    return conversationCards().find(conversationCardHasSelectedMarker) || null;
  }

  function conversationCardHasSelectedMarker(card) {
    const wrapper = card?.closest?.(".friend-content-warp");
    return [card, wrapper].filter(Boolean).some(nodeHasSelectedConversationMarker);
  }

  function nodeHasSelectedConversationMarker(node) {
    if (!node) return false;
    if (
      node.getAttribute?.("aria-selected") === "true"
      || node.getAttribute?.("aria-current") === "true"
      || node.getAttribute?.("data-selected") === "true"
      || node.getAttribute?.("data-active") === "true"
      || node.getAttribute?.("data-current") === "true"
    ) return true;
    return Array.from(node.classList || []).some(classTokenIsSelectedConversation);
  }

  function classTokenIsSelectedConversation(className) {
    return /(^|[-_])(selected|select|active|current|cur|checked)([-_]|$)/i.test(className)
      && !/(^|[-_])(inactive|disabled|unselected)([-_]|$)/i.test(className);
  }

  function extractUnreadEvidence(card) {
    const root = card?.closest?.(".friend-content-warp") || card;
    const avatarRoots = avatarUnreadRoots(card, root);
    const knownNode = firstVisibleNode([
      ...avatarRoots.flatMap((avatarRoot) => candidateNodes(avatarRoot, ".notice-badge,.dot")),
      ...candidateNodes(card, ".notice-badge,.dot"),
      ...candidateNodes(root, ".notice-badge,.dot"),
    ]);
    if (knownNode) {
      const isNoticeBadge = Boolean(
        knownNode.matches?.(".notice-badge")
        || knownNode.classList?.contains?.("notice-badge"),
      );
      return {
        unread: true,
        kind: isNoticeBadge ? "badge" : "dot",
        countText: inlineText(knownNode),
        source: isNoticeBadge ? "notice_badge" : "dot",
      };
    }

    const numericNode = firstVisibleNode(candidateNodes(root, "span,div,i,b,em,strong")
      .filter((node) => node !== root && node !== card)
      .filter(isTrustedAvatarNumericUnreadNode)
      .filter((node) => isAvatarBoundUnreadNode(node, avatarRoots, root)));
    if (!numericNode) return { unread: false, kind: "", countText: "", source: "" };
    return {
      unread: true,
      kind: "avatar_numeric",
      countText: avatarUnreadCountText(numericNode),
      source: avatarUnreadSource(numericNode, avatarRoots),
    };
  }

  function avatarUnreadRoots(card, root) {
    const roots = [
      firstMatchingDescendant(root, ".figure"),
      firstMatchingDescendant(card, ".figure"),
      ...candidateNodes(root, "img").filter((node) => (
        node.closest?.(".figure")
        || hasAvatarSemanticHint(node)
      )),
    ];
    return uniqueElements(roots).filter(isVisible);
  }

  function candidateNodes(root, selector) {
    if (!root) return [];
    return uniqueElements([
      root.matches?.(selector) ? root : null,
      ...Array.from(root.querySelectorAll?.(selector) || []),
    ].filter(Boolean));
  }

  function firstVisibleNode(nodes) {
    return (nodes || []).find((node) => isVisible(node)) || null;
  }

  function isTrustedAvatarNumericUnreadNode(node) {
    const countText = avatarUnreadCountText(node);
    if (!countText) return false;
    if (hasUnreadBadgeSemanticHint(node)) return true;
    return isRedUnreadBadgeNode(node);
  }

  function isAvatarBoundUnreadNode(node, avatarRoots, root) {
    if (!root?.contains?.(node) || !avatarRoots.length) return false;
    return avatarRoots.some((avatarRoot) => (
      avatarRoot === node
      || avatarRoot.contains?.(node)
      || isNearAvatarUnreadCorner(node, avatarRoot)
    ));
  }

  function avatarUnreadSource(node, avatarRoots) {
    return avatarRoots.some((avatarRoot) => avatarRoot.contains?.(node))
      ? "avatar_figure_numeric"
      : "avatar_nearby_numeric";
  }

  function avatarUnreadCountText(node) {
    const value = inlineText(node);
    return /^[1-9]\d{0,2}$/.test(value) ? value : "";
  }

  function hasUnreadBadgeSemanticHint(node) {
    const names = ["class", "aria-label", "title", "data-testid", "data-test", "data-type", "data-count", "data-badge"];
    const textValue = names
      .map((name) => String(node?.getAttribute?.(name) || ""))
      .join(" ");
    return /unread|notice|badge|count|num|number|red/i.test(textValue);
  }

  function hasAvatarSemanticHint(node) {
    const names = ["class", "alt", "aria-label", "title", "data-testid", "data-test"];
    const textValue = names
      .map((name) => String(node?.getAttribute?.(name) || ""))
      .join(" ");
    return /avatar|head|photo|portrait|figure/i.test(textValue);
  }

  function isRedUnreadBadgeNode(node) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : (node?.style || {});
    return isRedColorValue(style?.backgroundColor || style?.background || "")
      || styleAttributeHasRedBackground(node);
  }

  function styleAttributeHasRedBackground(node) {
    const styleText = String(node?.getAttribute?.("style") || "");
    const match = styleText.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    return Boolean(match && isRedColorValue(match[1]));
  }

  function isRedColorValue(value) {
    const textValue = String(value || "").trim().toLowerCase();
    if (textValue === "red") return true;
    const hex = textValue.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1].length === 3
        ? hex[1].split("").map((char) => `${char}${char}`).join("")
        : hex[1];
      const red = Number.parseInt(raw.slice(0, 2), 16);
      const green = Number.parseInt(raw.slice(2, 4), 16);
      const blue = Number.parseInt(raw.slice(4, 6), 16);
      return red >= 180 && green <= 120 && blue <= 120;
    }
    const rgb = textValue.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!rgb) return false;
    return Number(rgb[1]) >= 180 && Number(rgb[2]) <= 120 && Number(rgb[3]) <= 120;
  }

  function isNearAvatarUnreadCorner(node, avatarRoot) {
    const nodeRect = node.getBoundingClientRect?.();
    const avatarRect = avatarRoot.getBoundingClientRect?.();
    if (!nodeRect || !avatarRect || !nodeRect.width || !nodeRect.height || !avatarRect.width || !avatarRect.height) {
      return false;
    }
    const centerX = nodeRect.left + nodeRect.width / 2;
    const centerY = nodeRect.top + nodeRect.height / 2;
    const horizontalPad = Math.max(nodeRect.width, 12);
    const verticalPad = Math.max(nodeRect.height, 12);
    return centerX >= avatarRect.left - horizontalPad
      && centerX <= avatarRect.right + horizontalPad
      && centerY >= avatarRect.top - verticalPad
      && centerY <= avatarRect.bottom;
  }

  function extractHrReplyQueueItem(card, index = 0, allCards = null) {
    const visibleCards = Array.isArray(allCards) ? allCards : conversationCards();
    const identity = extractConversationIdentityFromCard(card);
    const hrName = identity.hrName;
    const titleLine = identity.titleLine;
    const latest = clipText(text(card, ".last-msg-text") || text(card, ".gray.last-msg") || "", 220);
    const time = text(card, ".time") || "";
    const unreadEvidence = extractUnreadEvidence(card);
    const draft = Boolean(card.querySelector(".draft")) || /草稿/.test(inlineText(card.querySelector(".gray.last-msg") || card));
    const company = identity.company;
    const hrRole = identity.hrRole;
    const combinedText = `${hrName} ${titleLine} ${latest}`;
    const stableHint = extractStableConversationHint(card, visibleCards, { hrName, company, hrRole });
    const messageHint = extractStableMessageHint(card);
    const semanticRoot = card.closest?.(".friend-content-warp") || card;
    const snapshot = {
      hr_name: hrName,
      company,
      hr_role: hrRole,
      latest_hr_message: latest,
      time_text: time,
      data_hint: stableHint,
      data_hint_unique: Boolean(stableHint),
      require_stable_hint: true,
      message_hint: messageHint,
      unread: unreadEvidence.unread,
      unread_kind: unreadEvidence.kind,
      unread_count_text: unreadEvidence.countText,
      draft,
      system: Boolean(
        semanticRoot.matches?.("[class*='system']")
        || semanticRoot.querySelector?.("[class*='system']"),
      ) || /系统通知|平台通知|直聘助手|BOSS助手/.test(combinedText),
      group: Boolean(
        semanticRoot.matches?.("[class*='group']")
        || semanticRoot.querySelector?.("[class*='group']"),
      ) || /群聊|群组|交流群|多人会话/.test(combinedText),
      latest_sender: /^\s*(?:\[(?:送达|已读|发送中|发送失败)\]|(?:我|本人)[:：])/.test(latest) ? "me" : "",
    };
    const classification = HR_REPLY_DISCOVERY
      ? HR_REPLY_DISCOVERY.classifySnapshot(snapshot)
      : {
        kind: "unavailable",
        shouldQueue: false,
        reject_reason: "module_missing",
        unread: { unread: snapshot.unread, kind: snapshot.unread_kind || "none", count: 0 },
      };
    const conversationFingerprint = HR_REPLY_DISCOVERY?.makeConversationFingerprint(snapshot) || "";
    const messageFingerprint = HR_REPLY_DISCOVERY?.makeMessageFingerprint({ ...snapshot, conversationFingerprint }) || "";
    const now = new Date().toISOString();
    return {
      id: conversationFingerprint ? `hr_reply_${conversationFingerprint.replace(/^conversation_/, "")}` : "",
      conversationFingerprint,
      messageFingerprint,
      hr_name: hrName,
      hr_role: hrRole,
      company,
      job_title: "",
      latest_hr_message: latest,
      latest_sender_role: snapshot.latest_sender || (classification.shouldQueue ? "hr" : ""),
      time_text: time,
      unread: classification.unread.unread,
      unreadCountText: snapshot.unread_count_text,
      unreadEvidenceSource: unreadEvidence.source,
      dataHint: stableHint,
      data_hint: stableHint,
      data_hint_unique: Boolean(stableHint),
      dataHintUnique: Boolean(stableHint),
      messageHint,
      discovery_kind: classification.kind,
      reject_reason: classification.reject_reason,
      shouldQueue: classification.shouldQueue,
      status: "pending",
      firstSeenAt: now,
      messageFirstSeenAt: now,
      updatedAt: now,
      selected: card.classList.contains("selected"),
      domIndex: index,
    };
  }

  function conversationDataKey(card) {
    const wrapper = card?.closest?.(".friend-content-warp") || card;
    const node = card?.hasAttribute?.("data-key")
      ? card
      : wrapper?.hasAttribute?.("data-key") ? wrapper : null;
    return String(node?.getAttribute?.("data-key") || "").trim();
  }

  function extractStableMessageHint(card) {
    const values = Array.from(card?.querySelectorAll?.("[data-mid]") || [])
      .map((node) => String(node.getAttribute("data-mid") || "").trim())
      .filter(Boolean);
    const uniqueValues = Array.from(new Set(values));
    return uniqueValues.length === 1 ? `data-mid:${uniqueValues[0]}` : "";
  }

  function extractStableConversationHint(card, allCards, identity = null) {
    const cards = Array.isArray(allCards) && allCards.length ? allCards : [card];
    const value = conversationDataKey(card);
    if (value) {
      const count = cards.filter((entry) => conversationDataKey(entry) === value).length;
      return count === 1 ? `data-key:${value}` : "";
    }

    const identityHint = conversationIdentityHint(identity) || conversationIdentityHintFromCard(card);
    if (!identityHint) return "";
    const count = cards.filter((entry) => conversationIdentityHintFromCard(entry) === identityHint).length;
    return count === 1 ? identityHint : "";
  }

  function conversationIdentityHintFromCard(card) {
    return conversationIdentityHint(extractConversationIdentityFromCard(card));
  }

  function extractConversationIdentityFromCard(card) {
    const hrName = text(card, ".name-text") || text(card, ".name-box") || "";
    const titleLine = text(card, ".title-box") || "";
    const structuredParts = extractTitleIdentityFragments(card, hrName);
    const company = structuredParts.length >= 2
      ? structuredParts[0]
      : extractCompanyFromTitleLine(titleLine, hrName);
    const hrRole = structuredParts.length >= 2
      ? structuredParts.slice(1).join(" ")
      : extractRoleFromTitleLine(titleLine, hrName, company);
    return { hrName, company, hrRole, titleLine };
  }

  function extractTitleIdentityFragments(card, hrName) {
    const root = card?.querySelector?.(".title-box") || card?.querySelector?.(".name-box");
    if (!root) return [];
    const candidates = Array.from(root.querySelectorAll?.("span, em, strong, b, i") || [])
      .filter((node) => !node.children || node.children.length === 0)
      .map((node) => normalizeTitleIdentityPart(inlineText(node)))
      .filter((value) => value && value !== normalizeTitleIdentityPart(hrName));
    return Array.from(new Set(candidates));
  }

  function conversationIdentityHint(identity = {}) {
    const hrName = normalizeIdentityHintValue(identity?.hrName || identity?.hr_name);
    const company = normalizeIdentityHintValue(identity?.company);
    const hrRole = normalizeIdentityHintValue(identity?.hrRole || identity?.hr_role);
    if (!hrName || !company || !hrRole) return "";
    return `identity:${simpleHash([hrName, company, hrRole].join("|"))}`;
  }

  function normalizeIdentityHintValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeHrReplyQueue(value) {
    const normalized = HR_REPLY_DISCOVERY
      ? HR_REPLY_DISCOVERY.dedupeQueueItems(value)
      : (Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && item.id) : []);
    return normalized.slice(-HR_REPLY_QUEUE_LIMIT);
  }

  function pendingHrReplyItems(queue) {
    const normalized = normalizeHrReplyQueue(queue);
    return HR_REPLY_DISCOVERY
      ? HR_REPLY_DISCOVERY.pendingItems(normalized)
      : normalized.filter((item) => ["pending", "needs_user"].includes(item.status));
  }

  function mergeHrReplyQueue(existingValue, freshItems) {
    const merged = HR_REPLY_DISCOVERY
      ? HR_REPLY_DISCOVERY.mergeQueueCandidate(existingValue, freshItems, { limit: HR_REPLY_QUEUE_LIMIT })
      : mergeHrReplyQueueFallback(existingValue, freshItems);
    return merged
      .filter((item) => !isStaleHrReplyItem(item))
      .slice(-HR_REPLY_QUEUE_LIMIT);
  }

  function mergeHrReplyQueueFallback(existingValue, freshItems) {
    const map = new Map(normalizeHrReplyQueue(existingValue).map((item) => [item.id, item]));
    (Array.isArray(freshItems) ? freshItems : [])
      .filter((item) => item?.debug && item.id)
      .forEach((item) => map.set(item.id, { ...map.get(item.id), ...item }));
    return Array.from(map.values()).slice(-HR_REPLY_QUEUE_LIMIT);
  }

  function isStaleHrReplyItem(item) {
    const updatedAt = Date.parse(item?.updatedAt || item?.firstSeenAt || "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt > 24 * 60 * 60 * 1000;
  }

  function extractCompanyFromTitleLine(titleLine, hrName) {
    const parts = splitTitleIdentityText(titleLine, hrName);
    return parts.length >= 2 ? parts.slice(0, -1).join(" ") : "";
  }

  function extractRoleFromTitleLine(titleLine, hrName, company) {
    const parts = splitTitleIdentityText(titleLine, hrName);
    if (parts.length < 2) return "";
    const normalizedCompany = normalizeTitleIdentityPart(company);
    const companyParts = parts.slice(0, -1).join(" ");
    return normalizeTitleIdentityPart(companyParts) === normalizedCompany ? parts[parts.length - 1] : "";
  }

  function splitTitleIdentityText(titleLine, hrName) {
    const cleaned = String(titleLine || "")
      .replace(String(hrName || ""), " ")
      .replace(/[·|｜\-—]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return [];
    return cleaned.split(/\s+/).map(normalizeTitleIdentityPart).filter(Boolean);
  }

  function normalizeTitleIdentityPart(value) {
    return String(value || "")
      .replace(/^[\s·|｜\-—:：,，/]+|[\s·|｜\-—:：,，/]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hrReplyStateMessage(queue) {
    const count = pendingHrReplyItems(queue).length;
    if (count) return `当前待回复 ${count} 条。`;
    if (isBossMessagePage()) return "当前没有识别到待回复队列。";
    return "打开 BOSS 消息页后可以检查 HR 回复。";
  }

  function appendHrReplyDiscoveryDiagnostics(message, enabled = debugHrReplyEnabled, diagnostics = runtimeState.hrReplyDiscoveryDiagnostics) {
    const textValue = String(message || "");
    if (enabled !== true) return textValue;
    const line = formatHrReplyDiscoveryDiagnostics(diagnostics);
    return line ? textValue + "\n" + line : textValue;
  }

  function formatHrReplyDiscoveryDiagnostics(diagnostics = {}) {
    const snapshot = sanitizeHrReplyDiscoveryDiagnostics(diagnostics);
    return [
      "诊断",
      "cardCount=" + snapshot.cardCount,
      "queuedCount=" + snapshot.queuedCount,
      "rejectedCount=" + snapshot.rejectedCount,
      "singleCardUnreadCount=" + snapshot.singleCardUnreadCount,
      "numericUnreadMissingStableHintCount=" + snapshot.numericUnreadMissingStableHintCount,
      "unreadSources=" + (snapshot.unreadSources || "-"),
      "rejectReasons=" + (snapshot.rejectReasons || "-"),
    ].join(" ");
  }

  function discoveryDiagnosticsSnapshot(diagnostics = runtimeState.hrReplyDiscoveryDiagnostics) {
    return sanitizeHrReplyDiscoveryDiagnostics(diagnostics);
  }

  function sanitizeHrReplyDiscoveryDiagnostics(diagnostics = {}) {
    return {
      cardCount: safeDiagnosticsCount(diagnostics.cardCount),
      queuedCount: safeDiagnosticsCount(diagnostics.queuedCount),
      rejectedCount: safeDiagnosticsCount(diagnostics.rejectedCount),
      singleCardUnreadCount: safeDiagnosticsCount(diagnostics.singleCardUnreadCount),
      numericUnreadMissingStableHintCount: safeDiagnosticsCount(diagnostics.numericUnreadMissingStableHintCount),
      unreadSources: safeDiagnosticsCountList(diagnostics.unreadSources),
      rejectReasons: safeDiagnosticsCountList(diagnostics.rejectReasons),
    };
  }

  function safeDiagnosticsCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function safeDiagnosticsCountList(value) {
    return String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const match = entry.match(/^([a-zA-Z0-9_-]+):(\d+)$/);
        return match ? match[1] + ":" + Number(match[2]) : "";
      })
      .filter(Boolean)
      .join(",");
  }

  async function processHrReplyItem(itemId) {
    const items = await storageGet([HR_REPLY_QUEUE_KEY]);
    const queue = normalizeHrReplyQueue(items[HR_REPLY_QUEUE_KEY]);
    const item = queue.find((entry) => entry.id === itemId);
    if (!item) {
      const result = { ok: false, error: "这条待回复记录已不存在，请重新检查 HR 回复。" };
      await renderChatAssistant(result.error);
      return result;
    }
    return processHrReplyTarget(item);
  }

  async function processCurrentConversationReply() {
    return processHrReplyTarget(null);
  }

  async function processHrReplyTarget(item) {
    const lock = acquireTaskLock("hr_reply", { label: "HR 回复处理", preempt: true });
    if (!lock.ok) {
      const message = `当前正在${lock.current?.label || "执行其他页面任务"}，请稍后再处理 HR 回复。`;
      await renderChatAssistant(message);
      return { ok: false, error: message };
    }
    const pausedInfo = pauseAutoApplyForHrReply();

    hrReplyProcessing = true;
    renderRuntimeState();
    try {
      clearLastError();
      if (pausedInfo.paused) await renderChatAssistant("已暂停海投，正在处理 HR 回复。");

      let evidenceResult = null;
      const debugItem = isDebugHrReplyItem(item);
      if (debugItem) {
        const currentEvidence = getBossPageMode() === "chat"
          ? extractCurrentChatEvidence(null)
          : null;
        if (!currentEvidence || !evidenceMatchesQueueItem(currentEvidence, item)) {
          return stopHrReplyForConversationMismatch(item);
        }
        evidenceResult = { ok: true, matched: true, evidence: currentEvidence };
      }

      if (!isBossMessagePage()) {
        rememberHrReplyTask(item);
        location.href = BOSS_CHAT_URL;
        return {
          ok: true,
          navigating: true,
          message: pausedInfo.paused ? "已暂停海投，正在进入消息页处理 HR 回复。" : "正在进入消息页处理 HR 回复。",
        };
      }

      if (item && !debugItem) {
        await scanHrReplyQueue({ source: "before_process", render: false });
        const refreshedItem = await reloadHrReplyQueueItem(item);
        if (!refreshedItem) return stopHrReplyForConversationMismatch(item);
        item = refreshedItem;
        const currentEvidence = extractCurrentChatEvidence(null);
        evidenceResult = evidenceMatchesQueueItem(currentEvidence, item)
          ? { ok: true, matched: true, evidence: currentEvidence }
          : await openConversationFromQueueItem(item);
        if (!evidenceResult.ok) {
          return stopHrReplyForConversationMismatch(item);
        }
      }

      evidenceResult = evidenceResult || await waitForCurrentChatEvidence(item);
      const evidence = evidenceResult.evidence;
      if (item && (!evidenceResult.ok || !evidenceMatchesQueueItem(evidence, item))) {
        return stopHrReplyForConversationMismatch(item);
      }
      if (currentChatAlreadyReplied(evidence)) {
        return stopHrReplyBecauseAlreadyReplied(item);
      }
      if (!evidence.latest_hr_message) {
        const message = "没有读到最新 HR 文本消息，已停止填草稿。";
        await markHrReplyQueueItem(item?.id, "needs_user", message);
        await renderChatAssistant(message);
        return { ok: false, error: message };
      }

      await renderChatAssistant("已读取聊天上下文，正在生成回复草稿。");
      const requestEvidence = extractCurrentChatEvidence(item);
      if (item && !evidenceMatchesQueueItem(requestEvidence, item)) {
        return stopHrReplyForConversationMismatch(item);
      }
      if (currentChatAlreadyReplied(requestEvidence)) {
        return stopHrReplyBecauseAlreadyReplied(item);
      }
      if (!requestEvidence.latest_hr_message) {
        const message = "没有读到最新 HR 文本消息，已停止填草稿。";
        await markHrReplyQueueItem(item?.id, "needs_user", message);
        await renderChatAssistant(message);
        return { ok: false, error: message };
      }

      const reply = await requestChatReply(requestEvidence);
      const responseEvidence = extractCurrentChatEvidence(item);
      if (!replyTargetStillCurrent(requestEvidence, responseEvidence, item)) {
        return stopHrReplyForConversationMismatch(item);
      }
      if (currentChatAlreadyReplied(responseEvidence)) {
        return stopHrReplyBecauseAlreadyReplied(item);
      }
      const result = await handleChatReplyResult(reply, responseEvidence, item);
      forgetHrReplyTask();
      return result;
    } catch (error) {
      const message = formatChatReplyError(error);
      forgetHrReplyTask();
      setLastError(message);
      if (item?.id) await markHrReplyQueueItem(item.id, "needs_user", message);
      await renderChatAssistant(message);
      return { ok: false, error: message };
    } finally {
      hrReplyProcessing = false;
      renderRuntimeState();
      releaseTaskLock(lock);
    }
  }

  function pauseAutoApplyForHrReply() {
    const pausedAutoApply = isAutoApplyBusy();
    if (pausedAutoApply) {
      disableAutoApplyTask();
      cancelActiveAnalysis();
      setPaused(true);
    }
    return { paused: pausedAutoApply };
  }

  function isDebugHrReplyItem(item) {
    return Boolean(item && (item.debug || item.source === HR_REPLY_DEBUG_SOURCE));
  }

  async function stopHrReplyForConversationMismatch(item) {
    const message = "当前会话与待回复记录不一致，请打开对应会话后重试";
    if (item?.id) await markHrReplyQueueItem(item.id, "needs_user", message, { statusReason: "conversation_mismatch" });
    forgetHrReplyTask();
    await renderChatAssistant(message);
    return { ok: false, mismatch: true, filled: false, error: message, message };
  }

  async function stopHrReplyBecauseAlreadyReplied(item) {
    const message = "当前会话最后一条是你发送的消息，无需重复回复";
    if (item?.id) await removeHrReplyQueueItem(item.id);
    forgetHrReplyTask();
    await renderChatAssistant(message);
    return { ok: true, filled: false, skipped: true, message };
  }

  async function openConversationFromQueueItem(item) {
    const deadline = Date.now() + 8 * 1000;
    while (Date.now() < deadline) {
      const card = findConversationCardForQueueItem(item);
      if (card) {
        clickElement(card);
        return waitForCurrentChatEvidence(item);
      }
      await sleep(300);
    }
    return { ok: false, matched: false, evidence: extractCurrentChatEvidence(null) };
  }

  function findConversationCardForQueueItem(item) {
    const cards = conversationCards();
    const byDataHint = item.dataHint
      ? cards.find((card) => extractStableConversationHint(card, cards) === item.dataHint)
      : null;
    if (byDataHint) return byDataHint;
    if (item.dataHint) return null;

    return cards.find((card, index) => {
      const cardItem = extractHrReplyQueueItem(card, index, cards);
      if (!cardItem) return false;
      const sameName = exactChatMatchValue(item.hr_name, cardItem.hr_name);
      const sameCompany = relatedChatMatchValue(item.company, cardItem.company);
      const sameLatest = chatMessageMatches(item.latest_hr_message, cardItem.latest_hr_message);
      return sameName && sameCompany && sameLatest;
    }) || null;
  }

  async function waitForCurrentChatEvidence(item = null) {
    const deadline = Date.now() + 10 * 1000;
    let latest = null;
    while (Date.now() < deadline) {
      latest = extractCurrentChatEvidence(item);
      const matched = item ? evidenceMatchesQueueItem(latest, item) : Boolean(latest.latest_hr_message);
      if (latest.latest_hr_message && matched) {
        return { ok: true, matched: true, evidence: latest };
      }
      await sleep(350);
    }
    const evidence = latest || extractCurrentChatEvidence(item);
    return {
      ok: false,
      matched: item ? evidenceMatchesQueueItem(evidence, item) : false,
      evidence,
    };
  }

  function evidenceMatchesQueueItem(evidence, item) {
    if (!item) return true;
    const identity = evidence.current_chat_identity || {};
    const stableIdentityMatch = stableConversationIdentityMatches({
      expectedHint: item.dataHint,
      actualHint: identity.data_hint,
      expectedName: item.hr_name,
      actualName: identity.hr_name,
    });
    if (stableIdentityMatch !== null) return stableIdentityMatch;
    const hasComparableNames = Boolean(compactChatMatchValue(item.hr_name) && compactChatMatchValue(identity.hr_name));
    const sameName = hrNameMatches(item.hr_name, identity.hr_name);
    const hasComparableJobs = Boolean(compactChatMatchValue(item.job_title) && compactChatMatchValue(identity.job_title));
    const sameContext = hasComparableJobs
      ? relatedChatMatchValue(item.job_title, identity.job_title)
      : relatedChatMatchValue(item.company, identity.company);
    const sameLatest = chatMessageMatches(item.latest_hr_message, evidence.latest_hr_message);
    return Boolean(hasComparableNames && sameName && sameContext && sameLatest);
  }

  function replyTargetStillCurrent(before, after, item = null) {
    if (!before || !after || !before.latest_hr_message || !after.latest_hr_message) return false;
    if (item && !evidenceMatchesQueueItem(after, item)) return false;
    const beforeIdentity = before.current_chat_identity || {};
    const afterIdentity = after.current_chat_identity || {};
    const stableIdentityMatch = stableConversationIdentityMatches({
      expectedHint: beforeIdentity.data_hint,
      actualHint: afterIdentity.data_hint,
      expectedName: beforeIdentity.hr_name,
      actualName: afterIdentity.hr_name,
    });
    if (stableIdentityMatch !== null) return stableIdentityMatch;
    const sameIdentity = hrNameMatches(beforeIdentity.hr_name, afterIdentity.hr_name);
    const beforeJob = compactChatMatchValue(beforeIdentity.job_title);
    const afterJob = compactChatMatchValue(afterIdentity.job_title);
    const sameContext = beforeJob || afterJob
      ? relatedChatMatchValue(beforeIdentity.job_title, afterIdentity.job_title)
      : relatedChatMatchValue(beforeIdentity.company, afterIdentity.company);
    const sameLatestHr = compactChatMatchValue(before.latest_hr_message)
      === compactChatMatchValue(after.latest_hr_message);
    return Boolean(sameIdentity && sameContext && sameLatestHr);
  }

  function stableConversationIdentityMatches({ expectedHint, actualHint, expectedName, actualName } = {}) {
    const hasExpectedHint = Boolean(compactChatMatchValue(expectedHint));
    if (!hasExpectedHint) return null;
    if (!compactChatMatchValue(actualHint)) return null;
    const sameHint = HR_REPLY_DISCOVERY?.stableHintsMatch
      ? HR_REPLY_DISCOVERY.stableHintsMatch({ data_hint: expectedHint }, { data_hint: actualHint })
      : exactChatMatchValue(expectedHint, actualHint);
    if (!sameHint) return false;
    const hasComparableNames = Boolean(compactChatMatchValue(expectedName) && compactChatMatchValue(actualName));
    return !hasComparableNames || hrNameMatches(expectedName, actualName);
  }

  async function reloadHrReplyQueueItem(item) {
    if (!item) return null;
    const stored = await storageGet([HR_REPLY_QUEUE_KEY]);
    const queue = normalizeHrReplyQueue(stored[HR_REPLY_QUEUE_KEY]);
    return queue.find((entry) => entry.id === item.id)
      || queue.find((entry) => (
        item.conversationFingerprint
        && entry.conversationFingerprint === item.conversationFingerprint
      ))
      || null;
  }

  function compactChatMatchValue(value) {
    return compactForMatch(value).toLowerCase();
  }

  function exactChatMatchValue(left, right) {
    const normalizedLeft = compactChatMatchValue(left);
    const normalizedRight = compactChatMatchValue(right);
    return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
  }

  function relatedChatMatchValue(left, right) {
    const normalizedLeft = compactChatMatchValue(left);
    const normalizedRight = compactChatMatchValue(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    return Math.min(normalizedLeft.length, normalizedRight.length) >= 3
      && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
  }

  function hrNameMatches(left, right) {
    const normalizedLeft = compactChatMatchValue(left);
    const normalizedRight = compactChatMatchValue(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    return Math.min(normalizedLeft.length, normalizedRight.length) >= 2
      && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
  }

  function chatMessageMatches(left, right) {
    const normalizedLeft = compactChatMatchValue(left);
    const normalizedRight = compactChatMatchValue(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    const leftPrefix = chatMessageComparablePrefix(normalizedLeft);
    const rightPrefix = chatMessageComparablePrefix(normalizedRight);
    if (!leftPrefix || !rightPrefix) return false;
    return Math.min(leftPrefix.length, rightPrefix.length) >= 8
      && (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix));
  }

  function chatMessageComparablePrefix(normalizedValue) {
    const value = String(normalizedValue || "");
    const ellipsisIndex = value.search(/\.{2,}|…|。{2,}/);
    const prefix = ellipsisIndex >= 0 ? value.slice(0, ellipsisIndex) : value;
    return prefix.replace(/[.。…]+$/g, "");
  }

  function extractCurrentChatEvidence(queueItem = null) {
    const selectedCard = selectedConversationCard();
    const selectedInfo = selectedCard ? extractHrReplyQueueItem(selectedCard, 0) : null;
    const positionRoot = document.querySelector(".chat-position-content") || document.querySelector(".position-content");
    const topRoot = document.querySelector(".top-info-content") || document.querySelector(".chat-conversation");
    const messages = extractVisibleChatMessages();
    const latestMessage = messages[messages.length - 1] || null;
    const latestHrIndex = messages.reduce((latestIndex, message, index) => (
      message.role === "hr" && message.content ? index : latestIndex
    ), -1);
    const latestHr = [...messages].reverse().find((message) => message.role === "hr" && message.content);
    const hasUserRepliedAfterLatestHr = latestHrIndex >= 0
      && messages.slice(latestHrIndex + 1).some((message) => message.role === "me" && message.content);
    const jobUrl = extractChatJobUrl(positionRoot || document);
    const currentHrName = selectedInfo?.hr_name || text(topRoot || document, ".name-text") || "";
    const currentCompany = selectedInfo?.company || extractCompanyFromTopInfo(topRoot);
    const currentJobTitle = text(positionRoot || document, ".position-name") || text(document, ".job-title") || "";
    return {
      source: "boss_chat_dom",
      page_url: location.href,
      hr_name: currentHrName || queueItem?.hr_name || "",
      hr_role: selectedInfo?.hr_role || queueItem?.hr_role || "",
      company: currentCompany || queueItem?.company || "",
      job_title: currentJobTitle || queueItem?.job_title || "",
      salary: text(positionRoot || document, ".salary"),
      city: text(positionRoot || document, ".city"),
      latest_hr_message: latestHr?.content || "",
      latest_message_role: latestMessage?.role || "",
      has_user_replied_after_latest_hr: hasUserRepliedAfterLatestHr,
      queued_latest_hr_message: queueItem?.latest_hr_message || "",
      conversation: messages.slice(-10),
      job_detail_entry: {
        has_entry: Boolean(jobUrl || findJobDetailEntry()),
        job_url: jobUrl,
        text: findJobDetailEntryText(),
      },
      jd_text: findCachedJdTextForChat({ company: currentCompany, job_title: currentJobTitle }),
      selected_unique_id_hint: selectedInfo?.dataHint || "",
      selected_from_list: Boolean(selectedInfo),
      current_chat_identity: {
        hr_name: currentHrName,
        company: currentCompany,
        job_title: currentJobTitle,
        data_hint: selectedInfo?.dataHint || "",
      },
      ui: {
        input_selector: "#chat-input[contenteditable='true']",
        send_button_selector: ".chat-op .btn-send",
        send_button_enabled: isSendButtonEnabled(),
      },
    };
  }

  function currentChatAlreadyReplied(evidence) {
    return evidence?.latest_message_role === "me"
      || evidence?.has_user_replied_after_latest_hr === true;
  }

  function extractVisibleChatMessages() {
    const collection = collectChatMessageNodes();
    const nodes = collection.nodes;
    const extracted = nodes.map((node) => extractChatMessage(node));
    const messages = extracted
      .filter((message) => !shouldSkipChatMessage(message))
      .slice(-12);
    updateChatMessageDiagnostics(nodes.length, messages, collection.diagnostics);
    return messages;
  }

  function chatMessageNodes(root = document) {
    return collectChatMessageNodes(root).nodes;
  }

  function collectChatMessageNodes(root = document) {
    const containers = chatMessageContainers(root);
    const visibleContainers = containers
      .filter((node) => !node.closest?.(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter(isVisibleChatNode);
    const candidateContainers = mostSpecificVisibleChatMessageContainers(visibleContainers);
    const containerInfos = candidateContainers
      .map((container, index) => {
        const nodes = chatMessageNodesInContainer(container);
        const messages = nodes.map((node) => extractChatMessage(node)).filter((message) => !shouldSkipChatMessage(message));
        const rect = container.getBoundingClientRect?.() || {};
        const visibleArea = visibleChatRectArea(rect);
        const activeScore = chatMessageContainerActiveScore(container);
        const inputScore = chatMessageContainerInputScore(container);
        return {
          container,
          index,
          nodes,
          textCount: messages.length,
          area: Number(rect.width || 0) * Number(rect.height || 0),
          visibleArea,
          bottom: Number(rect.bottom || 0),
          specificity: chatMessageContainerSpecificity(container),
          activeScore,
          inputScore,
        };
      })
      .filter((info) => info.nodes.length);
    const textContainers = containerInfos.filter((info) => info.textCount > 0);
    const selected = selectCurrentChatMessageContainer(textContainers.length ? textContainers : containerInfos);
    const selectedMessageContainerReason = selected?.selectionReason
      || (containerInfos.length ? "ambiguous" : "none");
    return {
      nodes: selected?.nodes || [],
      diagnostics: {
        messageContainerCount: containers.length,
        visibleMessageContainerCount: visibleContainers.length,
        candidateMessageContainerCount: candidateContainers.length,
        selectedMessageContainerIndex: selected?.index ?? -1,
        selectedMessageContainerTextCount: selected?.textCount || 0,
        selectedMessageContainerReason,
      },
    };
  }

  function chatMessageContainers(root = document) {
    const selector = ".conversation-message,.chat-conversation";
    const candidates = [];
    if (root.matches?.(selector)) candidates.push(root);
    candidates.push(...Array.from(root.querySelectorAll?.(selector) || []));
    return uniqueElements(candidates);
  }

  function mostSpecificVisibleChatMessageContainers(containers) {
    return containers.filter((container) => !containers.some((other) => (
      other !== container
      && container.contains?.(other)
      && chatMessageContainerSpecificity(other) >= chatMessageContainerSpecificity(container)
    )));
  }

  function selectCurrentChatMessageContainer(containerInfos) {
    if (!containerInfos.length) return null;
    if (containerInfos.length === 1) {
      return { ...containerInfos[0], selectionReason: "single" };
    }
    const sorted = [...containerInfos].sort(compareChatMessageContainerCandidate);
    const best = sorted[0];
    const second = sorted[1];
    if (best.activeScore > second.activeScore) return { ...best, selectionReason: "active" };
    if (best.inputScore > second.inputScore) return { ...best, selectionReason: "input" };
    if (best.visibleArea > 0 && best.visibleArea >= second.visibleArea * 1.6) {
      return { ...best, selectionReason: "visible_area" };
    }
    return null;
  }

  function compareChatMessageContainerCandidate(left, right) {
    return right.activeScore - left.activeScore
      || right.inputScore - left.inputScore
      || right.specificity - left.specificity
      || right.visibleArea - left.visibleArea
      || right.area - left.area;
  }

  function chatMessageContainerSpecificity(container) {
    if (container.matches?.(".conversation-message")) return 2;
    if (container.matches?.(".chat-conversation")) return 1;
    return 0;
  }

  function chatMessageContainerActiveScore(container) {
    let score = 0;
    if (hasActiveChatContainerMarker(container)) score += 100;
    if (chatClassTokens(container).some(isActiveChatContainerClass)) score += 30;
    return score;
  }

  function isActiveChatContainerClass(className) {
    return /(^|[-_])(selected|active|current)([-_]|$)/i.test(className)
      && !/(^|[-_])inactive([-_]|$)/i.test(className);
  }

  function hasActiveChatContainerMarker(container) {
    return Boolean(
      container.getAttribute?.("aria-selected") === "true"
      || container.getAttribute?.("aria-current") === "true"
      || container.getAttribute?.("data-active") === "true"
      || container.getAttribute?.("data-current") === "true"
    );
  }

  function chatMessageContainerInputScore(container) {
    const input = document.querySelector?.("#chat-input[contenteditable='true']");
    if (!input) return 0;
    const activeRoot = input.closest?.(".chat-conversation,.chat-detail,.chat-container,[class*='chat']");
    if (!activeRoot || !(activeRoot === container || activeRoot.contains?.(container))) return 0;
    const containerRect = container.getBoundingClientRect?.();
    const inputRect = input.getBoundingClientRect?.();
    if (!containerRect || !inputRect) return 1;
    return containerRect.bottom <= inputRect.top ? 2 : 1;
  }

  function visibleChatRectArea(rect) {
    const width = Number(rect?.width || 0);
    const height = Number(rect?.height || 0);
    if (!width || !height) return 0;
    const viewportWidth = Number(window.innerWidth || document.documentElement?.clientWidth || width);
    const viewportHeight = Number(window.innerHeight || document.documentElement?.clientHeight || height);
    const left = Math.max(0, Number(rect.left || 0));
    const top = Math.max(0, Number(rect.top || 0));
    const right = Math.min(viewportWidth, Number(rect.right || 0));
    const bottom = Math.min(viewportHeight, Number(rect.bottom || 0));
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function chatMessageNodesInContainer(container) {
    const selectors = [
      ".message-item",
      ".item-friend",
      ".item-myself",
      "[class*='message-item']",
      "[class*='item-friend']",
      "[class*='item-myself']",
      ".message-content",
      "[class*='message-content']",
    ];
    const candidates = selectors.flatMap((selector) => Array.from(container.querySelectorAll(selector)));
    return dedupeCanonicalChatMessageNodes(candidates.map(normalizeChatMessageNode))
      .filter((node) => node && (node === container || container.contains?.(node)))
      .filter((node) => !node.closest?.(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => !hasMixedChatRoles(node))
      .filter(isVisibleChatNode)
      .sort(compareChatMessageDocumentOrder);
  }

  function isVisibleChatNode(node) {
    if (!node) return false;
    for (let current = node; current; current = current.parentNode) {
      if (current.getAttribute?.("aria-hidden") === "true" || current.hasAttribute?.("hidden") || current.inert === true) return false;
      const inlineDisplay = current.style?.display;
      const inlineVisibility = current.style?.visibility;
      if (inlineDisplay === "none" || inlineVisibility === "hidden" || inlineVisibility === "collapse") return false;
      const canReadComputedStyle = current.nodeType === undefined || current.nodeType === 1;
      if (canReadComputedStyle && typeof getComputedStyle === "function") {
        const style = getComputedStyle(current);
        if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
      }
    }
    const rects = node.getClientRects?.();
    if (rects && rects.length === 0) return false;
    const rect = node.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function compareChatMessageDocumentOrder(left, right) {
    if (left === right) return 0;
    const visualOrder = compareChatMessageVisualOrder(left, right);
    if (visualOrder !== 0) return visualOrder;
    const position = left.compareDocumentPosition?.(right) || 0;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function compareChatMessageVisualOrder(left, right) {
    const leftRect = left.getBoundingClientRect?.();
    const rightRect = right.getBoundingClientRect?.();
    if (!leftRect || !rightRect) return 0;
    const topDelta = leftRect.top - rightRect.top;
    if (Math.abs(topDelta) > 2) return topDelta;
    const bottomDelta = leftRect.bottom - rightRect.bottom;
    if (Math.abs(bottomDelta) > 2) return bottomDelta;
    return 0;
  }

  function normalizeChatMessageNode(node) {
    if (!node) return null;
    const roleNode = closestSingleRoleChatNode(node);
    if (roleNode) return roleNode;
    const messageItem = closestOrSelf(node, ".message-item,[class*='message-item']");
    if (!messageItem) return node;
    const roleChildren = chatRoleDescendantNodes(messageItem);
    if (roleChildren.length === 1) return roleChildren[0];
    if (roleChildren.length > 1) return null;
    return hasMixedChatRoles(messageItem) ? null : messageItem;
  }

  function dedupeCanonicalChatMessageNodes(nodes) {
    const unique = uniqueElements(nodes);
    return unique.filter((node) => !unique.some((other) => shouldPreferNestedChatMessageNode(other, node)));
  }

  function shouldPreferNestedChatMessageNode(candidate, current) {
    if (!candidate || !current || candidate === current) return false;
    const candidateContainsCurrent = candidate.contains?.(current);
    const currentContainsCandidate = current.contains?.(candidate);
    if (!candidateContainsCurrent && !currentContainsCandidate) return false;
    const candidateRank = chatMessageNodeRank(candidate);
    const currentRank = chatMessageNodeRank(current);
    return candidateRank > currentRank;
  }

  function chatMessageNodeRank(node) {
    if (isSingleRoleChatNode(node)) return 3;
    if (node.matches?.(".message-item,[class*='message-item']")) return 2;
    if (node.matches?.(".message-content,[class*='message-content']")) return 1;
    return 0;
  }

  function closestOrSelf(node, selector) {
    if (!node) return null;
    if (node.matches?.(selector)) return node;
    return node.closest?.(selector) || null;
  }

  function closestSingleRoleChatNode(node) {
    let current = node;
    while (current) {
      if (isSingleRoleChatNode(current)) return current;
      current = current.parentNode;
    }
    return null;
  }

  function chatRoleDescendantNodes(node) {
    const roleNodes = uniqueElements(Array.from(node?.querySelectorAll?.(chatRoleCandidateSelector()) || []))
      .filter(isSingleRoleChatNode);
    return roleNodes.filter((roleNode) => !roleNodes.some((other) => (
      other !== roleNode
      && roleNode.contains?.(other)
      && chatMessageNodeRank(other) > chatMessageNodeRank(roleNode)
    )));
  }

  function isSingleRoleChatNode(node) {
    return Boolean(chatRoleKind(node));
  }

  function extractChatMessage(node) {
    const messageType = detectChatMessageType(node);
    const role = messageType === "system" ? "system" : detectChatMessageRole(node);
    const content = messageType === "text" ? clipText(extractChatTextContent(node), 700) : "";
    return {
      mid: String(node.getAttribute("data-mid") || ""),
      role,
      content,
      time_text: text(node, ".time,.message-time,[class*='time']"),
      message_type: messageType,
    };
  }

  function detectChatMessageType(node) {
    if (isSystemChatMessageNode(node)) return "system";
    if (isJobCardChatMessageNode(node)) return "job_card";
    if (isCompetitivenessChatMessageNode(node)) return "analysis_card";
    if (node.querySelector("img") && !extractChatTextContent(node)) return "image";
    return "text";
  }

  function detectChatMessageRole(node) {
    if (hasMixedChatRoles(node)) return "system";
    const role = chatRoleKind(node);
    if (role) return role;
    return inferChatRoleByPosition(node);
  }

  function chatRoleKind(node) {
    if (!node) return "";
    if (!chatRoleNodeHasContent(node)) return "";
    const hasMe = hasChatRoleMarker(node, "item-myself");
    const hasHr = hasChatRoleMarker(node, "item-friend");
    if (hasMe && !hasHr) return "me";
    if (hasHr && !hasMe) return "hr";
    return "";
  }

  function hasMixedChatRoles(node) {
    if (!node) return false;
    const roles = new Set();
    const selfRole = chatRoleKind(node);
    if (selfRole) roles.add(selfRole);
    chatRoleDescendantNodes(node).forEach((roleNode) => {
      const role = chatRoleKind(roleNode);
      if (role) roles.add(role);
    });
    return roles.has("me") && roles.has("hr");
  }

  function chatRoleCandidateSelector() {
    return ".item-friend,.item-myself,[class*='item-friend'],[class*='item-myself']";
  }

  function chatRoleNodeHasContent(node) {
    return Boolean(extractChatTextContent(node));
  }

  function hasChatRoleMarker(node, roleClassName) {
    if (node.classList?.contains(roleClassName)) return true;
    return chatClassTokens(node).some((className) => (
      className.includes(roleClassName)
      && !isDecorativeChatRoleClass(className)
    ));
  }

  function chatClassTokens(node) {
    return String(node?.className || "").split(/\s+/).filter(Boolean);
  }

  function isDecorativeChatRoleClass(className) {
    return /avatar|icon|name|time|status|content|text|image|img|photo|head|badge|label|meta/i.test(className);
  }

  function inferChatRoleByPosition(node) {
    const bubble = chatTextContainer(node) || node;
    const root = node.closest?.(".conversation-message") || document.querySelector(".conversation-message") || node.closest?.(".chat-conversation");
    const bubbleRect = bubble.getBoundingClientRect?.();
    const rootRect = root?.getBoundingClientRect?.();
    if (!bubbleRect || !rootRect || !rootRect.width) return "system";
    const bubbleCenter = bubbleRect.left + bubbleRect.width / 2;
    const rootCenter = rootRect.left + rootRect.width / 2;
    return bubbleCenter <= rootCenter ? "hr" : "me";
  }

  function extractChatTextContent(node) {
    const selectors = [
      ".message-content .text",
      ".message-content [class*='text']",
      ".text",
      ".message-content",
      "[class*='message-content']",
      ".message-text",
      "[class*='message-text']",
    ];
    for (const selector of selectors) {
      const contentNode = firstMatchingDescendant(node, selector);
      const value = inlineText(contentNode);
      if (value && !isTimeOnlyChatText(value)) return value;
    }
    return "";
  }

  function chatTextContainer(node) {
    return firstMatchingDescendant(node, ".message-content")
      || firstMatchingDescendant(node, "[class*='message-content']")
      || firstMatchingDescendant(node, ".text")
      || node;
  }

  function firstMatchingDescendant(node, selector) {
    if (!node) return null;
    if (node.matches?.(selector)) return node;
    return node.querySelector?.(selector) || null;
  }

  function shouldSkipChatMessage(message) {
    if (!message || !message.content) return true;
    if (message.message_type !== "text") return true;
    if (message.role !== "hr" && message.role !== "me") return true;
    return isTimeOnlyChatText(message.content);
  }

  function isSystemChatMessageNode(node) {
    return Boolean(
      node.classList?.contains("item-system") ||
      node.closest?.(".item-system,.system-msg,.system-message") ||
      node.querySelector?.(".item-system,.system-msg,.system-message"),
    );
  }

  function isJobCardChatMessageNode(node) {
    const selector = ".item-jobdesc,.job-desc,.job-title,.job-card,.position-card,[class*='job-card'],[class*='position-card'],[class*='jobdesc'],[ka='geek_chat_job_detail']";
    if (node.matches?.(selector) || node.querySelector?.(selector)) return true;
    const value = inlineText(node);
    return /查看职位|职位详情|岗位详情/.test(value) && /职位|岗位|薪|K|k/.test(value);
  }

  function isCompetitivenessChatMessageNode(node) {
    const selector = ".competitiveness-card,.analysis-card,[class*='competitiveness'],[class*='competition'],[class*='analysis-card']";
    if (node.matches?.(selector) || node.querySelector?.(selector)) return true;
    return /竞争力分析|竞争力|竞争优势/.test(inlineText(node));
  }

  function isTimeOnlyChatText(value) {
    const normalized = String(value || "").trim();
    if (!normalized) return true;
    return /^(?:\d{1,2}:\d{2}|\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|今天(?:\s+\d{1,2}:\d{2})?|昨天(?:\s+\d{1,2}:\d{2})?|周[一二三四五六日天](?:\s+\d{1,2}:\d{2})?|星期[一二三四五六日天](?:\s+\d{1,2}:\d{2})?)$/.test(normalized);
  }

  function updateChatMessageDiagnostics(messageNodeCount, messages, containerDiagnostics = {}) {
    const textMessages = messages.filter((message) => message.message_type === "text" && message.content);
    const tailMessageRoles = textMessages.slice(-5).map((message) => message.role).join(">");
    const latestMessageRole = textMessages[textMessages.length - 1]?.role || "";
    runtimeState.chatMessageDiagnostics = {
      messageNodeCount: Number(messageNodeCount || 0),
      messageContainerCount: Number(containerDiagnostics.messageContainerCount || 0),
      visibleMessageContainerCount: Number(containerDiagnostics.visibleMessageContainerCount || 0),
      candidateMessageContainerCount: Number(containerDiagnostics.candidateMessageContainerCount || 0),
      selectedMessageContainerIndex: Number(containerDiagnostics.selectedMessageContainerIndex ?? -1),
      selectedMessageContainerTextCount: Number(containerDiagnostics.selectedMessageContainerTextCount || 0),
      selectedMessageContainerReason: String(containerDiagnostics.selectedMessageContainerReason || ""),
      hrMessageCount: messages.filter((message) => message.role === "hr").length,
      myMessageCount: messages.filter((message) => message.role === "me").length,
      textMessageCount: textMessages.length,
      tailMessageRoles,
      latestMessageRole,
    };
    renderRuntimeState();
  }

  function runChatMessageCanonicalProbe() {
    let order = 0;
    function probeClassNames(node) {
      return String(node?.className || "").split(/\s+/).filter(Boolean);
    }
    function probeMatchesSelector(node, selector) {
      return String(selector || "")
        .split(",")
        .some((part) => probeMatchesSingleSelector(node, part.trim()));
    }
    function probeMatchesSingleSelector(node, selector) {
      if (!node || !selector) return false;
      if (/\s/.test(selector)) {
        const parts = selector.split(/\s+/).filter(Boolean);
        const leafSelector = parts.pop();
        if (!probeMatchesSelector(node, leafSelector)) return false;
        const ancestorSelector = parts.join(" ");
        let parent = node.parentNode;
        while (parent) {
          if (probeMatchesSelector(parent, ancestorSelector)) return true;
          parent = parent.parentNode;
        }
        return false;
      }
      if (selector.startsWith("#")) return node.id === selector.slice(1);
      if (selector.startsWith(".")) return probeClassNames(node).includes(selector.slice(1));
      const classContains = selector.match(/^\[class\*=['"]([^'"]+)['"]\]$/);
      if (classContains) return String(node.className || "").includes(classContains[1]);
      return false;
    }
    class ProbeNode {
      constructor(className, textValue, top, left, options = {}) {
        this.id = "";
        this.className = className;
        this._textValue = textValue || "";
        this.children = [];
        this.parentNode = null;
        this.attributes = { ...(options.attributes || {}) };
        this.style = { ...(options.style || {}) };
        this.inert = Boolean(options.inert);
        this.__order = order;
        order += 1;
        const width = options.width ?? 120;
        const height = options.height ?? 18;
        this.__rect = options.rect || { top, bottom: top + height, left, right: left + width, width, height };
        this.__clientRects = options.clientRects || (width > 0 && height > 0 ? [this.__rect] : []);
        this.classList = {
          contains: (classNameValue) => probeClassNames(this).includes(classNameValue),
        };
      }
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      }
      get textContent() {
        return this._textValue || this.children.map((child) => child.textContent).join("");
      }
      get innerText() {
        return this.textContent;
      }
      matches(selector) {
        return probeMatchesSelector(this, selector);
      }
      closest(selector) {
        let current = this;
        while (current) {
          if (current.matches(selector)) return current;
          current = current.parentNode;
        }
        return null;
      }
      querySelectorAll(selector) {
        const results = [];
        const visit = (node) => {
          node.children.forEach((child) => {
            if (child.matches(selector)) results.push(child);
            visit(child);
          });
        };
        visit(this);
        return results;
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      }
      contains(other) {
        let current = other;
        while (current) {
          if (current === this) return true;
          current = current.parentNode;
        }
        return false;
      }
      getBoundingClientRect() {
        return this.__rect;
      }
      getClientRects() {
        return this.__clientRects;
      }
      getAttribute(name) {
        return this.attributes[name] || "";
      }
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name);
      }
      compareDocumentPosition(other) {
        if (!other || this === other) return 0;
        if (this.__order < other.__order) return Node.DOCUMENT_POSITION_FOLLOWING;
        return Node.DOCUMENT_POSITION_PRECEDING;
      }
    }

    function summarizeProbe(root) {
      const nodes = chatMessageNodes(root);
      const messages = nodes.map((node) => extractChatMessage(node)).filter((message) => !shouldSkipChatMessage(message));
      const roles = messages.map((message) => message.role);
      return {
        nodes,
        messages,
        nodeCount: nodes.length,
        nodeClasses: nodes.map((node) => node.className),
        roles: roles.join(">"),
        latestRole: roles[roles.length - 1] || "",
      };
    }

    const normalRoot = new ProbeNode("chat-conversation", "", 0, 0, { width: 320, height: 120 });
    const normalList = normalRoot.appendChild(new ProbeNode("conversation-message", "", 0, 0, { width: 320, height: 120 }));
    const normalHr = normalList.appendChild(new ProbeNode("item-friend", "", 10, 0));
    const normalHrContent = normalHr.appendChild(new ProbeNode("message-content", "", 10, 0));
    normalHrContent.appendChild(new ProbeNode("text", "normal hr text", 10, 0));
    const normalMe = normalList.appendChild(new ProbeNode("item-myself", "", 40, 200));
    const normalMeContent = normalMe.appendChild(new ProbeNode("message-content", "", 40, 200));
    normalMeContent.appendChild(new ProbeNode("text", "normal me text", 40, 200));

    const mixedRoot = new ProbeNode("chat-conversation", "", 0, 0);
    const mixedList = mixedRoot.appendChild(new ProbeNode("conversation-message", "", 0, 0));
    const mixedMessageItem = mixedList.appendChild(new ProbeNode("message-item", "", 10, 0));
    const me = mixedMessageItem.appendChild(new ProbeNode("item-myself", "", 10, 220));
    const meContent = me.appendChild(new ProbeNode("message-content", "", 10, 220));
    meContent.appendChild(new ProbeNode("text", "me text", 10, 220));
    const hr = mixedMessageItem.appendChild(new ProbeNode("item-friend", "", 40, 0));
    const hrContent = hr.appendChild(new ProbeNode("message-content", "", 40, 0));
    hrContent.appendChild(new ProbeNode("text", "hr text", 40, 0));

    const decoratedRoot = new ProbeNode("chat-conversation", "", 0, 0);
    const decoratedList = decoratedRoot.appendChild(new ProbeNode("conversation-message", "", 0, 0));
    const decoratedFriend = decoratedList.appendChild(new ProbeNode("item-friend", "", 10, 0));
    decoratedFriend.appendChild(new ProbeNode("item-friend-avatar", "", 10, 0));
    const decoratedContent = decoratedFriend.appendChild(new ProbeNode("message-content", "", 10, 40));
    decoratedContent.appendChild(new ProbeNode("text", "decorated hr text", 10, 40));

    const duplicateRoot = new ProbeNode("chat-conversation", "", 0, 0, { width: 360, height: 260 });
    const visibleList = duplicateRoot.appendChild(new ProbeNode("conversation-message", "", 0, 0, { width: 360, height: 120 }));
    const visibleMe = visibleList.appendChild(new ProbeNode("item-myself", "", 10, 220));
    const visibleMeContent = visibleMe.appendChild(new ProbeNode("message-content", "", 10, 220));
    visibleMeContent.appendChild(new ProbeNode("text", "visible me text", 10, 220));
    const visibleHr = visibleList.appendChild(new ProbeNode("item-friend", "", 40, 0));
    const visibleHrContent = visibleHr.appendChild(new ProbeNode("message-content", "", 40, 0));
    visibleHrContent.appendChild(new ProbeNode("text", "visible hr text", 40, 0));
    const hiddenList = duplicateRoot.appendChild(new ProbeNode("conversation-message", "", 130, 0, {
      attributes: { "aria-hidden": "true" },
      width: 360,
      height: 120,
    }));
    const hiddenHr = hiddenList.appendChild(new ProbeNode("item-friend", "", 130, 0));
    const hiddenHrContent = hiddenHr.appendChild(new ProbeNode("message-content", "", 130, 0));
    hiddenHrContent.appendChild(new ProbeNode("text", "hidden hr text", 130, 0));
    const hiddenMe = hiddenList.appendChild(new ProbeNode("item-myself", "", 170, 220));
    const hiddenMeContent = hiddenMe.appendChild(new ProbeNode("message-content", "", 170, 220));
    hiddenMeContent.appendChild(new ProbeNode("text", "hidden me text", 170, 220));

    const siblingRoot = new ProbeNode("chat-conversation", "", 0, 0, { width: 360, height: 300 });
    const currentSiblingList = siblingRoot.appendChild(new ProbeNode("conversation-message active", "", 0, 0, { width: 360, height: 120 }));
    const currentSiblingMe = currentSiblingList.appendChild(new ProbeNode("item-myself", "", 10, 220));
    const currentSiblingMeContent = currentSiblingMe.appendChild(new ProbeNode("message-content", "", 10, 220));
    currentSiblingMeContent.appendChild(new ProbeNode("text", "current visible me text", 10, 220));
    const currentSiblingHr = currentSiblingList.appendChild(new ProbeNode("item-friend", "", 40, 0));
    const currentSiblingHrContent = currentSiblingHr.appendChild(new ProbeNode("message-content", "", 40, 0));
    currentSiblingHrContent.appendChild(new ProbeNode("text", "current visible hr text", 40, 0));
    const oldSiblingList = siblingRoot.appendChild(new ProbeNode("conversation-message", "", 150, 0, { width: 360, height: 120 }));
    const oldSiblingHr = oldSiblingList.appendChild(new ProbeNode("item-friend", "", 150, 0));
    const oldSiblingHrContent = oldSiblingHr.appendChild(new ProbeNode("message-content", "", 150, 0));
    oldSiblingHrContent.appendChild(new ProbeNode("text", "old visible hr text", 150, 0));
    const oldSiblingMe = oldSiblingList.appendChild(new ProbeNode("item-myself", "", 190, 220));
    const oldSiblingMeContent = oldSiblingMe.appendChild(new ProbeNode("message-content", "", 190, 220));
    oldSiblingMeContent.appendChild(new ProbeNode("text", "old visible me text", 190, 220));

    const normal = summarizeProbe(normalRoot);
    const mixed = summarizeProbe(mixedRoot);
    const decorated = summarizeProbe(decoratedRoot);
    const duplicate = summarizeProbe(duplicateRoot);
    const sibling = summarizeProbe(siblingRoot);
    const normalOk = normal.nodeCount === 2 && normal.roles === "hr>me" && normal.latestRole === "me";
    const mixedOk = mixed.nodeCount === 2 && mixed.roles === "me>hr" && mixed.latestRole === "hr";
    const decoratedOk = decorated.nodeCount === 1
      && decorated.nodeClasses[0] === "item-friend"
      && decorated.roles === "hr"
      && decorated.latestRole === "hr"
      && decorated.messages[0]?.content === "decorated hr text";
    const duplicateOk = duplicate.nodeCount === 2 && duplicate.roles === "me>hr" && duplicate.latestRole === "hr";
    const siblingOk = sibling.nodeCount === 2 && sibling.roles === "me>hr" && sibling.latestRole === "hr";
    return {
      ok: normalOk && mixedOk && decoratedOk && duplicateOk && siblingOk,
      normal: {
        ok: normalOk,
        nodeCount: normal.nodeCount,
        roles: normal.roles,
        latestRole: normal.latestRole,
      },
      mixed: {
        ok: mixedOk,
        nodeCount: mixed.nodeCount,
        roles: mixed.roles,
        latestRole: mixed.latestRole,
      },
      decorated: {
        ok: decoratedOk,
        nodeCount: decorated.nodeCount,
        nodeClasses: decorated.nodeClasses,
        roles: decorated.roles,
        latestRole: decorated.latestRole,
        contentExtracted: decorated.messages[0]?.content === "decorated hr text",
      },
      duplicate: {
        ok: duplicateOk,
        nodeCount: duplicate.nodeCount,
        roles: duplicate.roles,
        latestRole: duplicate.latestRole,
      },
      visibleSiblings: {
        ok: siblingOk,
        nodeCount: sibling.nodeCount,
        roles: sibling.roles,
        latestRole: sibling.latestRole,
      },
    };
  }

  async function runDebugHrReplyButtonProbe() {
    function sequenceReader(sequence) {
      let index = 0;
      return async () => {
        const value = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        return value;
      };
    }
    const debugOffHidden = debugHrReplyButtonHtmlFor(false, "chat") === "";
    const initialChatVisible = /job-chat-debug-add/.test(debugHrReplyButtonHtmlFor(true, "chat"));
    const messageModeHidden = debugHrReplyButtonHtmlFor(true, "message") === "";
    const sameUrlMessageToChatRefresh = shouldRefreshChatShellForPageModeChange("message", "chat", "chat");
    const unchangedModeDoesNotRefresh = !shouldRefreshChatShellForPageModeChange("chat", "chat", "chat");
    const jobPanelDoesNotRefresh = !shouldRefreshChatShellForPageModeChange("message", "chat", "jobs");
    const transientRetryStates = [];
    const transientThenTrue = await resolveDebugHrReplyFlag(sequenceReader([
      { ok: false, hasValue: false, value: false, error: "temporary" },
      { ok: true, hasValue: true, value: true, error: "" },
    ]), {
      maxAttempts: 3,
      retryDelayMs: 0,
      onRetry: (state) => transientRetryStates.push(state.state),
    });
    const falseResult = await resolveDebugHrReplyFlag(sequenceReader([
      { ok: true, hasValue: true, value: false, error: "" },
    ]), { maxAttempts: 3, retryDelayMs: 0 });
    const trueResult = await resolveDebugHrReplyFlag(sequenceReader([
      { ok: true, hasValue: true, value: true, error: "" },
    ]), { maxAttempts: 3, retryDelayMs: 0 });
    const finiteRetryResult = await resolveDebugHrReplyFlag(sequenceReader([
      { ok: false, hasValue: false, value: false, error: "temporary" },
    ]), { maxAttempts: 2, retryDelayMs: 0 });
    const transientButtonAppears = transientThenTrue.state === "loaded"
      && transientThenTrue.enabled === true
      && transientThenTrue.attempts === 2
      && transientRetryStates.length === 1
      && /job-chat-debug-add/.test(debugHrReplyButtonHtmlFor(transientThenTrue.enabled, "chat"));
    const falseStaysHidden = falseResult.state === "loaded"
      && falseResult.enabled === false
      && falseResult.attempts === 1
      && debugHrReplyButtonHtmlFor(falseResult.enabled, "chat") === "";
    const trueShowsImmediately = trueResult.state === "loaded"
      && trueResult.enabled === true
      && trueResult.attempts === 1
      && /job-chat-debug-add/.test(debugHrReplyButtonHtmlFor(trueResult.enabled, "chat"));
    const retryIsFinite = finiteRetryResult.state === "error" && finiteRetryResult.attempts === 2;
    return {
      ok: debugOffHidden
        && initialChatVisible
        && messageModeHidden
        && sameUrlMessageToChatRefresh
        && unchangedModeDoesNotRefresh
        && jobPanelDoesNotRefresh
        && transientButtonAppears
        && falseStaysHidden
        && trueShowsImmediately
        && retryIsFinite,
      debugOffHidden,
      initialChatVisible,
      messageModeHidden,
      sameUrlMessageToChatRefresh,
      unchangedModeDoesNotRefresh,
      jobPanelDoesNotRefresh,
      transientButtonAppears,
      falseStaysHidden,
      trueShowsImmediately,
      retryIsFinite,
      transientAttempts: transientThenTrue.attempts,
      finiteRetryAttempts: finiteRetryResult.attempts,
    };
  }

  function extractCompanyFromTopInfo(root) {
    if (!root) return "";
    const candidates = [".company-name", ".brand-name", "[class*='company']", "[class*='brand']"];
    for (const selector of candidates) {
      const value = text(root, selector);
      if (value) return value;
    }
    return "";
  }

  function extractChatJobUrl(root) {
    const link = root?.querySelector?.("a[href*='/job_detail/']") || document.querySelector("a[href*='/job_detail/']");
    const raw = link?.href || link?.getAttribute?.("href") || "";
    try {
      return raw ? new URL(raw, location.href).href : "";
    } catch (_) {
      return "";
    }
  }

  function findJobDetailEntry() {
    return document.querySelector(".position-content[ka='geek_chat_job_detail']")
      || Array.from(document.querySelectorAll(".chat-position-content *, .position-content *"))
        .find((node) => /查看职位/.test(inlineText(node)));
  }

  function findJobDetailEntryText() {
    const entry = findJobDetailEntry();
    return entry ? clipText(inlineText(entry), 120) : "";
  }

  function findCachedJdTextForChat(evidence) {
    try {
      const raw = sessionStorage.getItem(SESSION_JOBS_KEY);
      if (!raw) return "";
      const data = JSON.parse(raw);
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const title = compactForMatch(evidence.job_title).slice(0, 12);
      const company = compactForMatch(evidence.company).slice(0, 12);
      const matched = jobs.find((job) => {
        const jobTitle = compactForMatch(job.title);
        const jobCompany = compactForMatch(job.company);
        return Boolean(
          job.jd_text &&
          (!title || jobTitle.includes(title) || title.includes(jobTitle.slice(0, 8))) &&
          (!company || jobCompany.includes(company) || company.includes(jobCompany.slice(0, 8))),
        );
      });
      return String(matched?.jd_text || "").slice(0, 8000);
    } catch (_) {
      return "";
    }
  }

  function isSendButtonEnabled() {
    const button = document.querySelector(".chat-op .btn-send");
    if (!button) return false;
    return !button.disabled && !button.classList.contains("disabled");
  }

  async function requestChatReply(evidence) {
    const cfg = await storageGet(["apiUrl", "resume_text", "resume_profile"]);
    const api = chatReplyUrlFor(resolveApiUrl(cfg.apiUrl));
    const payload = {
      hr_message: evidence.latest_hr_message,
      conversation: evidence.conversation.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      job_title: evidence.job_title || "",
      company: evidence.company || "",
      city: evidence.city || "",
      salary: evidence.salary || "",
      jd_text: evidence.jd_text || "",
      resume_text: String(cfg.resume_text || ""),
      resume_profile: cfg.resume_profile || undefined,
      evidence_context: buildChatEvidenceContext(evidence),
      evidence_sources: ["boss_chat_dom"],
    };

    if (canUseBackgroundRequest()) {
      const result = await sendRuntimeMessageWithTimeout({
        action: "jobAccelerator.chatReply",
        apiUrl: api,
        apiToken: DEFAULT_API_TOKEN,
        payload,
        timeoutMs: CHAT_REPLY_TIMEOUT_MS,
      }, CHAT_REPLY_TIMEOUT_MS);
      if (!result?.ok) {
        throw new Error(result?.error || (result?.status ? `HTTP ${result.status}` : "Background chat reply request failed"));
      }
      setLastRequestId(result.request_id || result.data?.request_id);
      return unwrapApiResponse(result.data);
    }

    const response = await fetchWithTimeout(api, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(payload),
    }, CHAT_REPLY_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return unwrapApiResponse(await response.json());
  }

  async function handleChatReplyResult(reply, evidence, item) {
    const data = reply || {};
    const modeText = data.reply_mode ? `reply_mode=${data.reply_mode}` : "reply_mode=unknown";
    const durationText = Number.isFinite(Number(data.duration_ms)) ? `，耗时 ${data.duration_ms}ms` : "";
    const allowed = data.should_fill === true && data.action_policy === "fill_draft" && String(data.draft || "").trim();
    if (!allowed) {
      const reason = [
        data.reason || "后端建议用户接管，本次不填草稿。",
        data.missing_evidence?.length ? `缺少证据：${data.missing_evidence.join("；")}` : "",
        `${modeText}${durationText}`,
      ].filter(Boolean).join("\n");
      if (item?.id) await markHrReplyQueueItem(item.id, "needs_user", reason);
      await renderChatAssistant(reason);
      return { ok: true, filled: false, data, message: reason };
    }

    const input = await waitForChatInput();
    if (!input) {
      const message = "没有找到聊天输入框，未填入草稿。";
      if (item?.id) await markHrReplyQueueItem(item.id, "needs_user", message);
      await renderChatAssistant(message);
      return { ok: false, filled: false, data, error: message };
    }
    const fillEvidence = extractCurrentChatEvidence(item);
    if (!replyTargetStillCurrent(evidence, fillEvidence, item)) {
      return stopHrReplyForConversationMismatch(item);
    }
    if (currentChatAlreadyReplied(fillEvidence)) {
      return stopHrReplyBecauseAlreadyReplied(item);
    }
    const currentInput = findChatInput();
    if (!currentInput || currentInput !== input) {
      const message = "聊天输入框在生成期间发生变化，未填入草稿，请重新处理。";
      if (item?.id) await markHrReplyQueueItem(item.id, "needs_user", message);
      await renderChatAssistant(message);
      return { ok: false, filled: false, data, error: message };
    }
    fillChatInput(currentInput, String(data.draft || "").trim());
    const message = `草稿已填入，请用户确认发送。\n${modeText}${durationText}`;
    if (item?.id) await markHrReplyQueueItem(item.id, "draft_filled", message, { statusReason: "draft_filled", cleanupDuplicates: true });
    renderHrReplyDraftHelper(evidence, data);
    await renderChatAssistant(message);
    return { ok: true, filled: true, data, message };
  }

  function buildChatEvidenceContext(evidence) {
    return [
      evidence.hr_name && `HR：${evidence.hr_name}`,
      evidence.hr_role && `HR身份：${evidence.hr_role}`,
      evidence.company && `公司：${evidence.company}`,
      evidence.job_title && `岗位：${evidence.job_title}`,
      evidence.salary && `薪资：${evidence.salary}`,
      evidence.city && `城市：${evidence.city}`,
      evidence.job_detail_entry?.has_entry ? `职位入口：${evidence.job_detail_entry.job_url || evidence.job_detail_entry.text || "可见"}` : "",
    ].filter(Boolean).join("\n").slice(0, 8000);
  }

  async function markHrReplyQueueItem(itemId, status, note = "", options = {}) {
    if (!itemId) return;
    const stored = await storageGet([HR_REPLY_QUEUE_KEY]);
    const now = new Date().toISOString();
    const existingQueue = normalizeHrReplyQueue(stored[HR_REPLY_QUEUE_KEY]);
    const queue = existingQueue.map((item) => (
      item.id === itemId
        ? {
          ...item,
          status,
          statusReason: options.statusReason || item.statusReason || "",
          statusChangedAt: item.status === status
            ? (item.statusChangedAt || item.updatedAt || item.firstSeenAt || now)
            : now,
          note: clipText(note, 300),
          updatedAt: now,
        }
        : item
    ));
    const cleanedQueue = options.cleanupDuplicates
      ? cleanupHrReplyQueueAfterDraftFilled(queue, itemId)
      : queue;
    await storageSet({ [HR_REPLY_QUEUE_KEY]: cleanedQueue });
    updatePendingHrQueueCount(cleanedQueue);
  }

  function cleanupHrReplyQueueAfterDraftFilled(queue, itemId) {
    const target = queue.find((item) => item.id === itemId);
    if (!target || target.status !== "draft_filled") return queue;
    return queue.filter((item) => (
      item.id === itemId
      || !sameHrReplyQueueTarget(item, target)
      || !isSafeToRemoveAfterDraftFilled(item)
    ));
  }

  function isSafeToRemoveAfterDraftFilled(item) {
    return Boolean(
      item?.debug
      || item?.source === HR_REPLY_DEBUG_SOURCE
      || isRecoverableHrReplyQueueItem(item)
      || item?.status === "draft_filled"
    );
  }

  function isRecoverableHrReplyQueueItem(item = {}) {
    if (item.status !== "needs_user") return false;
    const textValue = [
      item.statusReason,
      item.status_reason,
      item.reason,
      item.note,
      item.error,
      item.message,
    ].map((value) => String(value || "").toLowerCase()).join(" ");
    return textValue.includes("conversation_mismatch")
      || textValue.includes("当前会话与待回复记录不一致")
      || textValue.includes("conversation mismatch");
  }

  function sameHrReplyQueueTarget(left = {}, right = {}) {
    if (!left || !right) return false;
    if (left.id && right.id && left.id === right.id) return true;
    const leftConversation = compactChatMatchValue(left.conversationFingerprint);
    const rightConversation = compactChatMatchValue(right.conversationFingerprint);
    if (leftConversation && rightConversation && leftConversation === rightConversation) return true;
    const leftHint = left.dataHint || left.data_hint;
    const rightHint = right.dataHint || right.data_hint;
    if (compactChatMatchValue(leftHint) && compactChatMatchValue(rightHint)) {
      const sameHint = HR_REPLY_DISCOVERY?.stableHintsMatch
        ? HR_REPLY_DISCOVERY.stableHintsMatch({ data_hint: leftHint }, { data_hint: rightHint })
        : exactChatMatchValue(leftHint, rightHint);
      if (sameHint) return true;
    }
    const sameName = hrNameMatches(left.hr_name, right.hr_name);
    const sameCompany = relatedChatMatchValue(left.company, right.company);
    const sameRole = !compactChatMatchValue(left.hr_role)
      || !compactChatMatchValue(right.hr_role)
      || relatedChatMatchValue(left.hr_role, right.hr_role);
    const sameMessage = chatMessageMatches(left.latest_hr_message, right.latest_hr_message)
      || (
        compactChatMatchValue(left.messageFingerprint)
        && compactChatMatchValue(left.messageFingerprint) === compactChatMatchValue(right.messageFingerprint)
      );
    return Boolean(sameName && sameCompany && sameRole && sameMessage);
  }

  async function removeHrReplyQueueItem(itemId) {
    if (!itemId) return;
    const stored = await storageGet([HR_REPLY_QUEUE_KEY]);
    const queue = normalizeHrReplyQueue(stored[HR_REPLY_QUEUE_KEY])
      .filter((item) => item.id !== itemId);
    await storageSet({ [HR_REPLY_QUEUE_KEY]: queue });
    updatePendingHrQueueCount(queue);
  }

  function rememberHrReplyTask(item) {
    try {
      sessionStorage.setItem(HR_REPLY_ACTIVE_TASK_KEY, JSON.stringify({
        item,
        createdAt: new Date().toISOString(),
      }));
    } catch (_) {}
  }

  function readHrReplyTask() {
    try {
      const raw = sessionStorage.getItem(HR_REPLY_ACTIVE_TASK_KEY);
      if (!raw) return null;
      const task = JSON.parse(raw);
      const createdAt = Date.parse(task?.createdAt || "");
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000) {
        forgetHrReplyTask();
        return null;
      }
      return task;
    } catch (_) {
      return null;
    }
  }

  function forgetHrReplyTask() {
    try {
      sessionStorage.removeItem(HR_REPLY_ACTIVE_TASK_KEY);
    } catch (_) {}
  }

  async function resumeHrReplyTaskIfNeeded() {
    const task = readHrReplyTask();
    if (!task || !isBossMessagePage()) return;
    // The persisted task only bridges the one user-approved navigation to the message page.
    // Consume it before processing so refreshes and network failures cannot auto-retry it.
    forgetHrReplyTask();
    await sleep(800);
    if (!panel) await show();
    await processHrReplyTarget(task.item || null);
  }

  async function runScheduledHrReplyScan() {
    if (!isBossMessagePage()) {
      return { ok: true, skipped: true, reason: "not_message_page" };
    }
    clearStaleTaskLock();
    if (hrReplyScheduledScanRunning || hrReplyProcessing || isAutoApplyBusy() || taskLock) {
      return { ok: true, skipped: true, reason: "busy" };
    }

    hrReplyScheduledScanRunning = true;
    try {
      const result = await scanHrReplyQueue({ source: "background_alarm", render: false });
      if (!result?.ok) return { ok: false, reason: "scan_failed" };
      return { ok: true, skipped: false, reason: "scan_complete", count: Number(result.count || 0) };
    } finally {
      hrReplyScheduledScanRunning = false;
    }
  }

  function renderHrReplyDraftHelper(evidence, reply) {
    document.getElementById(CHAT_HELPER_ID)?.remove();
    const helper = document.createElement("div");
    helper.id = CHAT_HELPER_ID;
    helper.innerHTML = `<style>
#${CHAT_HELPER_ID}{position:fixed;right:22px;bottom:88px;z-index:999999;background:#151820;color:#e6e8ee;border:1px solid #384255;border-radius:8px;box-shadow:0 8px 28px #0006;padding:12px;width:300px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#${CHAT_HELPER_ID} .helper-title{font-size:13px;font-weight:700;margin-bottom:6px;color:#fff}
#${CHAT_HELPER_ID} .helper-meta{font-size:11px;line-height:1.45;color:#aeb6c8;margin-bottom:8px}
#${CHAT_HELPER_ID} .helper-note{font-size:12px;line-height:1.45;color:#8fb8ff}
</style>
<div class="helper-title">草稿已填入</div>
<div class="helper-meta">${esc(evidence.company || "")} · ${esc(evidence.job_title || "")}<br>${esc(reply.reply_mode || "unknown")} / ${esc(reply.action_policy || "")}</div>
<div class="helper-note">请确认内容后手动发送。</div>`;
    document.body.appendChild(helper);
  }

  function isAutoApplyBusy() {
    return Boolean(isAutoApplyTaskActive() || autoApplyLoopRunning || autoApplyInProgress || analyzing || scanningMore);
  }

  function formatChatReplyError(error) {
    if (error?.name === "AbortError") return "HR 回复生成超时，未填入草稿。";
    const message = String(error?.message || error || "");
    if (/HTTP 401|HTTP 403/.test(message)) return "HR 回复接口访问令牌错误，未填入草稿。";
    if (/HTTP 429/.test(message)) return "HR 回复接口繁忙或限流，未填入草稿。";
    if (/Failed to fetch|NetworkError|Load failed|fetch|Extension message/i.test(message)) {
      return "HR 回复接口连接失败，未填入草稿；海投功能不受影响。";
    }
    return `HR 回复生成失败：${message || "未知错误"}。未填入草稿。`;
  }

  function chatReplyUrlFor(apiUrl) {
    const url = new URL(resolveApiUrl(apiUrl));
    url.pathname = url.pathname.replace(/\/match\/?$/, "/chat/reply");
    if (!url.pathname.endsWith("/chat/reply")) url.pathname = "/chat/reply";
    url.search = "";
    return url.toString();
  }

  function clipText(value, maxLength) {
    const textValue = String(value || "").replace(/\s+/g, " ").trim();
    return textValue.length > maxLength ? `${textValue.slice(0, maxLength - 1)}…` : textValue;
  }

  function bindShell() {
    document.getElementById("job-accelerator-close")?.addEventListener("click", hide);
    document.getElementById("job-accelerator-start")?.addEventListener("click", async () => {
      const button = document.getElementById("job-accelerator-start");
      if (button) {
        button.disabled = true;
        button.textContent = "海投进行中";
      }
      try {
        enableAutoApplyTask();
        await saveJobPanelControls();
        await runAutoApplyLoop("启动海投：扫描当前可见岗位。");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "启动海投";
        }
      }
    });
    document.getElementById("job-accelerator-refresh")?.addEventListener("click", async () => {
      await saveJobPanelControls();
      await refreshVisibleJobs("刷新当前可见岗位。");
    });
    document.getElementById("job-accelerator-next")?.addEventListener("click", continueScan);
    document.getElementById("job-accelerator-export")?.addEventListener("click", exportCsv);
    document.getElementById("job-accelerator-pause")?.addEventListener("click", () => setPaused(!paused));
    document.getElementById("job-accelerator-clear-cache")?.addEventListener("click", clearAnalysisCacheFromPanel);
    document.getElementById("job-accelerator-clear-low")?.addEventListener("click", () => {
      hideLowMatches = true;
      render(latestJobs);
      const button = document.getElementById("job-accelerator-clear-low");
      if (button) button.disabled = true;
    });
  }

  async function hydrateJobPanelControls() {
    const cfg = await storageGet([
      "apply_title_keywords",
      "apply_location_keywords",
      "exclude_keywords",
      "min_score",
      "daily_goal",
      "auto_confirm_chat",
      "apply_mode",
    ]);
    activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
    activeMinScore = normalizeMinScore(cfg.min_score);
    activeApplyMode = normalizeApplyMode(cfg.apply_mode);
    activeAutoConfirmChat = cfg.auto_confirm_chat === undefined ? DEFAULT_AUTO_CONFIRM_CHAT : Boolean(cfg.auto_confirm_chat);
    activeTitleKeywords = parseFilterKeywords(cfg.apply_title_keywords);
    activeLocationKeywords = parseFilterKeywords(cfg.apply_location_keywords);
    const dailyGoalInput = document.getElementById("job-accelerator-daily-goal");
    const titleInput = document.getElementById("job-accelerator-title-filter");
    const locationInput = document.getElementById("job-accelerator-location-filter");
    const excludeInput = document.getElementById("job-accelerator-exclude-filter");
    const minScoreInput = document.getElementById("job-accelerator-min-score");
    const autoConfirmInput = document.getElementById("job-accelerator-auto-confirm");
    if (dailyGoalInput) dailyGoalInput.value = activeDailyGoal;
    if (titleInput) titleInput.value = cfg.apply_title_keywords || "";
    if (locationInput) locationInput.value = cfg.apply_location_keywords || "";
    if (excludeInput) excludeInput.value = cfg.exclude_keywords || "";
    if (minScoreInput) minScoreInput.value = activeMinScore;
    if (autoConfirmInput) autoConfirmInput.checked = activeAutoConfirmChat;
    updatePanelMinScoreLabel(activeMinScore);
    updatePanelMode();
    [dailyGoalInput, titleInput, locationInput, excludeInput, minScoreInput, autoConfirmInput].forEach((input) => {
      input?.addEventListener("input", saveJobPanelControls);
      input?.addEventListener("change", saveJobPanelControls);
    });
  }

  async function saveJobPanelControls() {
    const dailyGoalValue = document.getElementById("job-accelerator-daily-goal")?.value || "";
    const titleValue = document.getElementById("job-accelerator-title-filter")?.value || "";
    const locationValue = document.getElementById("job-accelerator-location-filter")?.value || "";
    const excludeValue = document.getElementById("job-accelerator-exclude-filter")?.value || "";
    const minScoreValue = document.getElementById("job-accelerator-min-score")?.value || activeMinScore;
    const autoConfirmValue = Boolean(document.getElementById("job-accelerator-auto-confirm")?.checked);
    activeDailyGoal = normalizeDailyGoal(dailyGoalValue);
    activeMinScore = normalizeMinScore(minScoreValue);
    activeAutoConfirmChat = autoConfirmValue;
    activeTitleKeywords = parseFilterKeywords(titleValue);
    activeLocationKeywords = parseFilterKeywords(locationValue);
    updatePanelMinScoreLabel(activeMinScore);
    await storageSet({
      daily_goal: activeDailyGoal,
      min_score: activeMinScore,
      apply_mode: activeApplyMode,
      auto_confirm_chat: activeAutoConfirmChat,
      exclude_keywords: excludeValue,
      apply_title_keywords: titleValue,
      apply_location_keywords: locationValue,
    });
  }

  function updatePanelMinScoreLabel(score) {
    const label = document.getElementById("job-accelerator-min-score-label");
    if (label) label.textContent = `匹配度 ≥ ${score}%`;
  }

  async function clearAnalysisCacheFromPanel() {
    const confirmed = window.confirm("清空岗位分析缓存、本页会话、已沟通/跳过/收藏状态和待填开场白；不会删除简历和筛选配置。确定清空？");
    if (!confirmed) return;

    const button = document.getElementById("job-accelerator-clear-cache");
    if (button) {
      button.disabled = true;
      button.textContent = "清空中";
    }

    try {
      disableAutoApplyTask();
      cancelActiveAnalysis();
      const items = await storageGet(null);
      const cacheKeys = Object.keys(items || {}).filter((key) => key.startsWith(ALL_MATCH_CACHE_PREFIX));
      const statusKeys = Object.keys(items || {}).filter((key) => key.startsWith(JOB_STATUS_PREFIX));
      const removeKeys = [...cacheKeys, ...statusKeys, PENDING_CHAT_KEY, HR_REPLY_QUEUE_KEY];
      if (removeKeys.length) await storageRemove(removeKeys);
      Object.keys(statuses).forEach((key) => delete statuses[key]);
      clearSessionJobs();
      forgetHrReplyTask();

      const message = removeKeys.length
        ? `已清空 ${cacheKeys.length} 条分析缓存、${statusKeys.length} 条状态和本页会话。`
        : "已清空本页会话；没有本地分析缓存和状态。";
      renderScanSummary(message);

      const results = panel?.querySelector("#job-accelerator-results");
      if (results) {
        results.innerHTML = '<div class="empty">已清空缓存和状态，点击“启动海投”重新处理当前页面岗位</div>';
      }
      refreshStats([]);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "清空记录";
      }
    }
  }

  async function continueScan() {
    if (!panel || analyzing || scanningMore) return;
    if (isAutoApplyTaskActive()) {
      await runAutoApplyLoop("继续海投：检查当前页面和新增岗位。");
      return;
    }
    scanningMore = true;
    setContinueButtonBusy(true);
    try {
      const cfg = await storageGet([
        "exclude_keywords",
        "resume_text",
        "min_score",
        "daily_goal",
        "apply_title_keywords",
        "apply_location_keywords",
      ]);
      activeMinScore = normalizeMinScore(cfg.min_score);
      activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
      activeTitleKeywords = parseFilterKeywords(cfg.apply_title_keywords);
      activeLocationKeywords = parseFilterKeywords(cfg.apply_location_keywords);
      const resumeKey = String(cfg.resume_text || "") ? simpleHash(String(cfg.resume_text || "")) : "";
      const filters = scanFiltersFromConfig(cfg);
      const currentWork = await refreshVisibleJobs("先检查当前补位新增。");
      if (currentWork > 0) {
        scanSummary = await buildScanSummary(resumeKey, scanSummary.visible, 0);
        if (isAutoApplyTaskActive()) {
          await startNextAutoChat("当前可见新增已处理，继续沟通达标岗位。");
        }
        renderScanSummary(isAutoApplyTaskActive() ? "当前可见新增已处理，继续海投会自动下滑。" : "当前可见新增已处理，再点继续扫描下滑。");
        return;
      }

      if (isBossSearchPage()) {
        await scrollJobListOneScreen();
      }

      const afterJobs = extractJobs(filters);
      const afterNew = mergeSessionJobs(afterJobs);
      const newJobs = uniqueJobs(afterNew);
      scanSummary = await buildScanSummary(resumeKey, afterJobs.length, newJobs.length);
      renderScanSummary(newJobs.length ? "下滑后发现新增岗位，开始分析。" : "下滑后没有发现新增岗位。");

      if (newJobs.length) await analyze(newJobs);
      else render(sessionJobList());
      if (isAutoApplyTaskActive()) await startNextAutoChat("继续扫描后准备进入达标岗位沟通。");
    } finally {
      scanningMore = false;
      setContinueButtonBusy(false);
    }
  }

  function setContinueButtonBusy(busy) {
    const button = document.getElementById("job-accelerator-next");
    const isBusy = Boolean(busy || analyzing || scanningMore || autoApplyInProgress || autoApplyLoopRunning);
    if (button) {
      button.disabled = isBusy;
      button.textContent = autoApplyInProgress ? "沟通中" : autoApplyLoopRunning ? "海投中" : analyzing ? "分析中" : scanningMore ? "扫描中" : "继续扫描";
    }
    const startButton = document.getElementById("job-accelerator-start");
    if (startButton) {
      startButton.disabled = isBusy;
      startButton.textContent = autoApplyInProgress ? "等待沟通确认" : autoApplyLoopRunning ? "海投进行中" : analyzing ? "海投分析中" : scanningMore ? "海投扫描中" : "启动海投";
    }
    renderRuntimeState();
  }

  async function runAutoApplyLoop(prefix = "") {
    if (!panel || panelMode !== "jobs" || autoApplyLoopRunning || analyzing || scanningMore) return false;
    const lock = acquireTaskLock("auto_apply", { label: "海投扫描" });
    if (!lock.ok) {
      renderScanSummary(`当前正在${lock.current?.label || "执行其他页面任务"}，海投暂未启动。`);
      return false;
    }
    clearLastError();
    setLastAction(prefix || "海投扫描启动", "等待当前页面岗位扫描完成。");
    autoApplyLoopRunning = true;
    setContinueButtonBusy(true);
    let didWork = false;
    let idleRounds = 0;

    try {
      for (let round = 1; round <= AUTO_LOOP_MAX_ROUNDS; round += 1) {
        if (paused || !isAutoApplyTaskActive()) break;

        const beforeDone = await currentDoneCount();
        const work = await refreshVisibleJobs(round === 1 ? prefix : "检查当前可见岗位和 BOSS 补位。", { autoApply: true });
        const chatted = await startNextAutoChat(work ? "当前新增分析完成，处理达标岗位。" : "继续处理当前达标岗位。");
        const afterDone = await currentDoneCount();
        didWork = didWork || work > 0 || chatted || afterDone > beforeDone;
        if (await stopAutoApplyIfGoalReached()) break;
        if (paused || !isAutoApplyTaskActive() || !isBossSearchPage()) break;

        const beforeSize = sessionJobs.size;
        const scrolled = await scrollJobListOneScreen();
        if (!scrolled) {
          renderScanSummary("左侧岗位列表已接近底部或未找到可下滑区域，自动海投已停下。");
          break;
        }

        await sleep(AUTO_LOOP_STEP_DELAY_MS);
        const afterWork = await refreshVisibleJobs("下滑后扫描新增岗位。", { autoApply: true });
        const afterChatted = await startNextAutoChat("下滑后处理达标岗位。");
        const changed = afterWork > 0 || afterChatted || sessionJobs.size > beforeSize || (await currentDoneCount()) > afterDone;
        didWork = didWork || changed;
        if (await stopAutoApplyIfGoalReached()) break;

        idleRounds = changed ? 0 : idleRounds + 1;
        if (idleRounds >= AUTO_LOOP_IDLE_ROUNDS) {
          renderScanSummary("连续两轮没有发现新岗位或可沟通岗位，自动海投已停下。");
          break;
        }
        await sleep(AUTO_LOOP_STEP_DELAY_MS);
      }
    } finally {
      autoApplyLoopRunning = false;
      setContinueButtonBusy(false);
      refreshStats(sessionJobList());
      releaseTaskLock(lock);
    }

    return didWork;
  }

  async function currentDoneCount() {
    const items = await storageGet(null);
    return countStatus({ ...collectStatuses(items), ...statuses }, "done", { todayOnly: true });
  }

  async function stopAutoApplyIfGoalReached() {
    const doneCount = await currentDoneCount();
    if (activeDailyGoal && doneCount >= activeDailyGoal) {
      disableAutoApplyTask();
      renderScanSummary(`今日目标已达成：${doneCount}/${activeDailyGoal}，已停止自动海投。`);
      return true;
    }
    return false;
  }

  async function maybeAutoChatAnalyzedJob(job, options = {}) {
    const autoApplyEnabled = Boolean(isAutoApplyTaskActive() || (options.force && autoApplyArmed));
    if (!taskLockAllows("auto_apply")) return false;
    if (!autoApplyEnabled || !isBossSearchPage() || paused) return false;
    const items = await storageGet(null);
    const statusSnapshot = { ...collectStatuses(items), ...statuses };
    const doneCount = countStatus(statusSnapshot, "done", { todayOnly: true });
    if (activeDailyGoal && doneCount >= activeDailyGoal) {
      disableAutoApplyTask();
      renderScanSummary(`今日目标已达成：${doneCount}/${activeDailyGoal}，已停止自动海投。`);
      return false;
    }
    if (!isAutoChatCandidate(job, statusSnapshot) || !isJobCurrentlyActionable(job)) return false;

    let card = findRenderedCardForJob(job);
    if (!card) {
      render(sessionJobList());
      card = findRenderedCardForJob(job);
    }
    if (!card) return false;

    autoApplyInProgress = true;
    setContinueButtonBusy(true);
    try {
      renderScanSummary(`匹配达标，立即沟通 ${doneCount + 1}/${activeDailyGoal || "未设"}：${job.company || ""} · ${job.title || ""}`);
      const result = await startChatFromPanelCard(card, { stayOnPageAfterSend: true });
      if (result?.status === "stayed") {
        render(sessionJobList());
        await sleep(AUTO_CHAT_STEP_DELAY_MS);
        return true;
      }
      return false;
    } catch (error) {
      showCardError(card, error.message || "自动沟通失败");
      setLastError(error.message || "自动沟通失败");
      renderScanSummary(`自动沟通失败：${error.message || "未知错误"}。已暂停自动海投，避免连续误点。`);
      disableAutoApplyTask();
      return false;
    } finally {
      autoApplyInProgress = false;
      setContinueButtonBusy(false);
    }
  }

  async function startNextAutoChat(prefix = "") {
    if (!panel || panelMode !== "jobs" || autoApplyInProgress || paused) return false;
    if (!taskLockAllows("auto_apply")) return false;
    autoApplyInProgress = true;
    setContinueButtonBusy(true);
    let handledCount = 0;
    let messagePrefix = prefix;

    try {
      while (!paused && isAutoApplyTaskActive()) {
        const items = await storageGet(null);
        const statusSnapshot = { ...collectStatuses(items), ...statuses };
        const doneCount = countStatus(statusSnapshot, "done", { todayOnly: true });
        if (activeDailyGoal && doneCount >= activeDailyGoal) {
          disableAutoApplyTask();
          renderScanSummary(`今日目标已达成：${doneCount}/${activeDailyGoal}，已停止自动海投。`);
          refreshStats(sessionJobList());
          break;
        }

        const candidateJobs = sortJobsForDisplay(sessionJobList())
          .filter((job) => isAutoChatCandidate(job, statusSnapshot));
        const nextJob = candidateJobs.find((job) => isJobCurrentlyActionable(job));
        if (!nextJob) {
          const staleCount = candidateJobs.length;
          const staleText = staleCount ? `；另有 ${staleCount} 个达标岗位当前左侧已不可见，已暂不处理` : "";
          renderScanSummary(`${messagePrefix ? `${messagePrefix} ` : ""}本批没有可自动沟通的达标岗位${staleText}，可点“继续扫描”加载更多。`);
          break;
        }

        let card = findRenderedCardForJob(nextJob);
        if (!card) {
          render(sessionJobList());
          card = findRenderedCardForJob(nextJob);
        }
        if (!card) {
          renderScanSummary("找到达标岗位，但面板卡片还没渲染出来，请点“启动海投”重试。");
          break;
        }

        try {
          renderScanSummary(`${messagePrefix ? `${messagePrefix} ` : ""}正在自动沟通 ${doneCount + 1}/${activeDailyGoal || "未设"}：${nextJob.company || ""} · ${nextJob.title || ""}`);
          const result = await startChatFromPanelCard(card, { stayOnPageAfterSend: true });
          handledCount += 1;
          if (result?.status !== "stayed") break;
          render(sessionJobList());
          await sleep(AUTO_CHAT_STEP_DELAY_MS);
          messagePrefix = "";
        } catch (error) {
          showCardError(card, error.message || "自动打开沟通失败");
          setLastError(error.message || "自动打开沟通失败");
          renderScanSummary(`自动沟通失败：${error.message || "未知错误"}。请检查弹窗按钮后再继续。`);
          disableAutoApplyTask();
          break;
        }
      }

      return handledCount > 0;
    } finally {
      autoApplyInProgress = false;
      setContinueButtonBusy(false);
    }
  }

  function isAutoChatCandidate(job, statusSnapshot = statuses) {
    if (!job?.match || job.error) return false;
    const status = statusName(statusSnapshot[statusKeyFor(job)] || "");
    if (status === "done" || status === "skip") return false;
    return scoreOf(job) >= activeMinScore;
  }

  function isJobCurrentlyActionable(job) {
    return !isBossSearchPage() || Boolean(sourceCardForJob(job));
  }

  function findRenderedCardForJob(job) {
    const targetKey = cacheKeyFor(job);
    return Array.from(panel?.querySelectorAll(".card") || [])
      .find((card) => card.dataset.cacheKey === targetKey) || null;
  }

  function countStatus(statusSnapshot, targetStatus, options = {}) {
    return Object.values(statusSnapshot || {}).filter((value) => {
      if (statusName(value) !== targetStatus) return false;
      if (options.todayOnly) return statusIsToday(value);
      return true;
    }).length;
  }

  function todayStamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function makeStatusValue(status) {
    return {
      status,
      date: todayStamp(),
      updatedAt: new Date().toISOString(),
    };
  }

  function statusName(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    return String(value.status || "");
  }

  function statusIsToday(value) {
    if (!value || typeof value === "string") return false;
    return value.date === todayStamp();
  }

  function uniqueJobs(jobs) {
    const seen = new Set();
    return jobs.filter((job) => {
      const key = cacheKeyFor(job);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function bindCards() {
    panel?.querySelectorAll("[data-chat]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const card = button.closest(".card");
        if (!card) return;
        button.disabled = true;
        button.textContent = "沟通中";
        try {
          await startChatFromPanelCard(card, { stayOnPageAfterSend: isBossSearchPage() });
        } catch (error) {
          button.disabled = false;
          button.textContent = "沟通";
          showCardError(card, error.message || "打开沟通失败");
        }
      });
    });

    panel?.querySelectorAll("[data-act]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const card = button.closest(".card");
        const key = card?.dataset.key;
        if (!key) return;
        if (statusName(statuses[key]) === button.dataset.act) {
          delete statuses[key];
          await storageRemove(key);
          card.style.opacity = "1";
          card.querySelectorAll("[data-act]").forEach((item) => item.classList.remove("on"));
        } else {
          statuses[key] = makeStatusValue(button.dataset.act);
          await storageSet({ [key]: statuses[key] });
          card.style.opacity = button.dataset.act === "skip" ? ".45" : "1";
          card.querySelectorAll("[data-act]").forEach((item) => item.classList.remove("on"));
          button.classList.add("on");
        }
        render(sessionJobList());
        refreshStats();
      });
    });

    panel?.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => {
        openJobFromPanelCard(card);
      });
    });
  }

  function openJobFromPanelCard(card) {
    const url = card.dataset.url || "";
    if (url && url !== location.href) {
      location.href = url;
      return;
    }

    const index = parseInt(card.dataset.listIndex || "-1", 10);
    const cards = document.querySelectorAll(JOB_CARD_SELECTOR);
    const sourceCard = index >= 0 ? cards[index] : null;
    const clickable = sourceCard?.querySelector("a[href*='job_detail'],a[href],.job-name,.job-title") || sourceCard;
    if (clickable) clickElement(clickable);
  }

  async function startChatFromPanelCard(card, options = {}) {
    const lockOwner = options.taskOwner || (options.stayOnPageAfterSend ? "auto_apply" : "manual");
    const lock = acquireTaskLock(lockOwner, {
      label: lockOwner === "manual" ? "用户手动沟通" : "海投沟通",
      preempt: lockOwner === "manual",
    });
    if (!lock.ok) throw new Error(`当前正在${lock.current?.label || "执行其他页面任务"}，请稍后再沟通。`);
    if (lock.preempted?.owner === "auto_apply") {
      disableAutoApplyTask();
      setPaused(true);
    }
    const cacheKey = card.dataset.cacheKey || "";
    try {
      const job = renderedJobs.get(cacheKey);
      if (!job?.match) throw new Error("岗位还没有完成匹配分析");
      const stayOnPageAfterSend = Boolean(options.stayOnPageAfterSend);
      const existingDialogResult = await handleExistingSentDialogForJob(job, card);
      if (existingDialogResult) return existingDialogResult;

      if (isBossSearchPage()) {
        const sourceCard = sourceCardForJob(job);
        if (!sourceCard) throw new Error("找不到左侧岗位卡片");
        const before = detailSignature();
        selectJobCard(sourceCard);
        await waitForDetailText(before, job);
      }

      const selectedDialogResult = await handleExistingSentDialogForJob(job, card);
      if (selectedDialogResult) return selectedDialogResult;

      const chatButton = findChatButton();
      if (!chatButton) {
        const hint = hasBossSentMessageDialog()
          ? "已检测到 BOSS 发送成功弹窗，但还没识别到“留在此页”按钮"
          : "找不到 BOSS 的立即沟通按钮";
        throw new Error(hint);
      }

      const cfg = await storageGet(["auto_confirm_chat"]);
      activeAutoConfirmChat = cfg.auto_confirm_chat === undefined ? DEFAULT_AUTO_CONFIRM_CHAT : Boolean(cfg.auto_confirm_chat);
      const shouldAutoConfirm = stayOnPageAfterSend || activeAutoConfirmChat;
      if (stayOnPageAfterSend) {
        await storageRemove(PENDING_CHAT_KEY);
      } else {
        await storageSet({ [PENDING_CHAT_KEY]: makePendingChat(job) });
        rememberAutoOpenPanel();
      }
      clickElement(chatButton);
      if (shouldAutoConfirm) {
        showCardInfo(card, stayOnPageAfterSend
          ? "已点击立即沟通，正在等待 BOSS 发送结果弹窗并选择“留在此页”。"
          : "已点击立即沟通，正在尝试自动确认 BOSS 弹窗。");
        const confirmResult = await waitAndClickChatConfirm({ preferStayOnPage: stayOnPageAfterSend });
        if (confirmResult === "stay") {
          await markJobDoneAfterChat(job, card, "BOSS 已发送招呼语，并已留在此页继续海投。");
          return { status: "stayed" };
        }
        if (confirmResult === "chat" || confirmResult === "continue") {
          showCardInfo(card, "已进入沟通页。");
          if (!stayOnPageAfterSend) {
            const opened = await waitForChatPageAndFill();
            if (!opened && !isBossChatPage()) throw new Error("未进入沟通页");
          }
          return { status: "chat" };
        }
        if (stayOnPageAfterSend) throw new Error("未识别到“留在此页”按钮，请手动确认后继续。");
        showCardInfo(card, "未识别到确认弹窗；如 BOSS 弹窗仍在，请手动确认。");
      } else if (stayOnPageAfterSend) {
        showCardInfo(card, "请在 BOSS 弹窗中手动点击“留在此页”，然后再继续海投。");
        return { status: "manual" };
      } else {
        showCardInfo(card, "请在 BOSS 弹窗中手动确认；如进入聊天页，会尝试自动填入开场白。");
      }
      const opened = await waitForChatPageAndFill();
      if (!opened && !isBossChatPage()) throw new Error("未进入沟通页");
      return { status: "chat" };
    } finally {
      releaseTaskLock(lock);
    }
  }

  async function handleExistingSentDialog(job, card) {
    if (!hasBossSentMessageDialog()) return null;
    const confirmResult = await waitAndClickChatConfirm({ preferStayOnPage: true });
    if (confirmResult === "stay") {
      await markJobDoneAfterChat(job, card, "检测到 BOSS 已发送招呼语，已点击“留在此页”并继续。");
      return { status: "stayed" };
    }
    if (confirmResult === "chat" || confirmResult === "continue") return { status: "chat" };
    return null;
  }

  async function handleExistingSentDialogForJob(job, card) {
    if (!hasBossSentMessageDialog()) return null;
    const items = await storageGet(null);
    const statusSnapshot = { ...collectStatuses(items), ...statuses };
    const currentJob = findCurrentDetailJob(statusSnapshot);
    if (currentJob && sameJobIdentity(currentJob, job)) {
      return handleExistingSentDialog(job, card);
    }

    if (await closeStaleSentDialog()) {
      renderScanSummary("检测到上一条 BOSS 发送结果弹窗，已先留在此页，再继续当前岗位。");
      await sleep(300);
      return null;
    }
    throw new Error("检测到上一条 BOSS 发送结果弹窗，请先点击“留在此页”后继续。");
  }

  async function closeStaleSentDialog() {
    const stayButton = findStayOnPageButton();
    if (!stayButton) return false;
    clickElement(stayButton);
    await waitForStayDialogClosed();
    return true;
  }

  function sameJobIdentity(a, b) {
    return Boolean(a && b && cacheKeyFor(a) === cacheKeyFor(b));
  }

  function makePendingChat(job) {
    return {
      jobKey: cacheKeyFor(job),
      statusKey: statusKeyFor(job),
      title: job.title || "",
      company: job.company || "",
      opening_message: String(job.match?.opening_message || "").trim(),
      searchUrl: location.href,
      createdAt: new Date().toISOString(),
    };
  }

  function findChatButton() {
    return findClickableByText(/^(立即沟通|继续沟通|开聊)$/);
  }

  async function waitAndClickChatConfirm(options = {}) {
    const preferStayOnPage = Boolean(options.preferStayOnPage);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (isBossChatPage()) return "chat";
      const button = findChatConfirmButton(options);
      if (button) {
        const label = normalizedButtonText(button);
        clickElement(button);
        if (/留在/.test(label)) {
          await waitForStayDialogClosed();
          return "stay";
        }
        if (preferStayOnPage && !hasBossSentMessageDialog()) {
          await sleep(450);
          continue;
        }
        if (/继续沟通|开聊/.test(label)) return "continue";
        return "confirm";
      }
      await sleep(250);
    }
    return "";
  }

  async function waitForStayDialogClosed() {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!findStayOnPageButton()) return true;
    }
    return false;
  }

  function findChatConfirmButton(options = {}) {
    const modalRoots = findModalRoots();
    const preferStayOnPage = Boolean(options.preferStayOnPage);
    const hasSentDialog = hasBossSentMessageDialog();
    if (preferStayOnPage) {
      const stayButton = findStayOnPageButton();
      if (stayButton) return stayButton;
    }
    if (!modalRoots.length) return null;
    const candidates = modalRoots
      .flatMap((root) => Array.from(root.querySelectorAll(confirmButtonSelector())))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => {
        const label = normalizedButtonText(node);
        if (/取消|稍后|返回|关闭|不了|暂不|再想想/.test(label)) return false;
        const modalRoot = modalRoots.find((root) => root === node || root.contains(node));
        const modalText = normalizeLooseText(modalRoot?.innerText || modalRoot?.textContent || "");
        if (/发送.*简历|投递.*简历|附件简历|简历附件/.test(`${label}${modalText}`)) return false;
        return /^(留在此页|留在本页|留在当前页|确认|确定|立即沟通|继续沟通|开始沟通|开聊)/.test(label);
      });
    if (preferStayOnPage && hasSentDialog) {
      return candidates.find((node) => /^留在(此页|本页|当前页)/.test(normalizedButtonText(node))) || null;
    }
    candidates.sort((a, b) => scoreConfirmButton(b) - scoreConfirmButton(a));
    return candidates[0] || null;
  }

  function findStayOnPageButton() {
    const exactStayPattern = /^留在(此页|本页|当前页)/;
    const modalCandidates = findModalRoots()
      .flatMap((root) => Array.from(root.querySelectorAll(confirmButtonSelector())))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => exactStayPattern.test(normalizedButtonText(node)));
    if (modalCandidates.length) return modalCandidates[0];

    if (!hasBossSentMessageDialog()) return null;
    const buttonCandidates = Array.from(document.querySelectorAll(confirmButtonSelector()))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => exactStayPattern.test(normalizedButtonText(node)));
    if (buttonCandidates.length) return buttonCandidates[0];

    return Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => exactStayPattern.test(normalizedButtonText(node)))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 40 && rect.width <= 260 && rect.height >= 20 && rect.height <= 90;
      })[0] || null;
  }

  function hasBossSentMessageDialog() {
    const textValue = normalizeLooseText(document.body?.innerText || document.body?.textContent || "");
    return /已向BOSS发送消息/.test(textValue) || (/招呼内容/.test(textValue) && /设置招呼语/.test(textValue));
  }

  function normalizedButtonText(node) {
    return normalizeLooseText(inlineText(node));
  }

  function normalizeLooseText(value) {
    return String(value || "").replace(/\s+/g, "").trim();
  }

  function confirmButtonSelector() {
    return [
      "button",
      "a",
      "[role='button']",
      ".btn",
      ".btn-primary",
      "[class*='btn']",
      "[class*='Btn']",
      "[class*='button']",
      "[class*='Button']",
    ].join(",");
  }

  function findModalRoots() {
    const selectors = [
      "[role='dialog']",
      ".dialog",
      ".modal",
      ".popup",
      ".confirm-dialog",
      ".dialog-container",
      ".dialog-wrapper",
      ".boss-dialog",
      ".tip-dialog",
      "[class*='dialog']",
      "[class*='Dialog']",
      "[class*='modal']",
      "[class*='Modal']",
      "[class*='popup']",
      "[class*='Popup']",
      "[class*='confirm']",
      "[class*='Confirm']",
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`));
  }

  function scoreConfirmButton(node) {
    const label = normalizedButtonText(node);
    const className = String(node.className || "");
    let score = 0;
    if (/primary|confirm|sure|submit|btn-primary/i.test(className)) score += 4;
    if (/开始沟通|立即沟通|继续沟通/.test(label)) score += 3;
    if (/留在此页|留在本页|留在当前页/.test(label)) score -= 1;
    if (/确认|确定/.test(label)) score += 2;
    const rect = node.getBoundingClientRect();
    if (rect.left > window.innerWidth * 0.45) score += 1;
    return score;
  }

  function findClickableByText(pattern) {
    const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],.btn,.btn-primary"))
      .filter(isVisible)
      .filter((node) => pattern.test(inlineText(node)));
    return candidates[0] || null;
  }

  function clickElement(node) {
    const preventJavascriptUrl = (event) => {
      if (isJavascriptHref(node)) event.preventDefault();
    };
    node.addEventListener("click", preventJavascriptUrl, { capture: true, once: true });
    try {
      if (typeof node.click === "function") {
        node.click();
        return;
      }
      ["mousedown", "mouseup", "click"].forEach((type) => {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
    } finally {
      node.removeEventListener("click", preventJavascriptUrl, { capture: true });
    }
  }

  function isJavascriptHref(node) {
    const link = node instanceof HTMLAnchorElement ? node : node.closest?.("a[href]");
    return String(link?.getAttribute("href") || "").trim().toLowerCase().startsWith("javascript:");
  }

  function showCardError(card, message) {
    let meta = card.querySelector(".chat-error");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "chat-error";
      card.appendChild(meta);
    }
    meta.textContent = message;
  }

  function showCardInfo(card, message) {
    let meta = card.querySelector(".chat-info");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "chat-info";
      card.appendChild(meta);
    }
    meta.textContent = message;
  }

  async function markJobDoneAfterChat(job, card, message) {
    const key = statusKeyFor(job);
    statuses[key] = makeStatusValue("done");
    await storageSet({ [key]: statuses[key] });
    await storageRemove(PENDING_CHAT_KEY);
    if (card) {
      card.querySelectorAll("[data-act]").forEach((item) => item.classList.remove("on"));
      card.querySelector("[data-act='done']")?.classList.add("on");
      showCardInfo(card, message);
    }
    refreshStats(sessionJobList());
  }

  async function autoFillPendingChat() {
    if (!isBossChatPage()) return;
    const items = await storageGet([PENDING_CHAT_KEY]);
    const pending = items[PENDING_CHAT_KEY];
    const message = String(pending?.opening_message || "").trim();
    if (!message || isStalePendingChat(pending)) return;
    if (pending.filledAt) {
      renderChatHelper(pending);
      renderChatAssistant("开场白已经填过。").catch(() => {});
      return;
    }

    const input = await waitForChatInput();
    if (!input) return;
    fillChatInput(input, message);
    const updated = { ...pending, filledAt: new Date().toISOString() };
    const storagePatch = { [PENDING_CHAT_KEY]: updated };
    if (pending.statusKey) {
      statuses[pending.statusKey] = makeStatusValue("done");
      storagePatch[pending.statusKey] = statuses[pending.statusKey];
    }
    await storageSet(storagePatch);
    renderChatHelper(updated);
    renderChatAssistant("开场白已自动填入。").catch(() => {});
  }

  function watchChatRoute() {
    let lastHref = location.href;
    let lastPageMode = getBossPageMode();
    setInterval(() => {
      autoCloseSentDialogIfNeeded().catch(() => {});
      const currentHref = location.href;
      const currentPageMode = getBossPageMode();
      const hrefChanged = currentHref !== lastHref;
      const pageModeChanged = currentPageMode !== lastPageMode;
      if (!hrefChanged && !pageModeChanged) return;
      const previousPageMode = lastPageMode;
      lastHref = currentHref;
      lastPageMode = currentPageMode;
      if (pageModeChanged) refreshChatShellForPageModeChange(previousPageMode, currentPageMode);
      if (isBossChatPage()) {
        if (panel && visible && panelMode !== "chat") switchToChatPanel();
        if (hrefChanged) {
          autoFillPendingChat().catch(() => {});
          renderChatAssistant("已进入沟通页。").catch(() => {});
          resumeHrReplyTaskIfNeeded().catch(() => {});
        }
      } else if (hrefChanged && isBossSearchPage() && consumeAutoOpenPanel()) {
        if (panel && visible) {
          if (panelMode !== "jobs") switchToJobPanel();
          refreshVisibleJobs("已返回，扫描当前补位新增。").catch(() => {});
        } else {
          scheduleAutoShow();
        }
      }
    }, 500);
  }

  function refreshChatShellForPageModeChange(previousPageMode, currentPageMode) {
    if (!shouldRefreshChatShellForPageModeChange(previousPageMode, currentPageMode, panelMode)) return false;
    refreshDebugHrReplyButton();
    renderRuntimeState();
    return true;
  }

  function shouldRefreshChatShellForPageModeChange(previousPageMode, currentPageMode, currentPanelMode) {
    return previousPageMode !== currentPageMode && currentPanelMode === "chat";
  }

  async function autoCloseSentDialogIfNeeded() {
    if (sentDialogGuardRunning || autoApplyInProgress || !panel || panelMode !== "jobs") return;
    if (!isAutoApplyTaskActive() || !hasBossSentMessageDialog()) return;
    sentDialogGuardRunning = true;
    try {
      const result = await waitAndClickChatConfirm({ preferStayOnPage: true });
      if (result === "stay") {
        const items = await storageGet(null);
        const statusSnapshot = { ...collectStatuses(items), ...statuses };
        const currentJob = findCurrentDetailJob(statusSnapshot);
        if (currentJob) {
          await markJobDoneAfterChat(currentJob, findRenderedCardForJob(currentJob), "检测到 BOSS 已发送招呼语，已点击“留在此页”并标记完成。");
        } else {
          renderScanSummary("检测到 BOSS 发送成功弹窗，已自动点击“留在此页”。");
        }
        setTimeout(() => {
          if (isAutoApplyTaskActive() && !autoApplyInProgress) startNextAutoChat("继续海投。").catch(() => {});
        }, AUTO_CHAT_STEP_DELAY_MS);
      }
    } finally {
      sentDialogGuardRunning = false;
    }
  }

  function findCurrentDetailJob(statusSnapshot = statuses) {
    const detailText = selectedDetailPanelText();
    if (!detailText) return null;
    return sortJobsForDisplay(sessionJobList())
      .find((job) => isAutoChatCandidate(job, statusSnapshot) && detailMatchesJob(job, detailText)) || null;
  }

  function switchToChatPanel() {
    if (!panel) return;
    panelMode = "chat";
    panel.innerHTML = chatShellHtml();
    bindChatShell();
    refreshPendingHrQueueCount().catch(() => {});
    renderRuntimeState();
    renderChatAssistant("已进入 HR 回复助手。").catch(() => {});
  }

  function switchToJobPanel() {
    if (!panel) return;
    panelMode = "jobs";
    panel.innerHTML = shellHtml(0, "已返回，准备扫描新增岗位。");
    bindShell();
    refreshPendingHrQueueCount().catch(() => {});
    renderRuntimeState();
    hydrateJobPanelControls().catch(() => {});
  }

  function renderChatHelper(pending) {
    document.getElementById(CHAT_HELPER_ID)?.remove();
    const helper = document.createElement("div");
    helper.id = CHAT_HELPER_ID;
    helper.innerHTML = `<style>
#${CHAT_HELPER_ID}{position:fixed;right:22px;bottom:88px;z-index:999999;background:#151820;color:#e6e8ee;border:1px solid #384255;border-radius:8px;box-shadow:0 8px 28px #0006;padding:12px;width:280px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#${CHAT_HELPER_ID} .helper-title{font-size:13px;font-weight:700;margin-bottom:6px;color:#fff}
#${CHAT_HELPER_ID} .helper-meta{font-size:11px;line-height:1.45;color:#aeb6c8;margin-bottom:10px}
#${CHAT_HELPER_ID} .helper-actions{display:flex;gap:6px;flex-wrap:wrap}
#${CHAT_HELPER_ID} button{font-size:12px;padding:6px 8px;border:1px solid #48536a;border-radius:6px;background:#202636;color:#d8deea;cursor:pointer}
#${CHAT_HELPER_ID} button.primary{background:#2f80ed;border-color:#2f80ed;color:#fff}
</style>
<div class="helper-title">开场白已填入</div>
<div class="helper-meta">${esc(pending.company || "")} · ${esc(pending.title || "")}<br>发送记录以 BOSS 消息列表为准。</div>
<div class="helper-actions">
  <button class="primary" data-helper-act="back">返回原页面</button>
</div>`;
    document.body.appendChild(helper);
    helper.querySelector("[data-helper-act='back']")?.addEventListener("click", () => returnWithoutMarking(pending));
  }

  async function returnWithoutMarking(pending) {
    await storageRemove(PENDING_CHAT_KEY);
    returnToSearchPage(pending);
  }

  function returnToSearchPage(pending) {
    rememberAutoOpenPanel();
    const target = String(pending?.searchUrl || "");
    if (target) {
      location.href = target;
    } else {
      history.back();
    }
  }

  async function waitForChatPageAndFill() {
    const deadline = Date.now() + CHAT_CONFIRM_WAIT_MS;
    while (Date.now() < deadline) {
      if (isBossChatPage()) {
        await autoFillPendingChat();
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  function isBossChatPage() {
    return isBossMessagePage();
  }

  function isBossMessagePage() {
    return location.href.includes("/web/geek/chat");
  }

  function getBossPageMode() {
    if (isBossSearchPage()) return "job";
    if (isBossMessagePage()) return hasActiveChatDetail() ? "chat" : "message";
    if (location.href.includes("/job_detail/")) return "job_detail";
    return "other";
  }

  function hasActiveChatDetail() {
    return Boolean(
      document.querySelector(".chat-conversation") &&
      (
        document.querySelector(".friend-content.selected") ||
        document.querySelector(".conversation-message .message-item") ||
        document.querySelector("#chat-input[contenteditable='true']")
      ),
    );
  }

  function bossPageModeLabel(mode) {
    return {
      job: "job mode / 岗位搜索页",
      message: "message mode / 消息列表页",
      chat: "chat mode / 聊天详情页",
      job_detail: "job detail / 岗位详情页",
      other: "other / 其他页面",
    }[mode] || "other / 其他页面";
  }

  function pageModeShortLabel(mode) {
    return {
      job: "岗位页",
      message: "消息页",
      chat: "聊天页",
      job_detail: "岗位详情",
      other: "其他",
    }[mode] || "其他";
  }

  function isStalePendingChat(pending) {
    const createdAt = Date.parse(pending?.createdAt || "");
    return !Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000;
  }

  async function waitForChatInput() {
    const deadline = Date.now() + 10 * 1000;
    while (Date.now() < deadline) {
      const input = findChatInput();
      if (input) return input;
      await sleep(300);
    }
    return null;
  }

  function findChatInput() {
    const primary = document.querySelector("#chat-input[contenteditable='true']");
    if (primary && isVisible(primary)) return primary;
    const candidates = Array.from(document.querySelectorAll("textarea,[contenteditable='true']"))
      .filter(isVisible)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.45 && rect.width > 200;
      });
    return candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  }

  function fillChatInput(input, message) {
    input.focus();
    if ("value" in input) {
      input.value = message;
    } else {
      document.execCommand?.("selectAll", false, null);
      document.execCommand?.("insertText", false, message);
      if (!inlineText(input)) input.textContent = message;
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
  }

  async function exportCsv() {
    const button = document.getElementById("job-accelerator-export");
    if (button) button.disabled = true;
    try {
      const items = await storageGet(null);
      const statusSnapshot = collectStatuses(items);
      const rows = Object.entries(items)
        .filter(([key]) => key.startsWith(MATCH_CACHE_PREFIX))
        .map(([key, value]) => {
          const entry = normalizeCacheEntry(value);
          const job = entry.job || {};
          const match = entry.match || {};
          const status = statusSnapshot[statusKeyFromCacheKey(key)] || statusKeyFor(job) && statusSnapshot[statusKeyFor(job)] || "";
          return {
            title: job.title || match.role || "",
            company: job.company || "",
            salary: job.salary || "",
            score: scoreOf({ match }),
            risk: match.risk_level || "",
            matched: skillListText(match.matched_skills),
            missing: skillListText(match.missing_skills),
            status: statusLabel(statusName(status)),
          };
        })
        .filter((row) => row.title || row.company || row.score)
        .sort((a, b) => b.score - a.score);

      if (!rows.length) return;

      const header = ["岗位名", "公司", "薪资", "匹配度", "风险等级", "匹配技能", "缺失技能", "状态"];
      const csv = "\ufeff" + [header, ...rows.map((row) => [
        row.title,
        row.company,
        row.salary,
        row.score,
        row.risk,
        row.matched,
        row.missing,
        row.status,
      ])].map(csvLine).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `job-accelerator-${dateStamp()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function refreshStats(currentJobs = []) {
    const stat = panel?.querySelector("#job-accelerator-stats");

    const items = await storageGet(null);
    const cache = new Map();
    Object.entries(items)
      .filter(([key]) => key.startsWith(MATCH_CACHE_PREFIX))
      .forEach(([key, value]) => {
        const entry = normalizeCacheEntry(value);
        if (entry.match) cache.set(key, entry);
      });
    currentJobs
      .filter((job) => job.match && !job.error)
      .forEach((job) => cache.set(cacheKeyFor(job), { job, match: job.match }));

    const counts = { analyzed: 0, ready: 0, high: 0, mid: 0, low: 0, done: 0, skip: 0, failed: 0 };
    cache.forEach((entry) => {
      const score = scoreOf({ match: entry.match });
      counts.analyzed += 1;
      if (score >= activeMinScore) counts.ready += 1;
      if (score >= 75) counts.high += 1;
      else if (score >= 50) counts.mid += 1;
      else counts.low += 1;
    });
    currentJobs.forEach((job) => {
      if (job.error) counts.failed += 1;
    });

    Object.values({ ...collectStatuses(items), ...statuses }).forEach((value) => {
      const status = statusName(value);
      if (status === "done" && statusIsToday(value)) counts.done += 1;
      if (status === "skip") counts.skip += 1;
    });

    updateRuntimeCounts(counts);
    if (!stat) return;
    stat.textContent = `今日目标 ${activeDailyGoal || "未设"} | 已分析 ${counts.analyzed} | 达标(≥${activeMinScore}分) ${counts.ready} | 已沟通 ${counts.done} | 跳过 ${counts.skip} | 失败 ${counts.failed}`;
  }

  function scoreOf(job) {
    const score = Number.parseFloat(job.match?.match_score || 0);
    return Number.isFinite(score) ? score : 0;
  }

  function normalizeMinScore(value) {
    const score = Number.parseInt(value, 10);
    if (!Number.isFinite(score)) return 80;
    return Math.max(50, Math.min(100, score));
  }

  function normalizeDailyGoal(value) {
    const goal = Number.parseInt(value, 10);
    if (!Number.isFinite(goal)) return DEFAULT_DAILY_GOAL;
    return Math.max(1, Math.min(500, goal));
  }

  function normalizeApplyMode(value) {
    return value === "smart" ? "smart" : DEFAULT_APPLY_MODE;
  }

  function applyModeTitle(mode = activeApplyMode) {
    return normalizeApplyMode(mode) === "smart" ? "智能投递" : "快速投递";
  }

  function applyModeDescription(mode = activeApplyMode) {
    return normalizeApplyMode(mode) === "smart"
      ? "云端辅助判断，质量更高但可能更慢；超时会自动兜底。"
      : "本地规则匹配，不等待大模型，优先保证批量海投不中断。";
  }

  function updatePanelMode() {
    const node = document.getElementById("job-accelerator-mode-summary");
    if (!node) return;
    node.innerHTML = `当前模式：<strong>${esc(applyModeTitle())}</strong><br>${esc(applyModeDescription())}`;
  }

  function text(root, selector) {
    const node = root.querySelector(selector);
    return node ? inlineText(node) : "";
  }

  function inlineText(node) {
    return String(node?.innerText || node?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseExcludeKeywords(input) {
    return String(input || "")
      .split(/[,，\n]/)
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
  }

  function parseFilterKeywords(input) {
    return String(input || "")
      .split(/[,，\n]/)
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
  }

  function scanFiltersFromConfig(cfg = {}) {
    return {
      excludeKeywords: parseExcludeKeywords(cfg.exclude_keywords),
      titleKeywords: parseFilterKeywords(cfg.apply_title_keywords),
      locationKeywords: parseFilterKeywords(cfg.apply_location_keywords),
    };
  }

  function matchesExcludeKeyword(cardText, keywords) {
    if (!keywords.length) return false;
    const lowerText = String(cardText || "").toLowerCase();
    return keywords.some((keyword) => lowerText.includes(keyword));
  }

  function matchesIncludeKeyword(textValue, keywords) {
    if (!keywords.length) return true;
    const lowerText = String(textValue || "").toLowerCase();
    return keywords.some((keyword) => lowerText.includes(keyword));
  }

  function extractHrActiveDays(card) {
    const root = card.matches?.(".job-card-box") ? card : card.querySelector(".job-card-box") || card;
    const candidates = [
      ...Array.from(root.querySelectorAll("[class*='active'],[class*='online'],[class*='boss']"))
        .map((node) => inlineText(node)),
      ...String(root.innerText || root.textContent || "")
        .split(/\n+/)
        .map((line) => line.trim()),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const days = parseHrActiveDays(candidate);
      if (days !== null) return days;
    }
    return null;
  }

  function parseHrActiveDays(textValue) {
    const text = String(textValue || "").replace(/\s+/g, "");
    if (!/活跃|在线|刚刚/.test(text)) return null;
    if (/在线|刚刚|今日|今天/.test(text)) return 0;
    if (/昨天/.test(text)) return 1;
    if (/本周|近一周/.test(text)) return 7;
    if (/本月|近一月/.test(text)) return 30;

    const matched = text.match(/([0-9一二两三四五六七八九十]+)(日|天|周|月|年)(?:内|前)?活跃/);
    if (!matched) return null;

    const count = parseChineseNumber(matched[1]);
    if (!count) return null;
    const unit = matched[2];
    if (unit === "日" || unit === "天") return count;
    if (unit === "周") return count * 7;
    if (unit === "月") return count * 30;
    if (unit === "年") return count * 365;
    return null;
  }

  function parseChineseNumber(value) {
    if (/^\d+$/.test(value)) return Number(value);
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === "十") return 10;
    if (value.includes("十")) {
      const [tensRaw, onesRaw] = value.split("十");
      const tens = tensRaw ? digits[tensRaw] || 0 : 1;
      const ones = onesRaw ? digits[onesRaw] || 0 : 0;
      return tens * 10 + ones;
    }
    return digits[value] || 0;
  }

  function setPaused(nextPaused) {
    paused = nextPaused;
    const button = document.getElementById("job-accelerator-pause");
    if (button) button.textContent = paused ? "继续" : "暂停";
    if (!paused && resumeWaiter) {
      resumeWaiter();
      resumeWaiter = null;
    }
  }

  function waitIfPaused() {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => {
      resumeWaiter = resolve;
    });
  }

  function extractLocation(card) {
    return (
      text(card, ".job-area-wrapper") ||
      text(card, ".job-area") ||
      text(card, ".job-location") ||
      text(card, ".area") ||
      ""
    );
  }

  function extractJobUrl(card) {
    const link = card.querySelector("a[href*='job_detail'],a[href]");
    const raw = link?.href || link?.getAttribute("href") || "";
    try {
      return raw ? new URL(raw, location.href).href : "";
    } catch (_) {
      return "";
    }
  }

  function extractDomJdText(root) {
    for (const selector of DETAIL_TEXT_SELECTORS) {
      const chunks = matchingNodes(root, selector)
        .map((node) => paragraphText(node))
        .filter((value) => value.length >= 20);
      const merged = uniqueParagraphs(chunks.join("\n\n"));
      if (merged.length >= 40) return merged;
    }
    return extractReadyTextBlock(root);
  }

  function matchingNodes(root, selector) {
    const nodes = [];
    if (root instanceof Element && root.matches(selector)) nodes.push(root);
    nodes.push(...root.querySelectorAll(selector));
    return nodes;
  }

  function extractReadyTextBlock(root) {
    const selectors = ["section", "article", "main", "[class*='detail']", "[class*='job']", "[class*='desc']", "[class*='require']"];
    const candidates = uniqueElements(selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector))))
      .filter(isVisible)
      .filter((node) => !node.closest(`#${CHAT_HELPER_ID},#job-accelerator-panel`))
      .filter((node) => !(root === document && node.closest(JOB_CARD_SELECTOR)))
      .map((node) => ({ node, value: paragraphText(node) }))
      .filter((item) => item.value.length >= 40 && item.value.length <= 3000)
      .filter((item) => DETAIL_READY_RE.test(item.value))
      .sort((a, b) => {
        const aDetail = /detail|desc|require|job/i.test(a.node.className || "") ? 1 : 0;
        const bDetail = /detail|desc|require|job/i.test(b.node.className || "") ? 1 : 0;
        return bDetail - aDetail || b.value.length - a.value.length;
      });
    return uniqueParagraphs(candidates[0]?.value || "");
  }

  function paragraphText(node) {
    return uniqueParagraphs(node?.innerText || node?.textContent || "");
  }

  function uniqueParagraphs(input) {
    const seen = new Set();
    return String(input || "")
      .replace(/\r/g, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join("\n\n");
  }

  function buildJdText(job, detailText) {
    return [
      job.title && `岗位：${job.title}`,
      job.company && `公司：${job.company}`,
      job.salary && `薪资：${job.salary}`,
      job.location && `地点：${job.location}`,
      job.tags?.length ? `标签：${job.tags.join("；")}` : "",
      detailText && `岗位详情：\n${detailText}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function cacheKeyFor(job) {
    return MATCH_CACHE_PREFIX + makeKey(jobIdentity(job));
  }

  function statusKeyFor(job) {
    return JOB_STATUS_PREFIX + makeKey(jobIdentity(job));
  }

  function jobIdentity(job) {
    return job.url || [job.title, job.company].filter(Boolean).join("_");
  }

  function statusKeyFromCacheKey(cacheKey) {
    return JOB_STATUS_PREFIX + cacheKey.slice(MATCH_CACHE_PREFIX.length);
  }

  function makeCacheEntry(job, match, resumeKey = "", applyMode = activeApplyMode) {
    return {
      version: 4,
      analyzedAt: new Date().toISOString(),
      resumeKey,
      applyMode: normalizeApplyMode(applyMode),
      job: {
        title: job.title || "",
        company: job.company || "",
        salary: job.salary || "",
        location: job.location || "",
        tags: job.tags || [],
        url: job.url || "",
        detailSource: job.detailSource || "",
      },
      match,
    };
  }

  function cacheMatchesResume(value, resumeKey) {
    if (!resumeKey && !value?.resumeKey) return true;
    return value?.resumeKey === resumeKey;
  }

  function cacheMatchesApplyMode(value, applyMode) {
    return normalizeApplyMode(value?.applyMode) === normalizeApplyMode(applyMode);
  }

  function cacheIsUsable(value, resumeKey, applyMode = activeApplyMode) {
    return cacheMatchesResume(value, resumeKey) && cacheMatchesApplyMode(value, applyMode) && cacheIsFresh(value);
  }

  function cacheIsFresh(value) {
    const analyzedAt = Date.parse(value?.analyzedAt || "");
    return Number.isFinite(analyzedAt) && Date.now() - analyzedAt < CACHE_TTL_MS;
  }

  function normalizeCacheEntry(value, fallbackJob = {}) {
    if (value && typeof value === "object" && "match" in value) {
      return {
        job: { ...(value.job || {}), ...(fallbackJob || {}) },
        match: value.match || {},
      };
    }
    return {
      job: fallbackJob || {},
      match: value || {},
    };
  }

  async function pruneMatchCache() {
    const items = await storageGet(null);
    const entries = Object.entries(items || {})
      .filter(([key]) => key.startsWith(MATCH_CACHE_PREFIX))
      .map(([key, value]) => ({
        key,
        analyzedAt: Date.parse(value?.analyzedAt || "") || 0,
      }))
      .sort((a, b) => b.analyzedAt - a.analyzedAt);

    if (entries.length <= MATCH_CACHE_LIMIT) return;
    await storageRemove(entries.slice(MATCH_CACHE_LIMIT).map((entry) => entry.key));
  }

  function collectStatuses(items) {
    return Object.fromEntries(Object.entries(items || {}).filter(([key]) => key.startsWith(JOB_STATUS_PREFIX)));
  }

  async function hydrateStatuses() {
    const items = await storageGet(null);
    Object.assign(statuses, collectStatuses(items));
  }

  function hasStorageAccess() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  }

  function formatAnalyzeError(error, api) {
    const message = String(error?.message || error || "");
    if (error?.name === "AbortError" || /^AbortError$/i.test(message)) {
      return `请求超时：${applyModeTitle()}超过 ${matchTimeoutMsForMode(activeApplyMode) / 1000}s 未返回。这条不会阻塞后续海投，继续扫描会重试。`;
    }
    if (/HTTP 401|HTTP 403/.test(message)) {
      return `访问令牌错误或没有带上：请确认朋友版插件是最新打包的 cloud 版本，并且服务器访问令牌一致。当前 API：${api}`;
    }
    if (/Extension message/i.test(message)) {
      return `插件后台通信失败：请在 chrome://extensions 里重新加载“求职加速器”，再刷新 BOSS 页面重试。当前 API：${api}`;
    }
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
      return `后端请求失败：云端版请确认服务器在线、插件包为最新版本，或联系开发者检查网络/CORS/HTTP 入口。当前 API：${api}`;
    }
    if (/HTTP 400/.test(message)) {
      return "没有读到有效 JD：可能是右侧详情还没加载，或 BOSS 页面结构变化。请点开岗位详情后重试。";
    }
    if (/HTTP 500/.test(message)) {
      return "后端匹配失败：请联系开发者检查服务器日志，常见原因是模型额度、网络或 LLM 超时。";
    }
    if (/HTTP 429/.test(message)) {
      return "云端当前请求较多或触发限流，这条不会丢失，稍后点击“继续扫描”会重试。";
    }
    if (/HTTP \d+/.test(message)) {
      return `后端返回异常：${message}。请联系开发者检查服务器状态。`;
    }
    return `请求失败：${message || "未知错误"}。请确认后端服务和网络代理正常。`;
  }

  function analyzeErrorHint(job) {
    if (!job.retryable) return "这类错误通常需要先处理配置或页面状态，再刷新插件。";
    if (/后端请求失败/.test(job.error || "")) return "云端版先确认插件包已更新；服务器恢复后，点击“继续扫描”会重试。";
    if (/插件后台通信失败/.test(job.error || "")) return "在 chrome://extensions 重新加载插件，再刷新 BOSS 页面。";
    if (/没有读到有效 JD/.test(job.error || "")) return "先在左侧点一下该岗位，让右侧详情加载出来，再继续扫描。";
    if (/请求超时|LLM|后端匹配失败|请求较多|限流/.test(job.error || "")) return "这条会保留在面板里，等云端恢复后继续扫描会重试。";
    return "这是可重试错误，稍后点击“继续扫描”会重新分析。";
  }

  function isRetryableAnalyzeError(error) {
    const message = String(error?.message || error || "");
    return Boolean(
      error?.name === "AbortError" ||
      /Extension message|Failed to fetch|NetworkError|Load failed|fetch|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message),
    );
  }

  async function requestMatch(api, payload) {
    const timeoutMs = matchTimeoutMsForMode(payload.mode);
    if (canUseBackgroundRequest()) {
      const result = await sendRuntimeMessageWithTimeout({
        action: "jobAccelerator.match",
        apiUrl: api,
        apiToken: DEFAULT_API_TOKEN,
        payload,
        timeoutMs,
      }, timeoutMs);

      if (!result?.ok) {
        throw new Error(result?.error || (result?.status ? `HTTP ${result.status}` : "Background match request failed"));
      }
      setLastRequestId(result.request_id || result.data?.request_id);
      return unwrapApiResponse(result.data);
    }

    const response = await fetchWithTimeout(api, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(payload),
    }, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return unwrapApiResponse(await response.json());
  }

  function unwrapApiResponse(data) {
    if (data && typeof data === "object" && "success" in data && "data" in data) {
      setLastRequestId(data.request_id);
      if (data.success === false) throw new Error(data.message || "Backend request failed");
      return data.data || {};
    }
    return data || {};
  }

  function canUseBackgroundRequest() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
  }

  function matchTimeoutMsForMode(mode) {
    return normalizeApplyMode(mode) === "smart" ? SMART_REQUEST_TIMEOUT_MS : FAST_REQUEST_TIMEOUT_MS;
  }

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

  function sendRuntimeMessageWithTimeout(message, timeoutMs) {
    const controller = new AbortController();
    activeFetchControllers.add(controller);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        activeFetchControllers.delete(controller);
        fn(value);
      };
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      controller.signal.addEventListener("abort", () => {
        finish(reject, new DOMException("Aborted", "AbortError"));
      }, { once: true });

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            finish(reject, new Error(`Extension message failed: ${lastError.message}`));
            return;
          }
          finish(resolve, response);
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    activeFetchControllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => {
      clearTimeout(timeoutId);
      activeFetchControllers.delete(controller);
    });
  }

  function requestHeaders(extraHeaders = {}) {
    return {
      "Content-Type": "application/json",
      ...(DEFAULT_API_TOKEN ? { "X-Job-Accelerator-Token": DEFAULT_API_TOKEN } : {}),
      ...extraHeaders,
    };
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!hasStorageAccess()) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (items) => resolve(chrome.runtime?.lastError ? {} : items || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageGetChecked(keys) {
    return new Promise((resolve) => {
      if (!hasStorageAccess()) {
        resolve({ ok: false, items: {}, error: "storage_unavailable" });
        return;
      }
      try {
        chrome.storage.local.get(keys, (items) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            resolve({ ok: false, items: {}, error: lastError.message || "storage_read_failed" });
            return;
          }
          resolve({ ok: true, items: items || {}, error: "" });
        });
      } catch (error) {
        resolve({ ok: false, items: {}, error: error?.message || "storage_read_failed" });
      }
    });
  }

  async function loadDebugHrReplyFlag(options = {}) {
    const refresh = Boolean(options.refresh);
    const runId = debugFlagSyncRunId + 1;
    debugFlagSyncRunId = runId;
    debugFlagLoadState = "loading";
    debugFlagLoadAttempt = 0;
    if (refresh) renderRuntimeState();
    const result = await resolveDebugHrReplyFlag(readDebugHrReplyFlagFromStorage, {
      maxAttempts: options.maxAttempts,
      retryDelayMs: options.retryDelayMs,
      onRetry: (state) => {
        if (runId !== debugFlagSyncRunId) return;
        debugFlagLoadState = state.state;
        debugFlagLoadAttempt = state.attempts;
        if (refresh) renderRuntimeState();
      },
    });
    if (runId !== debugFlagSyncRunId) return debugHrReplyEnabled;
    debugFlagLoadState = result.state;
    debugFlagLoadAttempt = result.attempts;
    if (result.state === "loaded") {
      debugHrReplyEnabled = Boolean(result.enabled);
    } else if (result.state === "missing") {
      debugHrReplyEnabled = false;
    }
    if (refresh) {
      refreshDebugHrReplyButton();
      renderRuntimeState();
    }
    return debugHrReplyEnabled;
  }

  function syncDebugHrReplyFlagForOpenPanel() {
    return loadDebugHrReplyFlag({ refresh: true });
  }

  async function resolveDebugHrReplyFlag(reader, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts || DEBUG_FLAG_READ_MAX_ATTEMPTS));
    const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? DEBUG_FLAG_RETRY_DELAY_MS));
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await reader();
      if (result?.ok && result.hasValue) {
        return { state: "loaded", enabled: Boolean(result.value), attempts: attempt };
      }
      if (result?.ok) {
        if (attempt >= maxAttempts) return { state: "missing", enabled: false, attempts: attempt };
      } else {
        lastError = result?.error || "storage_error";
        if (attempt >= maxAttempts) return { state: "error", enabled: null, attempts: attempt, error: lastError };
      }
      options.onRetry?.({ state: "retrying", attempts: attempt, error: lastError });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
    return { state: "error", enabled: null, attempts: maxAttempts, error: lastError || "storage_error" };
  }

  function readDebugHrReplyFlagFromStorage() {
    return new Promise((resolve) => {
      if (!hasStorageAccess()) {
        resolve({ ok: false, hasValue: false, value: false, error: "storage_unavailable" });
        return;
      }
      try {
        chrome.storage.local.get([HR_REPLY_DEBUG_FLAG_KEY], (items) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            resolve({ ok: false, hasValue: false, value: false, error: lastError.message || "storage_error" });
            return;
          }
          const data = items || {};
          resolve({
            ok: true,
            hasValue: Object.prototype.hasOwnProperty.call(data, HR_REPLY_DEBUG_FLAG_KEY),
            value: data[HR_REPLY_DEBUG_FLAG_KEY],
            error: "",
          });
        });
      } catch (error) {
        resolve({ ok: false, hasValue: false, value: false, error: error?.message || "storage_error" });
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      if (!hasStorageAccess()) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set(items, () => resolve(!chrome.runtime?.lastError));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      if (!hasStorageAccess()) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.remove(keys, () => resolve(!chrome.runtime?.lastError));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function skillListText(items) {
    return (items || [])
      .map((item) => {
        if (typeof item === "string") return item;
        return [item.skill, item.level].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .join("；");
  }

  function statusLabel(status) {
    return { done: "已沟通", skip: "跳过", save: "收藏" }[status] || "";
  }

  function csvLine(values) {
    return values
      .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
      .join(",");
  }

  function dateStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function timeText() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function simpleHash(input) {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) | 0;
    }
    return String(hash >>> 0);
  }

  function makeKey(input) {
    return encodeURIComponent(String(input)).slice(0, 160);
  }

  function esc(input) {
    return String(input || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  if (typeof window !== "undefined" && window.__JOB_ACCELERATOR_ENABLE_CHAT_PROBES__ === true) {
    window.__JOB_ACCELERATOR_RUN_CHAT_CANONICAL_PROBE__ = runChatMessageCanonicalProbe;
    window.__JOB_ACCELERATOR_RUN_DEBUG_BUTTON_PROBE__ = runDebugHrReplyButtonProbe;
    window.__JOB_ACCELERATOR_CHAT_CANONICAL_PROBE_RESULT__ = runChatMessageCanonicalProbe();
    window.__JOB_ACCELERATOR_DEBUG_BUTTON_PROBE_RESULT__ = runDebugHrReplyButtonProbe();
  }
})();
