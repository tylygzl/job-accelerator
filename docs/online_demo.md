# 在线 Demo 说明

求职加速器不是普通网页应用，而是 Chrome 插件 + BOSS 页面脚本 + FastAPI 云端后端。因此在线 Demo 分成两层。

## 可公开访问的部分

后端健康检查：

```text
http://121.196.231.160/job-accelerator/health
```

这个地址用来证明云端后端正在运行，可以看到：

- 服务是否存活
- 并发限制
- 运行统计
- LLM 配置状态
- Trace 开关状态

注意：当前是临时 HTTP IP，不是长期 HTTPS 域名。它适合演示和朋友测试，不适合公开大规模分发。

## 不公开免登录 Demo 的原因

完整插件体验依赖：

- 用户自己的 BOSS 登录状态
- Chrome 扩展本地加载
- BOSS 搜索页真实 DOM
- 私有访问令牌
- 用户自己的简历和投递意愿

如果做成公开免登录 Demo，反而会产生账号、隐私、平台风控和误操作风险。所以第一版只提供私有朋友试用包。

## 朋友试用方式

维护者在本机打包：

```powershell
$env:JOB_ACCELERATOR_ACCESS_TOKEN="你的访问令牌"
powershell -ExecutionPolicy Bypass -File scripts/build_friend_plugin.ps1
```

生成：

```text
release/plugin-cloud.zip
```

朋友解压后，在 Chrome 里打开：

```text
chrome://extensions/
```

打开「开发者模式」，加载解压后的 `plugin-cloud/` 目录。

## 面试展示方式

推荐展示顺序：

1. 打开 README，讲清楚项目目标和主流程。
2. 打开 `/health`，证明云端后端可用。
3. 展示打码后的插件截图和 BOSS 侧边栏截图。
4. 展示 `tests/eval_summary.json`，说明有固定样本回归评测。
5. 展示 `docs/trace_logging.md`，说明线上问题可以通过 Trace 复盘。

## 当前限制

- 临时 HTTP IP 会明文传输访问令牌，只适合短期演示。
- 真实 BOSS 操作必须由用户自己登录并承担账号风控风险。
- 真实截图/GIF 必须打码公司、HR、聊天记录、简历和 API Key。
- 长期公开体验需要先解决 HTTPS、用户鉴权、额度统计和隐私脱敏。
