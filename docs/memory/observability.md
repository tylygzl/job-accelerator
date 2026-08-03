# 状态可观测专项记忆

> 用途：记录插件状态面板、调试状态和卡住排查的长期约束。详细实现来源是 `plugin/content.js` 和 `朋友使用说明.txt`。

更新时间：2026-08-03

## Fact

- 窗口 3 已新增轻量状态可观测面板。
- 岗位侧边栏和 HR 回复侧边栏顶部都展示只读状态。
- 普通用户状态包含：页面模式、当前任务、本轮进度、最近一步、下一步建议。
- 折叠调试状态包含：taskLock、autoApplyActive、autoApplyLoopRunning、autoApplyInProgress、analyzing、scanningMore、hrReplyProcessing、待回复队列数、lastError、lastRequestId。
- 新增集中封装：`setLastAction()`、`setLastError()`、`setLastRequestId()`、`renderRuntimeState()` 等。
- 已在海投扫描、自动沟通、HR 回复处理、后端请求失败等关键节点打点。
- `lastRequestId` 是 best-effort：background 成功响应会保留顶层 `request_id`，content 通过 `result.request_id || result.data?.request_id` 显示。
- HR 回复开发测试入口默认关闭，不依赖 BOSS 页控制台或 BOSS 页 storage；插件 popup 连点标题 5 次后，把 `debug_hr_reply` 写入 `chrome.storage.local`。
- 标题五连点执行的是“切换”而不是“强制开启”：若开发测试模式原本已开启，第一次五连点会关闭，再五连点才会重新开启。操作时必须以 popup 底部“已开启/已关闭”状态文案为准，不要按点击次数猜测。
- 聊天诊断已增加不含正文的结构字段：消息节点数、HR/本人/文本消息数、尾部角色序列、最后角色、候选/可见消息容器数、选中容器索引与选中原因。
- 当多个可见聊天容器无法可靠确定当前会话时，选中原因显示 `ambiguous`，消息提取返回空结果，避免把草稿填到错误会话。
- 侧栏可能遮住 BOSS 聊天区最右侧或最底部内容；判断最后消息角色前应关闭侧栏或横向确认完整聊天区，避免把被遮挡的用户消息误认为不存在。

## Decision

- 当前阶段优先做“看得见卡在哪里”，不要继续盲目加业务功能。
- 普通用户只看简洁状态，开发调试信息默认折叠。
- 状态面板是插件版和未来 Agent 版都能复用的地基。

## Constraint

- 状态面板只能只读展示，不改变现有业务流程。
- 不新增自动发送能力。
- 不新增后端接口。
- 开发测试开关必须存在插件侧存储里，不能依赖 BOSS 页 DevTools 控制台。
- 不把真实简历、真实聊天记录、API Key、访问令牌写入状态面板或长期文档。
- 状态更新应集中封装，避免大量重复 DOM 操作散落在业务逻辑里。
- 如果状态显示“找不到 selector / 等待弹窗 / 后端失败 / task lock 占用”，应提示用户接管或下一步建议，而不是继续乱点。

## Verification

窗口 3 已报告：
- `node --check plugin\content.js` 通过。
- `node --check plugin\popup.js` 通过。
- `node --check plugin\background.js` 通过。
- `git diff --check` 通过，仅有既有 LF/CRLF warning。

## Risk

- 还未在真实 BOSS 登录态完整复测。
- 状态面板可能增加一点 UI 占用，需要实测侧边栏是否拥挤。
- 状态字段如果太多，普通用户可能看不懂；需要保持“普通状态简洁、调试状态折叠”。

## Next

- 后续真实页复测时重点截图 `latestMessageRole`、`selectedMessageContainerReason` 和容器计数；必要时临时关闭侧栏确认页面最底部消息，但不把聊天正文写入日志或长期文档。
- 真实 BOSS 页面验证时，遇到卡住先截图状态面板顶部和调试折叠区。
- 不打开 BOSS 控制台，在插件 popup 连点标题 5 次，验证聊天页测试入口显示/隐藏。
- 如果用户反馈“看不懂状态”，再精简普通状态文案，把技术字段保留在调试区。
