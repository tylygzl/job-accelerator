from dotenv import load_dotenv
load_dotenv()

import os
from uuid import uuid4
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from deepagents import create_deep_agent
from deepagents import FilesystemPermission
from pipeline import make_chat_model

# --- 模型 ---
model = make_chat_model(temperature=0, timeout=60, required=True)

# --- 三个子 Agent ---

jd_analyzer = {
    "name": "jd-analyzer",
    "description": "拆解 JD。把岗位描述拆成硬性要求、加分项、软技能三类。",
    "system_prompt": (
        "你是 JD 拆解专家。拿到一份岗位描述后，输出三组内容：\n"
        "1. 硬性要求（学历/经验/技能，必须全满足）\n"
        "2. 加分项（有更好没有也行）\n"
        "3. 软技能（沟通/协作/抗压等）\n"
        "每条要求单独一行，用 - 开头。不要写其他内容。"
    ),
}

matcher = {
    "name": "resume-matcher",
    "description": "人岗匹配。对照 JD 要求逐一评估简历，输出三栏分类和匹配度打分。",
    "system_prompt": (
        "你是人岗匹配评估师。输入 JD 拆解结果和简历内容，按以下规则输出：\n\n"
        "三栏分类标准：\n"
        "- 🟢 能说硬的：简历有直接对得上的经历，面试追问不慌\n"
        "- 🟡 学两天能说的：有相关概念但没做过，花半天一天能补到能聊\n"
        "- 🔴 暂时说不了的：简历完全没涉及，短时间补不上\n\n"
        "匹配度打分规则：\n"
        "- 硬性要求匹配率 (权重 60%)\n"
        "- 加分项匹配率 (权重 25%)\n"
        "- 软技能匹配率 (权重 15%)\n"
        "- 总分 = 三项加权求和\n\n"
        "输出格式：先出三栏表格，再出匹配度分数，最后给一句总评。"
    ),
}

interviewer = {
    "name": "interview-predictor",
    "description": "面试预测。根据匹配缺口和岗位特点，预测最可能被问到的面试题。",
    "system_prompt": (
        "你是面试出题官。根据人岗匹配结果和 JD，预测 5 道最可能被问到的面试题。\n"
        "出题原则：\n"
        "1. 从 🟡 和 🔴 的缺口里抽题（面试官的视角：你简历缺什么就问什么）\n"
        "2. 从 🟢 的强项里抽题追问（你能说的我会深挖）\n"
        "3. 每道题标出来源（来自 JD 的哪条要求）\n"
        "4. 按「大概率被问」到「小概率被问」排序\n\n"
        "输出格式：每道题一行，行首标序号和概率等级，括号里标来源。"
    ),
}

# --- 组装 ---
agent = create_deep_agent(
    model=model,
    system_prompt=(
        "你是求职顾问。收到用户的 JD 和简历后，严格按以下流程：\n"
        "1. task() 委派给 jd-analyzer 拆解 JD\n"
        "2. 拿到拆解结果后 task() 委派给 resume-matcher 做人岗匹配\n"
        "3. 拿到匹配结果后 task() 委派给 interview-predictor 出面试题\n"
        "4. 汇总输出：三栏评估 + 匹配度分数 + 面试预测题\n"
        "不要自己分析，全程委派。公司分析不回避劣势，标注乐观/保守两档估计。"
    ),
    subagents=[jd_analyzer, matcher, interviewer],
)

# --- 测试数据 ---
SAMPLE_JD = """
AI 产品实习生
岗位职责：
1. 参与 AI 产品的需求分析和功能设计
2. 协助产品经理完成 PRD 文档撰写
3. 跟踪 AI 行业动态，输出竞品分析报告
4. 与开发团队协作推进产品迭代

任职要求：
1. 本科及以上学历，计算机/人工智能/大数据相关专业优先
2. 了解大语言模型基本原理，有 LLM API 调用经验
3. 熟练使用 Python，能独立完成数据分析和原型验证
4. 有产品实习经验者优先
5. 具备良好的逻辑思维和沟通能力
6. 每周到岗 4 天以上，实习期不少于 3 个月
"""

SAMPLE_RESUME = """
郭震霖 | 山东理工大学 大数据专业 大三
项目经历：
- 独立开发微信小程序「我的餐盘日记」，含 AI 配餐客服，已上线
- 搭建 Ralph 多智能体系统（策划→开发→测试闭环）
- 联网研究员（Tavily + DeepSeek），自动搜索并生成报告
技能：Python、JavaScript（入门）、微信小程序开发、DeepSeek API、Prompt Engineering
实习经历：无
"""

# --- 运行 ---
print("=" * 60)
print("求职加速器启动")
print("=" * 60)

# 分步运行：先拆 JD，结果给匹配，最后给面试
jd_text = SAMPLE_JD.strip()
resume_text = SAMPLE_RESUME.strip()

result = agent.invoke(
    {"messages": [{"role": "user", "content": f"请拆解以下岗位描述：\n\n{jd_text}\n\n拆解完成后，用这份简历做人岗匹配：\n\n{resume_text}"}]},
    config={"configurable": {"thread_id": str(uuid4())}},
)

for msg in result["messages"]:
    role = getattr(msg, 'type', 'unknown')
    name = getattr(msg, 'name', None)
    label = f"{role}:{name}" if name else role
    content = getattr(msg, 'content', '') or ''
    if content and len(str(content)) > 20:
        print(f"\n[{label}]")
        print(str(content)[:1200])

print("\n" + "=" * 60)
