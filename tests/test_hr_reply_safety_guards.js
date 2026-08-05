"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../plugin/content.js"), "utf8");
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok - ${name}\n`);
}

function functionSource(name) {
  const patterns = [`function ${name}(`, `async function ${name}(`];
  const start = patterns
    .map((pattern) => source.indexOf(pattern))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `missing function ${name}`);

  const bodyMarker = source.indexOf(") {", start);
  const braceStart = bodyMarker >= 0 ? bodyMarker + 2 : -1;
  assert.ok(braceStart >= 0, `missing body for ${name}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
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
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function assertOrdered(block, first, second, message) {
  const firstIndex = block.indexOf(first);
  const secondIndex = block.indexOf(second);
  assert.ok(firstIndex >= 0, `missing ${first}`);
  assert.ok(secondIndex >= 0, `missing ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

function matcherHelpers() {
  const names = [
    "compactForMatch",
    "compactChatMatchValue",
    "exactChatMatchValue",
    "relatedChatMatchValue",
    "hrNameMatches",
    "chatMessageComparablePrefix",
    "chatMessageMatches",
    "stableConversationIdentityMatches",
    "evidenceMatchesQueueItem",
    "replyTargetStillCurrent",
    "isRecoverableHrReplyQueueItem",
    "sameHrReplyQueueTarget",
    "isSafeToRemoveAfterDraftFilled",
    "cleanupHrReplyQueueAfterDraftFilled",
  ];
  return new Function(`
const HR_REPLY_DEBUG_SOURCE = "debug_current_chat";
const HR_REPLY_DISCOVERY = {
  stableHintsMatch(expected = {}, actual = {}) {
    const left = String(expected.data_hint || "").trim().toLowerCase();
    const right = String(actual.data_hint || "").trim().toLowerCase();
    if (!left) return true;
    return Boolean(right && left === right);
  },
};
${names.map(functionSource).join("\n")}
return { evidenceMatchesQueueItem, replyTargetStillCurrent, cleanupHrReplyQueueAfterDraftFilled, isRecoverableHrReplyQueueItem };
`)();
}

test("auto confirmation rejects resume attachment actions", () => {
  const block = functionSource("findChatConfirmButton");
  assert.match(block, /发送\.\*简历\|投递\.\*简历\|附件简历\|简历附件/);
  const allowedLine = block.split(/\r?\n/).find((line) => line.includes("return /^(留在此页")) || "";
  assert.ok(allowedLine, "missing confirmation allowlist");
  assert.doesNotMatch(allowedLine, /发送简历|投递简历/);
});

test("reply target is revalidated after backend response", () => {
  const block = functionSource("processHrReplyTarget");
  assertOrdered(block, "await requestChatReply(requestEvidence)", "replyTargetStillCurrent(requestEvidence, responseEvidence, item)", "target check must happen after the reply returns");
  assertOrdered(block, "replyTargetStillCurrent(requestEvidence, responseEvidence, item)", "handleChatReplyResult(reply, responseEvidence, item)", "target check must happen before handing off the draft");
  assert.match(block, /catch \(error\)[\s\S]*forgetHrReplyTask\(\)/);
});

test("conversation and input are checked immediately before filling", () => {
  const block = functionSource("handleChatReplyResult");
  assertOrdered(block, "replyTargetStillCurrent(evidence, fillEvidence, item)", "fillChatInput(currentInput", "conversation must be checked before filling");
  assertOrdered(block, "currentInput !== input", "fillChatInput(currentInput", "the same editor must still be active before filling");
});

test("HR reply task lock is not reentrant", () => {
  const block = functionSource("acquireTaskLock");
  assert.match(block, /taskLock\.owner === owner && owner === "hr_reply"[\s\S]*ok: false/);
});

test("active task locks are not expired by wall clock alone", () => {
  const block = functionSource("clearStaleTaskLock");
  assert.match(block, /taskLockOwnerIsActive\(taskLock\.owner\)/);
});

test("persisted navigation task is consumed before processing", () => {
  const block = functionSource("resumeHrReplyTaskIfNeeded");
  assertOrdered(block, "forgetHrReplyTask()", "processHrReplyTarget(task.item || null)", "refresh must not replay an already consumed task");
});

test("selected conversation marker includes wrapper level classes", () => {
  const selectedBlock = functionSource("selectedConversationCard");
  const markerBlock = functionSource("conversationCardHasSelectedMarker");
  const nodeBlock = functionSource("nodeHasSelectedConversationMarker");
  assert.match(selectedBlock, /conversationCardHasSelectedMarker/);
  assert.match(markerBlock, /friend-content-warp/);
  assert.match(nodeBlock, /aria-selected/);
  assert.match(nodeBlock, /data-selected/);
});

test("stable data-key match tolerates changed latest HR text", () => {
  const { evidenceMatchesQueueItem, replyTargetStillCurrent } = matcherHelpers();
  const item = {
    dataHint: "data-key:conversation-1",
    hr_name: "Tang",
    company: "Acme",
    job_title: "",
    latest_hr_message: "Old list summary",
  };
  const evidence = {
    latest_hr_message: "Full detail message that changed after opening",
    current_chat_identity: {
      data_hint: "data-key:conversation-1",
      hr_name: "Tang",
      company: "Different detail header",
      job_title: "",
    },
  };
  const before = {
    latest_hr_message: "Message before backend returns",
    current_chat_identity: {
      data_hint: "data-key:conversation-1",
      hr_name: "Tang",
      company: "Acme",
      job_title: "",
    },
  };
  const after = {
    latest_hr_message: "Same conversation but richer text after DOM refresh",
    current_chat_identity: {
      data_hint: "data-key:conversation-1",
      hr_name: "Tang",
      company: "Acme",
      job_title: "",
    },
  };

  assert.equal(evidenceMatchesQueueItem(evidence, item), true);
  assert.equal(replyTargetStillCurrent(before, after, item), true);
});

test("stable data-key match tolerates richer detail header names", () => {
  const { evidenceMatchesQueueItem } = matcherHelpers();
  const item = {
    dataHint: "data-key:conversation-1",
    hr_name: "Tang",
    company: "Acme",
    latest_hr_message: "List summary",
  };
  const evidence = {
    latest_hr_message: "Detail message",
    current_chat_identity: {
      data_hint: "data-key:conversation-1",
      hr_name: "Tang Acme HR",
      company: "Acme",
    },
  };

  assert.equal(evidenceMatchesQueueItem(evidence, item), true);
});

test("missing detail data-key falls back to strict visible identity", () => {
  const { evidenceMatchesQueueItem } = matcherHelpers();
  const item = {
    dataHint: "data-key:conversation-1",
    hr_name: "Tang",
    company: "Acme",
    latest_hr_message: "Please send your resume...",
  };
  const evidence = {
    latest_hr_message: "Please send your resume before noon.",
    current_chat_identity: {
      data_hint: "",
      hr_name: "Tang",
      company: "Acme Inc",
    },
  };
  const wrongMessage = {
    latest_hr_message: "Could you join tomorrow?",
    current_chat_identity: {
      data_hint: "",
      hr_name: "Tang",
      company: "Acme Inc",
    },
  };

  assert.equal(evidenceMatchesQueueItem(evidence, item), true);
  assert.equal(evidenceMatchesQueueItem(wrongMessage, item), false);
});

test("draft fill cleans stale mismatch and debug duplicate entries", () => {
  const { cleanupHrReplyQueueAfterDraftFilled, isRecoverableHrReplyQueueItem } = matcherHelpers();
  const target = {
    id: "debug-target",
    debug: true,
    source: "debug_current_chat",
    status: "draft_filled",
    hr_name: "Tang",
    company: "Acme",
    hr_role: "HR",
    latest_hr_message: "Please send your resume...",
  };
  const staleMismatch = {
    id: "old-mismatch",
    status: "needs_user",
    statusReason: "conversation_mismatch",
    note: "当前会话与待回复记录不一致，请打开对应会话后重试",
    hr_name: "Tang",
    company: "Acme Inc",
    hr_role: "HR",
    latest_hr_message: "Please send your resume before noon.",
  };
  const realFallback = {
    ...staleMismatch,
    id: "real-fallback",
    statusReason: "backend_fallback",
    note: "需要人工确认城市",
  };
  const other = {
    ...staleMismatch,
    id: "other",
    company: "Other",
    note: "当前会话与待回复记录不一致，请打开对应会话后重试",
  };

  assert.equal(isRecoverableHrReplyQueueItem(staleMismatch), true);
  assert.equal(isRecoverableHrReplyQueueItem(realFallback), false);
  const cleaned = cleanupHrReplyQueueAfterDraftFilled([target, staleMismatch, realFallback, other], target.id);
  assert.deepEqual(cleaned.map((item) => item.id), ["debug-target", "real-fallback", "other"]);
});

test("stable data-key mismatch still rejects wrong conversations", () => {
  const { evidenceMatchesQueueItem, replyTargetStillCurrent } = matcherHelpers();
  const item = {
    dataHint: "data-key:conversation-1",
    hr_name: "Tang",
    company: "Acme",
    latest_hr_message: "Old list summary",
  };
  const wrongEvidence = {
    latest_hr_message: "Old list summary",
    current_chat_identity: {
      data_hint: "data-key:conversation-2",
      hr_name: "Tang",
      company: "Acme",
    },
  };
  const nameMismatch = {
    latest_hr_message: "Full detail message",
    current_chat_identity: {
      data_hint: "data-key:conversation-1",
      hr_name: "Wrong HR",
      company: "Acme",
    },
  };

  assert.equal(evidenceMatchesQueueItem(wrongEvidence, item), false);
  assert.equal(evidenceMatchesQueueItem(nameMismatch, item), false);
  assert.equal(replyTargetStillCurrent({
    latest_hr_message: "Before",
    current_chat_identity: { data_hint: "data-key:conversation-1", hr_name: "Tang" },
  }, {
    latest_hr_message: "Before",
    current_chat_identity: { data_hint: "data-key:conversation-2", hr_name: "Tang" },
  }, item), false);
});

process.stdout.write(`hr_reply_safety_guards: ${passed} scenarios passed\n`);
