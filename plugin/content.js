// content.js — 求职加速器 BOSS 侧边栏。
(function () {
  "use strict";

  const DEFAULT_API = "http://localhost:8000/match";
  const DEFAULT_DAILY_GOAL = 10;
  const MATCH_CACHE_PREFIX = "job_match_v6_";
  const JOB_STATUS_PREFIX = "job_status_";
  const PENDING_CHAT_KEY = "job_accelerator_pending_chat";
  const CHAT_HELPER_ID = "job-accelerator-chat-helper";
  const AUTO_OPEN_KEY = "job_accelerator_auto";
  const MATCH_CACHE_LIMIT = 500;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const AUTO_OPEN_TTL_MS = 2 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 120 * 1000;
  const MATCH_API_CONCURRENCY = 1;
  const CHAT_CONFIRM_WAIT_MS = 90 * 1000;
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
  ];
  let panel = null;
  let visible = false;
  let paused = false;
  let resumeWaiter = null;
  let activeMinScore = 80;
  let activeDailyGoal = 0;
  let hideLowMatches = false;
  const statuses = {};
  const renderedJobs = new Map();
  let sessionJobs = new Map();
  let latestJobs = [];
  let scanSummary = emptyScanSummary();
  let analyzing = false;
  let scanningMore = false;
  let analysisRunId = 0;
  const activeFetchControllers = new Set();

  hydrateStatuses().catch(() => {});
  autoFillPendingChat().catch(() => {});
  watchChatRoute();

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "toggle") {
      visible ? hide() : show();
      sendResponse({ ok: true });
    }
    if (request.action === "clearSessionCache") {
      clearSessionJobs();
      sendResponse({ ok: true });
    }
    return true;
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
    if (shouldRefresh && panel) {
      const jobs = latestJobs.length ? latestJobs : sessionJobList();
      if (jobs.length) render(jobs);
      else refreshStats([]);
    }
  });

  async function show() {
    if (panel) return;
    await hydrateStatuses();
    hideLowMatches = false;
    scanSummary = emptyScanSummary();
    sessionJobs = isBossSearchPage() ? loadSessionJobs() : new Map();
    latestJobs = sessionJobList();
    panel = document.createElement("div");
    panel.id = "job-accelerator-panel";
    panel.innerHTML = shellHtml(0, "正在读取页面岗位...");
    document.body.appendChild(panel);
    visible = true;
    bindShell();

    await refreshVisibleJobs("正在分析当前可见岗位...");
  }

  function hide() {
    if (!panel) return;
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

  function scheduleAutoShow() {
    if (visible || panel) return;
    const wait = setInterval(() => {
      if (document.querySelectorAll(JOB_CARD_SELECTOR).length > 0) {
        clearInterval(wait);
        show();
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
    const distance = Math.max(scroller.clientHeight * 0.85, 520);
    const stepDistance = distance / SEARCH_SCROLL_STEPS;
    scanSummary.scrolled = true;
    renderScanSummary("正在慢速下滑加载下一批...");
    for (let step = 0; step < SEARCH_SCROLL_STEPS; step += 1) {
      scroller.scrollTop = Math.min(scroller.scrollTop + stepDistance, scroller.scrollHeight);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(SEARCH_SCROLL_STEP_MS);
    }
    await sleep(SEARCH_SCROLL_SETTLE_MS);
    scanSummary.loadedAfter = document.querySelectorAll(JOB_CARD_SELECTOR).length;
    return true;
  }

  function countCardsInside(node) {
    return node.querySelectorAll?.(JOB_CARD_SELECTOR).length || 0;
  }

  function scrollRoom(node) {
    return Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0));
  }

  async function buildScanSummary(resumeKey, visibleCount = 0, addedCount = 0) {
    const jobs = sessionJobList();
    const keys = jobs.map((job) => cacheKeyFor(job));
    const items = keys.length ? await storageGet(keys) : {};
    let cached = 0;
    jobs.forEach((job) => {
      const value = items[cacheKeyFor(job)];
      if (value && cacheIsUsable(value, resumeKey)) cached += 1;
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
    const node = panel?.querySelector("#job-accelerator-scan-summary");
    if (!node) return;
    const visible = scanSummary.visible || document.querySelectorAll(JOB_CARD_SELECTOR).length;
    const textValue = `当前可见 ${visible} 个 | 本次累计 ${scanSummary.total} 个 | 新增 ${scanSummary.added} 个 | 缓存 ${scanSummary.cached} | 待请求 ${scanSummary.fresh}`;
    node.textContent = `${prefix ? `${prefix} ` : ""}${textValue}`;
  }

  async function refreshVisibleJobs(prefix = "扫描当前可见岗位。") {
    if (analyzing) {
      renderScanSummary("正在分析中，暂不加入新岗位。");
      return 0;
    }
    const cfg = await storageGet(["exclude_keywords", "resume_text", "min_score", "daily_goal"]);
    activeMinScore = normalizeMinScore(cfg.min_score);
    activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
    const resumeKey = String(cfg.resume_text || "") ? simpleHash(String(cfg.resume_text || "")) : "";
    const jobs = extractJobs(parseExcludeKeywords(cfg.exclude_keywords));
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
      await analyze(jobsToAnalyze);
      return jobsToAnalyze.length;
    }
    render(sessionJobList());
    return 0;
  }

  function extractJobs(excludeKeywords = []) {
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
      if (matchesExcludeKeyword(cardText, excludeKeywords)) return;
      const activeDays = extractHrActiveDays(card);
      if (activeDays !== null && activeDays > 7) return;

      const title = text(card, ".job-name") || text(card, ".job-title");
      const company = text(card, ".boss-name") || text(card, ".company-name");
      const salary = text(card, ".job-salary") || text(card, ".salary") || "未标注";
      const tags = Array.from(card.querySelectorAll(".tag-list li,.job-card-footer li"))
        .map((item) => inlineText(item))
        .filter(Boolean);
      const locationText = extractLocation(card);
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

  async function analyze(jobs) {
    const container = panel?.querySelector("#job-accelerator-results");
    if (!container) return;
    if (!jobs.length) {
      if (sessionJobs.size) render(sessionJobList());
      else container.innerHTML = '<div class="empty">未检测到岗位卡片或 JD 详情</div>';
      return;
    }
    if (analyzing) return;
    analyzing = true;
    setContinueButtonBusy(true);
    const runId = analysisRunId;
    let resumeKeyForSummary = "";

    try {
      const cfg = await storageGet(["apiUrl", "resume_text", "min_score", "daily_goal"]);
      const api = cfg.apiUrl || DEFAULT_API;
      const resumeText = String(cfg.resume_text || "");
      const resumeKey = resumeText ? simpleHash(resumeText) : "";
      resumeKeyForSummary = resumeKey;
      activeMinScore = normalizeMinScore(cfg.min_score);
      activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
      jobs = await enrichSearchJobsWithDetails(jobs, resumeKey);
      if (runId !== analysisRunId || !panel) return;
      jobs.forEach((job) => sessionJobs.set(cacheKeyFor(job), mergeJobSnapshot(sessionJobs.get(cacheKeyFor(job)) || {}, job)));
      saveSessionJobs();

      const analyzeOne = async (job) => {
        const cacheKey = cacheKeyFor(job);
        const cachedEntry = await getUsableCachedEntry(job, resumeKey);
        if (cachedEntry) {
          const entry = normalizeCacheEntry(cachedEntry, job);
          return { ...job, ...entry.job, match: entry.match, cached: true };
        }

        try {
          const response = await fetchWithTimeout(api, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jd_text: job.jd_text, resume_text: resumeText }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          await storageSet({ [cacheKey]: makeCacheEntry(job, data, resumeKey) });
          pruneMatchCache().catch(() => {});
          return { ...job, match: data };
        } catch (error) {
          return { ...job, error: formatAnalyzeError(error, api), retryable: isRetryableAnalyzeError(error) };
        }
      };

      for (let index = 0; index < jobs.length; index += MATCH_API_CONCURRENCY) {
        if (runId !== analysisRunId || !panel) return;
        await waitIfPaused();
        const batch = jobs.slice(index, index + MATCH_API_CONCURRENCY);
        await Promise.all(batch.map(async (job) => {
          const result = await analyzeOne(job);
          if (runId !== analysisRunId || !panel) return;
          sessionJobs.set(cacheKeyFor(job), result);
          saveSessionJobs();
          render(sessionJobList());
        }));
      }
    } finally {
      if (runId === analysisRunId) {
        scanSummary = await buildScanSummary(resumeKeyForSummary, scanSummary.visible, 0);
        renderScanSummary("本批分析完成。");
        analyzing = false;
        setContinueButtonBusy(false);
      }
    }
  }

  async function enrichSearchJobsWithDetails(jobs, resumeKey) {
    if (!isBossSearchPage()) return jobs;
    const enriched = [];
    let scannedInBatch = 0;
    let batchStartIndex = 0;
    for (let index = 0; index < jobs.length; index += 1) {
      if (!panel) return [...enriched, ...jobs.slice(index)];
      await waitIfPaused();
      const job = jobs[index];

      const cachedEntry = await getUsableCachedEntry(job, resumeKey);
      if (cachedEntry) {
        updateScanProgress(index + 1, jobs.length, job, "命中缓存");
        enriched.push(job);
        continue;
      }

      if (scannedInBatch >= DETAIL_SCAN_BATCH_LIMIT) {
        await pauseScanBatch(index, jobs.length);
        scannedInBatch = 0;
        batchStartIndex = index;
        await waitIfPaused();
      }

      const batchTotal = Math.min(DETAIL_SCAN_BATCH_LIMIT, jobs.length - batchStartIndex);
      updateScanProgress(index + 1, jobs.length, job, "读取右侧 JD", scannedInBatch + 1, batchTotal);
      const detailText = await readRightDetailForJob(job);
      scannedInBatch += 1;
      enriched.push(
        detailText
          ? { ...job, jd_text: buildJdText(job, detailText), detailLoaded: true, detailSource: "detail" }
          : { ...job, detailLoaded: false, detailSource: "summary" },
      );
      await sleep(DETAIL_SCAN_COOLDOWN_MS);
    }
    return enriched;
  }

  async function pauseScanBatch(index, total) {
    setPaused(true);
    const container = panel?.querySelector("#job-accelerator-results");
    if (container) {
      container.innerHTML = `<div class="loading">已读取本批上限 ${DETAIL_SCAN_BATCH_LIMIT} 个右侧 JD，本次处理 ${index}/${total}。<br>自动暂停保护页面，稍等几秒后点击“继续”扫描下一批。</div>`;
    }
  }

  function updateScanProgress(current, total, job, action, batchCurrent = 0, batchTotal = 0) {
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

  async function getUsableCachedEntry(job, resumeKey) {
    const cacheKey = cacheKeyFor(job);
    const cached = await storageGet(cacheKey);
    return cached[cacheKey] && cacheIsUsable(cached[cacheKey], resumeKey) ? cached[cacheKey] : null;
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
      const aStatus = statuses[statusKeyFor(a)] || "";
      const bStatus = statuses[statusKeyFor(b)] || "";
      const aSkipped = aStatus === "skip" ? 1 : 0;
      const bSkipped = bStatus === "skip" ? 1 : 0;
      if (aSkipped !== bSkipped) return aSkipped - bSkipped;
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
      return `<div class="card low" ${dataAttrs}><div class="title">请求失败 | ${esc(job.title)}</div><div class="meta">${esc(job.error)}</div></div>`;
    }
    const match = job.match || {};
    const score = scoreOf(job);
    const level = score >= 75 ? "high" : score >= 50 ? "mid" : "low";
    const status = statuses[statusKey] || "";
    const opacity = status === "skip" ? "opacity:.45;" : "";
    const matched = (match.matched_skills || []).slice(0, 4);
    const missing = (match.missing_skills || []).slice(0, 3);
    const questions = (match.interview_questions || []).slice(0, 3);
    const opening = String(match.opening_message || "").trim();
    const canChat = score >= activeMinScore && opening;
    const sourceLabel = jdSourceLabel(job);

    return `<div class="card ${level}" ${dataAttrs} style="${opacity}">
      <div class="title">${score}% | ${esc(match.role || job.title)}</div>
      <div class="meta">${esc(job.company)} | ${esc(job.salary)} ${job.cached ? "| 已缓存" : ""} ${sourceLabel ? `| ${sourceLabel}` : ""}</div>
      <div class="risk">风险：${esc(match.risk_level || "待分析")}</div>
      ${matched.length ? `<div>${matched.map((item) => `<span class="badge good">${esc(item.skill)} · ${esc(item.level)}</span>`).join("")}</div>` : ""}
      ${missing.length ? `<div>${missing.map((item) => `<span class="badge warn">${esc(item.skill)}</span>`).join("")}</div>` : ""}
      ${questions.length ? `<div class="questions">${questions.map((question) => `<div>Q：${esc(question)}</div>`).join("")}</div>` : ""}
      ${opening ? `<div class="opening">📩 ${esc(opening)}</div>` : ""}
      <div class="actions">
        ${canChat ? '<button data-chat="1">去沟通</button>' : ""}
        <button data-act="done" class="${status === "done" ? "on" : ""}">已投</button>
        <button data-act="skip" class="${status === "skip" ? "on" : ""}">跳过</button>
        <button data-act="save" class="${status === "save" ? "on" : ""}">收藏</button>
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
#job-accelerator-panel .close{position:absolute;top:12px;right:14px;background:transparent;border:0;color:#b8c0d4;font-size:20px;cursor:pointer}
#job-accelerator-panel .pager{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
#job-accelerator-panel .pager button{padding:6px 10px;font-size:12px;background:#202636;border:1px solid #384255;color:#d8deea;border-radius:6px;cursor:pointer}
#job-accelerator-panel .pager button:disabled{opacity:.35;cursor:not-allowed}
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
<div class="pager">
  <button id="job-accelerator-next">继续扫描</button>
  <button id="job-accelerator-refresh">刷新</button>
  <button id="job-accelerator-pause">暂停</button>
  <button id="job-accelerator-clear-low">隐藏未达标</button>
</div>
<div class="stats" id="job-accelerator-stats">已分析 0 个 | 达标 0 | 今日目标 0 | 已投 0 | 跳过 0</div>
<div class="scan-summary" id="job-accelerator-scan-summary">${esc(loadingText)}</div>
<div id="job-accelerator-results"><div class="loading">${esc(loadingText)}</div></div>
<div class="footer"><button class="export" id="job-accelerator-export">导出 CSV</button></div>`;
  }

  function bindShell() {
    document.getElementById("job-accelerator-close")?.addEventListener("click", hide);
    document.getElementById("job-accelerator-refresh")?.addEventListener("click", () => {
      hide();
      setTimeout(show, 100);
    });
    document.getElementById("job-accelerator-next")?.addEventListener("click", continueScan);
    document.getElementById("job-accelerator-export")?.addEventListener("click", exportCsv);
    document.getElementById("job-accelerator-pause")?.addEventListener("click", () => setPaused(!paused));
    document.getElementById("job-accelerator-clear-low")?.addEventListener("click", () => {
      hideLowMatches = true;
      render(latestJobs);
      const button = document.getElementById("job-accelerator-clear-low");
      if (button) button.disabled = true;
    });
  }

  async function continueScan() {
    if (!panel || analyzing || scanningMore) return;
    scanningMore = true;
    setContinueButtonBusy(true);
    try {
      const cfg = await storageGet(["exclude_keywords", "resume_text", "min_score", "daily_goal"]);
      activeMinScore = normalizeMinScore(cfg.min_score);
      activeDailyGoal = normalizeDailyGoal(cfg.daily_goal);
      const resumeKey = String(cfg.resume_text || "") ? simpleHash(String(cfg.resume_text || "")) : "";
      const excludeKeywords = parseExcludeKeywords(cfg.exclude_keywords);
      const currentWork = await refreshVisibleJobs("先检查当前补位新增。");
      if (currentWork > 0) {
        scanSummary = await buildScanSummary(resumeKey, scanSummary.visible, 0);
        renderScanSummary("当前可见新增已处理，再点继续扫描下滑。");
        return;
      }

      if (isBossSearchPage()) {
        await scrollJobListOneScreen();
      }

      const afterJobs = extractJobs(excludeKeywords);
      const afterNew = mergeSessionJobs(afterJobs);
      const newJobs = uniqueJobs(afterNew);
      scanSummary = await buildScanSummary(resumeKey, afterJobs.length, newJobs.length);
      renderScanSummary(newJobs.length ? "下滑后发现新增岗位，开始分析。" : "下滑后没有发现新增岗位。");

      if (newJobs.length) await analyze(newJobs);
      else render(sessionJobList());
    } finally {
      scanningMore = false;
      setContinueButtonBusy(false);
    }
  }

  function setContinueButtonBusy(busy) {
    const button = document.getElementById("job-accelerator-next");
    if (!button) return;
    const isBusy = Boolean(busy || analyzing || scanningMore);
    button.disabled = isBusy;
    button.textContent = analyzing ? "分析中" : scanningMore ? "扫描中" : "继续扫描";
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
        button.textContent = "等待确认";
        try {
          await startChatFromPanelCard(card);
        } catch (error) {
          button.disabled = false;
          button.textContent = "去沟通";
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
        if (statuses[key] === button.dataset.act) {
          delete statuses[key];
          await storageRemove(key);
          card.style.opacity = "1";
          card.querySelectorAll("[data-act]").forEach((item) => item.classList.remove("on"));
        } else {
          statuses[key] = button.dataset.act;
          await storageSet({ [key]: button.dataset.act });
          card.style.opacity = button.dataset.act === "skip" ? ".45" : "1";
          card.querySelectorAll("[data-act]").forEach((item) => item.classList.remove("on"));
          button.classList.add("on");
        }
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

  async function startChatFromPanelCard(card) {
    const cacheKey = card.dataset.cacheKey || "";
    const job = renderedJobs.get(cacheKey);
    if (!job?.match?.opening_message) throw new Error("没有可发送的开场白");

    if (isBossSearchPage()) {
      const sourceCard = sourceCardForJob(job);
      if (!sourceCard) throw new Error("找不到左侧岗位卡片");
      const before = detailSignature();
      selectJobCard(sourceCard);
      await waitForDetailText(before, job);
    }

    const chatButton = findChatButton();
    if (!chatButton) throw new Error("找不到 BOSS 的立即沟通按钮");

    await storageSet({ [PENDING_CHAT_KEY]: makePendingChat(job) });
    rememberAutoOpenPanel();
    clickElement(chatButton);
    showCardInfo(card, "请在 BOSS 弹窗中手动确认，进入聊天页后会自动填入开场白。");
    const opened = await waitForChatPageAndFill();
    if (!opened && !isBossChatPage()) throw new Error("未进入沟通页");
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

  async function autoFillPendingChat() {
    if (!isBossChatPage()) return;
    const items = await storageGet([PENDING_CHAT_KEY]);
    const pending = items[PENDING_CHAT_KEY];
    const message = String(pending?.opening_message || "").trim();
    if (!message || isStalePendingChat(pending)) return;
    if (pending.filledAt) {
      renderChatHelper(pending);
      return;
    }

    const input = await waitForChatInput();
    if (!input) return;
    fillChatInput(input, message);
    const updated = { ...pending, filledAt: new Date().toISOString() };
    await storageSet({ [PENDING_CHAT_KEY]: updated });
    renderChatHelper(updated);
  }

  function watchChatRoute() {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (isBossChatPage()) {
        autoFillPendingChat().catch(() => {});
      } else if (isBossSearchPage() && consumeAutoOpenPanel()) {
        if (panel && visible) {
          refreshVisibleJobs("已返回，扫描当前补位新增。").catch(() => {});
        } else {
          scheduleAutoShow();
        }
      }
    }, 500);
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
    return location.href.includes("/web/geek/chat");
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
            status: statusLabel(status),
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
    if (!stat) return;

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

    const counts = { analyzed: 0, ready: 0, high: 0, mid: 0, low: 0, done: 0, skip: 0 };
    cache.forEach((entry) => {
      const score = scoreOf({ match: entry.match });
      counts.analyzed += 1;
      if (score >= activeMinScore) counts.ready += 1;
      if (score >= 75) counts.high += 1;
      else if (score >= 50) counts.mid += 1;
      else counts.low += 1;
    });

    Object.values({ ...collectStatuses(items), ...statuses }).forEach((status) => {
      if (status === "done") counts.done += 1;
      if (status === "skip") counts.skip += 1;
    });

    stat.textContent = `已分析 ${counts.analyzed} 个 | ≥${activeMinScore}分 ${counts.ready} | 今日目标 ${activeDailyGoal || "未设"} | 已投 ${counts.done} | 跳过 ${counts.skip}`;
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
    return Math.max(1, Math.min(100, goal));
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

  function matchesExcludeKeyword(cardText, keywords) {
    if (!keywords.length) return false;
    const lowerText = String(cardText || "").toLowerCase();
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
    return "";
  }

  function matchingNodes(root, selector) {
    const nodes = [];
    if (root instanceof Element && root.matches(selector)) nodes.push(root);
    nodes.push(...root.querySelectorAll(selector));
    return nodes;
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

  function makeCacheEntry(job, match, resumeKey = "") {
    return {
      version: 3,
      analyzedAt: new Date().toISOString(),
      resumeKey,
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

  function cacheIsUsable(value, resumeKey) {
    return cacheMatchesResume(value, resumeKey) && cacheIsFresh(value);
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
    if (error?.name === "AbortError") {
      return `请求超时：后端或 LLM 超过 ${REQUEST_TIMEOUT_MS / 1000}s 未返回。这条会在下次刷新或继续扫描时重试。`;
    }
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
      return `后端未连接：请先运行 python server.py，再刷新插件。当前 API：${api}`;
    }
    if (/HTTP 400/.test(message)) {
      return "参数错误：没有读到有效 JD，请刷新页面或点开岗位详情后重试。";
    }
    if (/HTTP 500/.test(message)) {
      return "后端匹配失败：请查看 server.py 终端报错，常见原因是 API key、代理或 LLM 超时。";
    }
    if (/HTTP \d+/.test(message)) {
      return `后端返回异常：${message}。请查看 server.py 终端报错。`;
    }
    return `请求失败：${message || "未知错误"}。请确认后端服务和网络代理正常。`;
  }

  function isRetryableAnalyzeError(error) {
    const message = String(error?.message || error || "");
    return Boolean(
      error?.name === "AbortError" ||
      /Failed to fetch|NetworkError|Load failed|fetch|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message),
    );
  }

  function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    activeFetchControllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => {
      clearTimeout(timeoutId);
      activeFetchControllers.delete(controller);
    });
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
    return { done: "已投", skip: "跳过", save: "收藏" }[status] || "";
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
})();
