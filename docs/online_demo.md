# 演示与朋友包说明

求职加速器不是普通网页应用，而是 Chrome 插件、BOSS 页面脚本和 FastAPI 后端组成的半自动工作流。公开仓库不提供长期在线后端，也不保存朋友测试环境的真实地址或访问令牌。

## 公开可验证的部分

本地启动后可以访问：

```text
http://127.0.0.1:8000/health
```

该接口可以验证：

- 服务是否存活
- 并发限制
- 运行统计
- LLM 配置状态
- Trace 开关状态

代码、固定样例回归和脱敏 Trace 截图可以公开复核。朋友测试环境的在线状态需要单独验证，不能仅凭仓库中的历史记录宣称当前可用。

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
$env:JOB_ACCELERATOR_API_URL="https://your-domain.example/job-accelerator/match"
$env:JOB_ACCELERATOR_ACCESS_TOKEN="你的访问令牌"
powershell -ExecutionPolicy Bypass -File scripts/build_friend_plugin.ps1
```

也可以显式传入 `-ApiUrl`。打包脚本会把后端地址及对应的 Chrome 域名权限写入私有朋友包；真实地址和 Token 不进入 Git。

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
2. 本地运行 `/health`，或现场展示已单独验证的私有测试环境。
3. 展示打码后的插件截图和 BOSS 侧边栏截图。
4. 展示 `tests/eval_summary.json`，说明有固定样本回归评测。
5. 展示 `docs/trace_logging.md`，说明线上问题可以通过 Trace 复盘。

## 当前限制

- 朋友包应使用 HTTPS；HTTP 会明文传输访问令牌和简历内容。
- 真实 BOSS 操作必须由用户自己登录并承担账号风控风险。
- 真实截图/GIF 必须打码公司、HR、聊天记录、简历和 API Key。
- 扩大测试范围前需要验证 HTTPS、用户鉴权、额度统计和隐私脱敏。
