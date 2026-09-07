# BOSS 消息页 DOM 调研笔记

更新时间：2026-08-02

## 调研边界

本文件只记录 BOSS 直聘求职端消息页的 URL、DOM、交互结构和后续实现风险，不实现功能，不保存真实公司、HR、聊天内容、账号、Cookie、token 或验证码信息。

本次调研记录两类取证：

- 直接访问 `https://www.zhipin.com/web/geek/chat` 后被重定向到 `https://www.zhipin.com/web/user/`。
- 页面标题为 `【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘`，可见 DOM 只停留在 `#app > .page-data-tips > .layout-page-loading`，文案为“加载中，请稍后”。
- 当前 Codex 环境没有已登录 BOSS 会话，因此无法直接读取消息列表和聊天详情 DOM。
- 用户已用真实 BOSS 登录态补充可见页面观察。本文记录字段和结构结论，但不记录样例中的真实 HR 姓名、公司名、聊天原文。

因此本文把结论分为两类：

- 已观察：来自当前页面 URL、标题、根 DOM、已加载资源，以及用户登录态可见观察。
- 资源推断：来自 BOSS 官方前端 bundle/CSS，不等同于登录后实测，需要后续在用户已登录、已打码环境复核。

## 页面和资源

已观察到的入口：

- 消息页入口：`https://www.zhipin.com/web/geek/chat`
- 未登录跳转：`https://www.zhipin.com/web/user/`
- 登录态下消息页 URL 保持为 `https://www.zhipin.com/web/geek/chat`。
- 点击左侧不同会话后，右侧聊天详情会切换，但浏览器 URL 暂未观察到明显变化，也看不到会话 id。
- Vue Router：history 模式，路由名推断为 `cpc_chat`，path 为 `/web/geek/chat`。
- 通知/跳转 URL 中存在 `chatUrl = /web/geek/chat?id=<encryptBossId>` 的拼接逻辑。
- 群组会话打开逻辑使用内部 router params：`{ name: "cpc_chat", params: { gid, t } }`。由于普通会话切换不改变地址栏，后续不能只依赖 URL 判断当前会话。

当前会话定位建议：

- 结合左侧 `.friend-content.selected`。
- 结合右侧顶部 HR / 公司 / 岗位 / 薪资 / 城市。
- 结合右侧最后一条消息。
- 继续调研会话卡片 DOM 上是否有稳定 `data-id`、`href`、`ka`、`encryptId`、`uniqueId` 等隐藏标识。

已观察到的官方静态资源：

- `https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5519/static/js/app.3e6f18aa.js`
- `https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5519/static/js/chat.3e6f18aa.js`
- `https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5519/static/css/app.3e6f18aa.css`
- `https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5519/static/css/chat.3e6f18aa.css`
- `https://static.zhipin.com/assets/zhipin/chat/mqtt-v1.2.min.js`

## 总体 DOM 结构

资源推断的消息页主体结构：

```text
div.main-wrap
  div.inner#main
    div#container
      div.chat-container.page-container
        div.chat-wrap
          BossList
          ChatConversation
          ChatOther 仅 selectedFriend.showType === "wx" 时出现
```

CSS 尺寸线索：

- `.chat-wrap`：`display:flex`，上下各约 20px。
- `.list-warp`：左侧列表容器，宽约 `360px`。
- `.chat-conversation`：右侧聊天容器，宽约 `812px`，左边距 `4px`，纵向 flex。

## 消息列表页

资源推断的左侧结构：

```text
BossList
  div.list-warp.v2
    NormalList
      div.chat-user.v2
        BossSearch
        BossLabel
        div.chat-content
          div.user-list
            VirtualList.user-list-content
              ul > li > BossItem
```

列表使用虚拟滚动：

- `VirtualList` 的 `data-key` 为 `uniqueId`。
- `estimate-size` 为 `78`。
- `headerTag` / `wrapTag` 为 `ul`，`itemTag` 为 `li`。
- 只应把当前可见 DOM 当作可读范围；不要假设所有会话项同时存在于 DOM。
- 底部加载事件为 `tobottom`，有 `.boss-list-footer`、`.spinner`、`.finished`。

筛选标签：

- `全部`
- `未读`
- `新招呼`
- `更多`
- `AI筛选`

资源里还出现过以下扩展标签，实际是否展示取决于账号和页面状态：

- `仅沟通`
- `有交换`
- `有面试`
- `不感兴趣`

搜索入口：

- 搜索框 class：`.boss-search-input`
- placeholder：`搜索30天内的联系人`
- 搜索结果项 class：`.search-list`
- 搜索结果字段包括 `.boss-name`、`.company-name`、`.job-city` 等。

单个会话项：

```text
div.friend-content-warp
  div.friend-content[d-c="62001"]
    BossAvatar -> div.figure
    div.text
      TimeLabel
      NameContent -> div.title-box > span.name-box
      LastMsg -> div.gray.last-msg
```

字段和状态：

- `.friend-content` 是主要点击目标。
- `.friend-content.selected` 表示当前选中；登录态观察中选中卡片会变成浅灰背景。
- `.friend-content.friend-top` 表示置顶。
- `.friend-content.drawer` 表示抽屉/分组入口。
- `.friend-content-warp.ai-filter` / `.ai-filter .friend-content` 表示 AI 筛选态。
- 头像区域 `.figure` 中未读展示为 `.notice-badge`，大于 999 时显示 999；部分群组/系统态可能是 `.dot`。
- 名称区：`.title-box .name-box .name-text` 对应 `boss.name`；同一行还会拼接 `boss.brandName`、`boss.title`。
- 最后一条消息：`.gray.last-msg .last-msg-text`。
- 草稿状态：`.draft` 后接 `.last-msg-text`。
- 时间：`.time`，来源标签：`.prop-label`。
- Hover 操作区：`.user-operation`，包含置顶、备注、不感兴趣、黑名单、删除、举报等入口，不能作为自动回复 MVP 的默认操作目标。

登录态可见字段：

- HR 头像。
- HR 姓名。
- 公司名。
- HR 职位/身份，例如猎头顾问、总经理等。
- 最后一条消息摘要。
- 最近时间。

未读状态：

- 顶部“未读”筛选入口已确认存在，可作为批量查找待回复的入口。
- 当前用户截图里选中“全部”时暂未看到明显红点/数字未读标记，所以会话卡片上的 `.notice-badge,.dot` 仍需在真实未读消息下复测。
- 如果点击会话会清零未读，则插件必须在点击前记录未读状态。

点击逻辑：

- 普通 BOSS 会话：点击后清零当前项 `unreadCount`，更新 `selectedFriend`，右侧详情刷新。
- `friendId` 为 `0` / `-2`：进入群组/项目列表抽屉。
- `friendId` 为 `-1`：进入“不感兴趣/过滤”抽屉。
- 特殊求职助手项会打开右侧 dialog，而不是普通聊天详情。
- 登录态观察确认：点击左侧不同会话后 URL 不变，右侧顶部 HR、公司、岗位、薪资、城市会同步切换。

## 聊天详情页

资源推断的右侧结构：

```text
ChatConversation
  div.chat-conversation
    TopInfo
      div.top-info-content
        UserInfo
        PositionInfo
    div.message-content
      MessageList
      TipBar
    div.message-controls
      Toolbar
```

未选中会话时显示 `NoData`，文案线索：

- `当前暂无消息`
- `与您进行过沟通的 Boss 都会在左侧列表中显示`
- 入口按钮：`查看职位`、`更新简历`

顶部信息：

- `UserInfo` 显示对方名称、职务、在线/备注/操作入口等。
- `PositionInfo` class：`.chat-position-content`。
- 岗位信息在 `.position-content` 内：
  - `.position-name`：`conversation.jobName`
  - `.salary`：`conversation.salaryDesc`，低薪资为 0 时显示“面议”
  - `.city`：`conversation.locationName`
  - “查看职位”点击会进入岗位详情
- 系统/群组通知可能出现在 `.inner-notice`。

登录态可见字段：

- HR 姓名：右侧顶部可见。
- HR 身份/角色：右侧顶部可见，例如猎头顾问、总经理等。
- 公司名：右侧顶部随会话切换，可作为当前会话证据字段。
- 岗位名：右侧顶部可见。
- 薪资：右侧顶部可见。
- 城市：右侧顶部可见。
- `查看职位 >`：右侧顶部可见，可打开岗位详情页。

消息列表：

```text
MessageList
  div.conversation-message
    ul.im-list
      li.message-item[data-mid]
        div.item-time > span.time
        MessageText / MessageImage / MessageInterview / MessageHyperlink / MessageArticle / MessageDialog / ...
```

消息项状态：

- `.message-item.item-myself`：自己发送的消息。
- `.message-item.item-friend`：对方发送的消息。
- `.message-item.item-system`：系统消息、卡片消息、发送失败或特殊模板。
- `data-mid`：消息 ID，可作为去重和定位锚点，但不要持久保存真实消息正文。
- 普通文本消息结构：`.message-content > .text > span`。
- 图片、语音、岗位卡片、面试邀请、交换联系方式等都有独立组件，不能只按纯文本处理。
- 岗位卡片类：`.item-jobdesc`、`.job-desc`、`.job-title`、`.job-subtitle`、`.job-conversation-labels`、`.job-dec`。
- 登录态观察确认：我的消息在右侧，背景偏青色；HR/对方消息在左侧，头像在左边，气泡为浅灰或白色。判断“最新一条是不是 HR 发的”时，可优先用气泡方向、头像位置和 `.item-friend` / `.item-myself` 类共同判断。

输入区：

```text
div.message-controls
  div.chat-im.chat-editor
    div.chat-controls
      EmotionBtn
      PhraseBtn
      RemindBtn
      ImageBtn
      ResumeBtn
      ContactBtn
      WeChatBtn
      WukongChatBar
    Editor
      div.editor-container
        QuoteMessage
        div.chat-input#chat-input[contenteditable="true"]
        div.chat-op
          span.tip
          button.btn-v2.btn-sure-v2.btn-send[type="send"][d-c="62013"]
```

输入交互：

- 主输入框是 `div#chat-input.chat-input[contenteditable="true"]`，不是 textarea。
- 提示文案：`按Enter键发送，按Ctrl+Enter键换行`。
- 发送按钮：`.btn-send`，文本为“发送”，禁用时有 `disabled` class。
- 登录态观察确认：底部可见“发简历”“换电话”“换微信”和“发送”按钮；当前发送按钮灰色，说明输入框为空或未激活。
- 输入文本长度阈值约为 1000，过长会 toast。
- 粘贴文本有最大长度限制，超限会 toast。
- `Enter` 默认发送；`Ctrl+Enter` 或 `Shift+Enter` 换行。
- 当前项目若只填草稿，应写入 `#chat-input` 并触发 input/change/keyup 等事件，但不自动点击 `.btn-send`。

## 查看职位和 JD 入口

登录态观察确认：

- 在聊天详情页点击右上方 `查看职位 >` 后，浏览器会打开岗位详情页。
- 岗位详情页 URL 形态类似 `https://www.zhipin.com/job_detail/<job_id>.html?securityId=...`。
- 岗位详情页能看到完整 JD 信息，包括岗位名、薪资、城市、学历/经验、公司或代招公司、职位描述、任职要求、优先条件等。
- 已建立沟通的岗位详情页顶部可能显示 `继续沟通`。

对 `/chat/reply` 的意义：

- 如果聊天页只拿到岗位名、薪资、城市，而拿不到完整 `jd_text`，可以把 `查看职位` 作为 JD 补充入口。
- 推荐流程是：聊天页读取岗位入口 -> 打开岗位详情页 -> 提取 JD -> 返回或切回聊天页 -> 调用 `/chat/reply`。
- 这一步会打断用户当前聊天上下文，第一版不建议自动频繁执行。

产品边界建议：

- 第一版只记录 `job_detail_entry` 是否存在。
- 优先使用海投阶段缓存过的 JD。
- 找不到缓存 JD 时，再让用户手动点击“补充 JD”。
- 不要在消息扫描阶段自动打开岗位详情页。

## RAG-ready 证据字段可用性

后续 `/chat/reply` 不应直接吃完整页面文本，而应接收结构化证据。以下字段是从消息列表和聊天详情页抽取的候选证据字段；其中“登录态确认”来自用户真实登录态观察，但具体 DOM selector 仍需后续用 DevTools 复核。

| 字段 | 消息列表页 | 聊天详情页 | 推荐来源 | 可靠性 |
| --- | --- | --- | --- | --- |
| `hr_name` | 可拿 | 可拿 | 列表 `.name-text`；详情顶部 `UserInfo` | 高 |
| `hr_role` | 可拿 | 可拿 | 列表 `.title-box .name-box` 中身份字段；详情顶部身份文本 | 高 |
| `company` | 可拿 | 可拿 | 列表公司/品牌名；详情顶部公司字段 | 高 |
| `job_title` | 不一定有 | 可拿 | 详情顶部 `.chat-position-content .position-name`，资源字段为 `conversation.jobName` | 高 |
| `salary` | 不一定有 | 可拿 | 详情顶部 `.salary`，资源字段为 `conversation.salaryDesc` | 高 |
| `city` | 不一定有 | 可拿 | 详情顶部 `.city`，资源字段为 `conversation.locationName` | 高 |
| `job_detail_entry` | 通常不直接暴露 | 可拿 | `.position-content[ka="geek_chat_job_detail"]` 的“查看职位”；跳转后 URL 为 `/job_detail/<job_id>.html?securityId=...` | 高 |
| `jd_text` | 不可直接拿 | 聊天页不可直接拿，岗位详情页可拿 | 通过 `job_detail_entry` 打开岗位详情页，或复用海投阶段 JD 缓存 | 中 |
| `latest_hr_message` | 只能拿最后消息摘要 | 可准确从消息流判断 | 详情页最后一个左侧/`.item-friend[data-mid]` 文本消息 | 高 |
| `unread` | 顶部“未读”筛选可辅助；卡片未读样式待复测 | 点击后会被清零 | 点击前读取筛选结果和 `.notice-badge,.dot` | 中 |
| `conversation` | 只能拿摘要 | 可拿最近可见消息 | `.conversation-message .message-item[data-mid]`，按 DOM 顺序取末尾 N 条 | 高 |
| `input_box` | 不在列表页 | 可拿 | `#chat-input[contenteditable="true"]` | 高 |
| `send_button` | 不在列表页 | 可拿，但第一版不要自动点击 | `.chat-op .btn-send`，灰色/disabled class 表示不可发送 | 高 |

字段采集建议：

- `company_name`：优先从详情页顶部 `UserInfo` 的公司字段取；若复测后没有独立 class，再从左侧 `.title-box .name-box` 中排除 `.name-text` 后取 `boss.brandName` 对应文本。不要用整页 `innerText` 猜公司名。
- `job_title`：优先从 `.chat-position-content .position-name` 取；如果为空，再从最近的岗位卡片 `.job-desc .job-title` 或搜索结果 `.job-city` 附近文本兜底。
- `job_url`：优先取真实 `a[href*="/job_detail/"]`；如果详情顶部只是点击事件而没有 href，只记录 `has_job_detail_entry=true`，不要伪造 URL。
- `jd_entry`：记录可点击入口元素和入口文案，例如 `.position-content[ka="geek_chat_job_detail"]` / “查看职位”；登录态已确认点击后能打开岗位详情页并看到完整 JD。
- `last_hr_message`：在详情页按 DOM 顺序从后往前找 `.message-item.item-friend[data-mid]`，提取其 `.message-content .text` 文本，跳过 `.item-system`、图片、语音、卡片和空文本。
- `unread`：必须在点击会话前记录，点击 `.friend-content` 后页面逻辑会把当前项 `unreadCount` 置 0。
- `recent_context`：建议取最近 6-10 条可见消息，结构为 `{ mid, role, time, type, text_excerpt }`。`role` 由 `.item-friend` / `.item-myself` / `.item-system` 判断；`type` 由文本、图片、岗位卡片、面试、系统卡片等粗分类。
- `reply_box`：只写草稿到 `#chat-input`。按钮 `.btn-send` 只用于判断草稿是否使发送按钮变为可用，不作为自动点击目标。

建议给 `/chat/reply` 的证据对象形状：

```json
{
  "source": "boss_chat_dom",
  "page_url": "https://www.zhipin.com/web/geek/chat",
  "conversation": {
    "company_name": "",
    "hr_name": "",
    "hr_role": "",
    "boss_name": "",
    "boss_title": "",
    "job_title": "",
    "salary": "",
    "city": "",
    "job_url": "",
    "has_jd_entry": false,
    "jd_source": "cache_or_manual_job_detail",
    "unread": false,
    "unread_count_text": "",
    "selected_unique_id_hint": ""
  },
  "messages": [
    {
      "mid": "",
      "role": "hr",
      "time_text": "",
      "message_type": "text",
      "text_excerpt": ""
    }
  ],
  "last_hr_message": {
    "mid": "",
    "text_excerpt": ""
  },
  "ui": {
    "input_selector": "#chat-input[contenteditable='true']",
    "send_button_selector": ".chat-op .btn-send",
    "send_button_enabled": false
  }
}
```

隐私和证据护栏：

- `messages[].text_excerpt` 只保留必要上下文，默认截断，不落盘完整聊天。
- 不保存手机号、微信号、邮箱、地址、附件简历、图片 URL、语音 URL。
- 遇到“发简历”“换电话”“换微信”“面试邀约”“测评”“合同/报价/到岗/薪资承诺”等消息类型，只生成提醒或草稿，不自动执行页面动作。
- RAG 只使用本轮 DOM 抽取证据和用户允许的简历/JD 摘要；不要把历史真实聊天长期写入仓库或 trace。
- 用户提供的真实观察样例只能用于确认字段存在，不能把真实姓名、公司、聊天原文固化到仓库文档或测试数据。

## 相关接口线索

以下只作为页面行为理解，不建议在插件 MVP 中直接调用 BOSS 私有接口：

- `/wapi/zpchat/group/groupInfoList`
- `/wapi/zpchat/group/batchGetGroupInfo`
- `/wapi/zpchat/group/gravityGroupInfoList`
- `/wapi/zpchat/group/userGroupEnter`
- `/wapi/zpchat/geek/getBossData`
- `/wapi/zpchat/geek/historyMsg`
- `/wapi/zpchat/group/historyMsg`
- `/wapi/zpchat/message/refresh`
- `/wapi/zpchat/message/batchGet`
- `/wapi/zpchat/session/geekEnter`
- `/wapi/zpchat/message/withdrawMessage`
- `/wapi/zpchat/message/updateSoundMsg`
- `/wapi/zpchat/sticker/get/sticker`

## 候选选择器

建议优先使用“结构 + 可见性 + 文案”组合，不要只依赖单一 class。

消息页判断：

```js
location.href.includes("/web/geek/chat")
```

左侧列表：

```js
document.querySelector(".list-warp.v2 .user-list .user-list-content")
document.querySelectorAll(".friend-content-warp .friend-content")
document.querySelector(".friend-content.selected")
```

未读会话候选：

```js
Array.from(document.querySelectorAll(".friend-content")).filter((item) =>
  item.querySelector(".notice-badge,.dot")
)
```

会话字段：

```js
const name = item.querySelector(".name-text")?.innerText?.trim()
const titleLine = item.querySelector(".title-box")?.innerText?.trim()
const companyGuess = titleLine?.replace(name || "", "").trim()
const lastText = item.querySelector(".last-msg-text")?.innerText?.trim()
const time = item.querySelector(".time")?.innerText?.trim()
const unreadBadge = item.querySelector(".notice-badge,.dot")
const unread = Boolean(unreadBadge)
const unreadCountText = unreadBadge?.innerText?.trim() || (unread ? "dot" : "")
```

右侧消息：

```js
document.querySelector(".chat-conversation")
document.querySelector(".conversation-message .im-list")
document.querySelectorAll(".conversation-message .message-item[data-mid]")
document.querySelectorAll(".message-item.item-friend")
document.querySelectorAll(".message-item.item-myself")
document.querySelector(".chat-position-content .position-name")
document.querySelector(".chat-position-content .position-content")
document.querySelector(".chat-position-content .salary")
document.querySelector(".chat-position-content .city")
document.querySelector("a[href*='/job_detail/']")
```

输入框和发送按钮：

```js
document.querySelector("#chat-input[contenteditable='true']")
document.querySelector(".chat-op .btn-send")
```

## 自动化边界建议

第一版 HR 回复助手建议只做：

- 识别 `/web/geek/chat` 是否可用。
- 在 message mode 扫描可见 `.friend-content`，优先结合“未读”筛选入口和 `.notice-badge,.dot` 找待回复会话。
- 只写入待回复队列和提醒用户，不自动抢占当前搜索页。
- 用户主动点击“处理回复”后进入 chat mode，再读取右侧最新几条 `.message-item[data-mid]` 的脱敏摘要。
- 生成回复草稿并填入 `#chat-input`。
- 明确等待用户确认发送。
- 需要完整 JD 时，优先使用海投阶段缓存；没有缓存时让用户手动触发“补充 JD”。

第一版不要做：

- 不要点击 `.btn-send` 自动发送。
- 不要绕过登录、验证码、MFA 或风控。
- 不要调用 BOSS 私有 `/wapi/zpchat/...` 接口替代页面 DOM。
- 不要保存完整聊天记录。
- 不要操作删除、拉黑、不感兴趣、举报、发送简历、交换微信/电话、面试邀约等高风险按钮。
- 海投运行中，回复助手不能抢当前 BOSS 搜索页、不能跳聊天页、不能填输入框。

模式和任务锁：

- 一个插件内承载三个模式，不拆成两个独立插件。
- `job mode`：岗位搜索页，负责海投。
- `message mode`：消息列表页，负责扫描待回复。
- `chat mode`：聊天详情页，负责生成并填入回复草稿。
- `task lock`：同一个 BOSS tab 同一时间只能做一件事。
- HR 回复助手不能在海投运行中直接改变当前 BOSS 搜索页；消息扫描只允许写入待回复队列和提醒，进入聊天页必须由用户主动触发。

## 待登录态复测清单

需要用户自行登录 BOSS，并在打码/无敏环境下复测：

- `/web/geek/chat` 登录后已观察为同一 SPA 路由；仍需用 DevTools 复核 DOM 属性。
- 点击左侧普通会话后 URL 已观察为不变；仍需调研卡片 DOM 是否有稳定 id。
- 左侧未读 badge 在真实 HR 回复、系统消息、群组消息下分别是 `.notice-badge` 还是 `.dot`。
- `.friend-content` 点击后右侧 `.chat-conversation` 的刷新时机。
- `.conversation-message` 是否需要滚动到顶部加载历史消息。
- 最新消息是否总在 `.im-list` 末尾。
- `#chat-input` 在不同会话状态下是否总存在；被禁言、对方关闭岗位、账号风控时是否隐藏。
- 填入 `#chat-input` 后需要触发哪些事件才能使 `.btn-send` 从 disabled 变为可用。
- 右侧顶部 HR 姓名、身份、公司、岗位、薪资、城市分别对应哪些稳定 class 或 data 字段。
- `查看职位 >` 是否总能拿到真实 `href`；如果只有点击事件，如何安全获取跳转后的岗位详情 URL。
- BOSS 页面是否动态更新 class hash 或版本号，现有 `v5519` 是否短期稳定。

## 与当前项目的关系

当前 `plugin/content.js` 已有聊天页雏形：

- 用 `location.href.includes("/web/geek/chat")` 判断聊天页。
- 用 `textarea,[contenteditable='true']` 查找输入框。
- 当前资源推断显示真实主输入框是 `#chat-input.chat-input[contenteditable="true"]`，与现有“contenteditable 兜底”方向一致。
- 当前代码只适合从岗位页跳到聊天页后填开场白，不等同于完整 HR 回复 Agent。

后续实现前，应先完成登录态复测，再把本文件中的“资源推断”升级为“实测确认”。
