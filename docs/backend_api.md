# 后端 API 结构

求职加速器后端使用 FastAPI + Pydantic。所有业务接口统一返回：

```json
{
  "success": true,
  "data": {},
  "message": "ok",
  "request_id": "abc123"
}
```

## 输入校验

`/match` 使用 `MatchRequest` 校验：

```text
jd_text      必填，去掉首尾空格后不能为空
resume_text  可空，统一转成字符串
mode         fast / smart，其他值自动按 fast 处理
```

`/chat/reply` 使用 `ChatReplyRequest` 校验：

```text
hr_message        必填，HR 最新消息，最多 2000 字
conversation      可选，最近几轮对话，最多 20 条，每条包含 role/content
job_title         可选，岗位名，最多 120 字
company           可选，公司名，最多 120 字
city              可选，城市信息，最多 80 字
salary            可选，薪资信息，最多 80 字
jd_text           可选，岗位 JD，最多 8000 字
resume_text       可选，简历文本，最多 8000 字
resume_profile    可选，已解析好的简历画像；聊天接口不会重新解析 PDF
evidence_context  可选，外部 RAG 或项目知识库检索出的证据文本，最多 8000 字
evidence_sources  可选，证据来源列表，例如 rag-engine、job-accelerator、meal-agent
```

兼容说明：当前后端也兼容旧字段 `latest_hr_message` 和 `chat_history`，新接入应优先使用 `hr_message` 和 `conversation`。

如果输入不合法，后端返回：

```json
{
  "success": false,
  "data": {
    "errors": [
      {"field": "jd_text", "message": "Value error, jd_text 不能为空", "type": "value_error"}
    ]
  },
  "message": "输入参数校验失败",
  "request_id": "abc123"
}
```

## 成功返回

`GET /health`

`data` 里包含服务状态、并发限制、运行统计、trace 配置和 LLM 配置。

`limits` 会分别展示：

```text
fast_match   快速匹配并发门控
smart_match  智能匹配并发门控
chat_reply   聊天回复草稿并发门控
pdf_parse    PDF 解析并发门控
```

`/chat/reply` 使用独立并发门控，不和 `/match` 的 `smart_match` 共用队列。可通过 `JOB_ACCELERATOR_CHAT_REPLY_CONCURRENCY` 调整，默认 `2`。

`POST /match`

`data` 里包含岗位匹配报告：

```text
role
match_score
matched_skills
missing_skills
risk_level
suggestions
interview_questions
opening_message
```

`POST /resume/parse`

`data` 里包含 PDF 简历解析结果：

```text
resume_text
char_count
page_count
skill_count
skills_profile
warning
```

`POST /chat/reply`

`data` 里包含 HR 回复意图分类、证据护栏和安全草稿：

```text
intent             ask_resume / ask_availability / ask_project / interview_question / schedule_interview / salary / location / unknown
evidence_relation  jd_and_resume / jd_only / resume_only / rag_supported / none
evidence           本次回复使用的证据数组，每项包含 source/relation/text
missing_evidence   缺少的证据数组
risk_level         low / medium / high
should_fill        是否允许插件自动填入草稿；不代表自动发送
action_policy      fill_draft / ask_user / do_not_reply / no_action
reply_mode         fast_template / rag_llm / fallback
duration_ms        接口处理耗时
draft              回复草稿；高风险或证据不足时可能为空或只给极短承接句
reason             为什么这样回复
policy_version     本地规则版本
```

当 `conversation` 中最后一条有效人类消息角色是 `me`、`user` 或 `candidate` 时，说明用户已经回复，后端返回 `action_policy="no_action"`、`should_fill=false`、`draft=""`，避免重复回复。

示例请求：

```json
{
  "hr_message": "明天下午方便视频面试吗？",
  "job_title": "AI 应用开发实习生",
  "company": "示例公司"
}
```

示例返回：

```json
{
  "success": true,
  "data": {
    "intent": "schedule_interview",
    "evidence_relation": "none",
    "evidence": [],
    "missing_evidence": [],
    "risk_level": "low",
    "should_fill": true,
    "action_policy": "fill_draft",
    "reply_mode": "fast_template",
    "duration_ms": 0,
    "draft": "您好，可以沟通。麻烦您发一下可选时间段、面试形式和预计时长，我确认后回复您。",
    "reason": "HR 正在沟通面试安排，可用快速模板请求可选时间和形式。",
    "policy_version": "2026-08-02-rag-ready-v2"
  },
  "message": "回复草稿生成成功",
  "request_id": "abc123"
}
```

项目/技术类请求示例：

```json
{
  "hr_message": "你有做过 RAG 项目吗？",
  "jd_text": "岗位要求：熟悉 RAG、向量检索和 LLM API。",
  "resume_profile": {
    "skills": {
      "must_have": [
        {"skill": "RAG", "level": "项目经验", "evidence": "做过 rag-engine，包含文档切分、向量检索和评测。"}
      ]
    }
  },
  "evidence_context": "rag-engine：支持文档切分、FAISS 检索、RRF 融合和评测脚本。",
  "evidence_sources": ["rag-engine"]
}
```

此类请求会进入证据增强慢路径，`reply_mode` 返回 `rag_llm`。当前版本不接真实 RAG 引擎，只使用请求体传入的 `evidence_context` 和 `evidence_sources`；如果后续启用 LLM，RAG + LLM 总耗时应控制在约 4 秒内，失败或超时返回 `fallback`。

如果 `/chat/reply` 并发槽位已满，后端不会占用 `/match` 的快速海投或智能匹配队列，也不会抛出非结构化错误；会返回统一响应里的 fallback 数据：

```json
{
  "success": true,
  "data": {
    "intent": "unknown",
    "evidence_relation": "none",
    "evidence": [],
    "missing_evidence": ["chat_reply 并发槽位"],
    "risk_level": "medium",
    "should_fill": false,
    "action_policy": "ask_user",
    "reply_mode": "fallback",
    "duration_ms": 0,
    "draft": "",
    "reason": "聊天回复草稿服务正在处理其他请求，已返回结构化兜底结果；不影响 /match 快速海投接口。"
  },
  "message": "回复草稿服务繁忙，已返回兜底结果",
  "request_id": "abc123"
}
```

高风险示例：

```json
{
  "hr_message": "你的期望薪资是多少，最快什么时候到岗？"
}
```

会返回 `risk_level="high"`、`should_fill=false`、`action_policy="ask_user"`，不替用户承诺薪资、到岗、远程、报价或交付。

证据不足示例：

```json
{
  "hr_message": "你能讲一下 RAG 召回优化怎么做的吗？",
  "jd_text": "岗位要求：熟悉 RAG 召回优化。"
}
```

JD 有要求但简历和 `evidence_context` 都没有证据时，返回 `evidence_relation="jd_only"`、`risk_level="medium"`、`should_fill=false`、`reply_mode="fallback"`。后端不能把 JD 要求当成候选人经历来编写回复。

## 错误处理

后端统一处理：

- `RequestValidationError`：Pydantic 输入校验失败，返回 422。
- `HTTPException`：鉴权失败、限流、PDF 不合法、业务参数错误等，保留原状态码。
- `Exception`：未预期异常，返回 500，并写入服务端日志。

所有错误都会返回：

```json
{
  "success": false,
  "data": null,
  "message": "错误原因",
  "request_id": "abc123"
}
```

`request_id` 会同时写入响应头 `X-Job-Accelerator-Request-Id`，方便从浏览器错误对应到服务器日志。

`/chat/reply` 日志事件会区分：

```text
chat_reply_ok        正常返回 fast_template 或 rag_llm
chat_reply_fallback  规则兜底或 LLM 失败/超时兜底
chat_reply_rejected  chat_reply 独立并发门控已满，返回结构化 fallback
chat_reply_failed    未预期异常
```

## 插件兼容

Chrome 插件内部会自动拆开统一响应：

```text
后端返回 success/data/message
插件读取 data
页面逻辑继续使用 match_score、resume_text 等原字段
```

所以统一响应结构不会改变用户在插件里看到的功能。

当前 `/chat/reply` 已接入 Chrome 插件的 HR 回复助手。插件只在用户点击“处理回复”后调用接口，并且只根据 `should_fill=true` 与 `action_policy="fill_draft"` 填入草稿；插件不会自动点击发送按钮。
