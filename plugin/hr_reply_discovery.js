(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.HRReplyDiscovery = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_LIMIT = 30;
  const DRAFT_REOPEN_AFTER_MS = 60 * 1000;
  const STATUS_PRIORITY = Object.freeze({
    pending: 1,
    needs_user: 2,
    draft_filled: 3,
  });

  function valueOf(snapshot, names) {
    for (const name of names) {
      if (snapshot && snapshot[name] !== undefined && snapshot[name] !== null) return snapshot[name];
    }
    return "";
  }

  function textValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizedValue(value) {
    return textValue(value).toLowerCase();
  }

  function boolValue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }

  function dataHint(snapshot) {
    return textValue(valueOf(snapshot, ["data_hint", "dataHint", "stable_hint"]));
  }

  function dataHintIsUnique(snapshot) {
    if (snapshot && snapshot.data_hint_unique !== undefined) return boolValue(snapshot.data_hint_unique);
    if (snapshot && snapshot.dataHintUnique !== undefined) return boolValue(snapshot.dataHintUnique);
    return false;
  }

  function messageHint(snapshot) {
    return textValue(valueOf(snapshot, ["message_hint", "messageHint", "latest_message_id"]));
  }

  function conversationValues(snapshot) {
    return {
      hr: normalizedValue(valueOf(snapshot, ["hr_name"])),
      company: normalizedValue(valueOf(snapshot, ["company"])),
      role: normalizedValue(valueOf(snapshot, ["hr_role", "role"])),
      job: normalizedValue(valueOf(snapshot, ["job_title"])),
    };
  }

  function simpleHash(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function makeConversationFingerprint(snapshot = {}) {
    const hint = dataHint(snapshot);
    if (hint && dataHintIsUnique(snapshot)) return `conversation_${simpleHash(`hint|${normalizedValue(hint)}`)}`;
    const values = conversationValues(snapshot);
    if (!values.hr || !values.company || !values.role) return "";
    return `conversation_${simpleHash(`identity|${values.hr}|${values.company}|${values.role}|${values.job}`)}`;
  }

  function makeMessageFingerprint(snapshot = {}) {
    const conversation = textValue(snapshot.conversationFingerprint) || makeConversationFingerprint(snapshot);
    const message = normalizedValue(valueOf(snapshot, ["latest_hr_message"]));
    if (!conversation || !message) return "";
    const stableMessageHint = normalizedValue(messageHint(snapshot));
    const unreadCount = textValue(valueOf(snapshot, ["unread_count_text", "unreadCountText"]));
    const discriminator = stableMessageHint
      ? `hint|${stableMessageHint}`
      : `text|${message}|unread|${unreadCount}`;
    return `message_${simpleHash(`${conversation}|${discriminator}`)}`;
  }

  function stableHintsMatch(expected = {}, actual = {}) {
    const expectedHint = normalizedValue(dataHint(expected));
    const actualHint = normalizedValue(dataHint(actual));
    if (!expectedHint) return true;
    return Boolean(actualHint && expectedHint === actualHint);
  }

  function unreadKind(snapshot) {
    return normalizedValue(valueOf(snapshot, ["unread_kind", "unreadKind", "unread_badge_type"]));
  }

  function hasUnread(snapshot) {
    if (snapshot && snapshot.unread !== undefined) return boolValue(snapshot.unread);
    return Boolean(unreadKind(snapshot));
  }

  function isNumericBadge(snapshot, kind) {
    if (![
      "avatar-numeric",
      "avatar_numeric",
      "badge",
      "numeric",
      "number",
      "notice-badge",
      "notice_badge",
    ].includes(kind)) return false;
    const countText = textValue(valueOf(snapshot, ["unread_count_text", "unreadCountText"]));
    return /^\d+$/.test(countText);
  }

  function classifySnapshot(snapshot = {}) {
    const kind = unreadKind(snapshot);
    const unread = hasUnread(snapshot);
    const unreadEvidence = {
      unread,
      kind: kind || "none",
      count: Number.parseInt(textValue(valueOf(snapshot, ["unread_count_text", "unreadCountText"])), 10) || (unread ? 1 : 0),
    };
    const reject = (discoveryKind, reason) => ({
      kind: discoveryKind,
      shouldQueue: false,
      reject_reason: reason,
      unread: unreadEvidence,
    });

    if (!unread) return reject("ignored", "no_unread");
    if (!textValue(snapshot.latest_hr_message)) return reject("unknown", "missing_message");
    if (boolValue(valueOf(snapshot, ["draft", "is_draft"]))) return reject("draft", "draft");
    if (boolValue(valueOf(snapshot, ["system", "is_system"]))) return reject("system", "system");
    if (boolValue(valueOf(snapshot, ["group", "is_group"]))) return reject("group", "group");
    if (normalizedValue(valueOf(snapshot, ["latest_sender", "latest_sender_role"])) === "me") {
      return reject("self", "latest_sender_me");
    }
    if (!isNumericBadge(snapshot, kind)) {
      return reject("unknown", kind === "dot" ? "unconfirmed_dot" : "unreliable_unread");
    }
    if (boolValue(valueOf(snapshot, ["require_stable_hint", "requireStableHint"]))
      && !(dataHint(snapshot) && dataHintIsUnique(snapshot))) {
      return reject("unknown", "missing_stable_hint");
    }
    if (!makeConversationFingerprint(snapshot)) return reject("unknown", "insufficient_identity");
    return {
      kind: "hr_reply",
      shouldQueue: true,
      reject_reason: "",
      unread: unreadEvidence,
    };
  }

  function normalizeQueue(value) {
    return Array.isArray(value)
      ? value.filter((item) => item && typeof item === "object" && item.id)
      : [];
  }

  function queueItemKey(item = {}) {
    const conversation = textValue(item.conversationFingerprint);
    const message = textValue(item.messageFingerprint);
    if (conversation && message) return `fingerprints:${conversation}:${message}`;
    return item.id ? `id:${item.id}` : "";
  }

  function preferredStatus(left, right) {
    const leftPriority = STATUS_PRIORITY[left] || 0;
    const rightPriority = STATUS_PRIORITY[right] || 0;
    return rightPriority > leftPriority ? right : left;
  }

  function isRecoverableQueueStatus(item = {}) {
    if (item.status !== "needs_user") return false;
    const reason = normalizedValue(valueOf(item, ["statusReason", "status_reason", "reason"]));
    const note = normalizedValue(valueOf(item, ["note", "message", "error"]));
    return reason === "conversation_mismatch"
      || note.includes("当前会话与待回复记录不一致")
      || note.includes("conversation mismatch");
  }

  function statusPriority(item = {}) {
    if (isRecoverableQueueStatus(item)) return 0;
    return STATUS_PRIORITY[item.status] || 0;
  }

  function messageTextsMatch(left, right) {
    const normalizedLeft = normalizedValue(left);
    const normalizedRight = normalizedValue(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    const leftPrefix = normalizedLeft.replace(/(\.{2,}|…|。{2,}).*$/, "").replace(/[.。…]+$/g, "");
    const rightPrefix = normalizedRight.replace(/(\.{2,}|…|。{2,}).*$/, "").replace(/[.。…]+$/g, "");
    return Math.min(leftPrefix.length, rightPrefix.length) >= 8
      && (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix));
  }

  function sameQueueTarget(left = {}, right = {}) {
    const leftConversation = textValue(left.conversationFingerprint);
    const rightConversation = textValue(right.conversationFingerprint);
    if (leftConversation && rightConversation && leftConversation === rightConversation) return true;
    if (dataHint(left) && dataHint(right) && stableHintsMatch(left, right)) return true;
    const leftValues = conversationValues(left);
    const rightValues = conversationValues(right);
    if (!leftValues.hr || leftValues.hr !== rightValues.hr) return false;
    if (!leftValues.company || leftValues.company !== rightValues.company) return false;
    if (leftValues.role && rightValues.role && leftValues.role !== rightValues.role) return false;
    return messageTextsMatch(left.latest_hr_message, right.latest_hr_message)
      || (
        textValue(left.messageFingerprint)
        && textValue(left.messageFingerprint) === textValue(right.messageFingerprint)
      );
  }

  function cleanupResolvedRecoverableItems(items) {
    const queue = normalizeQueue(items);
    const resolved = queue.filter((item) => item.status === "draft_filled");
    if (!resolved.length) return queue;
    return queue.filter((item) => (
      !isRecoverableQueueStatus(item)
      || !resolved.some((done) => sameQueueTarget(item, done))
    ));
  }

  function dedupeQueueItems(value) {
    const map = new Map();
    normalizeQueue(value).forEach((item) => {
      const key = queueItemKey(item);
      if (!key) return;
      const previous = map.get(key);
      if (!previous) {
        map.set(key, item);
        return;
      }
      const useIncomingStatus = statusPriority(item) > statusPriority(previous);
      const status = useIncomingStatus ? item.status : previous.status;
      const statusSource = useIncomingStatus ? item : previous;
      map.set(key, {
        ...previous,
        ...item,
        status,
        statusChangedAt: statusSource.statusChangedAt
          || statusSource.updatedAt
          || statusSource.firstSeenAt
          || previous.statusChangedAt
          || item.statusChangedAt,
      });
    });
    return cleanupResolvedRecoverableItems(Array.from(map.values()));
  }

  function pendingItems(value) {
    return dedupeQueueItems(value).filter((item) => ["pending", "needs_user"].includes(item.status));
  }

  function sameLegacyIdentity(left = {}, right = {}) {
    const leftValues = conversationValues(left);
    const rightValues = conversationValues(right);
    if (!leftValues.hr || !rightValues.hr || leftValues.hr !== rightValues.hr) return false;
    if (!leftValues.company || !rightValues.company || leftValues.company !== rightValues.company) return false;
    if (leftValues.role && rightValues.role && leftValues.role !== rightValues.role) return false;
    if (leftValues.job && rightValues.job && leftValues.job !== rightValues.job) return false;
    return true;
  }

  function findLegacyQueueEntries(map, freshItem) {
    return Array.from(map.entries()).filter(([, previous]) => (
      !previous.debug
      && !(dataHint(previous) && dataHintIsUnique(previous))
      && sameLegacyIdentity(previous, freshItem)
    ));
  }

  function fingerprintsForPrevious(previous, conversationFingerprint) {
    return [
      previous?.messageFingerprint,
      previous ? makeMessageFingerprint({ ...previous, conversationFingerprint }) : "",
    ].filter(Boolean);
  }

  function strongestSameMessageCandidate(candidates, freshItem, conversationFingerprint) {
    if (!freshItem.messageFingerprint) return null;
    return candidates
      .filter(Boolean)
      .filter((candidate) => fingerprintsForPrevious(candidate, conversationFingerprint)
        .includes(freshItem.messageFingerprint))
      .sort((left, right) => (
        statusPriority(right) - statusPriority(left)
      ))[0] || null;
  }

  function mergeQueueCandidate(existingValue, freshItems, options = {}) {
    const now = options.now || new Date().toISOString();
    const limit = Number(options.limit) > 0 ? Number(options.limit) : DEFAULT_LIMIT;
    const map = new Map();
    normalizeQueue(existingValue).forEach((item) => {
      const fingerprint = item.conversationFingerprint || makeConversationFingerprint(item);
      const hasTrustedHint = Boolean(dataHint(item) && dataHintIsUnique(item));
      const key = item.debug
        ? `debug:${item.id}`
        : (hasTrustedHint && fingerprint ? fingerprint : `legacy:${item.id}`);
      map.set(key, { ...item, conversationFingerprint: fingerprint || item.conversationFingerprint || "" });
    });
    (Array.isArray(freshItems) ? freshItems : [])
      .filter((item) => item && item.shouldQueue === true)
      .forEach((item) => {
        const fingerprint = item.conversationFingerprint || makeConversationFingerprint(item);
        if (!fingerprint && !item.debug) return;
        const key = item.debug ? `debug:${item.id}` : fingerprint;
        let previous = map.get(key);
        if (!item.debug) {
          const legacyEntries = findLegacyQueueEntries(map, item);
          legacyEntries.forEach(([legacyKey]) => map.delete(legacyKey));
          const candidates = [previous, ...legacyEntries.map(([, value]) => value)].filter(Boolean);
          const basePrevious = previous || candidates[0] || null;
          const statusPrevious = strongestSameMessageCandidate(candidates, item, fingerprint);
          previous = basePrevious
            ? {
              ...basePrevious,
              status: statusPrevious?.status || basePrevious.status,
              statusChangedAt: statusPrevious?.statusChangedAt
                || statusPrevious?.updatedAt
                || statusPrevious?.firstSeenAt
                || basePrevious.statusChangedAt,
            }
            : null;
        }
        const previousMessageFingerprints = fingerprintsForPrevious(previous, fingerprint);
        const sameMessage = Boolean(
          previous
          && item.messageFingerprint
          && previousMessageFingerprints.includes(item.messageFingerprint),
        );
        const previousStatusChangedAt = Date.parse(
          previous?.statusChangedAt || previous?.updatedAt || previous?.firstSeenAt || "",
        );
        const currentTime = Date.parse(now);
        const draftCooldownElapsed = Boolean(
          sameMessage
          && previous?.status === "draft_filled"
          && !messageHint(previous)
          && !messageHint(item)
          && Number.isFinite(previousStatusChangedAt)
          && Number.isFinite(currentTime)
          && currentTime - previousStatusChangedAt >= DRAFT_REOPEN_AFTER_MS,
        );
        const preservedStatus = sameMessage
          && !draftCooldownElapsed
          && !isRecoverableQueueStatus(previous)
          && ["needs_user", "draft_filled"].includes(previous.status)
          ? previous.status
          : (item.status || "pending");
        map.set(key, {
          ...previous,
          ...item,
          id: previous?.id || item.id || `hr_reply_${fingerprint.replace(/^conversation_/, "")}`,
          conversationFingerprint: fingerprint,
          status: preservedStatus,
          statusChangedAt: previous?.status === preservedStatus
            ? (previous?.statusChangedAt || previous?.updatedAt || previous?.firstSeenAt || now)
            : now,
          firstSeenAt: previous?.firstSeenAt || item.firstSeenAt || now,
          messageFirstSeenAt: sameMessage
            ? (previous?.messageFirstSeenAt || previous?.firstSeenAt || now)
            : (item.messageFirstSeenAt || now),
          updatedAt: now,
        });
      });
    return Array.from(map.values()).slice(-limit);
  }

  return {
    classifySnapshot,
    makeConversationFingerprint,
    makeMessageFingerprint,
    stableHintsMatch,
    mergeQueueCandidate,
    pendingItems,
    dedupeQueueItems,
    normalizeQueue,
    isRecoverableQueueStatus,
    cleanupResolvedRecoverableItems,
  };
});
