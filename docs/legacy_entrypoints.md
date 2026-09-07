# 旧入口说明

当前主线是：

```text
Chrome 插件 plugin/ + FastAPI 后端 server.py + 匹配流水线 pipeline.py
```

仓库里还保留了一些早期实验入口，主要用于项目演进展示，不是普通用户试用路径：

- `app.py`：早期 Streamlit 网页版，适合手动粘贴 JD 和经历做演示。
- `main.py`：早期 Deep Agents 命令行实验。
- `hr_bot.py`：早期 Streamlit/实习僧探索实验。
- `shixiseng_*.py`、`run_pipeline.py`：早期实习僧搜索和 CLI 流水线。

普通用户和朋友试用不要从这些文件启动。

如果要运行旧 Streamlit/实验入口，需要额外安装可选依赖：

```bash
uv sync --extra legacy
```

其中 `main.py` 和部分 Deep Agents 实验需要 Python 3.11+。如果你只运行 Chrome 插件主流程，不需要安装这些旧依赖。

或者手动安装：

```bash
pip install streamlit deepagents playwright playwright-stealth python-docx
```

这些旧入口可能没有跟 Chrome 插件主流程同步维护，出现问题时优先保证 `server.py`、`pipeline.py` 和 `plugin/` 主线可用。
