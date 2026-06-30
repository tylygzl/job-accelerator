# 🚀 求职加速器

贴 JD + 经历 + 公司名，告诉你投不投、怎么准备。

## 这是什么

一个基于 Deep Agents 的多 Agent 协作工具。主 Agent 协调三个子 Agent：

- **jd-analyzer**：拆解 JD → 硬性要求 / 加分项 / 软技能
- **resume-matcher**：人岗匹配 → 三栏评估（能说硬 / 学两天能说 / 暂时说不了）+ 匹配度打分
- **interview-predictor**：面试预测 → 从缺口和强项出题，每题标来源

## 安装

```bash
git clone <repo-url>
cd job-accelerator
uv sync
```

## 配置

```bash
cp .env.example .env
# 编辑 .env，填入你的 API Key
```

## 运行

**命令行版**：
```bash
uv run python main.py
```

**网页版**：
```bash
uv run streamlit run app.py --server.headless true
```
浏览器打开 `http://localhost:8501`

## 隐私

所有处理在本地完成，不上传、不收集、不存储用户数据。

## 已知限制

- deepagents 0.6.12 在 LangSmith Tracing 开启时存在兼容性问题（PR #3993 已修复但未发版），当前代码强制关闭 Tracing
- Agent 运行需 1~2 分钟，取决于模型响应速度
- Streamlit 同步框架限制，分析期间页面无进度更新

## 技术栈

- Deep Agents（LangGraph）
- DeepSeek V4
- Streamlit
- Python 3.11+
- uv 包管理器
