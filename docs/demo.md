# 截图和 GIF 演示清单

真实截图建议由项目维护者自己录制，并对公司名、HR、聊天记录、简历内容、访问令牌和 API Key 做打码处理。

素材统一放到：

```text
docs/assets/
```

## 必补截图

1. `popup-user.png`
   普通用户版插件弹窗：展示 PDF 上传、快速投递、智能投递、今日目标和自动留在此页开关。

2. `boss-filter.png`
   BOSS 搜索页顶部筛选条件：展示用户已经在 BOSS 内设置好城市、岗位、薪资、经验、学历等条件。

3. `boss-panel.png`
   BOSS 搜索页右侧插件面板：展示已分析、达标、已沟通、跳过、失败，以及达标/低匹配分组。

4. `auto-apply-dialog.png`
   点击「立即沟通」后的 BOSS 弹窗：展示插件会自动选择「留在此页」继续处理下一条。

5. `trace-log-public.png`
   服务端 Trace 日志或 `logs/match_trace.jsonl` 的打码截图：展示一次请求包含分数、技能、LLM 调用状态、错误和耗时。

6. `eval-summary-public.png`
   `python eval_accuracy.py --summary-json` 的终端截图，展示固定 JD 回归评测通过率。

## 推荐 GIF

`workflow-demo.gif`

录制流程：

```text
打开 BOSS 搜索页
-> 用户已在 BOSS 内设置筛选条件
-> 点击插件
-> 上传/粘贴简历
-> 点击快速投递
-> 插件逐条分析 JD
-> 达标岗位自动点击立即沟通
-> 自动点击留在此页
-> 继续下一条
```

GIF 长度建议控制在 20-40 秒，只展示 2-3 个岗位，不要录完整海投过程。

## 打码清单

截图和 GIF 发布前必须遮住：

- 公司名
- HR 姓名和头像
- 聊天记录
- 简历姓名、电话、邮箱、学校、证件号
- 访问令牌
- API Key
- 服务器敏感路径
- 任何未授权公开的岗位详情全文

## README 引用模板

真实素材补齐后，可以在 README 增加：

```md
## 项目截图

![插件弹窗](docs/assets/popup-user.png)
![BOSS 插件面板](docs/assets/boss-panel.png)
![自动留在此页](docs/assets/auto-apply-dialog.png)
```

如果图片还没补齐，不要提前在 README 里引用，避免 GitHub 页面出现破图。
