# 插件 task lock 与 HR 回复集成专项记忆

> 详细来源：`plugin/content.js`、`plugin/popup.js`、`plugin/background.js`、窗口 3 交接记录。

更新时间：2026-08-03

## Fact

- HR 回复助手已经接进同一个 Chrome 插件，没有拆成第二个插件。
- `content.js` 已区分 `job mode`、`message mode`、`chat mode`。
- popup 已新增“检查 HR 回复”和待回复列表入口。
- 用户点击某条“处理回复”后，插件才会暂停海投、进入消息页/会话、调用 `/chat/reply`、填入草稿。
- `/chat/reply` 返回 `should_fill=false` 或 `action_policy !== "fill_draft"` 时，插件不填输入框，只提示用户接管。
- 插件不点击 `.btn-send`，只写入 `#chat-input[contenteditable='true']` 草稿。
- 主窗口审查后已加固：队列里的 HR 消息只能用于定位和展示，不能替代当前聊天 DOM 里真实读到的 HR 消息。
- 清空缓存/本页会话时会清理未完成的 HR 回复任务，避免旧任务在刷新后自动恢复。

## Mode

- `job mode`：BOSS 岗位搜索页，负责扫描 JD、匹配、达标自动沟通、点“留在此页”、继续下一条。
- `message mode`：BOSS 消息列表页，负责扫描新 HR 回复并加入待回复队列。
- `chat mode`：BOSS 聊天详情页，负责读取当前会话上下文、请求 `/chat/reply`、填入草稿。

## Task Lock

- 同一个 BOSS tab 同一时间只能执行一个页面操作。
- 优先级：用户手动操作 > HR 回复处理 > 海投扫描。
- 海投运行中，回复助手只能记录待回复队列和提醒用户。
- 用户主动点击“处理回复”时，HR 回复处理可以暂停海投并获得锁。
- HR 回复处理结束后，不应自动发送，也不应强行自动恢复海投；由用户确认下一步。

## Decision

- HR 回复助手和海投必须共用同一个状态系统，不能互相不知道对方正在操作页面。
- 队列只保存必要结构化信息，不保存完整隐私聊天。
- 第一版不自动补完整 JD，只使用已有岗位缓存和消息页能读到的职位入口。
- 第一版优先做“发现回复 -> 用户点处理 -> 填草稿”，不做无人值守回复。

## Constraint

- 不能在海投运行时直接跳转消息页。
- 不能在会话定位不确定时填草稿。
- 不能用队列里的旧 `latest_hr_message` 作为填草稿证据；必须从当前聊天详情 DOM 读到最新 HR 消息。
- 不能点击发送按钮。
- 不能把 `opening` 和 `reply` 混用到同一个输入框逻辑里，必须区分用途。
- 后端 `/match` 和 `/chat/reply` 的并发和失败兜底必须隔离，聊天 LLM 不能拖慢海投。

## Verification

窗口 3 已报告：
- `node --check plugin\content.js` 通过。
- `node --check plugin\popup.js` 通过。
- `node --check plugin\background.js` 通过。
- `git diff --check` 通过，只有既有 CRLF/LF warning。
- 2026-08-03 固定审核已复跑聊天容器回归：normal、mixed role、decorated avatar、hidden duplicate、visible siblings 均通过。
- 多个聊天容器同时存在时，包含更具体可见消息容器的祖先会被排除，不再合并兄弟会话。
- 多个具体容器可见但缺少 active、输入区关联或明显可视面积优势时，返回空结果并标记 `ambiguous`，不请求 `/chat/reply`、不填草稿。
- 最新朋友包已重打，但上述聊天容器修复仍需一次真实 BOSS 登录态 E2E 确认后才算阶段 A 完成。
- 2026-08-03 真实 BOSS 登录态 E2E 已通过：错误会话安全拒绝；用户已回复时不重复处理；正确会话能调用 `/chat/reply` 并只填草稿、不自动发送。
- 正确会话成功路径返回 `fast_template / fill_draft` 和 `request_id`，待回复队列从 3 降为 2；切换到其他会话未出现串线填入。

## Risk

- 聊天容器选择仍需继续覆盖不同真实会话；某真实截图经展开页面复核后确认最底部实际是用户已发送消息，`latestMessageRole=me` 属于正确判断，不是角色误判。
- 未读徽标 selector 可能不稳定，例如 `.notice-badge`、`.dot`。
- BOSS 聊天页切换会话时 URL 不变，可能导致队列项和当前右侧会话不一致。
- 输入框激活、富文本事件触发、会话定位仍是第一轮实测重点。
- 如果残留弹窗或页面状态异常，可能影响海投和回复助手的锁释放。

## Next

- 阶段 A 的 A/B/C 三项真实浏览器验收已完成。
- 关闭开发测试模式，重打朋友包并执行最终 release 内容审核。
- 朋友版保持“只填草稿、不自动发送”的产品边界。
