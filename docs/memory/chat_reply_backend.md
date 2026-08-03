# HR 回复后端专项记忆

> 详细来源：`docs/backend_api.md`、`server.py`、`pipeline.py`、`tests/chat_reply_samples.json`。

更新时间：2026-08-03

## Fact

- 后端已新增 `/chat/reply`，用于根据 HR 最新消息、岗位信息、简历信息和可选证据生成回复草稿。
- `/chat/reply` 使用统一响应结构：`success / data / message / request_id`。
- `/chat/reply` 已做鉴权、限流、结构化日志和独立并发门控。
- 默认 `JOB_ACCELERATOR_CHAT_REPLY_CONCURRENCY=2`，使用独立 `_CHAT_REPLY_GATE`，不和 `/match` 的 smart match 共用队列。
- 忙碌时 `/chat/reply` 返回 200 + 结构化 fallback，`should_fill=false`，不抛非结构化 429。
- 当前 RAG 是 RAG-ready：只消费请求体传入的 `evidence_context` 和 `evidence_sources`，不主动调用真实 RAG 检索引擎。
- LLM 只有配置 `JOB_ACCELERATOR_CHAT_REPLY_LLM=true` 才会尝试；失败、超时或证据不足会回到本地模板兜底。

## Request Fields

- `hr_message`：HR 最新消息。
- `conversation`：最近聊天上下文，建议只传最近少量消息。
- `job_title`、`company`、`city`、`salary`：消息页或岗位页能采到的结构化岗位信息。
- `jd_text`：岗位 JD，可空。
- `resume_text` / `resume_profile`：简历文本或简历画像，可空。
- `evidence_context`：外部 RAG 或项目知识库检索出的证据文本，可空。
- `evidence_sources`：证据来源列表，可空，例如 `rag-engine`、`job-accelerator`、`meal-agent`。
- 兼容旧字段：`latest_hr_message`、`chat_history`。

## Response Fields

- `intent`：HR 消息意图。
- `confidence`：本地意图判断置信度。
- `evidence_relation`：`jd_and_resume`、`jd_only`、`resume_only`、`rag_supported`、`none` 等证据关系。
- `evidence`：本次草稿使用到的证据数组。
- `missing_evidence`：缺少哪些证据。
- `risk_level`：`low`、`medium`、`high`。
- `should_fill`：是否允许插件自动填草稿。
- `action_policy`：`fill_draft`、`ask_user`、`do_not_reply`、`no_action`。
- `reply_mode`：`fast_template`、`rag_llm`、`fallback`。
- `duration_ms`：耗时。
- `draft`：回复草稿。
- `reason`：为什么这样回复。

## Decision

- 简单事务类问题走本地快速模板，例如是否在看机会、到岗需沟通、是否方便面试等。
- 技术/项目解释类问题可以走证据增强慢路径，但必须有简历或 RAG 证据。
- 证据不足时不能编造经历，应返回保守草稿或让用户接管。
- `/chat/reply` 不负责发送消息，只生成“是否应该填”和“填什么”。
- 如果最近一条有效人类消息来自候选人，返回 `no_action`、`should_fill=false` 和空草稿，避免重复回复。

## Constraint

- 高风险场景必须 `should_fill=false` 或要求用户确认：薪资承诺、到岗承诺、远程/驻场承诺、报价、敏感信息、长面试题。
- 不自动输出超长完整面试答案，优先提示用户在面试中展开。
- 不保存真实聊天全文到长期文档。
- 后端日志可记录结构化摘要和耗时，不写入完整隐私内容。

## Verification

- `python -m py_compile server.py pipeline.py eval_accuracy.py` 已通过。
- `python -m json.tool tests/chat_reply_samples.json` 已通过。
- `tests/chat_reply_samples.json` 当前 9 条样例断言通过。
- FastAPI TestClient 验证过 `fast_template`、`fallback`、`rag_llm` 三类路径。
- 手动占满 `_CHAT_REPLY_GATE` 后 `/chat/reply` 返回 fallback，`should_fill=false`。

## Risk

- 当前意图分类主要是本地规则，真实 HR 表达更复杂，需要继续积累脱敏样本。
- RAG-ready 还没有接真实 RAG 引擎。
- LLM 和网络不稳定时会 fallback，草稿会更保守。

## Next

- 继续用真实 BOSS 脱敏样本补充评测集，重点覆盖消息角色、会话切换和证据不足场景。
- 后续如接 RAG，引擎应作为外部证据提供者，不让 `/chat/reply` 强依赖单一 RAG 服务。
