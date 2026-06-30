"""求职加速器 · Streamlit 网页版"""
import streamlit as st
import os
from dotenv import load_dotenv

load_dotenv()
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from deepagents import create_deep_agent
from langchain_openai import ChatOpenAI

# ── 页面设置 ──
st.set_page_config(page_title="求职加速器", page_icon="🚀", layout="wide")
st.title("🚀 求职加速器")
st.caption("贴 JD + 经历 + 公司名，告诉你投不投、怎么准备。")

# 隐私说明
with st.expander("🔒 隐私说明", expanded=False):
    st.markdown("""
    - 所有处理在**你的电脑上本地完成**，不会上传到任何服务器
    - 不收集、不存储、不分享你的简历或个人数据
    - 关闭页面后数据自动清除
    - 仅在你点击"开始评估"时调用 AI 模型处理内容
    """)

# ── 输入区 ──
col1, col2 = st.columns(2)

with col1:
    st.subheader("📋 岗位描述")
    jd_text = st.text_area(
        "粘贴 JD",
        placeholder="把岗位描述全文贴在这里…",
        height=200,
        label_visibility="collapsed",
    )

with col2:
    st.subheader("👤 你的经历")
    resume_text = st.text_area(
        "你的经历",
        placeholder="没有简历？写三样就行：专业 + 做过的项目 + 会的技能",
        height=200,
        label_visibility="collapsed",
    )

company_name = st.text_input(
    "🏢 公司名称",
    placeholder="选填。填了出公司背景和行业对比",
)

# ── 模型初始化（只跑一次） ──
@st.cache_resource
def get_agent():
    model = ChatOpenAI(
        model=os.environ.get("MODEL_NAME", "deepseek-chat"),
        api_key=os.environ.get("DEEPSEEK_API_KEY"),
        base_url="https://api.deepseek.com/v1",
        temperature=0,
        timeout=60,
    )

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
            "- 硬性要求匹配率 (权重 60%)\n- 加分项匹配率 (权重 25%)\n- 软技能匹配率 (权重 15%)\n"
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
            "1. 从 🟡 和 🔴 的缺口里抽题\n2. 从 🟢 的强项里抽题追问\n"
            "3. 每道题标出来源\n4. 按「大概率被问」到「小概率被问」排序\n\n"
            "输出格式：每道题一行，行首标序号和概率等级，括号里标来源。"
        ),
    }

    return create_deep_agent(
        model=model,
        system_prompt=(
            "你是求职顾问。收到用户的 JD 和简历后，严格按以下流程：\n"
            "1. task() 委派给 jd-analyzer 拆解 JD\n"
            "2. task() 委派给 resume-matcher 做人岗匹配\n"
            "3. task() 委派给 interview-predictor 出面试题\n"
            "4. 汇总输出。\n\n"
            "汇总规则（必须遵守）：\n"
            "用 '### 一、JD 拆解' '### 二、人岗匹配' '### 三、面试预测' 三个标题分隔，\n"
            "每部分直接粘贴对应子 Agent 的完整输出，不删减、不改写。\n"
            "公司分析原则：结合学校层次、专业与竞争程度做真实判断，\n"
            "不回避劣势，标注「乐观估计」和「保守估计」两档。"
        ),
        subagents=[jd_analyzer, matcher, interviewer],
    )


# ── 运行按钮 ──
if st.button("🔍 开始评估", type="primary", use_container_width=True):
    if not jd_text.strip():
        st.error("请先粘贴岗位描述")
    elif not resume_text.strip():
        st.error("请先填写你的经历")
    else:
        agent = get_agent()

        user_input = (
            f"请拆解以下岗位描述：\n\n{jd_text.strip()}\n\n"
            f"拆解完成后，用这份简历做人岗匹配：\n\n{resume_text.strip()}"
        )
        if company_name.strip():
            user_input += f"\n\n最后，搜索 {company_name.strip()} 的公司背景，判断这家公司是否适合这位求职者。"

        with st.spinner("Agent 正在分析…（预计 1~2 分钟）"):
            try:
                result = agent.invoke(
                    {"messages": [{"role": "user", "content": user_input}]},
                    config={"configurable": {"thread_id": "1"}},
                )

                try:
                    messages = result.get("messages", []) if hasattr(result, "get") else getattr(result, "messages", [])

                    # 只取主 Agent 最终汇总（ai 类型、无 name）
                    final_output = ""
                    for msg in (messages if isinstance(messages, list) else []):
                        if getattr(msg, "type", "") == "ai" and not getattr(msg, "name", None):
                            content = str(getattr(msg, "content", "") or "")
                            if len(content) > 100:
                                final_output = content

                    if final_output:
                        st.success("✅ 评估完成")
                        st.markdown(final_output)
                    else:
                        st.warning("Agent 返回了空结果，请重试")
                except Exception as render_error:
                    st.warning(f"输出渲染异常：{render_error}")
                    st.text(str(result))

            except Exception as e:
                st.error(f"运行出错：{e}")
