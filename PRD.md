# 求职加速器 PRD

## 目标

做一个面向 BOSS 直聘搜索页的半自动求职助手：

1. 用户粘贴简历或技能树。
2. 用户在 BOSS 直聘页面自行设置城市、岗位、薪资、经验、学历等筛选条件。
3. Chrome 插件抓取当前可见岗位卡片和右侧 JD。
4. 后端先本地快筛匹配度。
5. 只有高潜岗位调用用户配置的 LLM 生成定制开场白。
6. 用户点击「去沟通」后插件自动填入开场白，最终发送由用户手动确认。

本项目不做无确认的全自动群发。

## 用户痛点

- 重复点开岗位、看 JD、判断是否匹配。
- 每个岗位都要临时写开场白。
- 低质量岗位太多，人工筛选耗时。
- 大模型全量分析太慢、容易排队超时。

## 当前架构

```text
plugin/
  popup.html/js   简历输入、匹配阈值、排除关键词、API 地址、缓存清理
  content.js      抓岗位、筛选、调 /match、展示结果、统计、CSV 导出、去沟通填话术

server.py         FastAPI：/health、/match
pipeline.py       LLM 配置、简历画像、本地快筛、开场白生成、兜底逻辑
skills.json       无简历时的默认技能画像
```

## 数据流

```text
Chrome popup 保存 resume_text / min_score / exclude_keywords
  ↓
BOSS 页面 content.js 抓岗位和 JD
  ↓
POST /match { jd_text, resume_text }
  ↓
pipeline.py 提取或复用简历 skills_profile
  ↓
本地快筛生成 match_score / matched_skills / missing_skills
  ↓
match_score >= LLM_MIN_SCORE 时调用 LLM 写 opening_message
  ↓
插件展示匹配结果，用户选择是否沟通
```

## 后端接口

### GET /health

返回服务状态和当前 LLM 配置摘要：

```json
{
  "ok": true,
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "api_key_configured": true,
    "two_stage": true,
    "llm_min_score": 75
  }
}
```

### POST /match

输入：

```json
{
  "jd_text": "岗位描述全文",
  "resume_text": "用户粘贴的简历或技能树"
}
```

输出：

```json
{
  "role": "AI Agent 实习生",
  "match_score": 85,
  "matched_skills": [
    {"skill": "Python", "level": "项目经验", "match_reason": "JD 要求 Python，简历项目有 FastAPI 后端实现"}
  ],
  "missing_skills": [
    {"skill": "Docker", "advice": "准备最小部署案例，说明当前经验边界"}
  ],
  "risk_level": "低",
  "suggestions": [],
  "interview_questions": [],
  "opening_message": "公司名的这个岗位，我看岗位里提到 Python 和 Agent 编排，这和我做过的求职加速器项目比较契合..."
}
```

## 模型配置

统一使用通用配置：

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=your-key
LLM_MODEL=deepseek-v4-flash
LLM_BASE_URL=
```

支持 DeepSeek、豆包/火山方舟、Qwen、Kimi、智谱 GLM、SiliconFlow、OpenRouter、OpenAI 和自定义 OpenAI-compatible 网关。

旧的 `DEEPSEEK_*` 变量只做兼容，不推荐新用户使用。

## 性能策略

- 默认 `LLM_MATCHER=false`，匹配分由本地规则计算。
- 默认 `LLM_OPENING=true`，只让 LLM 写高潜岗位开场白。
- 默认 `LLM_RESUME_EXTRACTOR=auto`，首次对简历提取技能画像并缓存在后端内存里。
- 默认 `LLM_MIN_SCORE=75`，低于阈值的岗位不调用 LLM。

## 安全和隐私

- `.env` 不提交，真实 API Key 只放用户本机。
- 简历文本保存在 Chrome 本地存储。
- 后端简历画像缓存只在内存中，重启服务后清空。
- 只有高潜岗位会把 JD 摘要和精简简历证据发给用户配置的 LLM。
- 发送沟通消息前必须由用户手动确认。

## 验收标准

- `python -m py_compile pipeline.py server.py app.py hr_bot.py main.py run_pipeline.py` 通过。
- `node --check plugin/content.js plugin/popup.js` 通过。
- `/health` 能显示 provider、model、two_stage、llm_min_score。
- BOSS 搜索页能扫描岗位、显示匹配度、风险、技能、开场白。
- 高潜岗位能进入去沟通流程并自动填入开场白。
- 低潜岗位快速返回，不造成 LLM 请求堆积。
