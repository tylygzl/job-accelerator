"""求职加速器 · Streamlit 网页版"""
import streamlit as st
import os
import re
from uuid import uuid4
from dotenv import load_dotenv

load_dotenv()
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from deepagents import create_deep_agent
from pipeline import make_chat_model

# ── 页面设置 ──
st.set_page_config(page_title="求职加速器", page_icon="🚀", layout="wide")
st.title("🚀 求职加速器")
st.caption("贴 JD + 经历 + 公司名，告诉你投不投、怎么准备。")

# 隐私说明
with st.expander("🔒 隐私说明", expanded=False):
    st.markdown("""
    - JD、个人经历和公司名会发送到你配置的 LLM API 进行模型分析
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
    placeholder="必填。你想应聘哪家公司？",
)

mode = st.radio(
    "输出模式",
    options=["⚡ 简洁（推荐）", "📋 详细"],
    horizontal=True,
    help="简洁模式输出更快，详细模式包含更多面试题和公司分析",
)

# ── 模型初始化（只跑一次） ──
@st.cache_resource
def get_jd_check_model():
    """轻量模型，只做 JD 有效性筛查"""
    return make_chat_model(temperature=0, timeout=15, required=True)


@st.cache_resource
def get_agent():
    model = make_chat_model(temperature=0, timeout=60, required=True)

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


def is_yes_answer(line: str) -> bool:
    clean = re.sub(r"^\s*(?:\d+|[一二三四五六七八九十]+)[\.、):：]?\s*", "", line or "")
    clean = clean.strip(" \t。.!！")
    return clean.startswith("是")


# ── 运行按钮 ──
if st.button("🔍 开始评估", type="primary", use_container_width=True):
    if not jd_text.strip():
        st.error("请先粘贴岗位描述")
    elif len(jd_text.strip()) > 5000:
        st.error("岗位描述超过 5000 字，请精简到核心要求再贴")
    elif not resume_text.strip():
        st.error("请先填写你的经历")
    elif len(resume_text.strip()) > 3000:
        st.error("经历超过 3000 字，请精简到关键项目再贴")
    elif not company_name.strip():
        st.error("请填写公司名称")
    else:
        check_model = get_jd_check_model()

        # ── JD + 简历联合筛查（一次调用省一轮请求） ──
        with st.spinner("正在检查输入是否有效…"):
            check_prompt = (
                "请逐行判断以下两个输入的有效性，每行只回复「是」或「否」：\n"
                f"1. 以下是招聘岗位描述（JD）吗？\n{jd_text.strip()[:2000]}\n\n"
                f"2. 以下是个人经历/简历吗？\n{resume_text.strip()[:2000]}"
            )
            check_result = check_model.invoke(check_prompt)
            check_text = str(check_result.content)

        check_lines = [line.strip() for line in check_text.splitlines() if line.strip()]
        jd_ok = is_yes_answer(check_lines[0]) if len(check_lines) >= 1 else False
        resume_ok = is_yes_answer(check_lines[-1]) if len(check_lines) >= 2 else False

        if not jd_ok:
            st.error("❌ 粘贴的内容不像一个岗位描述。请确认你贴的是招聘 JD。")
            st.stop()
        if not resume_ok:
            st.error("❌ 粘贴的内容不像一份个人经历。请确认你填的是简历或项目经历。")
            st.stop()

        agent = get_agent()

        is_concise = "简洁" in mode

        user_input = (
            f"请拆解以下岗位描述：\n\n{jd_text.strip()}\n\n"
            f"拆解完成后，用这份简历做人岗匹配：\n\n{resume_text.strip()}"
        )
        if company_name.strip():
            user_input += f"\n\n最后，搜索 {company_name.strip()} 的公司背景，判断这家公司是否适合这位求职者。"

        if is_concise:
            user_input += (
                "\n\n【输出要求：简洁模式】\n"
                "- JD 拆解：每条要求一行，不展开解释\n"
                "- 人岗匹配：三栏分类即可，匹配度打分一句话\n"
                "- 面试预测：只出 3 道最可能被问的题\n"
                "- 公司分析：不写"
            )

        # 占位：导出按钮先显示但不可用
        download_placeholder = st.empty()

        wait_msg = "Agent 正在分析…（简洁模式预计 2~3 分钟，请勿刷新）" if is_concise else "Agent 正在分析…（详细模式预计 3~5 分钟，请勿刷新）"
        with st.spinner(wait_msg):
            try:
                import concurrent.futures
                thread_id = str(uuid4())
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(
                        agent.invoke,
                        {"messages": [{"role": "user", "content": user_input}]},
                        {"configurable": {"thread_id": thread_id}},
                    )
                    result = future.result(timeout=180)

                try:
                    messages = result.get("messages", []) if hasattr(result, "get") else getattr(result, "messages", [])

                    # 收集所有主 Agent 输出（过滤子 Agent 中间输出）
                    parts = []
                    for msg in (messages if isinstance(messages, list) else []):
                        if getattr(msg, "type", "") == "ai" and not getattr(msg, "name", None):
                            content = str(getattr(msg, "content", "") or "")
                            if len(content) > 50:
                                parts.append(content)
                    final_output = "\n\n".join(parts) if parts else ""

                    if final_output:
                        st.success("✅ 评估完成")
                        st.markdown(final_output)
                        download_placeholder.download_button(
                            label="📥 下载评估报告 (Markdown)",
                            data=final_output,
                            file_name="求职评估报告.md",
                            mime="text/markdown",
                            use_container_width=True,
                        )
                    else:
                        st.warning("Agent 返回了空结果，请重试")
                except Exception as render_error:
                    st.warning(f"输出渲染异常：{render_error}")
                    st.text(str(result))

            except concurrent.futures.TimeoutError:
                st.error("⏱️ 分析超时（3 分钟），请缩短 JD 或重试")
            except Exception as e:
                st.error(f"运行出错：{e}")
