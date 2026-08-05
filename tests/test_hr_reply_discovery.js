const assert = require("assert");
const fs = require("fs");
const path = require("path");
const discovery = require("../plugin/hr_reply_discovery");

const contentSource = fs.readFileSync(path.join(__dirname, "../plugin/content.js"), "utf8");

const base = {
  hr_name: "Lin",
  company: "Acme",
  hr_role: "Recruiter",
  latest_hr_message: "Please send your resume.",
  unread: true,
  unread_kind: "badge",
  unread_count_text: "2",
};

function classify(overrides = {}) {
  return discovery.classifySnapshot({ ...base, ...overrides });
}

function item(overrides = {}) {
  const snapshot = {
    ...base,
    data_hint: "data-key:base-chat",
    data_hint_unique: true,
    ...overrides,
  };
  const conversationFingerprint = discovery.makeConversationFingerprint(snapshot);
  return {
    id: `hr_reply_${conversationFingerprint.slice(-8)}`,
    ...snapshot,
    conversationFingerprint,
    messageFingerprint: discovery.makeMessageFingerprint({ ...snapshot, conversationFingerprint }),
    shouldQueue: true,
    status: "pending",
  };
}

function functionSource(name) {
  const start = contentSource.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const bodyMarker = contentSource.indexOf(") {", start);
  const braceStart = bodyMarker >= 0 ? bodyMarker + 2 : -1;
  assert.ok(braceStart >= 0, `missing body for ${name}`);
  let depth = 0;
  let quote = "";
  let inRegex = false;
  let escaped = false;
  for (let index = braceStart; index < contentSource.length; index += 1) {
    const char = contentSource[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (inRegex) {
      if (char === "/") inRegex = false;
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "/" && !["/", "*"].includes(contentSource[index + 1])) {
      inRegex = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return contentSource.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function contentUnreadHelpers() {
  const names = [
    "uniqueElements",
    "isVisible",
    "text",
    "inlineText",
    "firstMatchingDescendant",
    "extractUnreadEvidence",
    "avatarUnreadRoots",
    "candidateNodes",
    "firstVisibleNode",
    "isTrustedAvatarNumericUnreadNode",
    "isAvatarBoundUnreadNode",
    "avatarUnreadSource",
    "avatarUnreadCountText",
    "hasUnreadBadgeSemanticHint",
    "hasAvatarSemanticHint",
    "isRedUnreadBadgeNode",
    "styleAttributeHasRedBackground",
    "isRedColorValue",
    "isNearAvatarUnreadCorner",
    "conversationDataKey",
    "extractStableConversationHint",
    "conversationIdentityHintFromCard",
    "conversationIdentityHint",
    "extractConversationIdentityFromCard",
    "extractTitleIdentityFragments",
    "normalizeIdentityHintValue",
    "extractCompanyFromTitleLine",
    "extractRoleFromTitleLine",
    "splitTitleIdentityText",
    "normalizeTitleIdentityPart",
    "simpleHash",
  ];
  return new Function(`${names.map(functionSource).join("\n")}; return { extractUnreadEvidence, extractStableConversationHint, extractConversationIdentityFromCard };`)();
}

function contentDiagnosticHelpers() {
  const names = [
    "appendHrReplyDiscoveryDiagnostics",
    "formatHrReplyDiscoveryDiagnostics",
    "discoveryDiagnosticsSnapshot",
    "sanitizeHrReplyDiscoveryDiagnostics",
    "safeDiagnosticsCount",
    "safeDiagnosticsCountList",
  ];
  return new Function(`${names.map(functionSource).join("\n")}; return { appendHrReplyDiscoveryDiagnostics, discoveryDiagnosticsSnapshot };`)();
}

class FakeNode {
  constructor(tagName, attrs = {}, children = [], text = "") {
    this.tagName = String(tagName || "div").toLowerCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this._text = text;
    this.style = attrs.styleObject || {};
    this.classList = {
      contains: (name) => this.classTokens().includes(name),
    };
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
  }

  classTokens() {
    return String(this.attrs.class || "").split(/\s+/).filter(Boolean);
  }

  get className() {
    return this.attrs.class || "";
  }

  get innerText() {
    return [this._text, ...this.children.map((child) => child.innerText)]
      .filter(Boolean)
      .join(" ");
  }

  get textContent() {
    return this.innerText;
  }

  getAttribute(name) {
    return this.attrs[name] || "";
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  matches(selector) {
    return String(selector || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => this.matchesSingle(part));
  }

  matchesSingle(selector) {
    if (selector.startsWith(".")) return this.classTokens().includes(selector.slice(1));
    return selector.toLowerCase() === this.tagName;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
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

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  contains(target) {
    if (!target) return false;
    if (target === this) return true;
    return this.children.some((child) => child.contains(target));
  }

  getBoundingClientRect() {
    if (this.attrs.hidden) return { width: 0, height: 0 };
    const left = Number(this.attrs.left || 0);
    const top = Number(this.attrs.top || 0);
    const width = Number(this.attrs.width || 20);
    const height = Number(this.attrs.height || 20);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
}

function node(tagName, attrs = {}, children = [], text = "") {
  return new FakeNode(tagName, attrs, children, text);
}

assert.strictEqual(classify({ unread: false }).shouldQueue, false);
assert.strictEqual(classify({ unread: false }).reject_reason, "no_unread");
assert.strictEqual(classify().shouldQueue, true);
assert.strictEqual(classify({ unread_kind: "avatar_numeric", unread_count_text: "1" }).shouldQueue, true);
assert.strictEqual(classify({ require_stable_hint: true }).reject_reason, "missing_stable_hint");
assert.strictEqual(classify({
  require_stable_hint: true,
  data_hint: "data-key:chat-1",
  data_hint_unique: true,
}).shouldQueue, true);
assert.strictEqual(classify({ unread_kind: "dot", data_hint: "chat-1", data_hint_unique: false }).reject_reason, "unconfirmed_dot");
assert.strictEqual(classify({ unread_kind: "dot", data_hint: "chat-1", data_hint_unique: true }).reject_reason, "unconfirmed_dot");
assert.strictEqual(classify({ unread_kind: "badge", unread_count_text: "" }).reject_reason, "unreliable_unread");
assert.strictEqual(classify({ system: true }).reject_reason, "system");
assert.strictEqual(classify({ group: true }).reject_reason, "group");
assert.strictEqual(classify({ draft: true }).reject_reason, "draft");
assert.strictEqual(classify({ latest_hr_message: "" }).reject_reason, "missing_message");
assert.strictEqual(classify({ latest_sender: "me" }).reject_reason, "latest_sender_me");
assert.strictEqual(classify({ hr_role: "" }).reject_reason, "insufficient_identity");

const withHint = { ...base, data_hint: "chat-1", data_hint_unique: true };
assert.strictEqual(
  discovery.makeConversationFingerprint(withHint),
  discovery.makeConversationFingerprint({ ...withHint, time_text: "10:00", latest_hr_message: "A different message" }),
);
assert.strictEqual(
  discovery.makeMessageFingerprint(withHint),
  discovery.makeMessageFingerprint({ ...withHint, time_text: "11:00" }),
);
assert.notStrictEqual(
  discovery.makeMessageFingerprint({ ...withHint, message_hint: "data-mid:1" }),
  discovery.makeMessageFingerprint({ ...withHint, message_hint: "data-mid:2" }),
);
assert.strictEqual(
  discovery.stableHintsMatch({ data_hint: "data-key:a" }, { data_hint: "data-key:a" }),
  true,
);
assert.strictEqual(
  discovery.stableHintsMatch({ data_hint: "data-key:a" }, { data_hint: "data-key:b" }),
  false,
);
assert.strictEqual(
  discovery.stableHintsMatch({ data_hint: "data-key:a" }, {}),
  false,
);
assert.notStrictEqual(
  discovery.makeConversationFingerprint({ ...base, job_title: "Agent Engineer" }),
  discovery.makeConversationFingerprint({ ...base, job_title: "Backend Engineer" }),
);

const repeated = item();
const repeatedQueue = discovery.mergeQueueCandidate([], [repeated, repeated, repeated], { now: "2026-08-03T00:00:00.000Z" });
assert.strictEqual(repeatedQueue.length, 1);
const refreshedQueue = discovery.mergeQueueCandidate(repeatedQueue, [repeated], { now: "2026-08-03T00:00:30.000Z" });
assert.strictEqual(refreshedQueue[0].updatedAt, "2026-08-03T00:00:30.000Z");

const newer = item({ latest_hr_message: "The interview is tomorrow.", time_text: "later" });
const updatedQueue = discovery.mergeQueueCandidate(repeatedQueue, [newer], { now: "2026-08-03T00:01:00.000Z" });
assert.strictEqual(updatedQueue.length, 1);
assert.strictEqual(updatedQueue[0].id, repeated.id);
assert.strictEqual(updatedQueue[0].latest_hr_message, newer.latest_hr_message);

const needsUser = { ...repeated, status: "needs_user" };
const preservedNeedsUser = discovery.mergeQueueCandidate([needsUser], [repeated], { now: "2026-08-03T00:02:00.000Z" });
assert.strictEqual(preservedNeedsUser[0].status, "needs_user");
const recoverableMismatch = {
  ...repeated,
  status: "needs_user",
  statusReason: "conversation_mismatch",
  note: "当前会话与待回复记录不一致，请打开对应会话后重试",
};
assert.strictEqual(discovery.isRecoverableQueueStatus(recoverableMismatch), true);
const retriedMismatch = discovery.mergeQueueCandidate([recoverableMismatch], [repeated], { now: "2026-08-03T00:02:30.000Z" });
assert.strictEqual(retriedMismatch[0].status, "pending");
const resolvedWithOldMismatch = discovery.dedupeQueueItems([
  recoverableMismatch,
  { ...repeated, id: "resolved-debug", status: "draft_filled", debug: true },
]);
assert.strictEqual(resolvedWithOldMismatch.length, 1);
assert.strictEqual(resolvedWithOldMismatch[0].status, "draft_filled");
const draftFilled = { ...repeated, status: "draft_filled" };
const preservedDraft = discovery.mergeQueueCandidate([draftFilled], [repeated], { now: "2026-08-03T00:03:00.000Z" });
assert.strictEqual(preservedDraft[0].status, "draft_filled");
assert.strictEqual(discovery.pendingItems(preservedDraft).length, 0);
assert.strictEqual(discovery.pendingItems([{ ...repeated, status: "handled" }]).length, 0);

const sameTextNewMessage = item({ message_hint: "data-mid:new-message" });
const oldDraftWithMessageHint = {
  ...item({ message_hint: "data-mid:old-message" }),
  status: "draft_filled",
};
const reopenedSameText = discovery.mergeQueueCandidate(
  [oldDraftWithMessageHint],
  [sameTextNewMessage],
  { now: "2026-08-03T00:03:30.000Z" },
);
assert.strictEqual(reopenedSameText.length, 1);
assert.strictEqual(reopenedSameText[0].status, "pending");

const noMessageHintDraft = {
  ...item({ message_hint: "" }),
  status: "draft_filled",
  updatedAt: "2026-08-03T00:00:00.000Z",
};
const noMessageHintRepeat = item({ message_hint: "" });
const reopenedWithoutMessageHint = discovery.mergeQueueCandidate(
  [noMessageHintDraft],
  [noMessageHintRepeat],
  { now: "2026-08-03T00:02:00.000Z" },
);
assert.strictEqual(reopenedWithoutMessageHint.length, 1);
assert.strictEqual(reopenedWithoutMessageHint[0].status, "pending");

const scanAtThirtySeconds = discovery.mergeQueueCandidate(
  [noMessageHintDraft],
  [noMessageHintRepeat],
  { now: "2026-08-03T00:00:30.000Z" },
);
assert.strictEqual(scanAtThirtySeconds[0].status, "draft_filled");
assert.strictEqual(scanAtThirtySeconds[0].statusChangedAt, "2026-08-03T00:00:00.000Z");
const scanAtSixtySeconds = discovery.mergeQueueCandidate(
  scanAtThirtySeconds,
  [noMessageHintRepeat],
  { now: "2026-08-03T00:01:00.000Z" },
);
assert.strictEqual(scanAtSixtySeconds[0].status, "pending");

const stableFresh = item({
  data_hint: "data-key:chat-1",
  data_hint_unique: true,
  dataHint: "data-key:chat-1",
  dataHintUnique: true,
});
const legacyNeedsUser = {
  ...repeated,
  id: "legacy-queue-item",
  conversationFingerprint: "",
  messageFingerprint: "",
  data_hint: "",
  dataHint: "",
  data_hint_unique: false,
  dataHintUnique: false,
  status: "needs_user",
};
const migratedLegacy = discovery.mergeQueueCandidate(
  [legacyNeedsUser],
  [stableFresh],
  { now: "2026-08-03T00:03:40.000Z" },
);
assert.strictEqual(migratedLegacy.length, 1);
assert.strictEqual(migratedLegacy[0].id, "legacy-queue-item");
assert.strictEqual(migratedLegacy[0].status, "needs_user");
assert.strictEqual(migratedLegacy[0].conversationFingerprint, stableFresh.conversationFingerprint);

const legacyWithOldMessage = {
  ...legacyNeedsUser,
  latest_hr_message: "Old question",
};
const freshWithNewMessage = {
  ...stableFresh,
  latest_hr_message: "New question",
};
freshWithNewMessage.messageFingerprint = discovery.makeMessageFingerprint(freshWithNewMessage);
const migratedChangedMessage = discovery.mergeQueueCandidate(
  [legacyWithOldMessage],
  [freshWithNewMessage],
  { now: "2026-08-03T00:04:00.000Z" },
);
assert.strictEqual(migratedChangedMessage.length, 1);
assert.strictEqual(migratedChangedMessage[0].id, "legacy-queue-item");
assert.strictEqual(migratedChangedMessage[0].status, "pending");
assert.strictEqual(migratedChangedMessage[0].latest_hr_message, "New question");

const stableExisting = {
  ...stableFresh,
  id: "stable-queue-item",
  status: "pending",
};
const cleanedCoexistingLegacy = discovery.mergeQueueCandidate(
  [legacyNeedsUser, stableExisting],
  [stableFresh],
  { now: "2026-08-03T00:04:30.000Z" },
);
assert.strictEqual(cleanedCoexistingLegacy.length, 1);
assert.strictEqual(cleanedCoexistingLegacy[0].id, "stable-queue-item");
assert.strictEqual(cleanedCoexistingLegacy[0].status, "needs_user");

const legacyDraftSameMessage = {
  ...legacyNeedsUser,
  id: "legacy-draft",
  status: "draft_filled",
};
const mergedMultipleLegacy = discovery.mergeQueueCandidate(
  [legacyNeedsUser, legacyDraftSameMessage, stableExisting],
  [stableFresh],
  { now: "2026-08-03T00:04:45.000Z" },
);
assert.strictEqual(mergedMultipleLegacy.length, 1);
assert.strictEqual(mergedMultipleLegacy[0].id, "stable-queue-item");
assert.strictEqual(mergedMultipleLegacy[0].status, "draft_filled");

const duplicatePendingItems = discovery.pendingItems([
  stableExisting,
  { ...stableExisting, id: "duplicate-stable", status: "needs_user" },
]);
assert.strictEqual(duplicatePendingItems.length, 1);
assert.strictEqual(duplicatePendingItems[0].status, "needs_user");

const debugItem = {
  ...repeated,
  id: "debug-one",
  debug: true,
  source: "debug_current_chat",
};
const debugQueue = discovery.mergeQueueCandidate([debugItem], [debugItem], { now: "2026-08-03T00:04:00.000Z" });
assert.strictEqual(debugQueue.length, 1);

const duplicateHint = discovery.makeConversationFingerprint({ ...base, data_hint: "shared", data_hint_unique: false });
assert.notStrictEqual(duplicateHint, discovery.makeConversationFingerprint({ ...base, data_hint: "shared", data_hint_unique: true }));
assert.notStrictEqual(duplicateHint, "");
assert.strictEqual(
  discovery.makeConversationFingerprint({ ...base, data_hint: "shared", data_hint_unique: false, hr_role: "" }),
  "",
);

const helpers = contentUnreadHelpers();
const topUnreadFilter = node("div", { class: "boss-label" }, [
  node("span", { class: "tab-text" }, [], "未读(3)"),
  node("span", { class: "top-red-dot", style: "background:#ff4d4f", left: 300, top: 10 }, [], "3"),
]);
function bossUnreadWrapper({
  dataKey = "",
  name,
  company = "",
  role = "",
  message,
  count,
  top,
}) {
  const wrapperAttrs = { class: "friend-content-warp" };
  if (dataKey) wrapperAttrs["data-key"] = dataKey;
  return node("div", wrapperAttrs, [
    node("div", { class: "friend-content", left: 0, top, width: 360, height: 78 }, [
      node("div", { class: "figure", left: 24, top: top + 12, width: 48, height: 48 }, [
        node("img", { class: "avatar", left: 24, top: top + 12, width: 48, height: 48 }),
      ]),
      node("span", { class: "boss-unread-num", style: "background:#ff4d4f", left: 58, top: top + 6, width: 18, height: 18 }, [], count),
      node("div", { class: "text" }, [
        node("div", { class: "title-box" }, [
          node("span", { class: "name-box" }, [
            node("span", { class: "name-text" }, [], name),
            ...(company ? [node("span", { class: "brand-name" }, [], company)] : []),
            ...(role ? [node("span", { class: "boss-title" }, [], role)] : []),
          ]),
        ]),
        node("div", { class: "gray last-msg" }, [node("span", { class: "last-msg-text" }, [], message)]),
      ]),
    ]),
  ]);
}

const firstUnreadWrapper = bossUnreadWrapper({
  name: "Alpha",
  company: "Northwind",
  role: "Recruiter",
  message: "Fixture message A",
  count: "2",
  top: 100,
});
const secondUnreadWrapper = bossUnreadWrapper({
  name: "Beta",
  company: "Contoso",
  role: "Director",
  message: "Fixture message B",
  count: "1",
  top: 178,
});
node("div", { class: "page" }, [topUnreadFilter, firstUnreadWrapper, secondUnreadWrapper]);
assert.deepStrictEqual(helpers.extractUnreadEvidence(topUnreadFilter), {
  unread: false,
  kind: "",
  countText: "",
  source: "",
});
const firstUnreadCard = firstUnreadWrapper.querySelector(".friend-content");
const secondUnreadCard = secondUnreadWrapper.querySelector(".friend-content");
const firstUnreadBadge = helpers.extractUnreadEvidence(firstUnreadCard);
const secondUnreadBadge = helpers.extractUnreadEvidence(secondUnreadCard);
assert.deepStrictEqual(firstUnreadBadge, {
  unread: true,
  kind: "avatar_numeric",
  countText: "2",
  source: "avatar_nearby_numeric",
});
assert.deepStrictEqual(secondUnreadBadge, {
  unread: true,
  kind: "avatar_numeric",
  countText: "1",
  source: "avatar_nearby_numeric",
});
const visibleUnreadCards = [firstUnreadCard, secondUnreadCard];
assert.deepStrictEqual(helpers.extractConversationIdentityFromCard(firstUnreadCard), {
  hrName: "Alpha",
  company: "Northwind",
  hrRole: "Recruiter",
  titleLine: "Alpha Northwind Recruiter",
});
const firstIdentityHint = helpers.extractStableConversationHint(firstUnreadCard, visibleUnreadCards);
const secondIdentityHint = helpers.extractStableConversationHint(secondUnreadCard, visibleUnreadCards);
assert.match(firstIdentityHint, /^identity:\d+$/);
assert.match(secondIdentityHint, /^identity:\d+$/);
assert.notStrictEqual(firstIdentityHint, secondIdentityHint);
assert.doesNotMatch(firstIdentityHint, /Alpha|Northwind/);
assert.doesNotMatch(secondIdentityHint, /Beta|Contoso/);

const whitespaceTitleWrapper = node("div", { class: "friend-content-warp" }, [
  node("div", { class: "friend-content" }, [
    node("div", { class: "title-box" }, [
      node("span", { class: "name-text" }, [], "Gamma"),
      node("span", { class: "combined-title" }, [], " Tailspin HRBP "),
    ]),
  ]),
]);
const whitespaceTitleCard = whitespaceTitleWrapper.querySelector(".friend-content");
assert.deepStrictEqual(helpers.extractConversationIdentityFromCard(whitespaceTitleCard), {
  hrName: "Gamma",
  company: "Tailspin",
  hrRole: "HRBP",
  titleLine: "Gamma Tailspin HRBP",
});
assert.match(helpers.extractStableConversationHint(whitespaceTitleCard, [whitespaceTitleCard]), /^identity:\d+$/);
const firstUnreadSnapshot = {
  hr_name: "Alpha",
  company: "Northwind",
  hr_role: "Recruiter",
  latest_hr_message: "Fixture message A",
  unread: firstUnreadBadge.unread,
  unread_kind: firstUnreadBadge.kind,
  unread_count_text: firstUnreadBadge.countText,
  data_hint: firstIdentityHint,
  data_hint_unique: true,
};
const secondUnreadSnapshot = {
  hr_name: "Beta",
  company: "Contoso",
  hr_role: "Director",
  latest_hr_message: "Fixture message B",
  unread: secondUnreadBadge.unread,
  unread_kind: secondUnreadBadge.kind,
  unread_count_text: secondUnreadBadge.countText,
  data_hint: secondIdentityHint,
  data_hint_unique: true,
};
assert.strictEqual(classify(firstUnreadSnapshot).shouldQueue, true);
assert.strictEqual(discovery.classifySnapshot(secondUnreadSnapshot).shouldQueue, true);
assert.notStrictEqual(
  discovery.makeConversationFingerprint({ ...base, ...firstUnreadSnapshot }),
  discovery.makeConversationFingerprint(secondUnreadSnapshot),
);

const firstUnreadMessageChanged = bossUnreadWrapper({
  name: "Alpha",
  company: "Northwind",
  role: "Recruiter",
  message: "Fixture message changed",
  count: "9",
  top: 260,
}).querySelector(".friend-content");
assert.strictEqual(
  helpers.extractStableConversationHint(firstUnreadMessageChanged, [firstUnreadMessageChanged]),
  helpers.extractStableConversationHint(firstUnreadCard, [firstUnreadCard]),
);

const duplicateIdentityA = bossUnreadWrapper({
  name: "Delta",
  company: "Fabrikam",
  role: "Consultant",
  message: "Duplicate message A",
  count: "1",
  top: 340,
}).querySelector(".friend-content");
const duplicateIdentityB = bossUnreadWrapper({
  name: "Delta",
  company: "Fabrikam",
  role: "Consultant",
  message: "Duplicate message B",
  count: "2",
  top: 418,
}).querySelector(".friend-content");
assert.strictEqual(helpers.extractStableConversationHint(duplicateIdentityA, [duplicateIdentityA, duplicateIdentityB]), "");
assert.strictEqual(helpers.extractStableConversationHint(duplicateIdentityB, [duplicateIdentityA, duplicateIdentityB]), "");

const missingCompanyCard = bossUnreadWrapper({
  name: "NoCompany",
  message: "Missing company",
  count: "1",
  top: 496,
}).querySelector(".friend-content");
const missingRoleCard = bossUnreadWrapper({
  name: "NoRole",
  company: "Tailspin",
  message: "Missing role",
  count: "1",
  top: 574,
}).querySelector(".friend-content");
assert.strictEqual(helpers.extractStableConversationHint(missingCompanyCard, [missingCompanyCard]), "");
assert.strictEqual(helpers.extractStableConversationHint(missingRoleCard, [missingRoleCard]), "");

const dataKeyWrapper = bossUnreadWrapper({
  dataKey: "real-chat-legacy",
  name: "Legacy",
  company: "WideWorld",
  role: "Partner",
  message: "Legacy key",
  count: "1",
  top: 652,
});
const dataKeyCard = dataKeyWrapper.querySelector(".friend-content");
assert.strictEqual(helpers.extractStableConversationHint(dataKeyCard, [dataKeyCard]), "data-key:real-chat-legacy");

const missingStableHint = classify({
  unread: firstUnreadBadge.unread,
  unread_kind: firstUnreadBadge.kind,
  unread_count_text: firstUnreadBadge.countText,
  require_stable_hint: true,
  data_hint: "",
  data_hint_unique: false,
});
assert.strictEqual(missingStableHint.reject_reason, "missing_stable_hint");

const wrapperSiblingBadge = node("div", { class: "friend-content-warp", "data-key": "real-chat-3" }, [
  node("span", { class: "notice-badge" }, [], "1"),
  node("div", { class: "friend-content" }, [
    node("div", { class: "figure" }, [node("img", { class: "avatar" })]),
  ]),
]);
assert.deepStrictEqual(helpers.extractUnreadEvidence(wrapperSiblingBadge.querySelector(".friend-content")), {
  unread: true,
  kind: "badge",
  countText: "1",
  source: "notice_badge",
});

const noCardBadgeWrapper = node("div", { class: "friend-content-warp", "data-key": "real-chat-4" }, [
  node("div", { class: "friend-content" }, [
    node("div", { class: "figure" }, [node("img", { class: "avatar" })]),
  ]),
]);
assert.deepStrictEqual(helpers.extractUnreadEvidence(noCardBadgeWrapper.querySelector(".friend-content")), {
  unread: false,
  kind: "",
  countText: "",
  source: "",
});

const diagnosticHelpers = contentDiagnosticHelpers();
const diagnosticSnapshot = {
  cardCount: 12,
  queuedCount: 0,
  rejectedCount: 12,
  singleCardUnreadCount: 2,
  numericUnreadMissingStableHintCount: 1,
  unreadSources: "avatar_nearby_numeric:2,none:10",
  rejectReasons: "missing_stable_hint:1,no_unread:10,missing_message:1",
};
const normalMessage = "已检查消息列表，暂未看到带未读标记的 HR 回复。";
const debugVisibleMessage = diagnosticHelpers.appendHrReplyDiscoveryDiagnostics(normalMessage, true, diagnosticSnapshot);
assert.match(debugVisibleMessage, /^已检查消息列表，暂未看到带未读标记的 HR 回复。\n诊断 /);
assert.match(debugVisibleMessage, /cardCount=12/);
assert.match(debugVisibleMessage, /queuedCount=0/);
assert.match(debugVisibleMessage, /rejectedCount=12/);
assert.match(debugVisibleMessage, /singleCardUnreadCount=2/);
assert.match(debugVisibleMessage, /numericUnreadMissingStableHintCount=1/);
assert.match(debugVisibleMessage, /unreadSources=avatar_nearby_numeric:2,none:10/);
assert.match(debugVisibleMessage, /rejectReasons=missing_stable_hint:1,no_unread:10,missing_message:1/);
assert.strictEqual(
  diagnosticHelpers.appendHrReplyDiscoveryDiagnostics(normalMessage, false, diagnosticSnapshot),
  normalMessage,
);
const sensitiveDiagnosticMessage = diagnosticHelpers.appendHrReplyDiscoveryDiagnostics("检查完成", true, {
  cardCount: 3,
  queuedCount: 0,
  rejectedCount: 3,
  singleCardUnreadCount: 0,
  numericUnreadMissingStableHintCount: 0,
  unreadSources: "none:3,private body from HR:1",
  rejectReasons: "no_unread:3,Please send your resume:1",
});
assert.doesNotMatch(sensitiveDiagnosticMessage, /private body|Please send|resume|Acme|Lin/);
assert.deepStrictEqual(diagnosticHelpers.discoveryDiagnosticsSnapshot({
  cardCount: "2",
  queuedCount: "bad",
  rejectedCount: -1,
  singleCardUnreadCount: 1.8,
  numericUnreadMissingStableHintCount: 1,
  unreadSources: "avatar_nearby_numeric:2,unsafe text:7",
  rejectReasons: "missing_stable_hint:1,secret phrase:9",
}), {
  cardCount: 2,
  queuedCount: 0,
  rejectedCount: 0,
  singleCardUnreadCount: 1,
  numericUnreadMissingStableHintCount: 1,
  unreadSources: "avatar_nearby_numeric:2",
  rejectReasons: "missing_stable_hint:1",
});

assert.match(contentSource, /window\.HRReplyDiscovery \|\| null/);
assert.doesNotMatch(contentSource, /throw new Error\("HR reply discovery module is unavailable"\)/);
assert.match(contentSource, /module_missing/);
assert.doesNotMatch(contentSource, /card\?\.closest\?\.\("\[data-key\]"\)/);
assert.match(contentSource, /if \(item\.dataHint\) return null;/);
assert.match(contentSource, /hrDiscoverySingleCardUnread/);
assert.match(contentSource, /hrDiscoveryNumericUnreadMissingStableHint/);
assert.match(contentSource, /message = appendHrReplyDiscoveryDiagnostics\(hrReplyStateMessage\(queue\)\)/);
assert.match(contentSource, /discovery: discoveryDiagnosticsSnapshot\(\)/);

console.log("hr_reply_discovery: 64 scenarios passed");
