// popup.js — 点击图标后切换 BOSS 页面内的分析侧栏。

const apiUrlEl = document.getElementById("apiUrl");
const statusEl = document.getElementById("status");
const resumeTextEl = document.getElementById("resumeText");
const saveResumeBtn = document.getElementById("saveResumeBtn");
const resumeStatusEl = document.getElementById("resumeStatus");
const minScoreEl = document.getElementById("minScore");
const minScoreLabelEl = document.getElementById("minScoreLabel");
const excludeKeywordsEl = document.getElementById("excludeKeywords");
const dailyGoalEl = document.getElementById("dailyGoal");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const DEFAULT_API = "http://localhost:8000/match";
const DEFAULT_MIN_SCORE = 80;
const DEFAULT_DAILY_GOAL = 10;
const MATCH_CACHE_PREFIX = "job_match_";

function saveConfig() {
  chrome.storage.local.set({
    apiUrl: apiUrlEl.value || DEFAULT_API,
    exclude_keywords: excludeKeywordsEl.value || "",
    daily_goal: normalizeDailyGoal(dailyGoalEl.value),
  });
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
  return Math.max(1, Math.min(100, goal));
}

chrome.storage.local.get(["apiUrl", "resume_text", "min_score", "exclude_keywords", "daily_goal"], (data) => {
  apiUrlEl.value = data.apiUrl || DEFAULT_API;
  resumeTextEl.value = data.resume_text || "";
  excludeKeywordsEl.value = data.exclude_keywords || "";
  dailyGoalEl.value = normalizeDailyGoal(data.daily_goal);
  updateResumeStatus(Boolean(data.resume_text));
  updateMinScore(data.min_score || DEFAULT_MIN_SCORE);
});

apiUrlEl.addEventListener("change", saveConfig);
excludeKeywordsEl.addEventListener("input", () => {
  chrome.storage.local.set({ exclude_keywords: excludeKeywordsEl.value || "" });
});
dailyGoalEl.addEventListener("input", () => {
  chrome.storage.local.set({ daily_goal: normalizeDailyGoal(dailyGoalEl.value) });
});

saveResumeBtn.addEventListener("click", () => {
  const resumeText = resumeTextEl.value.trim();
  chrome.storage.local.set({ resume_text: resumeText }, () => {
    updateResumeStatus(Boolean(resumeText));
    statusEl.textContent = resumeText ? "简历已保存" : "简历已清空";
  });
});

minScoreEl.addEventListener("input", () => {
  updateMinScore(minScoreEl.value);
  chrome.storage.local.set({ min_score: Number(minScoreEl.value) });
});

clearCacheBtn.addEventListener("click", () => {
  const confirmed = window.confirm("只清空岗位分析缓存，不会删除简历、配置和已投/跳过/收藏标记。确定清空？");
  if (!confirmed) return;

  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `读取缓存失败：${chrome.runtime.lastError.message}`;
      return;
    }

    const cacheKeys = Object.keys(items || {}).filter((key) => key.startsWith(MATCH_CACHE_PREFIX));
    if (!cacheKeys.length) {
      statusEl.textContent = "没有可清理的分析缓存";
      return;
    }

    chrome.storage.local.remove(cacheKeys, () => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = `清理缓存失败：${chrome.runtime.lastError.message}`;
        return;
      }
      statusEl.textContent = `已清空 ${cacheKeys.length} 条分析缓存`;
    });
  });
});

document.getElementById("analyzeBtn").addEventListener("click", async () => {
  saveConfig();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "toggle" });
    window.close();
  } catch (e) {
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        files: ["content.js"],
      },
      () => {
        chrome.tabs.sendMessage(tab.id, { action: "toggle" }, () => window.close());
      },
    );
    statusEl.textContent = "正在注入页面脚本...";
  }
});
