"""求职加速器 2.0 · LangGraph 双 Agent 匹配流水线。

Agent 1: JD拆解员，提取岗位、必备技能、加分项和软技能。
Agent 2: 技能匹配员，对照 skills.json 生成结构化匹配报告。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Literal, TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field


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
  "interview_questions": ["围绕JD和候选人项目最可能被问的问题"]
}

评分规则：
- 0-100 的整数分。
- 必备要求权重最高；加分项其次；软技能只做小幅修正。
- risk_level 只能是“低”“中”“高”：75分及以上低，50-74中，50以下高。
- matched_skills 必须引用候选人 skills.json 中的 level/evidence/project。
- missing_skills 不要扩大缺口，只列 JD 关心但候选人证据不足的点。"""


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
  ]
}

规则：
- must_have 放简历中证据明确、能作为核心竞争力的技能。
- familiar 放有接触但证据较弱或熟悉程度较浅的技能。
- projects 放能支撑技能判断的项目证据。
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
}


FALLBACK_SKILL_RULES: list[tuple[str, list[str], str]] = [
    ("Python", ["python"], "required"),
    ("FastAPI", ["fastapi"], "required"),
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
]


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


def _make_llm() -> Any | None:
    try:
        from dotenv import load_dotenv

        load_dotenv(Path(__file__).with_name(".env"))
    except Exception:
        pass

    api_key = os.getenv("DEEPSEEK_API_KEY")
    print(f"[llm] DEEPSEEK_API_KEY={api_key[:4]}...{api_key[-4:]}" if api_key else "[llm] DEEPSEEK_API_KEY=<empty>")
    if not api_key:
        return None

    proxy = os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or ""

    model = ChatOpenAI(
        model=os.getenv("DEEPSEEK_MODEL") or os.getenv("MODEL_NAME", "deepseek-v4-pro"),
        api_key=api_key,
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        temperature=0,
        timeout=float(os.getenv("JOB_ACCELERATOR_LLM_TIMEOUT", "45")),
        openai_proxy=proxy if proxy else None,
    )
    return _bind_json_mode(model)


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


def _normalize_resume_profile(data: dict[str, Any]) -> dict[str, Any]:
    must_have = _resume_items(data, "must_have")
    familiar = _resume_items(data, "familiar")
    projects = [_resume_project(item) for item in _resume_items(data, "projects")]
    return {
        "name": str(data.get("name") or "简历候选人"),
        "role": str(data.get("role") or ""),
        "skills": {
            "must_have": must_have,
            "familiar": familiar,
        },
        "weaknesses": [],
        "projects": projects,
    }


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
    }
    return profile if _candidate_skill_items(profile) else None


def _extract_resume_skills_profile(resume_text: str, llm: Any | None) -> dict[str, Any] | None:
    extract_text = _resume_extract_text(resume_text)
    profile: dict[str, Any] | None = None

    if llm is not None:
        for _attempt in range(3):
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
    return any(mark in window for mark in ["优先", "加分", "更好", "熟悉者"])


def _fallback_jd_analysis(jd_text: str) -> JDAnalysis:
    lower = jd_text.lower()
    required: list[JDRequirement] = []
    preferred: list[JDRequirement] = []
    seen: set[str] = set()

    for skill, aliases, default_priority in FALLBACK_SKILL_RULES:
        hit_alias = next((alias for alias in aliases if alias.lower() in lower), None)
        if not hit_alias or skill in seen:
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


def build_match_graph(llm: Any | None = None) -> Any:
    llm = _bind_json_mode(llm)

    def jd_decomposer_agent(state: MatchState) -> dict[str, Any]:
        jd_text = state["jd_text"]
        if llm is not None:
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


def _opening_target(report: dict[str, Any], jd_text: str = "") -> str:
    for line in jd_text.splitlines():
        clean = line.strip()
        if clean.startswith("公司：") or clean.startswith("公司:"):
            company = clean.split("：", 1)[-1].split(":", 1)[-1].strip()
            if company:
                return company

    role = str(report.get("role") or "").strip()
    return role if role and role != "未知岗位" else "这个岗位"


def generate_opening(report: dict[str, Any], skills_profile: dict[str, Any], jd_text: str = "") -> str:
    target = _opening_target(report, jd_text)
    score = _coerce_score(report.get("match_score", 0))
    if score >= 75:
        prefix = f"{target}的这个岗位跟我的技能高度匹配。"
    elif score >= 50:
        prefix = f"{target}的这个岗位与我的项目经历有部分匹配。"
    else:
        prefix = f"{target}的这个岗位与我的当前经历重合度有限。"
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
    if not selected:
        if score < 50:
            return f"{prefix}我可以围绕求职加速器项目说明多 Agent、FastAPI 和浏览器插件的工程实践，但建议先确认岗位核心要求。相关代码和项目记录在 GitHub: tylygzl。"
        return f"{prefix}我独立搭建了可复盘的项目，能直接说明实现细节、指标和部署过程。相关代码和项目记录在 GitHub: tylygzl。"

    skills_text = "、".join(skill for _, _, skill, _ in selected)
    evidence_parts: list[str] = []
    seen_evidence: set[str] = set()
    for _, _, _skill, evidence in selected:
        compact = _compact_evidence(evidence)
        key = compact.lower()
        if compact and key not in seen_evidence:
            seen_evidence.add(key)
            evidence_parts.append(compact)
    evidence_text = "；".join(evidence_parts) or "已有项目中可复盘实现、指标和部署细节"
    if score < 50:
        return f"{prefix}可沟通的交集主要是{skills_text}，证据是：{evidence_text}。相关代码和项目记录在 GitHub: tylygzl，我可以展开讲实现细节、指标和部署过程。"
    return f"{prefix}我独立搭建了{skills_text}相关项目，证据是：{evidence_text}。相关代码和项目记录在 GitHub: tylygzl，我可以展开讲实现细节、指标和部署过程。"


def match_jd(
    jd_text: str,
    resume_text: str = "",
    skills_profile: dict[str, Any] | None = None,
    skills_path: str | Path | None = None,
    llm: Any | None = None,
) -> dict[str, Any]:
    """运行 JD拆解员 -> 技能匹配员，并返回 MatchReport 字典。"""
    jd_text = (jd_text or "").strip()
    if not jd_text:
        raise ValueError("jd_text 不能为空")
    profile = skills_profile or load_skills_profile(skills_path)
    active_llm = llm if llm is not None else _make_llm()
    resume_text = (resume_text or "").strip()
    if resume_text:
        try:
            resume_profile = _extract_resume_skills_profile(resume_text, active_llm)
            if resume_profile:
                profile = resume_profile
        except Exception:
            pass
    graph = build_match_graph(active_llm)
    state = graph.invoke({"jd_text": jd_text, "skills_profile": profile})
    report = _model_dump(_model_validate(MatchReport, state["report"]))  # type: ignore[arg-type]
    report["opening_message"] = generate_opening(report, profile, jd_text)
    return report



def _skills_list_to_profile(skills: list[str]) -> dict[str, Any]:
    return {
        "name": "候选人",
        "role": "",
        "skills": {
            "must_have": [{"skill": skill, "level": "掌握", "evidence": skill} for skill in skills],
            "familiar": [],
        },
        "weaknesses": [],
        "projects": [],
    }


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
