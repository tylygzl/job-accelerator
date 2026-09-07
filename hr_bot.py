"""HR 加速器 · BOSS 直聘半自动投递 Agent · 第一期：搜岗 + 筛岗 + 匹配度 + 面试题"""
import streamlit as st
import os
from dotenv import load_dotenv

load_dotenv()
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from pipeline import filter_and_match, generate_interview_prep, make_chat_model
import subprocess, json, os, sys

# ── 模拟数据（Playwright 未安装时的后备） ──
DEMO_JOBS = [
    {
        "title": "AI应用开发实习生",
        "company": "深度赋智（厦门）",
        "salary": "150-200元/天",
        "location": "厦门",
        "url": "",
        "jd_text": "【岗位职责】\n1. 参与AI Agent产品开发，基于LangChain/LangGraph搭建多Agent协作系统\n2. 调用GPT/DeepSeek等大模型API完成Prompt优化和RAG检索增强\n3. 使用Python开发自动化流程，对接业务系统\n4. 参与AI应用的前端开发（Streamlit）\n\n【任职要求】\n1. 本科及以上，计算机/数据科学相关专业\n2. 熟练掌握Python，有API调用经验\n3. 了解LangChain/LangGraph等Agent框架\n4. 了解Prompt工程和RAG基础\n5. 实习至少3个月，每周5天"
    },
    {
        "title": "AI大模型应用开发实习生",
        "company": "某AIGC创业团队",
        "salary": "180-250元/天",
        "location": "厦门",
        "url": "",
        "jd_text": "【岗位职责】\n1. 基于Claude/GPT/DeepSeek API开发AI应用\n2. 搭建RAG知识库系统（向量数据库+检索+生成）\n3. 优化Prompt模板，提升输出质量\n4. 参与AI Agent系统设计\n\n【任职要求】\n1. 本科及以上\n2. Python熟练，有API开发经验\n3. 了解向量数据库（Milvus/Chroma）\n4. 有GitHub开源项目优先\n5. 实习6个月以上"
    },
    {
        "title": "Python开发实习生（AI方向）",
        "company": "某电商数据分析公司",
        "salary": "120-150元/天",
        "location": "厦门",
        "url": "",
        "jd_text": "【岗位职责】\n1. 使用Python处理和分析电商数据\n2. 参与数据报表自动化开发\n3. 辅助搭建AI客服机器人\n\n【任职要求】\n1. 熟练掌握Python和Pandas\n2. 了解SQL，能写多表查询\n3. 了解机器学习基础\n4. 有数据分析项目经验优先"
    }
]

# ── 配置 ──
st.set_page_config(page_title="HR 加速器", page_icon="🎯", layout="wide")
st.title("🎯 HR 加速器")
st.caption("搜 BOSS 岗位 → 简历匹配 → 面试题定制。半自动投递，你永远保留最终决定权。")

# ── 侧边栏 ──
with st.sidebar:
    st.header("⚙️ 配置")
    search_keyword = st.text_input("搜索关键词", "AI应用开发")
    city = st.selectbox("城市", ["青岛", "厦门", "济南", "威海", "北京", "上海", "杭州", "深圳", "广州"])
    
    st.divider()
    st.header("📋 我的技能")
    my_skills = st.text_area("贴简历核心经历（或技能关键词，一行一条）",
                             """LangGraph多Agent开发
DeepSeek API调用
Prompt工程与优化
Streamlit前端开发
Python Pandas SQL
微信小程序开发
Claude Code协作开发""",
                             height=150)
    
    st.divider()
    use_real_search = st.checkbox("🔗 调用实习僧搜索（需扫码登录）", value=False, help="勾选后弹出浏览器，扫码登录实习僧，自动搜岗。不勾选用模拟数据演示。")
    max_results = st.slider("最多搜几个岗", 3, 15, 8)

# ── 主区域 ──
if st.button("🔍 开始搜索", type="primary", use_container_width=True):
    skills_list = [s.strip() for s in my_skills.split("\n") if s.strip()]
    
    with st.status("搜索中...", expanded=True) as status:
        # 初始化 LLM
        llm = make_chat_model(temperature=0)
        
        if use_real_search:
            result_file = "search_results.json"
            if os.path.exists(result_file):
                with open(result_file, "r", encoding="utf-8") as f:
                    jobs = json.load(f)
                st.write(f"📂 已加载本地搜索结果：{len(jobs)} 个岗")
            else:
                st.info("💡 请在新终端中运行搜索，完成后刷新页面点击搜索加载结果。")
                st.code(f".venv/Scripts/python shixiseng_cli.py \"{search_keyword}\" \"{city}\" {max_results}", language="bash")
                st.stop()
        else:
            jobs = DEMO_JOBS
        
        st.write(f"✅ 共搜到 {len(jobs)} 个岗位")
        
        st.write("📊 正在逐条解析 JD 并匹配...")
        results = filter_and_match(jobs, skills_list, llm)
        
        st.write("🎯 正在生成面试题和开场白...")
        enriched = generate_interview_prep(results, skills_list, llm)
        
        status.update(label="✅ 完成！", state="complete")
    
    # ── 结果展示 ──
    st.divider()
    st.subheader(f"📊 匹配结果（共 {len(enriched)} 个岗位）")
    
    for i, item in enumerate(enriched):
        score = item.get("score", 0)
        emoji = "🟢" if score >= 70 else "🟡" if score >= 50 else "🔴"
        
        with st.expander(f"{emoji} {score}% | {item['title']} | {item['company']} | {item['salary']}", expanded=(i == 0)):
            col1, col2 = st.columns([3, 2])
            with col1:
                st.markdown("**📋 JD 摘要**")
                st.text(item.get("jd_summary", "暂无"))
                
                st.markdown("**✅ 匹配点**")
                for s in item.get("strengths", []):
                    st.success(s)
                
                st.markdown("**⚠️ 缺口**")
                for w in item.get("weaknesses", []):
                    st.warning(w)
            
            with col2:
                st.markdown("**📝 开场白草稿**")
                st.code(item.get("opening_line", ""), language=None)
                
                st.markdown("**🎤 定制面试题**")
                for q in item.get("interview_questions", []):
                    st.markdown(f"- {q}")
                
                st.markdown(f"**🏢 公司背景**")
                st.caption(item.get("company_background", "暂无"))
    
    st.success("💡 半自动意味着：你审核匹配度、选岗、复制开场白发过去。Agent 不自动发送。")
