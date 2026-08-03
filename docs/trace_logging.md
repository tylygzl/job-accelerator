# Trace 日志 / 调用记录

Trace 用来复盘一次岗位匹配的结构化过程：输入长度与哈希、抽取到的技能名、匹配分、是否调用 LLM、实际路径、成功或失败状态、耗时。Trace 保留评测和排错能力，但不保存可还原正文的内容。

默认不开启，避免把朋友的调用记录长期写到服务器磁盘。

## 开启方式

在服务器或本地 `.env` 里加：

```env
JOB_ACCELERATOR_TRACE_ENABLED=true
JOB_ACCELERATOR_TRACE_DETAIL=summary
JOB_ACCELERATOR_TRACE_PATH=~/.job-accelerator/logs/match_trace.jsonl
```

重启后端后生效。

## 路径规则

默认路径是：

```text
~/.job-accelerator/logs/match_trace.jsonl
```

如果配置相对路径，例如：

```env
JOB_ACCELERATOR_TRACE_PATH=logs/match_trace.jsonl
```

后端会把它解析到用户数据目录：

```text
~/.job-accelerator/logs/match_trace.jsonl
```

不会解析到仓库里的 `logs/` 目录。

## detail 模式

`summary` 是唯一实际写入模式。

旧配置 `JOB_ACCELERATOR_TRACE_DETAIL=full` 仍然兼容，但会自动降级为安全 summary，不会写入完整 JD、完整简历、正文预览或完整 LLM 返回。

## 单条记录包含什么

```text
trace_id            本次请求 ID，可和服务端日志对应
created_at          UTC 时间
status              ok / http_429 / error 等状态
mode                fast / smart
engine              local / smart / smart_local_fallback 等实际路径
duration_ms         总耗时
user_input          JD 和简历的 chars / sha256
job_skills          JD 技能名、分类和数量
resume_skills       简历技能名、分类和数量
match_score         匹配分
risk_level          风险等级
matched_skills      命中技能名和等级，不含 reason
missing_skills      缺失技能名，不含 advice
llm_called          是否真的调用过 LLM
llm                 LLM 可用性、调用路径、成功/失败、耗时、返回值长度/hash
error_reason        错误类型或 HTTP 状态，不含原始正文
```

## 不会记录什么

- 完整 JD。
- 完整简历。
- JD 或简历正文 preview。
- 简历 evidence 原文。
- `matched_skills.match_reason`。
- `missing_skills.advice`。
- 完整 LLM 返回内容、开场白或生成草稿。
- 真实 API Key、访问令牌。

## 查看最近记录

PowerShell：

```powershell
Get-Content "$HOME\.job-accelerator\logs\match_trace.jsonl" -Tail 5
```

服务器：

```bash
tail -n 5 ~/.job-accelerator/logs/match_trace.jsonl
```

## 排查思路

- `llm_called=false`：说明这次只走了本地快速匹配，适合快速投递。
- `engine=smart_local_fallback`：说明智能模式失败或忙碌，但已经回退到本地结果。
- `error_reason` 有内容：先看是鉴权、限流、PDF、页面 JD 为空，还是后端异常类型。
- `job_skills` 和 `resume_skills` 技能名对不上：优先改评分规则或简历技能提取。
- `duration_ms` 很高：看是否 smart 模式、LLM 超时、服务器并发过低。

## 安全边界

- Trace 写入失败不能影响 `/match`。
- Trace 文件不要提交到仓库。
- 对外展示时只展示字段结构和脱敏样例。
