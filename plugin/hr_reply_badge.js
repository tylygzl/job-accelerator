(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HRReplyBadge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTIVE_STATUSES = new Set(["pending", "needs_user"]);
  const STATUS_PRIORITY = Object.freeze({
    pending: 1,
    needs_user: 2,
    draft_filled: 3,
  });
  const BADGE_COLOR = "#d93025";

  function stringKey(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function dedupeKey(item) {
    const conversation = stringKey(item.conversationFingerprint);
    const message = stringKey(item.messageFingerprint);
    if (conversation && message) return `fingerprints:${JSON.stringify([conversation, message])}`;

    const id = stringKey(item.id);
    return id ? `id:${id}` : "";
  }

  function modelForCount(count) {
    return {
      count,
      text: count === 0 ? "" : count < 100 ? String(count) : "99+",
      color: BADGE_COLOR,
      title: count === 0 ? "暂无待处理 HR 回复" : `待处理 HR 回复：${count}`,
    };
  }

  function buildBadgeModel(queue) {
    if (!Array.isArray(queue)) return modelForCount(0);

    try {
      const statusByKey = new Map();
      for (const item of queue) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const status = item.status;
        const key = dedupeKey(item);
        if (!key) continue;
        const previousStatus = statusByKey.get(key);
        if (!previousStatus || (STATUS_PRIORITY[status] || 0) > (STATUS_PRIORITY[previousStatus] || 0)) {
          statusByKey.set(key, status);
        }
      }
      const count = Array.from(statusByKey.values())
        .filter((status) => ACTIVE_STATUSES.has(status))
        .length;
      return modelForCount(count);
    } catch (_error) {
      return modelForCount(0);
    }
  }

  return Object.freeze({ buildBadgeModel });
});
