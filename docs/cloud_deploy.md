# 阿里云部署说明

目标：把 FastAPI 后端放到你的阿里云服务器上，朋友只安装你打包好的 Chrome 插件，不需要本地跑 Python，也不需要配置 LLM API。

## 最终结构

```text
朋友 Chrome 插件
  -> http://121.196.231.160/job-accelerator/match
  -> 阿里云 Nginx
  -> 127.0.0.1:8000 FastAPI
  -> 服务器 .env 里的 LLM_API_KEY
```

插件里不能放 LLM API Key。LLM Key 只放服务器 `.env`。
当前朋友测试包使用临时 HTTP IP 入口；`https://tengyuanlinye.cn/job-accelerator/` 是备案和证书处理完成后的目标入口。

## 服务器准备

在阿里云安全组里开放：

- `80`
- `443`

不要把 `8000` 暴露到公网。FastAPI 只给本机 Nginx 调。

服务器安装基础依赖：

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip nginx
```

## 上传代码

推荐目录：

```bash
sudo mkdir -p /opt/job-accelerator
sudo chown -R $USER:$USER /opt/job-accelerator
cd /opt/job-accelerator
```

把本项目代码上传或 `git clone` 到这个目录。

安装后端依赖：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-backend.txt
```

## 配置服务器 `.env`

```bash
cp .env.example .env
nano .env
```

至少填：

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=你的模型 API Key
LLM_MODEL=你的模型名

JOB_ACCELERATOR_ACCESS_TOKEN=自己生成的一串随机令牌
```

建议同时保留这些云端保护参数：

```env
JOB_ACCELERATOR_FAST_CONCURRENCY=8
JOB_ACCELERATOR_SMART_CONCURRENCY=1
JOB_ACCELERATOR_PDF_CONCURRENCY=2
JOB_ACCELERATOR_RATE_LIMIT_PER_MINUTE=120
JOB_ACCELERATOR_SMART_LLM_TIMEOUT=5
JOB_ACCELERATOR_MAX_RESUME_PDF_BYTES=5242880
```

含义：

- `FAST_CONCURRENCY=8`：快速投递走本地规则，可以同时处理多个请求。
- `SMART_CONCURRENCY=1`：智能投递会碰 LLM，默认只放 1 个；忙了就快速兜底，不阻塞海投。
- `PDF_CONCURRENCY=2`：同时解析 PDF 的数量，防止大文件把机器拖慢。
- `RATE_LIMIT_PER_MINUTE=120`：按访问 IP 和接口做简单限流，防止接口被刷爆。
- `SMART_LLM_TIMEOUT=5`：智能模式最多等模型 5 秒，失败就本地兜底。
- `MAX_RESUME_PDF_BYTES=5242880`：PDF 简历最大 5MB。

生成令牌示例：

```bash
openssl rand -hex 24
```

## systemd 常驻运行

复制服务文件：

```bash
sudo cp deploy/job-accelerator.service /etc/systemd/system/job-accelerator.service
sudo systemctl daemon-reload
sudo systemctl enable --now job-accelerator
sudo systemctl status job-accelerator
```

查看日志：

```bash
journalctl -u job-accelerator -f
```

日志会使用统一事件格式，方便判断朋友试用时卡在哪里：

```text
job_accelerator event=match_ok request_id=... client=... mode=fast engine=local score=93 duration_ms=...
job_accelerator event=resume_parse_ok request_id=... client=... pages=1 chars=1800 skills=12 duration_ms=...
job_accelerator event=rate_limited request_id=... client=... scope=match limit=120
job_accelerator event=match_http_error request_id=... client=... mode=fast status=429 detail=...
```

常看事件：

- `match_ok`：岗位匹配成功。
- `resume_parse_ok`：PDF 简历解析成功。
- `engine=smart_busy_fallback`：智能模式忙，已经走快速兜底。
- `rate_limited`：请求太密集，被限流。
- `auth_failed`：插件令牌不对或朋友包过期。
- `match_failed` / `resume_parse_failed`：后端真实异常，需要看错误字段。

## Nginx 反向代理

把 `deploy/nginx-job-accelerator.conf` 里的 `location /job-accelerator/ { ... }` 加到 `tengyuanlinye.cn` 对应的 `server {}` 里。

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

测试：

```bash
curl http://121.196.231.160/job-accelerator/health
```

如果返回 `auth_required:true`，说明后端已经要求访问令牌。`limits` 和 `runtime` 字段可以用来观察当前并发配置、正在处理的请求数和累计请求数。

测试 `/match`：

```bash
curl -X POST http://121.196.231.160/job-accelerator/match \
  -H "Content-Type: application/json" \
  -H "X-Job-Accelerator-Token: 你的访问令牌" \
  -d '{"jd_text":"岗位：Python实习生，要求 FastAPI 和 LangGraph","resume_text":"我会 Python、FastAPI、LangGraph","mode":"fast"}'
```

## 构建朋友体验插件

在你本机 PowerShell 里运行：

```powershell
$env:JOB_ACCELERATOR_ACCESS_TOKEN="你的访问令牌"
powershell -ExecutionPolicy Bypass -File scripts/build_friend_plugin.ps1
```

脚本不会自动复用旧压缩包里的令牌。如果确实要复用旧令牌，需要显式加 `-ReuseExistingToken`；如果服务器没有开启访问令牌，需要显式加 `-AllowEmptyToken`。

输出：

```text
release/plugin-cloud/
release/plugin-cloud.zip
```

把 `release/plugin-cloud.zip` 发给朋友。朋友解压后，在 `chrome://extensions/` 里加载 `plugin-cloud/` 目录即可。

## 安全边界

- 朋友的简历和岗位 JD 会发送到你的服务器；演示前要说清楚。
- 访问令牌会写在你发给朋友的插件包里，不能当成银行级安全，只是防止公网接口裸奔。
- 如果朋友范围扩大，下一步要做账号登录、限流、额度统计和日志脱敏。
- `.env` 永远不要提交到 Git。

## 本次阿里云实测记录

- `job-accelerator.service` 已配置为 systemd 服务，监听 `127.0.0.1:8000`，服务器重启后会自动启动。
- Nginx 已添加 `/job-accelerator/` 反代，公网 IP 的 HTTP 入口可访问：`http://121.196.231.160/job-accelerator/health`。
- `/match` 已开启 `JOB_ACCELERATOR_ACCESS_TOKEN` 保护；服务器内部测试不带令牌返回 `401`，带令牌返回匹配结果。
- `https://tengyuanlinye.cn/job-accelerator/health` 暂时不可用，原因是阿里云对未备案/备案不合规域名返回 `Non-compliance ICP Filing`，Let's Encrypt 无法完成 HTTP 验证。
- 给朋友长期使用时，推荐先解决 HTTPS：完成域名备案、换已备案域名、换海外服务器，或使用可靠的 HTTPS 隧道/网关。只有 HTTP IP 可作为短期演示方案，令牌会明文传输，不适合公开分发。
