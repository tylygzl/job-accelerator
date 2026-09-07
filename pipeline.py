"""求职加速器 2.0 · LangGraph 双 Agent 匹配流水线。

Agent 1: JD拆解员，提取岗位、必备技能、加分项和软技能。
Agent 2: 技能匹配员，对照 skills.json 生成结构化匹配报告。
"""

from __future__ import annotations

import json
import os
import re
import copy
import hashlib
import threading
import time
from pathlib import Path
from typing import Any, Literal, TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field


_LLM_CACHE_READY = False
_LLM_CACHE: Any | None = None
_LLM_CACHE_LOCK = threading.Lock()
_RESUME_PROFILE_CACHE: dict[str, dict[str, Any] | None] = {}
_RESUME_PROFILE_LOCK = threading.Lock()


class JDRequirement(BaseModel):
    skill: str
    priority: Literal["required", "preferred"] = "required"
    category: Literal["hard_skill", "soft_skill", "bonus", "other"] = "hard_skill"
    evidence: str = ""


class JDAnalysis(BaseModel):
    role: str = "未知岗位"
    required: list[JDRequirement] = Field(default_factory=list)
    preferred: list[JDRequirement] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)


class MatchedSkill(BaseModel):
    skill: str
    level: str = "未标注"
    match_reason: str


class MissingSkill(BaseModel):
    skill: str
    advice: str


class MatchReport(BaseModel):
    role: str
    match_score: int = Field(ge=0, le=100)
    matched_skills: list[MatchedSkill] = Field(default_factory=list)
    missing_skills: list[MissingSkill] = Field(default_factory=list)
    risk_level: Literal["低", "中", "高"]
    suggestions: list[str] = Field(default_factory=list)
    interview_questions: list[str] = Field(default_factory=list)
    opening_message: str = ""


class MatchState(TypedDict, total=False):
    jd_text: str
    skills_profile: dict[str, Any]
    jd_analysis: dict[str, Any]
    report: dict[str, Any]


JD_DECOMPOSER_PROMPT = """你是“JD拆解员”。从招聘 JD 中提取结构化要求。

只输出 JSON object，不要 Markdown，不要解释。字段必须严格符合：
{
  "role": "岗位名，无法确定则写未知岗位",
  "required": [
    {"skill": "必备硬技能或硬性要求", "priority": "required", "category": "hard_skill", "evidence": "JD原文依据"}
  ],
  "preferred": [
    {"skill": "加分项", "priority": "preferred", "category": "bonus", "evidence": "JD原文依据"}
  ],
  "soft_skills": ["沟通协作等软技能"],
  "responsibilities": ["主要工作内容"],
  "keywords": ["技术关键词"]
}

规则：
- required 只放 JD 明确要求必须掌握、熟悉、了解或具备的事项。
- preferred 只放“优先、加分、熟悉更好、有经验更好”等事项。
- 不要编造 JD 没出现的技能；没有内容就返回空数组。"""


SKILL_MATCHER_PROMPT = """你是“技能匹配员”。你会收到 JD 拆解结果和候选人 skills.json。

只输出 JSON object，不要 Markdown，不要解释。字段必须严格符合：
{
  "role": "岗位名",
  "match_score": 0,
  "matched_skills": [
    {"skill": "命中的JD技能", "level": "候选人技能等级", "match_reason": "为什么匹配，引用候选人证据"}
  ],
  "missing_skills": [
    {"skill": "缺失或偏弱的JD技能", "advice": "短期补法或面试处理建议"}
  ],
  "risk_level": "低/中/高",
  "suggestions": ["投递或面试建议"],
  "interview_questions": ["围绕JD和候选人项目最可能被问的问题"],
  "opening_message": "发给 HR 的定制开场白"
}

评分规则：
- 0-100 的整数分。
- 必备要求权重最高；加分项其次；软技能只做小幅修正。
- risk_level 只能是“低”“中”“高”：75分及以上低，50-74中，50以下高。
- matched_skills 必须引用候选人 skills.json 中的 level/evidence/project。
- missing_skills 不要扩大缺口，只列 JD 关心但候选人证据不足的点。
- opening_message 必须用 opening_target 开头，第一句要写成“我看岗位里提到 X，这和我做过的 Y 比较契合...”，其中 X 必须来自 JD，Y 必须来自候选人证据。
- opening_message 结构：公司/岗位切入 + JD具体要求 + 对应项目/技能证据，80-140 字。
- 只写能和候选人证据挂上的 JD 要求；如果 JD 要求和简历证据挂不上，不要强行关联，改写“这块我只有部分交集”。
- 如果 skills_profile/简历证据里包含 GitHub、Gitee、作品集或博客链接，可以自然提及；没有就不要写 GitHub，也不要写固定用户名。
- 候选人证据必须来自 skills_profile 的 evidence/project，不要编造项目、指标或经历。
- 不要写“JD强调”“证据是”“高度匹配”“我热爱”“学习能力强”“快速学习”“感兴趣”“期待交流”“希望给机会”“我重点匹配”等空话或模板句。
- 50 分以下不要说高度匹配，只能写“有部分交集/建议先确认核心要求”。"""


OPENING_MESSAGE_PROMPT = """你是求职沟通开场白改写助手。
只输出 JSON object，不要 Markdown，不要解释：
{"opening_message": "发给 HR 的一句开场白"}

规则：
- 80-140 字，第一句必须以公司名或岗位名切入。
- 必须写成“我看岗位里提到 X，这和我做过的 Y 比较契合”的逻辑，其中 X 来自 JD，Y 来自候选人证据。
- 只使用输入里的 JD 要求和候选人证据，不要编造公司、项目、指标、链接。
- 如果 JD 要求和候选人证据挂不上钩，写“这块我只有部分交集”，不要强行说匹配。
- 不要写“JD强调”“证据是”“高度匹配”“我热爱”“学习能力强”“希望给机会”“期待交流”等模板话。"""


RESUME_SKILL_EXTRACTOR_PROMPT = """从以下简历提取技能列表，格式跟 skills.json 一样：must_have数组+familiar数组+projects数组，每项含skill/level/evidence。

只输出 JSON object，不要 Markdown，不要解释。字段必须严格符合：
{
  "must_have": [
    {"skill": "技能名", "level": "熟练/掌握/了解/项目经验/未标注", "evidence": "简历原文中的证据"}
  ],
  "familiar": [
    {"skill": "技能名", "level": "熟练/掌握/了解/项目经验/未标注", "evidence": "简历原文中的证据"}
  ],
  "projects": [
    {"skill": "项目名或项目相关技能", "level": "项目经验", "evidence": "项目证据、技术栈或成果"}
  ],
  "public_profiles": ["GitHub/Gitee/作品集/博客链接；简历没有就空数组"],
  "target_profile": {
    "target_roles": ["适合投递的岗位名称"],
    "core_domains": ["候选人的核心求职方向"],
    "transferable_roles": ["可以迁移尝试的岗位方向"],
    "avoid_roles": ["明显不建议投递的岗位方向"]
  }
}

规则：
- must_have 放简历中证据明确、能作为核心竞争力的技能。
- familiar 放有接触但证据较弱或熟悉程度较浅的技能。
- projects 放能支撑技能判断的项目证据。
- public_profiles 只放简历原文明确出现的公开作品链接或账号，不要编造。
- target_profile 必须根据简历证据推断，不要写死行业；例如 AI Agent 候选人适合 AI 应用/后端/RAG，机器人候选人适合机器人/强化学习，销售候选人适合销售/BD。
- 不要编造简历没有出现的技能或项目。"""


RESUME_LONG_TEXT_THRESHOLD = 2000
RESUME_SECTION_CHARS = 500
RESUME_EXTRACT_MAX_CHARS = 3000
RESUME_SECTION_KEYWORDS = [
    "项目经验",
    "项目经历",
    "项目实践",
    "技术栈",
    "专业技能",
    "技能清单",
    "核心技能",
    "个人技能",
    "技术能力",
]


SKILL_ALIASES: dict[str, list[str]] = {
    "Python": ["python"],
    "FastAPI": ["fastapi", "api开发", "后端api"],
    "AI应用/大模型工具": ["ai应用", "aigc", "大模型", "llm", "智能体", "agent", "langgraph", "langchain", "rag", "prompt", "deepseek", "gpt", "dify", "coze", "autogen", "openclaw", "codex", "cursor", "trae", "vibe coding", "mvp"],
    "业务流程自动化/RPA": ["自动化", "半自动", "流程自动化", "业务流程", "rpa", "影刀", "uibot", "n8n", "zapier", "make", "工作流", "sop", "内部工具", "提效", "插件"],
    "RAG检索增强生成": ["rag", "检索增强", "知识库", "混合检索"],
    "Prompt工程": ["prompt", "提示词", "结构化输出", "幻觉控制"],
    "Git/GitHub": ["git", "github", "开源"],
    "SQL/SQLite": ["sql", "sqlite", "数据库"],
    "Docker/Nginx/部署": ["docker", "nginx", "部署", "systemd", "云"],
    "LangChain/LangGraph": ["langchain", "langgraph", "多agent", "智能体"],
    "DeepSeek/GPT API": ["deepseek", "gpt", "llm api", "大模型api", "api调用", "rag", "prompt"],
    "Streamlit": ["streamlit"],
    "Pandas": ["pandas", "数据分析"],
    "向量数据库": ["向量数据库", "milvus", "chroma", "embedding", "向量检索"],
    "JavaScript": ["javascript", "js", "前端"],
    "微信小程序": ["小程序", "微信小程序"],
    "K8s/容器编排": ["k8s", "kubernetes", "容器编排"],
    "算法/数据结构": ["算法", "数据结构"],
    "PyTorch/TensorFlow": ["pytorch", "tensorflow", "torch"],
    "强化学习/机器人": ["强化学习", "reinforcement learning", "ppo", "dqn", "sac", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "机器人", "ros", "moveit", "mujoco", "isaac gym", "gazebo"],
    "机器学习/深度学习": ["机器学习", "machine learning", "深度学习", "deep learning"],
}


FALLBACK_SKILL_RULES: list[tuple[str, list[str], str]] = [
    ("Python", ["python"], "required"),
    ("FastAPI", ["fastapi"], "required"),
    ("AI应用/大模型工具", ["ai应用", "aigc", "大模型", "llm", "智能体", "agent", "langgraph", "langchain", "rag", "prompt", "deepseek", "gpt", "dify", "coze", "autogen", "openclaw", "codex", "cursor", "trae", "vibe coding", "mvp"], "required"),
    ("业务流程自动化/RPA", ["自动化", "半自动", "流程自动化", "业务流程", "rpa", "影刀", "uibot", "n8n", "zapier", "make", "工作流", "sop", "内部工具", "提效", "插件"], "required"),
    ("LangChain/LangGraph", ["langchain", "langgraph", "agent", "智能体", "多agent"], "required"),
    ("DeepSeek/GPT API", ["deepseek", "gpt", "大模型api", "api调用", "llm api"], "required"),
    ("RAG检索增强生成", ["rag", "检索增强", "知识库"], "required"),
    ("Prompt工程", ["prompt", "提示词"], "required"),
    ("SQL/SQLite", ["sql", "sqlite"], "required"),
    ("Pandas", ["pandas"], "required"),
    ("JavaScript", ["javascript", "js", "前端"], "preferred"),
    ("Streamlit", ["streamlit"], "preferred"),
    ("向量数据库", ["向量数据库", "milvus", "chroma", "embedding"], "preferred"),
    ("Git/GitHub", ["github", "git"], "preferred"),
    ("Docker/Nginx/部署", ["docker", "nginx", "部署"], "preferred"),
    ("K8s/容器编排", ["k8s", "kubernetes", "容器编排"], "preferred"),
    ("PyTorch/TensorFlow", ["pytorch", "tensorflow", "torch"], "required"),
    ("强化学习/机器人", ["强化学习", "reinforcement learning", "ppo", "dqn", "sac", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "机器人", "ros", "moveit", "mujoco", "isaac gym", "gazebo"], "required"),
    ("机器学习/深度学习", ["机器学习", "machine learning", "深度学习", "deep learning"], "required"),
]


JD_DOMAIN_RULES: list[dict[str, Any]] = [
    {
        "id": "ai_agent_app",
        "label": "AI 应用/Agent 开发",
        "keywords": ["ai应用", "大模型应用", "aigc", "llm", "智能体", "agent", "dify", "coze", "autogen", "openclaw", "工具调用", "任务规划", "记忆管理", "rag", "知识库", "prompt", "提示词", "mvp"],
        "profile_terms": ["ai应用", "大模型", "llm", "agent", "智能体", "rag", "prompt", "langgraph", "langchain", "工具调用"],
    },
    {
        "id": "automation",
        "label": "业务流程自动化",
        "keywords": ["自动化", "流程自动化", "业务流程", "工作流", "n8n", "zapier", "make", "sop", "内部工具", "提效", "批量内容生成", "数据处理分析"],
        "profile_terms": ["自动化", "流程", "工作流", "内部工具", "提效", "业务流程自动化", "ai工具落地"],
    },
    {
        "id": "rpa",
        "label": "RPA 流程自动化",
        "keywords": ["rpa", "影刀", "uibot", "流程机器人", "rpa机器人"],
        "profile_terms": ["rpa", "影刀", "uibot", "流程机器人", "rpa流程自动化"],
    },
    {
        "id": "backend_infra",
        "label": "后端/高并发基础工程",
        "keywords": ["后端开发", "架构设计", "高并发", "大流量", "亿级用户", "性能调优", "支付", "金融服务", "操作系统"],
        "profile_terms": ["后端", "fastapi", "api", "高并发", "支付", "java", "golang", "操作系统", "性能调优"],
    },
    {
        "id": "quality_ops",
        "label": "质量/流程运营",
        "keywords": ["质量运营", "质量目标", "iso9001", "iso13485", "管理体系", "内部审核", "供应商审核", "管理评审", "质量文化", "流程运营"],
        "profile_terms": ["质量运营", "流程运营", "体系运营", "运营协作"],
    },
    {
        "id": "ai_customer_ops",
        "label": "AI 客服/外呼运营",
        "keywords": ["外呼", "呼叫中心", "ai客服", "语音机器人", "外呼机器人", "客服机器人", "话术流程", "任务投放", "接通率", "意向率", "有效通话", "asr", "badcase", "样本抽检"],
        "profile_terms": ["ai客服", "外呼", "客服机器人", "运营", "数据分析", "报表自动化"],
    },
    {
        "id": "content_labeling",
        "label": "内容审核/数据标注",
        "keywords": ["内容审核", "内容鉴审", "数据标注", "标注师", "目标框", "cvat", "anylabeling", "样本质检", "标注规范", "人工校正", "社区治理"],
        "profile_terms": ["内容审核", "内容鉴审", "数据标注", "标注", "质检"],
    },
    {
        "id": "sales_bd",
        "label": "销售/BD",
        "keywords": ["销售实习", "销售顾问", "销售目标", "销售转化", "电话销售", "电话邀约", "客户建联", "客户名单", "客户线索", "crm", "课程顾问", "保险", "地推", "私域运营", "bd实习"],
        "profile_terms": ["销售", "bd", "课程顾问", "客户成功", "私域运营"],
    },
    {
        "id": "robot_rl",
        "label": "机器人/强化学习算法",
        "keywords": ["强化学习", "reinforcement learning", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "逆强化学习", "机器人", "运动规划", "ros", "moveit", "mujoco", "isaac gym", "gazebo"],
        "profile_terms": ["强化学习", "机器人", "pytorch", "tensorflow", "ros", "moveit", "mujoco", "isaac gym", "gazebo"],
    },
    {
        "id": "media_editing",
        "label": "内容剪辑/直播运营",
        "keywords": ["剪辑", "剪映", "短视频", "短剧", "直播运营", "主播", "抖音", "快手", "网感"],
        "profile_terms": ["剪辑", "短视频", "直播运营", "内容运营"],
    },
    {
        "id": "legal",
        "label": "法律实务",
        "keywords": ["律所", "法律事务", "法学", "诉讼", "仲裁", "非诉", "法考", "律师"],
        "profile_terms": ["法学", "法律", "律所", "律师", "法考"],
    },
    {
        "id": "ecommerce_ops",
        "label": "电商运营",
        "keywords": ["电商运营", "淘宝", "京东", "商品上下架", "标题优化", "库存核对", "618", "双 11", "售后流程"],
        "profile_terms": ["电商运营", "店铺运营", "平台运营"],
    },
]


MATCH_SIGNAL_RULES: dict[str, dict[str, list[str]]] = {
    "primary_outputs": {
        "software_system": ["系统", "平台", "接口", "api", "后端", "插件", "工具开发", "功能开发", "代码", "开发", "部署", "agent搭建", "工作流编排", "mvp原型"],
        "creative_assets": ["视频", "生图", "商业内容", "短剧", "广告", "视觉设计", "剪辑", "动画", "数字媒体", "aigc创作", "ai设计师", "ai设计", "创作者"],
        "ops_process": ["运营", "质检", "审核", "标注", "流程运营", "报表", "复盘", "任务投放", "样本抽检"],
        "sales_conversion": ["销售", "邀约", "客户建联", "客户线索", "销售转化", "crm", "课程顾问", "私域"],
        "research_algorithm": ["算法实验", "论文复现", "强化学习", "模仿学习", "模型训练", "训练执行", "微调", "lora训练"],
        "legal_documents": ["诉讼", "仲裁", "非诉", "法律事务", "律师实务", "法考", "法律文书"],
    },
    "tools": {
        "software_dev": ["python", "fastapi", "langgraph", "langchain", "rag", "api", "javascript", "docker", "sql", "github", "deepseek", "gpt"],
        "creative_ai": ["midjourney", "comfyui", "runway", "即梦", "soar", "soar2", "stable diffusion", "sd", "flux", "lora", "aigc设计工具"],
        "video_design": ["pr", "premiere", "ae", "after effects", "剪映", "视频剪辑", "视觉设计", "美术", "审美", "动画", "数字媒体"],
        "ops_data": ["excel", "sql", "python", "数据清洗", "报表", "看板", "数据分析"],
        "sales_crm": ["crm", "企微", "客户名单", "客户线索", "电话", "私域"],
        "legal": ["法考", "法律检索", "裁判文书", "诉讼", "仲裁"],
    },
    "proof": {
        "code_project": ["github", "gitee", "开源", "项目", "部署", "代码", "接口", "系统"],
        "creative_portfolio": ["作品集", "个人作品", "创作案例", "视频作品", "设计作品", "aigc作品", "ai广告", "漫画", "短剧"],
        "ops_case": ["运营案例", "复盘报告", "sop", "流程图", "报表", "看板"],
        "sales_case": ["销售业绩", "转化率", "客户案例", "crm记录"],
        "legal_cert": ["法考", "法律职业资格", "律所实习"],
    },
}


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _model_validate(model_cls: type[BaseModel], data: Any) -> BaseModel:
    if hasattr(model_cls, "model_validate"):
        return model_cls.model_validate(data)
    return model_cls.parse_obj(data)


def _coerce_score(value: Any, default: int = 50) -> int:
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = default
    return max(0, min(100, round(score)))


def _risk_level(score: int) -> Literal["低", "中", "高"]:
    if score >= 75:
        return "低"
    if score >= 50:
        return "中"
    return "高"


def load_skills_profile(path: str | Path | None = None) -> dict[str, Any]:
    skills_path = Path(path) if path else Path(__file__).with_name("skills.json")
    with skills_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value.strip()
    return ""


def _masked_secret(value: str) -> str:
    if not value:
        return "<empty>"
    if len(value) <= 8:
        return value[:2] + "..." + value[-2:]
    return value[:4] + "..." + value[-4:]


LLM_PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "aliases": ["deepseek", "ds"],
        "base_url": "https://api.deepseek.com/v1",
        "base_url_envs": ["DEEPSEEK_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "DEEPSEEK_API_KEY"],
        "model_envs": ["LLM_MODEL", "DEEPSEEK_MODEL", "MODEL_NAME"],
        "default_model": "deepseek-v4-flash",
    },
    "volcengine": {
        "aliases": ["volcengine", "doubao", "ark", "bytedance"],
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "base_url_envs": ["ARK_BASE_URL", "VOLCENGINE_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "ARK_API_KEY", "VOLCENGINE_API_KEY"],
        "model_envs": ["LLM_MODEL", "ARK_MODEL", "VOLCENGINE_MODEL", "MODEL_NAME"],
        "default_model": "doubao-pro-32k-240615",
    },
    "qwen": {
        "aliases": ["qwen", "dashscope", "aliyun", "alibaba"],
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "base_url_envs": ["DASHSCOPE_BASE_URL", "QWEN_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"],
        "model_envs": ["LLM_MODEL", "DASHSCOPE_MODEL", "QWEN_MODEL", "MODEL_NAME"],
        "default_model": "qwen-plus",
    },
    "moonshot": {
        "aliases": ["moonshot", "kimi"],
        "base_url": "https://api.moonshot.cn/v1",
        "base_url_envs": ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY"],
        "model_envs": ["LLM_MODEL", "MOONSHOT_MODEL", "KIMI_MODEL", "MODEL_NAME"],
        "default_model": "moonshot-v1-8k",
    },
    "zhipu": {
        "aliases": ["zhipu", "glm", "bigmodel"],
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "base_url_envs": ["ZHIPU_BASE_URL", "ZHIPUAI_BASE_URL", "GLM_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"],
        "model_envs": ["LLM_MODEL", "ZHIPU_MODEL", "ZHIPUAI_MODEL", "GLM_MODEL", "MODEL_NAME"],
        "default_model": "glm-4-flash",
    },
    "siliconflow": {
        "aliases": ["siliconflow", "silicon", "sf"],
        "base_url": "https://api.siliconflow.cn/v1",
        "base_url_envs": ["SILICONFLOW_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "SILICONFLOW_API_KEY"],
        "model_envs": ["LLM_MODEL", "SILICONFLOW_MODEL", "MODEL_NAME"],
        "default_model": "Qwen/Qwen2.5-7B-Instruct",
    },
    "openrouter": {
        "aliases": ["openrouter"],
        "base_url": "https://openrouter.ai/api/v1",
        "base_url_envs": ["OPENROUTER_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "OPENROUTER_API_KEY"],
        "model_envs": ["LLM_MODEL", "OPENROUTER_MODEL", "MODEL_NAME"],
        "default_model": "openai/gpt-4o-mini",
    },
    "openai": {
        "aliases": ["openai", "openai-official"],
        "base_url": None,
        "base_url_envs": ["OPENAI_BASE_URL"],
        "api_key_envs": ["LLM_API_KEY", "OPENAI_API_KEY"],
        "model_envs": ["LLM_MODEL", "OPENAI_MODEL", "MODEL_NAME"],
        "default_model": "gpt-4o-mini",
    },
    "openai-compatible": {
        "aliases": ["openai-compatible", "compatible", "custom", "gateway"],
        "base_url": None,
        "base_url_envs": [],
        "api_key_envs": ["LLM_API_KEY", "OPENAI_API_KEY"],
        "model_envs": ["LLM_MODEL", "MODEL_NAME"],
        "default_model": "gpt-4o-mini",
    },
}

LLM_PROVIDER_ALIASES = {
    alias: provider
    for provider, preset in LLM_PROVIDER_PRESETS.items()
    for alias in preset["aliases"]
}
LLM_LOCAL_PROVIDERS = {"none", "off", "false", "local"}


def _canonical_llm_provider(provider: str) -> str:
    normalized = (provider or "").strip().lower().replace("_", "-")
    if not normalized:
        return "none"
    return LLM_PROVIDER_ALIASES.get(normalized, normalized)


def _llm_provider_preset(provider: str) -> dict[str, Any]:
    return LLM_PROVIDER_PRESETS.get(_canonical_llm_provider(provider), LLM_PROVIDER_PRESETS["openai-compatible"])


def _llm_provider() -> str:
    provider = os.getenv("LLM_PROVIDER")
    if provider is not None:
        return _canonical_llm_provider(provider)
    if _env_value("ARK_API_KEY", "VOLCENGINE_API_KEY"):
        return "volcengine"
    if _env_value("DASHSCOPE_API_KEY", "QWEN_API_KEY"):
        return "qwen"
    if _env_value("MOONSHOT_API_KEY", "KIMI_API_KEY"):
        return "moonshot"
    if _env_value("ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"):
        return "zhipu"
    if _env_value("SILICONFLOW_API_KEY"):
        return "siliconflow"
    if _env_value("OPENROUTER_API_KEY"):
        return "openrouter"
    if _env_value("LLM_API_KEY", "OPENAI_API_KEY"):
        return "openai-compatible"
    if _env_value("DEEPSEEK_API_KEY"):
        return "deepseek"
    return "none"


def _llm_base_url(provider: str) -> str | None:
    base_url = _env_value("LLM_BASE_URL")
    if base_url:
        return base_url
    provider = _canonical_llm_provider(provider)
    if provider in LLM_LOCAL_PROVIDERS:
        return None
    preset = _llm_provider_preset(provider)
    provider_base_url = _env_value(*preset.get("base_url_envs", []))
    if provider_base_url:
        return provider_base_url
    return preset.get("base_url")


def _llm_model(provider: str) -> str:
    preset = _llm_provider_preset(provider)
    return _env_value(*preset.get("model_envs", [])) or str(preset.get("default_model") or "gpt-4o-mini")


def _llm_api_key(provider: str) -> str:
    preset = _llm_provider_preset(provider)
    return _env_value(*preset.get("api_key_envs", []))


def _load_local_dotenv() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(Path(__file__).with_name(".env"))
    except Exception:
        pass


def llm_config_summary() -> dict[str, Any]:
    _load_local_dotenv()
    provider = _llm_provider()
    local_mode = provider in LLM_LOCAL_PROVIDERS
    api_key = "" if local_mode else _llm_api_key(provider)
    return {
        "provider": provider,
        "model": "" if local_mode else _llm_model(provider),
        "base_url": "" if local_mode else (_llm_base_url(provider) or ""),
        "supported_providers": sorted([*LLM_PROVIDER_PRESETS.keys(), "none"]),
        "api_key_configured": bool(api_key),
        "proxy_configured": bool(os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")),
        "local_fallback": local_mode or not bool(api_key),
        "llm_jd_decomposer": _use_llm_jd_decomposer(),
        "two_stage": True,
        "llm_min_score": _llm_min_score(),
        "llm_resume_extractor": (not local_mode and bool(api_key) and _use_llm_resume_extractor()),
        "llm_resume_extractor_mode": _llm_resume_extractor_mode(),
        "llm_matcher": _use_llm_matcher(),
        "llm_opening": _use_llm_opening(),
    }


def _env_int(default: int, *names: str) -> int:
    for name in names:
        value = os.getenv(name)
        if not value:
            continue
        try:
            return max(0, min(100, int(value.strip())))
        except ValueError:
            continue
    return default


def _use_llm_jd_decomposer() -> bool:
    return _env_value("JOB_ACCELERATOR_LLM_JD_DECOMPOSER", "LLM_JD_DECOMPOSER").lower() in {"1", "true", "yes", "on"}


def _use_llm_matcher() -> bool:
    return _env_value("JOB_ACCELERATOR_LLM_MATCHER", "LLM_MATCHER").lower() in {"1", "true", "yes", "on"}


def _llm_resume_extractor_mode() -> str:
    value = _env_value("JOB_ACCELERATOR_LLM_RESUME_EXTRACTOR", "LLM_RESUME_EXTRACTOR").lower()
    if not value or value == "auto":
        return "auto"
    if value in {"1", "true", "yes", "on"}:
        return "on"
    if value in {"0", "false", "no", "off", "none", "local"}:
        return "off"
    return "auto"


def _use_llm_resume_extractor() -> bool:
    return _llm_resume_extractor_mode() in {"auto", "on"}


def _resume_extract_attempts() -> int:
    return max(1, _env_int(1, "JOB_ACCELERATOR_RESUME_EXTRACT_ATTEMPTS", "RESUME_EXTRACT_ATTEMPTS"))


def _use_llm_opening() -> bool:
    value = _env_value("JOB_ACCELERATOR_LLM_OPENING", "LLM_OPENING").lower()
    if not value:
        return True
    return value in {"1", "true", "yes", "on"}


def _llm_min_score() -> int:
    return _env_int(75, "JOB_ACCELERATOR_LLM_MIN_SCORE", "LLM_MIN_SCORE")


def make_chat_model(
    *,
    temperature: float = 0,
    timeout: float | None = None,
    max_retries: int | None = None,
    json_mode: bool = False,
    required: bool = False,
) -> Any | None:
    """Create a provider-agnostic ChatOpenAI model from LLM_* config."""
    _load_local_dotenv()

    provider = _llm_provider()
    if provider in LLM_LOCAL_PROVIDERS:
        if required:
            raise ValueError("未配置可用 LLM。请在 .env 中设置 LLM_PROVIDER、LLM_API_KEY 和 LLM_MODEL。")
        print("[llm] provider=none; using local fallback")
        return None

    api_key = _llm_api_key(provider)
    model_name = _llm_model(provider)
    base_url = _llm_base_url(provider)
    print(
        f"[llm] provider={provider} model={model_name} "
        f"base_url={base_url or '<provider-default>'} api_key={_masked_secret(api_key)}"
    )
    if not api_key:
        if required:
            raise ValueError(f"未配置 {provider} API Key。请设置 LLM_API_KEY 或对应供应商的 API Key。")
        return None

    proxy = os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or ""
    model = ChatOpenAI(
        model=model_name,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        timeout=timeout if timeout is not None else float(os.getenv("JOB_ACCELERATOR_LLM_TIMEOUT", "45")),
        max_retries=max_retries if max_retries is not None else _env_int(0, "JOB_ACCELERATOR_LLM_MAX_RETRIES", "LLM_MAX_RETRIES"),
        openai_proxy=proxy if proxy else None,
    )
    return _bind_json_mode(model) if json_mode else model


def _make_llm() -> Any | None:
    global _LLM_CACHE_READY, _LLM_CACHE
    if _LLM_CACHE_READY:
        return _LLM_CACHE

    with _LLM_CACHE_LOCK:
        if _LLM_CACHE_READY:
            return _LLM_CACHE

        _LLM_CACHE = make_chat_model(json_mode=True)
        _LLM_CACHE_READY = True
        return _LLM_CACHE


def _bind_json_mode(llm: Any | None) -> Any | None:
    if llm is None:
        return None
    try:
        return llm.bind(response_format={"type": "json_object"})
    except Exception:
        return llm


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    return str(content)


def _loads_json(raw: Any) -> dict[str, Any]:
    text = _stringify_content(raw).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def _invoke_json(llm: Any, system_prompt: str, user_prompt: str) -> dict[str, Any]:
    result = llm.invoke(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
    )
    return _loads_json(getattr(result, "content", result))


def _resume_extract_text(resume_text: str) -> str:
    resume_text = (resume_text or "").strip()
    if len(resume_text) <= RESUME_LONG_TEXT_THRESHOLD:
        return resume_text

    chunks: list[str] = []
    seen: set[str] = set()
    for keyword in RESUME_SECTION_KEYWORDS:
        for match in re.finditer(re.escape(keyword), resume_text, flags=re.I):
            start = match.start()
            end = min(len(resume_text), match.end() + RESUME_SECTION_CHARS)
            chunk = resume_text[start:end].strip()
            key = re.sub(r"\s+", "", chunk).lower()
            if chunk and key not in seen:
                seen.add(key)
                chunks.append(chunk)

    selected = "\n\n".join(chunks) if chunks else resume_text[:RESUME_EXTRACT_MAX_CHARS]
    return selected[:RESUME_EXTRACT_MAX_CHARS]


def _normalize_resume_skill_item(item: Any) -> dict[str, str] | None:
    if isinstance(item, str):
        skill = item.strip()
        return {"skill": skill, "level": "未标注", "evidence": skill} if skill else None
    if not isinstance(item, dict):
        return None
    skill = str(item.get("skill") or item.get("name") or "").strip()
    if not skill:
        return None
    return {
        "skill": skill,
        "level": str(item.get("level") or "未标注").strip() or "未标注",
        "evidence": str(item.get("evidence") or item.get("description") or "").strip(),
    }


def _resume_items(data: dict[str, Any], group: str) -> list[dict[str, str]]:
    raw = data.get(group)
    if raw is None and isinstance(data.get("skills"), dict):
        raw = data["skills"].get(group)
    if isinstance(raw, dict):
        raw = raw.values()
    return [item for item in (_normalize_resume_skill_item(item) for item in raw or []) if item]


def _resume_project(item: dict[str, str]) -> dict[str, Any]:
    keywords = [value for value in [item["skill"], item["level"], item["evidence"]] if value]
    return {
        "name": item["skill"],
        "skill": item["skill"],
        "level": item["level"],
        "evidence": item["evidence"],
        "keywords": keywords,
    }


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, dict):
        value = value.values()
    result: list[str] = []
    for item in value or []:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def _profile_text(skills_profile: dict[str, Any]) -> str:
    try:
        return json.dumps(skills_profile, ensure_ascii=False).lower()
    except TypeError:
        return str(skills_profile).lower()


def _infer_target_profile(skills_profile: dict[str, Any]) -> dict[str, list[str]]:
    text = _profile_text(skills_profile)
    target_roles: list[str] = []
    core_domains: list[str] = []
    transferable_roles: list[str] = []
    avoid_roles: list[str] = []

    def add(values: list[str], *items: str) -> None:
        for item in items:
            if item and item not in values:
                values.append(item)

    if _contains_any(text, ["langgraph", "langchain", "agent", "deepseek", "gpt", "llm", "rag", "prompt"]):
        add(target_roles, "AI Agent 实习生", "大模型应用开发实习生", "RAG 应用开发实习生")
        add(core_domains, "AI 应用开发", "Agent 工程", "RAG", "LLM API")
        add(transferable_roles, "Python 后端实习生", "自动化工具开发实习生")

    if _contains_any(text, ["python", "fastapi", "api", "后端", "sql", "docker"]):
        add(target_roles, "Python 后端实习生")
        add(core_domains, "后端 API", "工程化开发")

    if _contains_any(text, ["chrome extension", "浏览器插件", "javascript", "自动化"]):
        add(target_roles, "浏览器插件开发实习生", "自动化工具开发实习生")
        add(core_domains, "浏览器插件", "前端自动化")

    if _contains_any(text, ["自动化", "半自动", "流程", "提效", "工具", "插件", "sop", "rpa", "低代码", "内部工具"]):
        add(target_roles, "AI 自动化工具开发实习生", "业务流程自动化实习生")
        add(core_domains, "业务流程自动化", "AI 工具落地", "内部工具开发")
        add(transferable_roles, "RPA 实习生", "AI 产品运营实习生", "数据自动化实习生")

    if _contains_any(text, ["rpa", "影刀", "uibot", "来也", "流程机器人"]):
        add(target_roles, "RPA 开发实习生")
        add(core_domains, "RPA 流程自动化")

    if _contains_any(text, ["pytorch", "tensorflow", "强化学习", "reinforcement learning", "ppo", "dqn", "sac", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "机器人", "ros", "moveit", "mujoco", "isaac gym", "gazebo"]):
        add(target_roles, "机器人算法实习生", "强化学习实习生", "运动控制实习生")
        add(core_domains, "机器人控制", "强化学习", "深度学习", "仿真环境")
        add(transferable_roles, "算法实习生", "机器学习实习生")

    if _contains_any(text, ["销售", "bd", "客户沟通", "转化", "课程顾问", "私域运营", "地推", "电话邀约"]):
        add(target_roles, "销售实习生", "BD 实习生", "课程顾问实习生")
        add(core_domains, "销售转化", "客户沟通", "私域运营")

    if _contains_any(text, ["内容审核", "数据标注", "社区运营", "内容运营", "质检", "审核规则"]):
        add(target_roles, "内容审核实习生", "数据标注实习生", "内容运营实习生")
        add(core_domains, "内容审核", "数据标注", "运营协作")

    if not _contains_any(" ".join([*target_roles, *core_domains]), ["销售", "bd", "课程顾问"]):
        add(avoid_roles, "销售", "课程顾问", "保险", "带薪培训")
    if not _contains_any(" ".join([*target_roles, *core_domains]), ["内容审核", "数据标注", "内容运营"]):
        add(avoid_roles, "内容审核", "数据标注")

    return {
        "target_roles": target_roles,
        "core_domains": core_domains,
        "transferable_roles": transferable_roles,
        "avoid_roles": avoid_roles,
    }


def _normalize_target_profile(data: dict[str, Any], profile: dict[str, Any]) -> dict[str, list[str]]:
    raw = data.get("target_profile") or {}
    if not isinstance(raw, dict):
        raw = {}
    inferred = _infer_target_profile(profile)
    normalized: dict[str, list[str]] = {}
    for key in ["target_roles", "core_domains", "transferable_roles", "avoid_roles"]:
        values = _string_list(raw.get(key))
        normalized[key] = values or inferred[key]
    return normalized


def _normalize_resume_profile(data: dict[str, Any]) -> dict[str, Any]:
    must_have = _resume_items(data, "must_have")
    familiar = _resume_items(data, "familiar")
    projects = [_resume_project(item) for item in _resume_items(data, "projects")]
    profile = {
        "name": str(data.get("name") or "简历候选人"),
        "role": str(data.get("role") or ""),
        "skills": {
            "must_have": must_have,
            "familiar": familiar,
        },
        "weaknesses": [],
        "projects": projects,
        "public_profiles": _string_list(data.get("public_profiles")),
    }
    profile["target_profile"] = _normalize_target_profile(data, profile)
    return profile


def _extract_public_profiles(text: str) -> list[str]:
    profiles: list[str] = []

    def add(value: str) -> None:
        clean = value.strip(" \t\r\n，。；;()（）[]【】<>")
        if clean and clean not in profiles:
            profiles.append(clean)

    for match in re.finditer(r"https?://[^\s\"'，。；;()（）<>]+", text or "", flags=re.I):
        url = match.group(0)
        if _contains_any(url, ["github.com", "gitee.com", "gitlab.com", "juejin.cn", "zhihu.com", "notion.site"]):
            add(url)

    for match in re.finditer(r"(?:GitHub|Gitee|GitLab|作品集|个人网站|博客)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9_.\-/]{1,80})", text or "", flags=re.I):
        add(match.group(0))
    for match in re.finditer(r"(?:GitHub|Gitee|GitLab)\s*(?:用户名|账号|主页|profile)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_.-]{1,80})", text or "", flags=re.I):
        add(match.group(0))

    return profiles[:5]


def _resume_keyword_evidence(resume_text: str, alias: str) -> str:
    lines = [line.strip(" \t-#*|") for line in resume_text.splitlines()]
    for line in lines:
        if len(line) <= 180 and alias.lower() in line.lower():
            return line
    index = resume_text.lower().find(alias.lower())
    if index < 0:
        return f"简历提到 {alias}"
    start = max(0, index - 40)
    end = min(len(resume_text), index + 120)
    return re.sub(r"\s+", " ", resume_text[start:end]).strip() or f"简历提到 {alias}"


def _fallback_resume_skills_profile(resume_text: str) -> dict[str, Any] | None:
    lower = resume_text.lower()
    familiar: list[dict[str, str]] = []
    projects: list[dict[str, Any]] = []
    seen: set[str] = set()

    for skill, aliases, _priority in FALLBACK_SKILL_RULES:
        all_aliases = [skill, *aliases]
        hit_alias = next((alias for alias in all_aliases if alias.lower() in lower), None)
        if not hit_alias or skill in seen:
            continue
        seen.add(skill)
        familiar.append(
            {
                "skill": skill,
                "level": "了解",
                "evidence": _resume_keyword_evidence(resume_text, hit_alias),
            }
        )

    project_text = _resume_extract_text(resume_text)
    for keyword in ["项目经验", "项目经历", "项目实践"]:
        if keyword in project_text:
            evidence = _resume_keyword_evidence(project_text, keyword)
            projects.append(
                {
                    "name": keyword,
                    "skill": keyword,
                    "level": "项目经验",
                    "evidence": evidence,
                    "keywords": [evidence],
                }
            )
            break

    profile = {
        "name": "简历候选人",
        "role": "",
        "skills": {
            "must_have": [],
            "familiar": familiar,
        },
        "weaknesses": [],
        "projects": projects,
        "public_profiles": _extract_public_profiles(resume_text),
    }
    profile["target_profile"] = _infer_target_profile(profile)
    return profile if _candidate_skill_items(profile) else None


def _extract_resume_skills_profile(resume_text: str, llm: Any | None) -> dict[str, Any] | None:
    extract_text = _resume_extract_text(resume_text)
    profile: dict[str, Any] | None = None

    if llm is not None:
        for _attempt in range(_resume_extract_attempts()):
            try:
                data = _invoke_json(
                    llm,
                    RESUME_SKILL_EXTRACTOR_PROMPT,
                    f"<resume>\n{extract_text}\n</resume>",
                )
                profile = _normalize_resume_profile(data)
                if _candidate_skill_items(profile):
                    break
            except Exception:
                profile = None
        else:
            profile = None

    if not profile or not _candidate_skill_items(profile):
        profile = _fallback_resume_skills_profile(resume_text)

    profile_skills = (profile or {}).get("skills", {}) if isinstance(profile, dict) else {}
    skills = [*(profile_skills.get("must_have", []) or []), *(profile_skills.get("familiar", []) or [])]
    matched_items = _candidate_skill_items(profile or {})
    print(f"[resume] extracted {len(skills)} skills")
    return profile if matched_items else None


def _resume_cache_key(resume_text: str, llm: Any | None) -> str:
    mode = "llm" if llm is not None else "local"
    return hashlib.sha256(f"{mode}\n{resume_text}".encode("utf-8")).hexdigest()


def _get_resume_skills_profile(resume_text: str, llm: Any | None) -> dict[str, Any] | None:
    key = _resume_cache_key(resume_text, llm)
    with _RESUME_PROFILE_LOCK:
        if key not in _RESUME_PROFILE_CACHE:
            _RESUME_PROFILE_CACHE[key] = _extract_resume_skills_profile(resume_text, llm)
        return copy.deepcopy(_RESUME_PROFILE_CACHE[key])


def _infer_role(jd_text: str) -> str:
    for line in jd_text.splitlines():
        raw = line.strip()
        if re.match(r"^\d+[\.\、]", raw):
            continue
        clean = line.strip(" \t-#：:")
        if not clean or clean.startswith("【"):
            continue
        if any(word in clean for word in ["岗位职责", "任职要求", "使用", "参与", "负责", "调用", "优化", "搭建", "对接"]):
            continue
        if len(clean) <= 32 and any(word in clean for word in ["实习生", "工程师", "开发岗", "产品经理", "算法岗", "数据岗"]):
            return clean
    lower = jd_text.lower()
    if "langchain" in lower or "langgraph" in lower or "ai agent" in lower:
        return "AI应用开发实习生"
    if "rag" in lower or "大模型" in jd_text:
        return "AI大模型应用开发实习生"
    if "python" in lower:
        return "Python开发实习生"
    return "未知岗位"


def _extract_lines(jd_text: str, markers: list[str], limit: int = 6) -> list[str]:
    lines = [line.strip(" \t-0123456789.、") for line in jd_text.splitlines()]
    lines = [line for line in lines if len(line) >= 4]
    picked: list[str] = []
    for line in lines:
        if any(marker in line for marker in markers):
            picked.append(line)
        if len(picked) >= limit:
            break
    return picked


def _context_marks_preferred(jd_text: str, alias: str) -> bool:
    lower = jd_text.lower()
    idx = lower.find(alias.lower())
    if idx < 0:
        return False
    window = jd_text[max(0, idx - 24) : idx + 60]
    return any(mark in window for mark in ["优先", "加分", "更好", "熟悉者", "标签", "亮点"])


def _compact_text(text: str) -> str:
    return re.sub(r"[\s\-_·/|]+", "", str(text or "").lower())


def _is_false_positive_skill_hit(skill: str, alias: str, jd_text: str) -> bool:
    if skill == "强化学习/机器人" and alias.lower() in {"机器人"}:
        idx = jd_text.lower().find(alias.lower())
        window = jd_text[max(0, idx - 24) : idx + 60] if idx >= 0 else jd_text
        compact = _compact_text(window)
        return _contains_any(compact, ["rpa机器人", "软件机器人", "流程机器人", "语音机器人", "外呼机器人", "客服机器人", "聊天机器人", "机器人工作视频", "机器人视频", "机器人数据标注", "机器人标注"])
    return False


def _fallback_jd_analysis(jd_text: str) -> JDAnalysis:
    lower = jd_text.lower()
    required: list[JDRequirement] = []
    preferred: list[JDRequirement] = []
    seen: set[str] = set()

    for skill, aliases, default_priority in FALLBACK_SKILL_RULES:
        hit_alias = next((alias for alias in aliases if alias.lower() in lower), None)
        if not hit_alias or skill in seen:
            continue
        if _is_false_positive_skill_hit(skill, hit_alias, jd_text):
            continue
        seen.add(skill)
        priority = "preferred" if default_priority == "preferred" or _context_marks_preferred(jd_text, hit_alias) else "required"
        item = JDRequirement(
            skill=skill,
            priority=priority,
            category="bonus" if priority == "preferred" else "hard_skill",
            evidence=f"JD提到 {hit_alias}",
        )
        if priority == "preferred":
            preferred.append(item)
        else:
            required.append(item)

    soft_skills = []
    for skill in ["沟通能力", "协作能力", "逻辑思维", "抗压能力"]:
        if skill[:2] in jd_text or skill in jd_text:
            soft_skills.append(skill)

    return JDAnalysis(
        role=_infer_role(jd_text),
        required=required,
        preferred=preferred,
        soft_skills=soft_skills,
        responsibilities=_extract_lines(jd_text, ["参与", "负责", "开发", "优化", "搭建"]),
        keywords=[item.skill for item in [*required, *preferred]],
    )


def summarize_jd_skills(jd_text: str, limit: int = 12) -> dict[str, Any]:
    """Return a lightweight JD skill summary for trace logs and evaluation."""
    jd_analysis = _fallback_jd_analysis(jd_text or "")
    required = [_model_dump(item) for item in jd_analysis.required[:limit]]
    preferred = [_model_dump(item) for item in jd_analysis.preferred[:limit]]
    return {
        "role": jd_analysis.role,
        "required": required,
        "preferred": preferred,
        "soft_skills": jd_analysis.soft_skills[:limit],
        "keywords": jd_analysis.keywords[:limit],
    }


def _candidate_skill_items(skills_profile: dict[str, Any]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    skills = skills_profile.get("skills", {}) if isinstance(skills_profile, dict) else {}
    for group in ["must_have", "familiar"]:
        for item in skills.get(group, []) or []:
            if isinstance(item, dict) and item.get("skill"):
                items.append(
                    {
                        "skill": str(item.get("skill", "")),
                        "level": str(item.get("level", "未标注")),
                        "evidence": str(item.get("evidence", "")),
                    }
                )
    for project in skills_profile.get("projects", []) or []:
        if isinstance(project, dict):
            keywords = ", ".join(str(k) for k in project.get("keywords", []) or [])
            items.append(
                {
                    "skill": str(project.get("name", "项目经验")),
                    "level": "项目经验",
                    "evidence": keywords,
                }
            )
    return items


def summarize_resume_skills(
    resume_text: str = "",
    *,
    skills_profile: dict[str, Any] | None = None,
    limit: int = 16,
) -> dict[str, Any]:
    """Return a lightweight resume skill summary without forcing a real LLM call."""
    profile = skills_profile
    if profile is None and (resume_text or "").strip():
        profile = _get_resume_skills_profile((resume_text or "").strip(), None)
    if profile is None:
        profile = load_skills_profile()

    items = _candidate_skill_items(profile)
    target_profile = profile.get("target_profile", {}) if isinstance(profile, dict) else {}
    return {
        "skill_count": len(items),
        "skills": items[:limit],
        "target_profile": target_profile if isinstance(target_profile, dict) else {},
    }


def _aliases_for(skill: str) -> list[str]:
    aliases = [skill]
    for canonical, values in SKILL_ALIASES.items():
        if skill == canonical or skill in canonical or canonical in skill:
            aliases.extend(values)
    return [a.lower() for a in aliases if a]


def _match_requirement(requirement: JDRequirement, candidate_items: list[dict[str, str]]) -> dict[str, str] | None:
    aliases = _aliases_for(requirement.skill)
    for item in candidate_items:
        skill_text = item["skill"].lower()
        if any(alias in skill_text for alias in aliases):
            return item
    for item in candidate_items:
        evidence_text = item["evidence"].lower()
        if any(alias in evidence_text for alias in aliases):
            return item
    return None


def _advice_for(skill: str) -> str:
    if "k8s" in skill.lower() or "容器编排" in skill:
        return "短期先补 Docker Compose 到 K8s 基本概念，面试中说明当前以单机 Docker 部署为主。"
    if "向量" in skill or "milvus" in skill.lower() or "chroma" in skill.lower():
        return "用现有 RAG 项目补一版向量库实践，对比 BM25、余弦和向量数据库检索效果。"
    if "streamlit" in skill.lower() or "前端" in skill:
        return "准备一个 Streamlit 小 demo，说明如何把 AI 后端能力快速包装成交互原型。"
    if "算法" in skill or "数据结构" in skill:
        return "集中复习数组、哈希、栈队列和二分，准备 2-3 道能手写的基础题。"
    return "先补最小可演示案例，面试时坦诚说明经验边界，并把已有相关项目迁移到该技术点。"


def _default_interview_questions(report: dict[str, Any]) -> list[str]:
    skills = [item.get("skill", "") for item in report.get("matched_skills", [])]
    missing = [item.get("skill", "") for item in report.get("missing_skills", [])]
    questions: list[str] = []
    if any("Lang" in s or "Agent" in s for s in skills):
        questions.append("你用 LangGraph 做多 Agent 编排时，状态如何在节点之间传递？")
    if any("RAG" in s or "检索" in s for s in skills):
        questions.append("RAG 检索增强生成里，你如何评估召回质量并控制幻觉？")
    if any("Python" in s for s in skills):
        questions.append("这个岗位如果要你用 Python 对接业务系统，你会怎么设计接口和异常处理？")
    if missing:
        questions.append(f"JD 提到 {missing[0]}，你目前经验不足，会如何快速补齐？")
    while len(questions) < 3:
        questions.append("请结合你的项目讲一个从需求拆解到上线部署的完整过程。")
    return questions[:5]


def _fallback_report(jd_analysis: JDAnalysis, skills_profile: dict[str, Any]) -> MatchReport:
    candidate_items = _candidate_skill_items(skills_profile)
    matched: list[MatchedSkill] = []
    missing: list[MissingSkill] = []
    required_hits = 0
    preferred_hits = 0

    for requirement in jd_analysis.required:
        item = _match_requirement(requirement, candidate_items)
        if item:
            required_hits += 1
            matched.append(
                MatchedSkill(
                    skill=requirement.skill,
                    level=item["level"],
                    match_reason=f"JD要求{requirement.skill}；候选人证据：{item['evidence'] or item['skill']}",
                )
            )
        else:
            missing.append(MissingSkill(skill=requirement.skill, advice=_advice_for(requirement.skill)))

    for requirement in jd_analysis.preferred:
        item = _match_requirement(requirement, candidate_items)
        if item:
            preferred_hits += 1
            matched.append(
                MatchedSkill(
                    skill=requirement.skill,
                    level=item["level"],
                    match_reason=f"JD加分项{requirement.skill}；候选人证据：{item['evidence'] or item['skill']}",
                )
            )
        else:
            missing.append(MissingSkill(skill=requirement.skill, advice=_advice_for(requirement.skill)))

    required_total = max(1, len(jd_analysis.required))
    preferred_total = len(jd_analysis.preferred)
    score = round((required_hits / required_total) * 80)
    score += round((preferred_hits / preferred_total) * 15) if preferred_total else 10
    score += 5 if jd_analysis.soft_skills else 3
    score = _coerce_score(score)

    report = {
        "role": jd_analysis.role,
        "match_score": score,
        "matched_skills": [_model_dump(item) for item in matched],
        "missing_skills": [_model_dump(item) for item in missing[:5]],
        "risk_level": _risk_level(score),
        "suggestions": [
            "面试优先讲 RAG、Prompt 和 LangGraph/Agent 项目的真实实现细节。",
            "把 GitHub、评测数据、部署记录作为可信证据主动展示。",
        ],
        "interview_questions": [],
    }
    report["interview_questions"] = _default_interview_questions(report)
    return _model_validate(MatchReport, report)  # type: ignore[return-value]


def _normalize_jd_analysis(data: dict[str, Any], jd_text: str) -> JDAnalysis:
    data = dict(data or {})
    data.setdefault("role", _infer_role(jd_text))
    data.setdefault("required", [])
    data.setdefault("preferred", [])
    data.setdefault("soft_skills", [])
    data.setdefault("responsibilities", [])
    data.setdefault("keywords", [])
    return _model_validate(JDAnalysis, data)  # type: ignore[return-value]


def _normalize_report(data: dict[str, Any], jd_analysis: JDAnalysis) -> MatchReport:
    data = dict(data or {})
    data.setdefault("role", jd_analysis.role)
    data["match_score"] = _coerce_score(data.get("match_score", data.get("score", 50)))
    data.setdefault("risk_level", _risk_level(data["match_score"]))
    if data["risk_level"] not in {"低", "中", "高"}:
        data["risk_level"] = _risk_level(data["match_score"])
    data.setdefault("matched_skills", [])
    data.setdefault("missing_skills", [])
    data.setdefault("suggestions", [])
    data.setdefault("interview_questions", [])
    if not data["interview_questions"]:
        data["interview_questions"] = _default_interview_questions(data)
    return _model_validate(MatchReport, data)  # type: ignore[return-value]


def _contains_any(text: str, keywords: list[str]) -> bool:
    lower = text.lower()
    return any(keyword.lower() in lower for keyword in keywords)


def _profile_matches_any(skills_profile: dict[str, Any], keywords: list[str]) -> bool:
    if isinstance(skills_profile, dict):
        evidence_profile = dict(skills_profile)
        evidence_profile.pop("target_profile", None)
    else:
        evidence_profile = skills_profile
    try:
        text = json.dumps(evidence_profile, ensure_ascii=False).lower()
    except TypeError:
        text = str(evidence_profile).lower()
    return any(keyword.lower() in text for keyword in keywords)


def _target_profile_matches_any(skills_profile: dict[str, Any], keywords: list[str], sections: list[str] | None = None) -> bool:
    target_profile = skills_profile.get("target_profile", {}) if isinstance(skills_profile, dict) else {}
    if not isinstance(target_profile, dict):
        return False
    section_names = sections or ["target_roles", "core_domains", "transferable_roles"]
    values: list[str] = []
    for section in section_names:
        values.extend(_string_list(target_profile.get(section)))
    return _contains_any(" ".join(values), keywords)


def _target_profile_matches_text(skills_profile: dict[str, Any], text: str, sections: list[str]) -> bool:
    target_profile = skills_profile.get("target_profile", {}) if isinstance(skills_profile, dict) else {}
    if not isinstance(target_profile, dict):
        return False
    values: list[str] = []
    for section in sections:
        values.extend(_string_list(target_profile.get(section)))
    return _contains_any(text, values)


def _candidate_supports_direction(skills_profile: dict[str, Any], keywords: list[str]) -> bool:
    return _profile_matches_any(skills_profile, keywords) or _target_profile_matches_any(skills_profile, keywords)


def _matched_report_text(report: dict[str, Any]) -> str:
    parts: list[str] = []
    for group in ["matched_skills", "missing_skills"]:
        for item in report.get(group, []) or []:
            if isinstance(item, dict):
                parts.extend(str(value) for value in item.values())
    return " ".join(parts)


def _keyword_hits(text: str, keywords: list[str]) -> list[str]:
    lower = str(text or "").lower()
    compact = _compact_text(lower)
    hits: list[str] = []
    for keyword in keywords:
        key = str(keyword or "").lower()
        if not key:
            continue
        if re.fullmatch(r"[a-z0-9+#.]{1,2}", key):
            if re.search(rf"(?<![a-z0-9]){re.escape(key)}(?![a-z0-9])", lower):
                hits.append(keyword)
            continue
        if key in lower or _compact_text(key) in compact:
            hits.append(keyword)
    return hits


def _classify_jd_domains(jd_text: str) -> list[dict[str, Any]]:
    domains: list[dict[str, Any]] = []
    for rule in JD_DOMAIN_RULES:
        hits = _keyword_hits(jd_text, rule.get("keywords", []))
        if not hits:
            continue
        if rule["id"] == "robot_rl":
            hits = [
                hit for hit in hits
                if hit != "机器人" or not _is_false_positive_skill_hit("强化学习/机器人", "机器人", jd_text)
            ]
            if not hits:
                continue
        domains.append(
            {
                "id": rule["id"],
                "label": rule["label"],
                "hits": hits,
                "profile_terms": rule.get("profile_terms", []),
            }
        )
    return domains


def _has_domain(domains: list[dict[str, Any]], *domain_ids: str) -> bool:
    wanted = set(domain_ids)
    return any(domain.get("id") in wanted for domain in domains)


def _target_profile_text(skills_profile: dict[str, Any], sections: list[str] | None = None) -> str:
    target_profile = skills_profile.get("target_profile", {}) if isinstance(skills_profile, dict) else {}
    if not isinstance(target_profile, dict):
        return ""
    selected = sections or ["target_roles", "core_domains", "transferable_roles", "avoid_roles"]
    values: list[str] = []
    for section in selected:
        values.extend(_string_list(target_profile.get(section)))
    return " ".join(values).lower()


def _profile_evidence_text(skills_profile: dict[str, Any]) -> str:
    if isinstance(skills_profile, dict):
        evidence_profile = dict(skills_profile)
        evidence_profile.pop("target_profile", None)
    else:
        evidence_profile = skills_profile
    try:
        return json.dumps(evidence_profile, ensure_ascii=False).lower()
    except TypeError:
        return str(evidence_profile).lower()


def _candidate_evidence_matches_any(skills_profile: dict[str, Any], keywords: list[str]) -> bool:
    parts: list[str] = []
    skills = skills_profile.get("skills", {}) if isinstance(skills_profile, dict) else {}
    for group in ["must_have", "familiar"]:
        for item in skills.get(group, []) or []:
            if isinstance(item, dict):
                parts.append(str(item.get("evidence", "")))
    for project in skills_profile.get("projects", []) or []:
        if isinstance(project, dict):
            parts.append(str(project.get("evidence", "")))
            parts.extend(str(keyword) for keyword in project.get("keywords", []) or [])
    return _contains_any(" ".join(parts), keywords)


def _signals_for_text(text: str) -> dict[str, dict[str, list[str]]]:
    signals: dict[str, dict[str, list[str]]] = {}
    for section, rules in MATCH_SIGNAL_RULES.items():
        section_hits: dict[str, list[str]] = {}
        for signal_id, keywords in rules.items():
            hits = _keyword_hits(text, keywords)
            if hits:
                section_hits[signal_id] = hits
        signals[section] = section_hits
    return signals


def _profile_signal_text(skills_profile: dict[str, Any]) -> str:
    evidence_text = _profile_evidence_text(skills_profile)
    target_text = _target_profile_text(skills_profile, ["target_roles", "core_domains", "transferable_roles"])
    return f"{evidence_text}\n{target_text}"


def _jd_match_signals(jd_text: str) -> dict[str, dict[str, list[str]]]:
    return _signals_for_text(jd_text)


def _profile_match_signals(skills_profile: dict[str, Any]) -> dict[str, dict[str, list[str]]]:
    return _signals_for_text(_profile_signal_text(skills_profile))


def _signal_hits(signals: dict[str, dict[str, list[str]]], section: str, signal_id: str) -> list[str]:
    return signals.get(section, {}).get(signal_id, [])


def _signal_strength(signals: dict[str, dict[str, list[str]]], section: str, *signal_ids: str) -> int:
    return sum(len(_signal_hits(signals, section, signal_id)) for signal_id in signal_ids)


def _has_signal(signals: dict[str, dict[str, list[str]]], section: str, *signal_ids: str) -> bool:
    return any(_signal_hits(signals, section, signal_id) for signal_id in signal_ids)


def _primary_output_overlap(jd_signals: dict[str, dict[str, list[str]]], profile_signals: dict[str, dict[str, list[str]]]) -> bool:
    jd_outputs = set(jd_signals.get("primary_outputs", {}))
    profile_outputs = set(profile_signals.get("primary_outputs", {}))
    return bool(jd_outputs and profile_outputs and jd_outputs & profile_outputs)


def _domain_relation(domain: dict[str, Any], skills_profile: dict[str, Any]) -> str:
    terms = [str(term) for term in domain.get("profile_terms", []) if term]
    target_text = _target_profile_text(skills_profile, ["target_roles", "core_domains"])
    transferable_text = _target_profile_text(skills_profile, ["transferable_roles"])
    avoid_text = _target_profile_text(skills_profile, ["avoid_roles"])
    evidence_text = _profile_evidence_text(skills_profile)

    if terms and _contains_any(avoid_text, terms):
        return "avoid"
    if terms and _contains_any(target_text, terms):
        return "target"
    if terms and _contains_any(transferable_text, terms):
        return "transferable"
    if terms and _contains_any(evidence_text, terms):
        return "evidence"
    return "unrelated"


def _domain_relation_for(domains: list[dict[str, Any]], domain_id: str, skills_profile: dict[str, Any]) -> str:
    for domain in domains:
        if domain.get("id") == domain_id:
            return _domain_relation(domain, skills_profile)
    return "unrelated"


def _report_with_score_floor(report: dict[str, Any], floor: int, reason: str) -> dict[str, Any]:
    score = _coerce_score(report.get("match_score", 0))
    if score >= floor:
        return report
    boosted = dict(report)
    boosted["match_score"] = floor
    boosted["risk_level"] = _risk_level(floor)
    suggestions = list(boosted.get("suggestions") or [])
    suggestions.insert(0, f"分数补偿：{reason}，最低 {floor} 分。")
    boosted["suggestions"] = suggestions[:5]
    return boosted


def _report_with_score_cap(report: dict[str, Any], cap: int, reason: str) -> dict[str, Any]:
    score = _coerce_score(report.get("match_score", 0))
    if score <= cap:
        return report
    capped = dict(report)
    capped["match_score"] = cap
    capped["risk_level"] = _risk_level(cap)
    suggestions = list(capped.get("suggestions") or [])
    suggestions.insert(0, f"分数封顶：{reason}，最高 {cap} 分。")
    capped["suggestions"] = suggestions[:5]
    return capped


def _apply_signal_guardrails(report: dict[str, Any], jd_text: str, skills_profile: dict[str, Any]) -> dict[str, Any]:
    jd_signals = _jd_match_signals(jd_text)
    profile_signals = _profile_match_signals(skills_profile)
    adjusted = dict(report)

    creative_jd_strength = (
        _signal_strength(jd_signals, "primary_outputs", "creative_assets")
        + _signal_strength(jd_signals, "tools", "creative_ai", "video_design")
        + _signal_strength(jd_signals, "proof", "creative_portfolio")
    )
    creative_profile_strength = (
        _signal_strength(profile_signals, "primary_outputs", "creative_assets")
        + _signal_strength(profile_signals, "tools", "creative_ai", "video_design")
        + _signal_strength(profile_signals, "proof", "creative_portfolio")
    )
    if creative_jd_strength >= 3 and creative_profile_strength == 0:
        adjusted = _report_with_score_cap(
            adjusted,
            60,
            "JD 主产出是 AIGC/视频/视觉作品，但简历缺少创作工具、剪辑设计或作品集证据",
        )
    elif _has_signal(jd_signals, "proof", "creative_portfolio") and not _has_signal(profile_signals, "proof", "creative_portfolio"):
        adjusted = _report_with_score_cap(
            adjusted,
            70,
            "JD 明确看重作品集/创作案例，但简历证据里没有对应作品证明",
        )

    jd_outputs = set(jd_signals.get("primary_outputs", {}))
    profile_outputs = set(profile_signals.get("primary_outputs", {}))
    if jd_outputs and profile_outputs and not _primary_output_overlap(jd_signals, profile_signals):
        adjusted = _report_with_score_cap(
            adjusted,
            65,
            "JD 主产出和简历主证据不一致，不能只按相同领域关键词给高分",
        )

    jd_tool_groups = set(jd_signals.get("tools", {}))
    profile_tool_groups = set(profile_signals.get("tools", {}))
    if len(jd_tool_groups) >= 2 and not (jd_tool_groups & profile_tool_groups):
        adjusted = _report_with_score_cap(
            adjusted,
            65,
            "JD 的主要工具栈和简历工具证据不重合",
        )

    return adjusted


def _apply_domain_adjustments(report: dict[str, Any], jd_text: str, skills_profile: dict[str, Any]) -> dict[str, Any]:
    domains = _classify_jd_domains(jd_text)
    if not domains:
        return report

    adjusted = dict(report)

    if _has_domain(domains, "quality_ops") and _has_domain(domains, "ai_agent_app", "automation"):
        relation = _domain_relation_for(domains, "ai_agent_app", skills_profile)
        if relation in {"target", "transferable", "evidence"}:
            adjusted = _report_with_score_floor(adjusted, 55, "岗位主体偏质量/流程运营，但包含 AI 工具落地，和用户画像有相邻交集")
            adjusted = _report_with_score_cap(adjusted, 68, "岗位主体仍是质量/流程运营，不是完整 AI 应用开发")

    if _has_domain(domains, "ai_customer_ops"):
        support_terms = ["python", "sql", "数据分析", "报表", "自动化", "ai工具", "prompt", "大模型", "agent"]
        if _candidate_supports_direction(skills_profile, support_terms):
            adjusted = _report_with_score_floor(adjusted, 55, "岗位偏 AI 客服/外呼运营，但数据处理、话术流程和自动化能力可迁移")
            adjusted = _report_with_score_cap(adjusted, 68, "岗位主体不是工程开发，最高按相邻方向处理")

    if _has_domain(domains, "rpa") and not _has_domain(domains, "ai_agent_app"):
        explicit_rpa_support = _candidate_evidence_matches_any(skills_profile, ["rpa", "影刀", "uibot", "流程机器人"])
        automation_support = _candidate_supports_direction(skills_profile, ["自动化", "流程", "工作流", "内部工具", "提效"])
        if explicit_rpa_support:
            adjusted = _report_with_score_floor(adjusted, 75, "用户画像有明确 RPA 证据")
        elif automation_support:
            adjusted = _report_with_score_floor(adjusted, 58, "RPA 属于流程自动化，相比核心 Agent/RAG 是可迁移方向")
            adjusted = _report_with_score_cap(adjusted, 72, "缺少明确 RPA 工具证据，最高按可迁移方向处理")
        else:
            adjusted = _report_with_score_cap(adjusted, 50, "岗位核心是 RPA 工具搭建，当前用户画像缺少对应证据")

    if _has_domain(domains, "backend_infra"):
        infra_terms = ["高并发", "大流量", "亿级用户", "支付", "金融服务", "操作系统", "性能调优", "java", "golang", "c++", "php"]
        if _contains_any(jd_text, infra_terms) and not _candidate_supports_direction(skills_profile, infra_terms):
            adjusted = _report_with_score_cap(adjusted, 72, "岗位主体是后端/支付/高并发工程，AI 只是业务探索或加分项")

    vague_ai_product_terms = ["ai native", "产品定义", "产品创新", "有灵魂", "陪伴成长", "前沿探索"]
    concrete_build_terms = ["python", "fastapi", "api", "代码", "开发", "测试", "调试", "部署", "rag", "知识库", "prompt", "工具调用", "dify", "coze", "langchain", "langgraph", "autogen", "openclaw"]
    if _has_domain(domains, "ai_agent_app") and _contains_any(jd_text, vague_ai_product_terms):
        if not _contains_any(jd_text, concrete_build_terms):
            adjusted = _report_with_score_cap(adjusted, 72, "岗位方向接近 AI/Agent，但 JD 缺少可验证的工程技能要求")

    return adjusted


def _score_cap_for_jd(jd_text: str, report: dict[str, Any], skills_profile: dict[str, Any]) -> tuple[int | None, str]:
    jd_lower = jd_text.lower()
    report_text = _matched_report_text(report).lower()
    avoid_hit = _target_profile_matches_text(skills_profile, jd_lower, ["avoid_roles"])
    target_hit = _target_profile_matches_text(skills_profile, jd_lower, ["target_roles", "core_domains", "transferable_roles"])
    if avoid_hit and not target_hit:
        return 35, "岗位方向命中用户画像中的规避方向"

    sales_terms = ["销售实习", "销售顾问", "销售目标", "销售转化", "电话销售", "电话邀约", "客户建联", "客户名单", "客户线索", "crm", "地推", "保险", "课程顾问", "带薪培训", "bd实习", "私域运营"]
    if _contains_any(jd_lower, sales_terms):
        if not _candidate_supports_direction(skills_profile, sales_terms):
            return 35, "岗位核心是销售/培训，不是技术开发"

    content_terms = ["内容审核", "内容鉴审", "数据标注", "标注师", "目标框", "cvat", "anylabeling", "样本质检", "标注规范", "人工校正", "社区治理"]
    if _contains_any(jd_lower, content_terms):
        if not _candidate_supports_direction(skills_profile, content_terms):
            return 45, "岗位核心是审核/标注/运营，不是 AI 应用开发"

    robot_terms = ["强化学习", "reinforcement learning", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "逆强化学习", "运动规划", "ros", "moveit", "mujoco", "isaac gym", "gazebo"]
    has_robot_term = _contains_any(jd_lower, robot_terms) or ("机器人" in jd_lower and not _is_false_positive_skill_hit("强化学习/机器人", "机器人", jd_text))
    if has_robot_term:
        rl_evidence = ["pytorch", "tensorflow", "强化学习", "reinforcement learning", "ppo", "dqn", "sac", "模仿学习", "imitation learning", "行为克隆", "behavior cloning", "机器人", "机器人控制", "运动规划", "ros", "moveit", "mujoco", "isaac gym", "gazebo", "深度学习"]
        if not _candidate_supports_direction(skills_profile, rl_evidence) and not _contains_any(report_text, rl_evidence):
            return 55, "岗位强依赖机器人/强化学习证据，当前简历证据不足"

    if _contains_any(jd_lower, ["pytorch", "tensorflow", "深度学习", "机器学习算法", "machine learning", "deep learning"]):
        ml_evidence = ["pytorch", "tensorflow", "深度学习", "deep learning", "机器学习", "machine learning", "算法竞赛", "论文复现"]
        if not _candidate_supports_direction(skills_profile, ml_evidence) and not _contains_any(report_text, ml_evidence):
            return 60, "岗位强依赖机器学习框架或算法证据，当前简历证据不足"

    return None, ""


def _apply_score_guardrails(report: dict[str, Any], jd_text: str, skills_profile: dict[str, Any]) -> dict[str, Any]:
    adjusted = _apply_domain_adjustments(report, jd_text, skills_profile)
    adjusted = _apply_signal_guardrails(adjusted, jd_text, skills_profile)
    cap, reason = _score_cap_for_jd(jd_text, adjusted, skills_profile)
    if cap is None:
        return adjusted

    return _report_with_score_cap(adjusted, cap, reason)


def build_match_graph(llm: Any | None = None, use_llm_jd_decomposer: bool = False) -> Any:
    llm = _bind_json_mode(llm)

    def jd_decomposer_agent(state: MatchState) -> dict[str, Any]:
        jd_text = state["jd_text"]
        if llm is not None and use_llm_jd_decomposer:
            try:
                data = _invoke_json(
                    llm,
                    JD_DECOMPOSER_PROMPT,
                    f"<job_description>\n{jd_text}\n</job_description>",
                )
                analysis = _normalize_jd_analysis(data, jd_text)
                return {"jd_analysis": _model_dump(analysis)}
            except Exception:
                pass
        return {"jd_analysis": _model_dump(_fallback_jd_analysis(jd_text))}

    def skill_matcher_agent(state: MatchState) -> dict[str, Any]:
        jd_analysis = _model_validate(JDAnalysis, state["jd_analysis"])  # type: ignore[arg-type]
        skills_profile = state["skills_profile"]
        if llm is not None:
            try:
                data = _invoke_json(
                    llm,
                    SKILL_MATCHER_PROMPT,
                    json.dumps(
                        {
                            "jd_analysis": _model_dump(jd_analysis),
                            "skills_profile": skills_profile,
                            "opening_target": _opening_target({"role": jd_analysis.role}, state.get("jd_text", "")),
                            "jd_excerpt_for_opening": _opening_jd_excerpt(state.get("jd_text", "")),
                        },
                        ensure_ascii=False,
                    ),
                )
                report = _normalize_report(data, jd_analysis)  # type: ignore[arg-type]
                return {"report": _model_dump(report)}
            except Exception:
                pass
        return {"report": _model_dump(_fallback_report(jd_analysis, skills_profile))}

    builder = StateGraph(MatchState)
    builder.add_node("jd_decomposer", jd_decomposer_agent)
    builder.add_node("skill_matcher", skill_matcher_agent)
    builder.add_edge(START, "jd_decomposer")
    builder.add_edge("jd_decomposer", "skill_matcher")
    builder.add_edge("skill_matcher", END)
    return builder.compile()


def _skill_matches_text(skill: str, text: str) -> bool:
    lower_text = text.lower()
    lower_skill = skill.lower()
    aliases = set(_aliases_for(skill))
    return lower_skill in lower_text or any(alias and alias in lower_text for alias in aliases)


def _opening_evidence_for_skill(skill: str, skills_profile: dict[str, Any]) -> tuple[int, str]:
    skills = skills_profile.get("skills", {}) if isinstance(skills_profile, dict) else {}
    groups = [("must_have", 0), ("familiar", 2)]
    for group, rank in groups:
        for item in skills.get(group, []) or []:
            if not isinstance(item, dict):
                continue
            item_skill = str(item.get("skill", ""))
            evidence = str(item.get("evidence", "")).strip()
            haystack = f"{item_skill} {evidence}"
            if _skill_matches_text(skill, haystack):
                return rank, evidence or item_skill

    for project in skills_profile.get("projects", []) or []:
        if not isinstance(project, dict):
            continue
        project_name = str(project.get("name") or project.get("skill") or "项目经验")
        evidence = str(project.get("evidence") or "").strip()
        keywords = "、".join(str(k) for k in project.get("keywords", []) or [])
        haystack = f"{project_name} {evidence} {keywords}"
        if _skill_matches_text(skill, haystack):
            return 1, evidence or keywords or project_name

    return 3, ""


def _compact_evidence(text: str, limit: int = 72) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip(" ，。；;")
    if len(clean) <= limit:
        return clean
    return clean[:limit].rstrip(" ，。；;") + "..."


def _profile_json_text(skills_profile: dict[str, Any]) -> str:
    try:
        return json.dumps(skills_profile, ensure_ascii=False)
    except TypeError:
        return str(skills_profile)


def _opening_public_proof(skills_profile: dict[str, Any]) -> str:
    if not isinstance(skills_profile, dict):
        return ""
    candidates = [str(item) for item in skills_profile.get("public_profiles", []) or []]
    candidates.append(_profile_json_text(skills_profile))
    text = "\n".join(candidates)

    github_url = re.search(r"(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9-]{1,39})(?:[/?#\s\"'，。；;]|$)", text, flags=re.I)
    if github_url:
        return f"GitHub: {github_url.group(1)}"

    github_name = re.search(r"(?:GitHub|github)\s*(?:用户名|账号|主页|profile)?\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9-]{1,38})", text, flags=re.I)
    if github_name:
        name = github_name.group(1)
        if name.lower() not in {"github", "git", "readme"}:
            return f"GitHub: {name}"
    github_name = re.search(r"(?:GitHub|github)\s*(?:用户名|账号|主页|profile)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{1,38})", text, flags=re.I)
    if github_name:
        name = github_name.group(1)
        if name.lower() not in {"github", "git", "readme"}:
            return f"GitHub: {name}"

    gitee_url = re.search(r"(?:https?://)?(?:www\.)?gitee\.com/([A-Za-z0-9_.-]{1,60})(?:[/?#\s\"'，。；;]|$)", text, flags=re.I)
    if gitee_url:
        return f"Gitee: {gitee_url.group(1)}"

    for url in re.findall(r"https?://[^\s\"'，。；;()（）<>]+", text, flags=re.I):
        if _contains_any(url, ["gitlab.com", "juejin.cn", "zhihu.com", "notion.site"]):
            return f"作品集: {url}"

    return ""


def _opening_tail(skills_profile: dict[str, Any], action: str) -> str:
    proof = _opening_public_proof(skills_profile)
    return f"{proof}，{action}。" if proof else f"{action}。"


def _opening_role(report: dict[str, Any], jd_text: str = "") -> str:
    for line in jd_text.splitlines():
        clean = line.strip()
        if clean.startswith("岗位：") or clean.startswith("岗位:"):
            role = clean.split("：", 1)[-1].split(":", 1)[-1].strip()
            if role:
                return role

    role = str(report.get("role") or "").strip()
    return role if role and role != "未知岗位" else "岗位"


def _opening_subject(report: dict[str, Any], jd_text: str = "") -> str:
    target = _opening_target(report, jd_text)
    role = _opening_role(report, jd_text)
    if target and target != "这个岗位":
        if role and role not in target:
            suffix = role if role.endswith(("岗位", "职位")) else f"{role}岗位"
            return f"{target}的{suffix}"
        return f"{target}的这个岗位"
    if role and role != "岗位":
        return role if role.endswith(("岗位", "职位")) else f"{role}岗位"
    return "这个岗位"


def _clean_jd_hook_line(line: str) -> str:
    clean = re.sub(r"\s+", " ", line or "").strip(" \t-#*，。；;")
    clean = re.sub(r"^(岗位详情|职位描述|岗位职责|工作职责|任职要求|岗位要求|任职资格|工作内容)[:：]?", "", clean).strip()
    clean = re.sub(r"^[（(]?\s*[0-9一二三四五六七八九十]{1,3}\s*(?:[）)、.．:：]|[^\w\s])\s*", "", clean).strip()
    clean = re.sub(r"^[0-9一二三四五六七八九十]{1,3}\s+", "", clean).strip()
    clean = re.sub(r"^(岗位|公司|薪资|地点)[:：].*$", "", clean).strip()
    if len(clean) > 54:
        for separator in ["。", "；", ";"]:
            first = clean.split(separator, 1)[0].strip(" ，,。；;")
            if 12 <= len(first) < len(clean):
                clean = first
                break
    if len(clean) > 54:
        first = re.split(r"[，,]", clean, 1)[0].strip(" ，,。；;")
        if len(first) >= 12:
            clean = first
    if len(clean) > 54:
        clean = clean[:54].rstrip(" ，。；;") + "..."
    return clean


def _opening_jd_hook(jd_text: str, skills: list[str]) -> str:
    lines = [_clean_jd_hook_line(line) for line in _opening_jd_excerpt(jd_text, 900).splitlines()]
    lines = [line for line in lines if len(line) >= 8]
    for skill in skills:
        for line in lines:
            if _skill_matches_text(skill, line):
                return line

    for line in lines:
        if _contains_any(line, ["负责", "熟悉", "掌握", "具备", "开发", "搭建", "Agent", "RAG", "大模型", "LLM", "Python"]):
            return line
    return ""


def _opening_hook_clause(jd_text: str, skills: list[str]) -> str:
    hook = _opening_jd_hook(jd_text, skills)
    if hook:
        return f"我看岗位里提到“{hook}”"
    if skills:
        return f"我看岗位要求集中在{'、'.join(skills[:2])}"
    return "我看岗位核心要求还需要进一步确认"


def _opening_guardrail_reason(report: dict[str, Any]) -> str:
    suggestions = " ".join(str(item) for item in report.get("suggestions", []) or [])
    if "AIGC/视频/视觉作品" in suggestions:
        return "creative_output_gap"
    if "作品集/创作案例" in suggestions:
        return "creative_proof_gap"
    if "主产出和简历主证据不一致" in suggestions:
        return "primary_output_gap"
    if "主要工具栈和简历工具证据不重合" in suggestions:
        return "tool_gap"
    return ""


def _opening_guardrail_hook(jd_text: str, reason: str) -> str:
    if reason in {"creative_output_gap", "creative_proof_gap"}:
        keywords = ["视频", "生图", "midjourney", "comfyui", "runway", "剪映", "aigc", "作品"]
    elif reason == "tool_gap":
        keywords = ["工具", "平台", "框架", "软件", "系统"]
    else:
        keywords = ["负责", "要求", "使用", "完成", "搭建", "开发"]

    excerpt = _opening_jd_excerpt(jd_text, 900)
    lower = excerpt.lower()
    for keyword in keywords:
        idx = lower.find(keyword.lower())
        if idx < 0:
            continue
        start_candidates = [excerpt.rfind(mark, 0, idx) for mark in ["。", "；", ";", "\n"]]
        end_candidates = [pos for pos in [excerpt.find(mark, idx) for mark in ["。", "；", ";", "\n"]] if pos >= 0]
        start = max(start_candidates) + 1 if max(start_candidates) >= 0 else max(0, idx - 24)
        end = min(end_candidates) if end_candidates else min(len(excerpt), idx + 90)
        hook = _clean_jd_hook_line(excerpt[start:end])
        if len(hook) >= 8:
            return f"我看岗位里提到“{hook}”"
    return ""


def _opening_target(report: dict[str, Any], jd_text: str = "") -> str:
    for line in jd_text.splitlines():
        clean = line.strip()
        if clean.startswith("公司：") or clean.startswith("公司:"):
            company = clean.split("：", 1)[-1].split(":", 1)[-1].strip()
            if company:
                return company

    role = str(report.get("role") or "").strip()
    return role if role and role != "未知岗位" else "这个岗位"


def _opening_jd_excerpt(jd_text: str, limit: int = 700) -> str:
    lines: list[str] = []
    total = 0
    for line in jd_text.splitlines():
        clean = re.sub(r"\s+", " ", line).strip(" \t-#*")
        if not clean:
            continue
        if len(clean) > 160:
            clean = clean[:160].rstrip(" ，。；;") + "..."
        lines.append(clean)
        total += len(clean)
        if total >= limit:
            break
    return "\n".join(lines)[:limit]


def _rule_opening(report: dict[str, Any], skills_profile: dict[str, Any], jd_text: str = "") -> str:
    subject = _opening_subject(report, jd_text)
    score = _coerce_score(report.get("match_score", 0))
    matched = report.get("matched_skills", []) or []
    picks: list[tuple[int, int, str, str]] = []
    for index, item in enumerate(matched):
        if not isinstance(item, dict):
            continue
        skill = str(item.get("skill") or "").strip()
        if not skill:
            continue
        rank, evidence = _opening_evidence_for_skill(skill, skills_profile)
        picks.append((rank, index, skill, evidence))

    picks.sort(key=lambda item: (item[0], item[1]))
    selected = picks[:2]
    selected_skills = [skill for _, _, skill, _ in selected]
    hook_clause = _opening_hook_clause(jd_text, selected_skills)
    if not selected:
        if score < 50:
            return f"{subject}，{hook_clause}，这块和我的当前经历重合有限；我能补充已有项目里的工程实践。{_opening_tail(skills_profile, '我可以直接讲实现细节')}"
        return f"{subject}，{hook_clause}，我做过的项目里有部分工程经验能对上。{_opening_tail(skills_profile, '我可以直接讲实现、指标和部署过程')}"

    skills_text = "、".join(selected_skills)
    evidence_parts: list[str] = []
    seen_evidence: set[str] = set()
    for _, _, _skill, evidence in selected:
        compact = _compact_evidence(evidence)
        key = compact.lower()
        if compact and key not in seen_evidence:
            seen_evidence.add(key)
            evidence_parts.append(compact)
    evidence_text = "；".join(evidence_parts) or "已有项目中可复盘实现、指标和部署细节"
    guardrail_reason = _opening_guardrail_reason(report)
    if score < 75 and guardrail_reason in {"creative_output_gap", "creative_proof_gap"}:
        guarded_hook = _opening_guardrail_hook(jd_text, guardrail_reason) or hook_clause
        return f"{subject}，{guarded_hook}，这块和我的视频/视觉作品经验只有部分交集；我能补充的是{skills_text}相关项目：{evidence_text}。{_opening_tail(skills_profile, '可展开讲AI工具落地和自动化实现')}"
    if score < 75 and guardrail_reason in {"primary_output_gap", "tool_gap"}:
        guarded_hook = _opening_guardrail_hook(jd_text, guardrail_reason) or hook_clause
        return f"{subject}，{guarded_hook}，这块和我的主项目方向不完全一致；我能先补充{skills_text}相关经验：{evidence_text}。{_opening_tail(skills_profile, '我可以说明能迁移的部分和经验边界')}"
    if score < 50:
        return f"{subject}，{hook_clause}，这块和我的经历只有部分交集；能先聊的是{skills_text}相关项目：{evidence_text}。{_opening_tail(skills_profile, '我可以补充项目细节')}"
    if score < 75:
        return f"{subject}，{hook_clause}，其中{skills_text}和我做过的项目能对上：{evidence_text}。{_opening_tail(skills_profile, '我可以直接讲实现细节')}"
    return f"{subject}，{hook_clause}，这和我做过的{skills_text}项目比较契合：{evidence_text}。{_opening_tail(skills_profile, '我可以直接讲实现取舍和部署过程')}"


def _local_match_report(jd_text: str, skills_profile: dict[str, Any]) -> dict[str, Any]:
    jd_analysis = _fallback_jd_analysis(jd_text)
    report = _model_dump(_fallback_report(jd_analysis, skills_profile))
    return _apply_score_guardrails(report, jd_text, skills_profile)


def _profile_excerpt_for_opening(skills_profile: dict[str, Any], limit: int = 12) -> dict[str, Any]:
    items: list[dict[str, str]] = []
    for item in _candidate_skill_items(skills_profile)[:limit]:
        items.append(
            {
                "skill": item["skill"],
                "level": item["level"],
                "evidence": _compact_evidence(item["evidence"], 120),
            }
        )
    return {
        "skills": items,
        "public_profiles": _string_list(skills_profile.get("public_profiles")) if isinstance(skills_profile, dict) else [],
        "target_profile": skills_profile.get("target_profile", {}) if isinstance(skills_profile, dict) else {},
    }


def _generate_opening_with_llm(
    report: dict[str, Any],
    skills_profile: dict[str, Any],
    jd_text: str,
    llm: Any | None,
    trace: dict[str, Any] | None = None,
) -> str:
    if llm is None or not _use_llm_opening():
        return ""
    fallback = _rule_opening(report, skills_profile, jd_text)
    target = _opening_target(report, jd_text)
    score = _coerce_score(report.get("match_score", 0))
    try:
        if trace is not None:
            trace["llm_opening_called"] = True
        data = _invoke_json(
            llm,
            OPENING_MESSAGE_PROMPT,
            json.dumps(
                {
                    "opening_target": target,
                    "match_score": score,
                    "risk_level": report.get("risk_level", ""),
                    "matched_skills": report.get("matched_skills", [])[:5],
                    "missing_skills": report.get("missing_skills", [])[:5],
                    "jd_excerpt": _opening_jd_excerpt(jd_text, 900),
                    "candidate_profile": _profile_excerpt_for_opening(skills_profile),
                },
                ensure_ascii=False,
            ),
        )
        if trace is not None:
            trace["llm_opening_result"] = data
        clean = _sanitize_opening_message(data.get("opening_message", ""), target, fallback, score, skills_profile)
        if score < 75 and _opening_guardrail_reason(report):
            cautious_words = ["部分交集", "不完全一致", "经验边界", "需要确认", "能迁移"]
            if not any(word in clean for word in cautious_words):
                return fallback
        return clean
    except Exception as exc:
        if trace is not None:
            trace["llm_opening_error"] = f"{type(exc).__name__}: {exc}"
        print(f"[opening] llm failed: {exc}")
        return ""


def _remove_unverified_public_proof(message: str) -> str:
    clean = re.sub(r"(?:相关代码和项目记录在\s*)?GitHub[:：]\s*[A-Za-z0-9][A-Za-z0-9-]{1,38}[，,。；;]*", "", message, flags=re.I)
    clean = re.sub(r"https?://(?:www\.)?github\.com/[^\s\"'，。；;()（）<>]+[，,。；;]*", "", clean, flags=re.I)
    return re.sub(r"\s+", " ", clean).strip(" ，。；;")


def _sanitize_opening_message(message: Any, target: str, fallback: str, score: int, skills_profile: dict[str, Any]) -> str:
    clean = re.sub(r"\s+", " ", str(message or "")).strip(" 「」\"'")
    if len(clean) < 20:
        return fallback

    empty_words = ["我热爱", "学习能力强", "希望给机会", "希望贵公司给机会", "快速学习", "我重点匹配", "高度匹配"]
    if any(empty_word in clean for empty_word in empty_words):
        return fallback
    clean = re.sub(r"招聘团队[，,。:：]*", "", clean).strip()
    clean = re.sub(r"您好[，,!！。]*", "", clean).strip()
    clean = clean.replace("JD 里强调", "岗位里提到").replace("JD强调", "岗位里提到")
    clean = clean.replace("证据是：", "我对应的经历是：").replace("证据是:", "我对应的经历是：")
    clean = re.sub(r"我是正在应聘[^。；;]{0,50}候选人[。；;]*", "", clean).strip()
    clean = re.sub(r"我对[^。；;]{0,50}感兴趣[，。；;!！]*", "", clean).strip()
    clean = re.sub(r"我对[^。；;]{0,50}有兴趣[，。；;!！]*", "", clean).strip()
    clean = re.sub(r"(期待|希望)[^。；;]{0,30}(交流|沟通)[。；;!！]*$", "", clean).strip()
    clean = re.sub(r"GitHub[（(]\s*([A-Za-z0-9][A-Za-z0-9-]{1,38})\s*[）)]", r"GitHub: \1", clean, flags=re.I)
    clean = re.sub(r"GitHub[:：]\s*([A-Za-z0-9][A-Za-z0-9-]{1,38})", r"GitHub: \1", clean, flags=re.I)
    clean = re.sub(r"(虽然|但是|同时|另外|此外)[。；;!！]*$", "", clean).strip()
    generic_patterns = [
        r"^(这个|该)?岗位(和|跟)我的技能(高度|非常)?匹配",
        r"^我会围绕(这个|该)?岗位要求说明已有项目证据",
        r"的这个岗位(和|跟)我的技能(高度|非常)?匹配",
    ]
    if any(re.search(pattern, clean) for pattern in generic_patterns):
        return fallback

    if score < 50:
        clean = clean.replace("高度匹配", "有部分工程交集").replace("非常匹配", "有部分交集")

    proof = _opening_public_proof(skills_profile)
    if proof:
        if proof not in clean:
            clean = clean.rstrip(" ，。；;") + f"。{proof}。"
    else:
        clean = _remove_unverified_public_proof(clean)

    if target and target != "这个岗位" and not clean.startswith(target):
        clean = f"{target}的这个岗位，{clean}"

    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) > 180:
        if proof and proof in clean:
            prefix = clean.split(proof, 1)[0]
            clean = prefix[:155].rstrip(" ，。；;") + f"。{proof}。"
        else:
            clean = clean[:170].rstrip(" ，。；;") + "。"
    return clean if len(clean) >= 20 else fallback


def generate_opening(report: dict[str, Any], skills_profile: dict[str, Any], jd_text: str = "") -> str:
    fallback = _rule_opening(report, skills_profile, jd_text)
    target = _opening_target(report, jd_text)
    score = _coerce_score(report.get("match_score", 0))
    model_opening = report.get("opening_message", "")
    if model_opening:
        return _sanitize_opening_message(model_opening, target, fallback, score, skills_profile)
    return fallback


CHAT_REPLY_POLICY_VERSION = "2026-08-02-rag-ready-v2"

CHAT_REPLY_INTENT_LABELS = {
    "ask_resume": "索要简历/作品材料",
    "ask_availability": "可沟通/可到岗/时间可用性",
    "ask_project": "项目或经历确认",
    "interview_question": "面试题/技术追问",
    "schedule_interview": "面试邀约排期",
    "salary": "薪资/待遇确认",
    "location": "地点/远程/驻场确认",
    "unknown": "未识别意图",
}

CHAT_REPLY_LLM_PROMPT = """你是求职聊天回复草稿助手。你只能基于输入中的 evidence 生成短草稿。
只输出 JSON object，不要 Markdown，不要解释：
{"draft": "给 HR 的一句短回复"}

规则：
- 不超过 90 字。
- 只使用 evidence 里的证据，不要编造项目、指标、经历、薪资、到岗时间、远程/驻场接受条件。
- 面试题只做简短承接，说明可以在面试中围绕背景、实现、结果和边界展开，不输出完整长答案。
- 不承诺薪资、到岗、远程、报价、交付，不替用户做决定。"""

_CHAT_REPLY_PROJECT_INTENTS = {"ask_project", "interview_question"}
_CHAT_REPLY_FILLABLE_FAST_INTENTS = {"ask_resume", "ask_availability", "schedule_interview"}
_CHAT_REPLY_CANDIDATE_ROLES = {"me", "user", "candidate"}
_CHAT_REPLY_HUMAN_ROLES = {"hr", *_CHAT_REPLY_CANDIDATE_ROLES}
_CHAT_REPLY_DO_NOT_REPLY_TERMS = ["身份证", "银行卡", "验证码", "密码", "户口", "婚育", "结婚", "生育", "征信", "政治面貌"]
_CHAT_REPLY_ONBOARDING_TERMS = ["到岗", "入职时间", "什么时候入职", "最快入职", "可入职", "入职日期", "离职了吗", "离职状态"]
_CHAT_REPLY_LOCATION_RISK_TERMS = ["远程", "居家", "remote", "驻场", "外包", "派遣", "出差", "坐班", "大小周", "单双休", "搬到", "能来"]
_CHAT_REPLY_QUOTE_TERMS = ["报价", "报个价", "预算", "单价", "时薪", "日薪", "外包价", "项目费用", "交付"]
_CHAT_REPLY_TECH_TERMS = [
    "rag",
    "agent",
    "llm",
    "langgraph",
    "langchain",
    "fastapi",
    "faiss",
    "python",
    "deepseek",
    "api",
    "检索",
    "召回",
    "重排",
    "向量",
    "知识库",
    "智能体",
    "大模型",
    "项目",
    "经历",
    "经验",
    "技术",
    "架构",
    "部署",
    "评测",
    "指标",
    "优化",
    "工程",
]


def build_chat_reply_draft(
    hr_message: str = "",
    conversation: list[dict[str, Any]] | None = None,
    job_title: str = "",
    company: str = "",
    jd_text: str = "",
    resume_text: str = "",
    resume_profile: dict[str, Any] | None = None,
    evidence_context: str = "",
    evidence_sources: list[str] | None = None,
    *,
    latest_hr_message: str = "",
    chat_history: list[dict[str, Any]] | None = None,
    llm: Any | None = None,
    llm_timeout_seconds: float = 4.0,
) -> dict[str, Any]:
    """Classify the HR message and return a RAG-ready, human-reviewed reply draft."""
    started = time.perf_counter()
    latest = _normalize_chat_reply_text(hr_message or latest_hr_message)
    if not latest:
        raise ValueError("hr_message 不能为空")

    history = _normalize_chat_history(conversation if conversation is not None else chat_history)
    last_human_role = _last_effective_human_message_role(history)
    if last_human_role in _CHAT_REPLY_CANDIDATE_ROLES:
        intent_info = classify_hr_reply_intent(latest, [])
        return _chat_reply_no_action_result(intent_info, last_human_role, started)

    sources = _normalize_evidence_sources(evidence_sources)
    intent_info = classify_hr_reply_intent(latest, history)
    intent = str(intent_info["intent"])
    base_reason = str(intent_info.get("reason") or "")

    if intent in _CHAT_REPLY_PROJECT_INTENTS:
        result = _build_project_chat_reply(
            intent=intent,
            hr_message=latest,
            job_title=job_title,
            company=company,
            jd_text=jd_text,
            resume_text=resume_text,
            resume_profile=resume_profile or {},
            evidence_context=evidence_context,
            evidence_sources=sources,
            base_reason=base_reason,
            llm=llm,
            llm_timeout_seconds=llm_timeout_seconds,
            started=started,
        )
    else:
        result = _build_fast_chat_reply(intent, latest, intent_info, job_title=job_title, company=company)

    if result.get("draft") and _chat_reply_draft_has_banned_commitment(str(result.get("draft") or "")):
        result.update(
            {
                "risk_level": "high",
                "should_fill": False,
                "action_policy": "ask_user",
                "reply_mode": "fallback",
                "draft": "",
                "reason": "草稿触发薪资、到岗、远程、报价或交付承诺护栏，已改为人工确认。",
            }
        )

    result.setdefault("intent", intent)
    result.setdefault("evidence_relation", "none")
    result.setdefault("evidence", [])
    result.setdefault("missing_evidence", [])
    result.setdefault("risk_level", "medium")
    result.setdefault("should_fill", False)
    result.setdefault("action_policy", "ask_user")
    result.setdefault("reply_mode", "fallback")
    result.setdefault("draft", "")
    result.setdefault("reason", base_reason)
    result["duration_ms"] = int((time.perf_counter() - started) * 1000)
    result["policy_version"] = CHAT_REPLY_POLICY_VERSION
    return result


def classify_hr_reply_intent(
    hr_message: str,
    conversation: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    latest = _normalize_chat_reply_text(hr_message)
    if not latest:
        raise ValueError("hr_message 不能为空")
    context = _chat_reply_context_text(latest, conversation)

    if _contains_any(latest, _CHAT_REPLY_DO_NOT_REPLY_TERMS):
        return _chat_intent("unknown", 0.92, "涉及敏感个人信息，默认不生成回复。", risk_level="high", action_policy="do_not_reply")
    if _contains_any(latest, ["期望薪资", "薪资期望", "薪资要求", "薪资", "薪酬", "薪水", "工资", "待遇", "到手", "多少钱"]):
        return _chat_intent("salary", 0.9, "涉及薪资或待遇，不能替用户承诺薪资范围或接受条件。", risk_level="high")
    if _contains_any(latest, _CHAT_REPLY_QUOTE_TERMS):
        return _chat_intent("salary", 0.86, "涉及报价、预算或交付条件，不能替用户报价或承诺交付。", risk_level="high")
    if _contains_any(latest, _CHAT_REPLY_ONBOARDING_TERMS):
        return _chat_intent("ask_availability", 0.88, "涉及到岗或入职时间，需要用户按真实安排手动确认。", risk_level="high")
    if _contains_any(latest, _CHAT_REPLY_LOCATION_RISK_TERMS) or re.search(r"(base|地点|城市).{0,12}(哪里|哪|接受|可以|方便|能)", latest, flags=re.I):
        return _chat_intent("location", 0.82, "涉及地点、远程、驻场或工作制边界，不能替用户做决定。", risk_level="high")

    if _is_interview_question_request(latest):
        return _chat_intent("interview_question", 0.88, "HR 在追问技术、项目细节或面试题，只能基于证据生成简短承接。", risk_level="medium")
    if _is_project_experience_request(context):
        return _chat_intent("ask_project", 0.78, "HR 在确认项目、技术或经历，需要先检查 JD、简历和外部证据。", risk_level="medium")
    if _contains_any(latest, ["面试", "电话面", "视频面", "线下面", "约个时间", "约时间", "约一下", "初面", "复试", "一面", "二面"]):
        return _chat_intent("schedule_interview", 0.84, "HR 正在沟通面试安排，可用快速模板请求可选时间和形式。", risk_level="low")
    if _contains_any(latest, ["简历", "附件", "作品集", "作品链接", "项目链接", "github", "gitee", "博客", "pdf"]):
        return _chat_intent("ask_resume", 0.78, "HR 在索要简历或作品材料，可用短模板承接，但仍需用户确认附件或链接。", risk_level="low")
    if _contains_any(latest, ["在吗", "在线吗", "方便聊", "方便沟通", "现在方便", "有时间聊", "可以聊", "电话沟通", "还在找", "还看机会", "感兴趣吗", "考虑吗"]):
        return _chat_intent("ask_availability", 0.76, "HR 在确认是否方便沟通或是否还看机会，可用快速模板承接。", risk_level="low")

    return _chat_intent("unknown", 0.45, "未识别为安全可自动填入的场景，建议人工确认。", risk_level="medium")


def _chat_intent(
    intent: str,
    confidence: float,
    reason: str,
    *,
    risk_level: str = "medium",
    action_policy: str = "ask_user",
) -> dict[str, Any]:
    return {
        "intent": intent,
        "confidence": round(max(0.0, min(1.0, confidence)), 2),
        "risk_level": risk_level if risk_level in {"low", "medium", "high"} else "medium",
        "action_policy": action_policy if action_policy in {"fill_draft", "ask_user", "do_not_reply", "no_action"} else "ask_user",
        "reason": reason,
    }


def _chat_reply_no_action_result(intent_info: dict[str, Any], last_human_role: str, started: float) -> dict[str, Any]:
    role_label = {
        "me": "me",
        "user": "user",
        "candidate": "candidate",
    }.get(last_human_role, last_human_role)
    return {
        "intent": str(intent_info.get("intent") or "unknown"),
        "evidence_relation": "none",
        "evidence": [],
        "missing_evidence": [],
        "risk_level": "low",
        "should_fill": False,
        "action_policy": "no_action",
        "reply_mode": "fast_template",
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "draft": "",
        "reason": f"用户已回复，避免重复回复；最后一条有效人类消息角色是 {role_label}。",
        "confidence": intent_info.get("confidence", 0.5),
        "policy_version": CHAT_REPLY_POLICY_VERSION,
    }


def _build_fast_chat_reply(
    intent: str,
    hr_message: str,
    intent_info: dict[str, Any],
    *,
    job_title: str = "",
    company: str = "",
) -> dict[str, Any]:
    risk_level = str(intent_info.get("risk_level") or "medium")
    action_policy = str(intent_info.get("action_policy") or "ask_user")
    draft = _chat_reply_template(intent, hr_message=hr_message, job_title=job_title, company=company)

    if intent in _CHAT_REPLY_FILLABLE_FAST_INTENTS and risk_level == "low" and draft:
        should_fill = True
        action_policy = "fill_draft"
        reply_mode = "fast_template"
    elif action_policy == "do_not_reply":
        should_fill = False
        draft = ""
        reply_mode = "fallback"
    else:
        should_fill = False
        reply_mode = "fallback"

    return {
        "intent": intent,
        "evidence_relation": "none",
        "evidence": [],
        "missing_evidence": _missing_evidence_for_fast_intent(intent, risk_level),
        "risk_level": risk_level,
        "should_fill": should_fill,
        "action_policy": action_policy,
        "reply_mode": reply_mode,
        "draft": draft,
        "reason": str(intent_info.get("reason") or ""),
        "confidence": intent_info.get("confidence", 0.5),
    }


def _build_project_chat_reply(
    *,
    intent: str,
    hr_message: str,
    job_title: str = "",
    company: str = "",
    jd_text: str = "",
    resume_text: str = "",
    resume_profile: dict[str, Any] | None = None,
    evidence_context: str = "",
    evidence_sources: list[str] | None = None,
    base_reason: str = "",
    llm: Any | None = None,
    llm_timeout_seconds: float = 4.0,
    started: float = 0.0,
) -> dict[str, Any]:
    evidence_bundle = _collect_chat_reply_evidence(
        hr_message=hr_message,
        jd_text=jd_text,
        resume_text=resume_text,
        resume_profile=resume_profile or {},
        evidence_context=evidence_context,
        evidence_sources=evidence_sources or [],
    )
    relation = str(evidence_bundle["relation"])
    evidence = list(evidence_bundle["evidence"])
    missing = list(evidence_bundle["missing_evidence"])

    if relation == "none":
        return {
            "intent": intent,
            "evidence_relation": relation,
            "evidence": [],
            "missing_evidence": missing,
            "risk_level": "high",
            "should_fill": False,
            "action_policy": "ask_user",
            "reply_mode": "fallback",
            "draft": "这个问题需要结合我的真实项目细节确认后回复。",
            "reason": "JD、简历和外部证据都不足，不能编造项目或技术细节。",
        }

    if relation == "jd_only":
        return {
            "intent": intent,
            "evidence_relation": relation,
            "evidence": evidence,
            "missing_evidence": missing,
            "risk_level": "medium",
            "should_fill": False,
            "action_policy": "ask_user",
            "reply_mode": "fallback",
            "draft": "这点我需要结合自己的真实项目经历再确认后回复。",
            "reason": "JD 有相关要求，但简历和外部证据不足，不能把 JD 要求当成候选人经历。",
        }

    draft = _local_evidence_chat_reply(intent, hr_message, evidence, relation, job_title=job_title, company=company)
    reply_mode = "rag_llm"
    reason = _evidence_reply_reason(relation, base_reason)

    if _use_chat_reply_llm() and llm is not False:
        remaining = max(0.1, min(float(llm_timeout_seconds), 4.0) - (time.perf_counter() - started))
        try:
            active_llm = llm if llm is not None else make_chat_model(json_mode=True, timeout=remaining, max_retries=0)
            llm_draft = _generate_chat_reply_with_llm(
                active_llm,
                intent=intent,
                hr_message=hr_message,
                job_title=job_title,
                company=company,
                evidence=evidence,
                timeout_seconds=remaining,
            )
            if llm_draft:
                draft = llm_draft
        except Exception:
            reply_mode = "fallback"
            draft = _local_evidence_chat_reply(intent, hr_message, evidence, relation, job_title=job_title, company=company)
            reason = reason + " LLM 生成失败或超时，已使用本地证据模板兜底。"

    return {
        "intent": intent,
        "evidence_relation": relation,
        "evidence": evidence,
        "missing_evidence": missing,
        "risk_level": "medium",
        "should_fill": True,
        "action_policy": "fill_draft",
        "reply_mode": reply_mode,
        "draft": draft,
        "reason": reason,
    }


def _collect_chat_reply_evidence(
    *,
    hr_message: str,
    jd_text: str = "",
    resume_text: str = "",
    resume_profile: dict[str, Any] | None = None,
    evidence_context: str = "",
    evidence_sources: list[str] | None = None,
) -> dict[str, Any]:
    keywords = _chat_reply_keywords(hr_message)
    jd_has_context = bool(_normalize_chat_reply_text(jd_text))
    jd_evidence = _evidence_from_text(jd_text, "jd_text", keywords, relation="jd", limit=2)
    resume_evidence = _evidence_from_resume(resume_text, resume_profile or {}, keywords, limit=3)
    rag_evidence = _evidence_from_text(
        evidence_context,
        _primary_evidence_source(evidence_sources),
        keywords,
        relation="rag",
        limit=3,
    )

    if rag_evidence:
        relation = "rag_supported"
        evidence = (jd_evidence[:1] if jd_evidence else []) + rag_evidence[:3] + resume_evidence[:1]
    elif jd_has_context and resume_evidence:
        relation = "jd_and_resume"
        evidence = (jd_evidence[:1] if jd_evidence else []) + resume_evidence[:3]
    elif jd_has_context:
        relation = "jd_only"
        evidence = jd_evidence[:2] if jd_evidence else [{"source": "jd_text", "relation": "jd", "text": _compact_evidence(jd_text, 120)}]
    elif resume_evidence:
        relation = "resume_only"
        evidence = resume_evidence[:3]
    else:
        relation = "none"
        evidence = []

    missing: list[str] = []
    if not jd_has_context:
        missing.append("岗位 JD 要求")
    if relation in {"jd_only", "none"}:
        missing.append("简历或项目知识库中的可验证经历证据")
    if relation == "none":
        missing.append("可用于简短回复的项目/技术事实")
    return {
        "relation": relation,
        "evidence": _dedupe_evidence(evidence)[:5],
        "missing_evidence": _dedupe_strings(missing),
    }


def _generate_chat_reply_with_llm(
    llm: Any,
    *,
    intent: str,
    hr_message: str,
    job_title: str = "",
    company: str = "",
    evidence: list[dict[str, str]] | None = None,
    timeout_seconds: float = 4.0,
) -> str:
    _ = timeout_seconds
    data = _invoke_json(
        llm,
        CHAT_REPLY_LLM_PROMPT,
        json.dumps(
            {
                "intent": intent,
                "hr_message": hr_message,
                "job_title": job_title,
                "company": company,
                "evidence": evidence or [],
            },
            ensure_ascii=False,
        ),
    )
    draft = _sanitize_chat_reply_draft(data.get("draft", ""), max_chars=100)
    return draft if draft and not _chat_reply_draft_has_banned_commitment(draft) else ""


def _use_chat_reply_llm() -> bool:
    value = _env_value("JOB_ACCELERATOR_CHAT_REPLY_LLM", "CHAT_REPLY_LLM").lower()
    return value in {"1", "true", "yes", "on"}


def _local_evidence_chat_reply(
    intent: str,
    hr_message: str,
    evidence: list[dict[str, str]],
    relation: str,
    *,
    job_title: str = "",
    company: str = "",
) -> str:
    _ = (hr_message, relation, job_title, company)
    phrase = _chat_evidence_phrase(evidence)
    if intent == "interview_question":
        if phrase:
            return _sanitize_chat_reply_draft(f"这个问题我可以结合{phrase}在面试中展开讲，先从背景、实现路径、结果和边界四部分说明。", max_chars=110)
        return "这个问题我需要结合真实项目细节确认后回复。"
    if phrase:
        return _sanitize_chat_reply_draft(f"这块我有相关项目经验，可以结合{phrase}简要说明，具体实现和取舍我可以在面试中展开。", max_chars=110)
    return "这块我需要结合自己的真实项目经历再确认后回复。"


def _evidence_reply_reason(relation: str, base_reason: str) -> str:
    prefix = base_reason.rstrip("。")
    relation_reasons = {
        "rag_supported": "已使用请求体传入的 evidence_context/evidence_sources 作为 RAG-ready 外部证据；当前不接真实 RAG 检索。",
        "jd_and_resume": "JD 和简历画像/简历文本都有相关证据，可以生成短草稿。",
        "resume_only": "JD 未提供相关要求，但简历或项目证据可支持简短回复。",
    }
    detail = relation_reasons.get(relation, "已按本地证据护栏生成回复。")
    return f"{prefix}。{detail}" if prefix else detail


def _chat_reply_template(
    intent: str,
    *,
    hr_message: str = "",
    job_title: str = "",
    company: str = "",
) -> str:
    _ = (hr_message, job_title, company)
    templates = {
        "ask_resume": "您好，可以的。我确认合适的简历版本和材料后发您。",
        "ask_availability": "您好，在的，可以先文字沟通。您这边想先确认哪部分信息？",
        "schedule_interview": "您好，可以沟通。麻烦您发一下可选时间段、面试形式和预计时长，我确认后回复您。",
        "salary": "",
        "location": "",
        "unknown": "",
    }
    return _sanitize_chat_reply_draft(templates.get(intent, ""))


def _missing_evidence_for_fast_intent(intent: str, risk_level: str) -> list[str]:
    if risk_level == "high":
        if intent == "salary":
            return ["用户确认后的薪资范围/底线", "岗位薪资结构"]
        if intent == "location":
            return ["用户确认后的城市、通勤、远程或驻场边界"]
        if intent == "ask_availability":
            return ["用户确认后的到岗/入职安排"]
        return ["用户人工确认"]
    if intent == "ask_resume":
        return ["用户确认后的简历版本或作品链接"]
    return []


def _normalize_chat_reply_text(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip(" 「」\"'")


def _normalize_chat_history(conversation: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for item in conversation or []:
        if not isinstance(item, dict):
            continue
        role = _normalize_chat_role(item.get("role"))
        content = _normalize_chat_reply_text(item.get("content"))
        if not content:
            continue
        history.append({"role": role, "content": content})
    return history[-20:]


def _normalize_chat_role(role: Any) -> str:
    value = str(role or "other").strip().lower()
    if value in {"hr", "recruiter", "boss", "interviewer", "company"}:
        return "hr"
    if value in {"me", "myself", "self"}:
        return "me"
    if value in {"user"}:
        return "user"
    if value in {"candidate", "applicant", "jobseeker", "job_seeker"}:
        return "candidate"
    if value == "system":
        return "system"
    return "other"


def _last_effective_human_message_role(history: list[dict[str, str]]) -> str:
    for item in reversed(history):
        role = str(item.get("role") or "other")
        if role in _CHAT_REPLY_HUMAN_ROLES:
            return role
    return ""


def _normalize_evidence_sources(evidence_sources: list[str] | None) -> list[str]:
    sources: list[str] = []
    for item in evidence_sources or []:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if text and text not in sources:
            sources.append(text[:80])
    return sources[:10]


def _primary_evidence_source(evidence_sources: list[str] | None) -> str:
    sources = _normalize_evidence_sources(evidence_sources)
    return sources[0] if sources else "evidence_context"


def _chat_reply_context_text(latest: str, conversation: list[dict[str, Any]] | None = None) -> str:
    parts = [latest]
    for item in _normalize_chat_history(conversation)[-5:]:
        parts.append(str(item.get("content") or ""))
    return " ".join(parts)


def _is_interview_question_request(text: str) -> bool:
    clean = _normalize_chat_reply_text(text)
    if not clean:
        return False
    assignment_terms = ["笔试题", "测试题", "作业", "命题", "完整方案", "代码题", "写一段代码", "给一份方案"]
    if _contains_any(clean, assignment_terms):
        return True
    if _contains_any(clean, ["详细讲", "详细说", "详细介绍", "介绍一下自己", "自我介绍"]):
        return True
    if _contains_any(clean, ["讲讲", "讲一下", "说说", "说一下", "介绍一下", "介绍下"]) and _contains_any(clean, ["项目", "经历", "经验", "技术", "方案", "架构", "rag", "agent", "工具调用", "召回"]):
        return True
    question_marks = clean.count("?") + clean.count("？")
    if question_marks >= 2 and _contains_any(clean, ["项目", "技术", "实现", "方案", "经验", "为什么", "怎么", "原理"]):
        return True
    if _contains_any(clean, ["怎么做", "怎么处理", "如何处理"]) and _contains_any(clean, ["项目", "技术", "实现", "方案", "经验", "rag", "agent", "工具调用", "召回", "优化"]):
        return True
    if len(clean) >= 48 and _contains_any(clean, ["如何实现", "怎么实现", "怎么处理", "系统设计", "架构", "原理", "源码", "难点", "亮点", "优化", "算法", "设计一个"]):
        return True
    return False


def _is_project_experience_request(text: str) -> bool:
    clean = _normalize_chat_reply_text(text)
    if not clean:
        return False
    project_terms = ["项目", "经历", "经验", "做过", "熟悉", "会不会", "用过", "技术栈", "作品", "案例"]
    tech_terms = [term for term in _CHAT_REPLY_TECH_TERMS if term not in {"项目", "经历", "经验", "技术"}]
    return _contains_any(clean, project_terms) and _contains_any(clean, tech_terms)


def _chat_reply_keywords(text: str) -> list[str]:
    lower = _normalize_chat_reply_text(text).lower()
    keywords: list[str] = []
    for term in _CHAT_REPLY_TECH_TERMS:
        if term.lower() in lower:
            keywords.append(term)
    for token in re.findall(r"[A-Za-z][A-Za-z0-9+#.-]{1,30}", text):
        normalized = token.strip()
        if normalized and normalized.lower() not in {item.lower() for item in keywords}:
            keywords.append(normalized)
    return keywords[:12] or ["项目", "经验", "技术"]


def _evidence_from_text(
    text: str,
    source: str,
    keywords: list[str],
    *,
    relation: str,
    limit: int = 2,
) -> list[dict[str, str]]:
    clean_text = str(text or "").strip()
    if not clean_text:
        return []
    chunks = _split_evidence_chunks(clean_text)
    picked: list[dict[str, str]] = []
    for chunk in chunks:
        if _contains_any(chunk, keywords):
            picked.append({"source": source, "relation": relation, "text": _compact_evidence(chunk, 140)})
        if len(picked) >= limit:
            break
    if not picked and chunks and relation == "rag":
        picked.append({"source": source, "relation": relation, "text": _compact_evidence(chunks[0], 140)})
    return picked[:limit]


def _evidence_from_resume(
    resume_text: str,
    resume_profile: dict[str, Any],
    keywords: list[str],
    *,
    limit: int = 3,
) -> list[dict[str, str]]:
    evidence: list[dict[str, str]] = []
    if isinstance(resume_profile, dict) and resume_profile:
        skills = resume_profile.get("skills", {}) if isinstance(resume_profile.get("skills"), dict) else {}
        groups = [skills.get("must_have") or [], skills.get("familiar") or [], resume_profile.get("projects") or []]
        for group in groups:
            for item in group:
                if not isinstance(item, dict):
                    continue
                text = " ".join(
                    str(item.get(key) or "")
                    for key in ["skill", "name", "level", "evidence", "description", "project"]
                )
                keywords_text = " ".join(str(value) for value in item.get("keywords", []) or [])
                text = f"{text} {keywords_text}".strip()
                if text and _contains_any(text, keywords):
                    evidence.append({"source": "resume_profile", "relation": "resume", "text": _compact_evidence(text, 140)})
                if len(evidence) >= limit:
                    return evidence
    evidence.extend(_evidence_from_text(resume_text, "resume_text", keywords, relation="resume", limit=limit - len(evidence)))
    return evidence[:limit]


def _split_evidence_chunks(text: str) -> list[str]:
    normalized = str(text or "").replace("\r", "\n")
    chunks: list[str] = []
    for line in normalized.splitlines():
        clean = re.sub(r"\s+", " ", line).strip(" -#*，。；;")
        if not clean:
            continue
        if len(clean) <= 180:
            chunks.append(clean)
            continue
        parts = [part.strip(" ，。；;") for part in re.split(r"[。；;]", clean) if part.strip(" ，。；;")]
        chunks.extend(parts or [clean[:180]])
    return chunks[:50]


def _chat_evidence_phrase(evidence: list[dict[str, str]]) -> str:
    for item in evidence:
        if not isinstance(item, dict):
            continue
        if item.get("relation") == "jd":
            continue
        text = _compact_evidence(str(item.get("text") or ""), 52)
        if text:
            return f"“{text}”"
    if evidence:
        text = _compact_evidence(str(evidence[0].get("text") or ""), 52)
        if text:
            return f"“{text}”"
    return ""


def _sanitize_chat_reply_draft(message: Any, max_chars: int = 120) -> str:
    clean = _normalize_chat_reply_text(message)
    clean = re.sub(r"[。！？!?]{2,}", "。", clean)
    clean = re.sub(r"^(当然可以|没问题)[，,。！!]*", "", clean).strip()
    if len(clean) > max_chars:
        clean = clean[: max_chars - 1].rstrip(" ，。；;") + "。"
    return clean


def _chat_reply_draft_has_banned_commitment(message: str) -> bool:
    clean = _normalize_chat_reply_text(message)
    banned_patterns = [
        r"(期望薪资|薪资期望|薪资要求|最低薪资|薪资).{0,24}(可以|接受|没问题|确定|不低于|以上)",
        r"(可以|能|最快|确定).{0,20}(到岗|入职)",
        r"(接受|可以|能).{0,12}(远程|居家|驻场|外包|派遣|出差|大小周|单双休)",
        r"(报价|预算|单价|时薪|日薪).{0,24}(可以|接受|确定|没问题)",
        r"(可以|能够|保证|承诺).{0,18}(交付|上线|完成|入职|到岗)",
    ]
    return any(re.search(pattern, clean, flags=re.I) for pattern in banned_patterns)


def _dedupe_evidence(evidence: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for item in evidence:
        text = _compact_evidence(str(item.get("text") or ""), 160)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(
            {
                "source": str(item.get("source") or "unknown")[:80],
                "relation": str(item.get("relation") or "unknown")[:40],
                "text": text,
            }
        )
    return result


def _dedupe_strings(values: list[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def resume_profile_from_text(resume_text: str, llm: Any | None = None) -> dict[str, Any]:
    """Extract a reusable skills profile from resume text."""
    resume_text = (resume_text or "").strip()
    if not resume_text:
        raise ValueError("resume_text 不能为空")
    active_llm = None if llm is False else (llm if llm is not None else _make_llm())
    resume_llm = active_llm if _use_llm_resume_extractor() else None
    profile = _get_resume_skills_profile(resume_text, resume_llm)
    if not profile:
        raise ValueError("没有从简历中提取到有效技能")
    return profile


def match_jd(
    jd_text: str,
    resume_text: str = "",
    skills_profile: dict[str, Any] | None = None,
    skills_path: str | Path | None = None,
    llm: Any | None = None,
    llm_opening: bool | None = None,
    include_trace: bool = False,
) -> dict[str, Any]:
    """运行 JD拆解员 -> 技能匹配员，并返回 MatchReport 字典。"""
    jd_text = (jd_text or "").strip()
    if not jd_text:
        raise ValueError("jd_text 不能为空")
    profile = skills_profile or load_skills_profile(skills_path)
    active_llm = None if llm is False else (llm if llm is not None else _make_llm())
    trace: dict[str, Any] = {
        "llm_available": active_llm is not None,
        "llm_matcher_called": False,
        "llm_opening_called": False,
        "llm_resume_extractor_allowed": False,
        "llm_resume_extractor_called": False,
        "llm_min_score": _llm_min_score(),
    }
    resume_text = (resume_text or "").strip()
    if resume_text:
        try:
            resume_llm = active_llm if _use_llm_resume_extractor() else None
            trace["llm_resume_extractor_allowed"] = _use_llm_resume_extractor()
            trace["llm_resume_extractor_called"] = resume_llm is not None
            resume_profile = _get_resume_skills_profile(resume_text, resume_llm)
            if resume_profile:
                profile = resume_profile
        except Exception:
            trace["resume_profile_error"] = "resume profile extraction failed"

    report = _local_match_report(jd_text, profile)
    local_score = _coerce_score(report.get("match_score", 0))
    should_call_llm = active_llm is not None and local_score >= _llm_min_score()
    trace["local_score"] = local_score
    trace["should_call_llm"] = should_call_llm
    trace["jd_skills"] = summarize_jd_skills(jd_text)
    trace["resume_skills"] = summarize_resume_skills(skills_profile=profile)

    if should_call_llm and _use_llm_matcher():
        trace["llm_matcher_called"] = True
        graph = build_match_graph(active_llm, use_llm_jd_decomposer=_use_llm_jd_decomposer())
        state = graph.invoke({"jd_text": jd_text, "skills_profile": profile})
        report = _model_dump(_model_validate(MatchReport, state["report"]))  # type: ignore[arg-type]
        report = _apply_score_guardrails(report, jd_text, profile)
        trace["llm_matcher_result"] = report

    use_llm_opening = _use_llm_opening() if llm_opening is None else bool(llm_opening)
    if should_call_llm and use_llm_opening:
        opening_message = _generate_opening_with_llm(report, profile, jd_text, active_llm, trace=trace)
        report["opening_message"] = opening_message or generate_opening(report, profile, jd_text)
    else:
        if active_llm is not None:
            suggestions = list(report.get("suggestions") or [])
            if should_call_llm and not use_llm_opening:
                suggestions.insert(0, "海投模式优先保证速度，未调用 LLM 生成开场白。")
            else:
                suggestions.insert(0, f"本地快筛低于 {_llm_min_score()} 分，未调用 LLM 生成开场白。")
            report["suggestions"] = suggestions[:5]
        report["opening_message"] = generate_opening(report, profile, jd_text)
    if include_trace:
        report["_trace"] = trace
    return report



def _skills_list_to_profile(skills: list[str]) -> dict[str, Any]:
    profile = {
        "name": "候选人",
        "role": "",
        "skills": {
            "must_have": [{"skill": skill, "level": "掌握", "evidence": skill} for skill in skills],
            "familiar": [],
        },
        "weaknesses": [],
        "projects": [],
    }
    profile["target_profile"] = _infer_target_profile(profile)
    return profile


def filter_and_match(jobs: list[dict], skills: list[str], llm: Any | None = None) -> list[dict]:
    """兼容旧版 Streamlit：逐条 JD 调新流水线并转换旧字段名。"""
    profile = _skills_list_to_profile(skills)
    results = []
    for job in jobs:
        jd_text = job.get("jd_text", "")
        if not jd_text:
            continue
        report = match_jd(jd_text, skills_profile=profile, llm=llm)
        results.append(
            {
                **job,
                "score": report["match_score"],
                "strengths": [item["match_reason"] for item in report["matched_skills"]],
                "weaknesses": [f"{item['skill']}：{item['advice']}" for item in report["missing_skills"]],
                "brief": f"{report['role']}匹配度 {report['match_score']}%，风险{report['risk_level']}",
                "jd_parsed": report["role"],
                "interview_questions": report["interview_questions"],
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results


def generate_interview_prep(results: list[dict], skills: list[str], llm: Any | None = None) -> list[dict]:
    """兼容旧版入口：新报告已包含面试题，这里只补旧 UI 需要的字段。"""
    for item in results:
        item.setdefault("interview_questions", [])
        item.setdefault("company_background", "")
        item.setdefault("opening_line", "")
    return results
