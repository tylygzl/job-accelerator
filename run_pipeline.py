"""HR 加速器 · 完整管线 · 封装版"""
import os
from dotenv import load_dotenv
load_dotenv()
os.environ["LANGSMITH_TRACING"] = "false"

from shixiseng_search import search, close as close_browser
from pipeline import filter_and_match, generate_interview_prep, make_chat_model

# ── 用户配置（将来从 Streamlit 侧边栏读取） ──
CONFIG = {
    "keyword": "AI应用开发",
    "city": "北京",
    "months": "",      # 不限实习时长
    "days": "",        # 不限每周天数
    "degree": "",      # 不限学历
    "salary": "-0",    # 不限薪资
    "max_results": 8,
}

SKILLS = [
    "LangGraph多Agent开发",
    "DeepSeek API调用",
    "Prompt工程与优化",
    "Streamlit前端开发",
    "Python Pandas SQL",
    "微信小程序开发",
    "Claude Code协作开发"
]

# ── 初始化 ──
llm = make_chat_model(temperature=0)

# ── 流水线 ──
print(f"\n🔍 搜索：{CONFIG['keyword']} @ {CONFIG['city']}")
jobs = search(**{k: CONFIG[k] for k in ["keyword","city","months","days","degree","salary","max_results"]})
print(f"✅ {len(jobs)} 个岗\n")

print("📊 解析+匹配...")
results = filter_and_match(jobs, SKILLS, llm)

print("🎯 面试题...")
enriched = generate_interview_prep(results, SKILLS, llm)
close_browser()

for i, item in enumerate(enriched, 1):
    s = item["score"]
    e = "🟢" if s >= 70 else "🟡" if s >= 50 else "🔴"
    print(f"\n{e} {s}% | {item['title']} | {item['company']} | {item['salary']}")
    if item.get("strengths"):
        print(f"   ✅ {', '.join(item['strengths'][:2])}")
    if item.get("weaknesses"):
        print(f"   ⚠️ {', '.join(item['weaknesses'][:2])}")
    for q in item.get("interview_questions", [])[:2]:
        print(f"   🎤 {q}")

print("\n✅ 全链路")
