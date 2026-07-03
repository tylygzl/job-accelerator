"""HR 加速器 · 核心流水线：搜岗 → 筛岗 → 匹配 → 面试题 + 开场白

基于 Prompt 工程手册的三原则：
1. System Prompt 定角色、定边界、定输出格式
2. 预填充强制结构化输出（"{'score':"）
3. 输入隔离（JD/简历用 <input> 标签包裹，防注入）
"""

import time
from typing import Any


# ━━━ 第一期：Playwright 搜 BOSS（先上模拟数据，Playwright 到齐后替换）━━━

def search_jobs(keyword: str, city_code: str, max_results: int = 8) -> list[dict]:
    """
    BOSS 直聘搜索（Playwright 版·待完成）
    
    计划流程：
    1. 打开浏览器，跳转 BOSS 搜索页
    2. 等待用户扫码登录（headless=False 弹窗口）
    3. 搜索 {keyword}，城市 {city_code}
    4. 逐条读取岗位卡片：公司名、薪资、JD 链接
    5. 点进详情页提取完整 JD 文本
    6. 返回结构化列表
    
    当前：返回空列表，由 hr_bot.py 的模拟数据接管
    """
    try:
        from playwright.sync_api import sync_playwright
        
        with sync_playwright() as p:
            # 🔥 用你本机的 Edge 浏览器（自带 cookie，BOSS 认不出）
            browser = p.chromium.launch(
                headless=False,
                channel="msedge",
                args=["--disable-blink-features=AutomationControlled"]
            )
            page = browser.new_page()
            
            # 因为你 Edge 已经登录过 BOSS，直接搜岗
            search_url = f"https://www.zhipin.com/web/geek/job?query={keyword}&city={city_code}"
            page.goto(search_url)
            page.wait_for_timeout(3000)
            
            jobs = []
            cards = page.locator(".job-card-wrapper").all()
            
            for card in cards[:max_results]:
                try:
                    title = card.locator(".job-name").inner_text()
                    salary = card.locator(".salary").inner_text()
                    company = card.locator(".company-name").inner_text()
                    
                    # 点击卡片进入详情页读取 JD
                    card.click()
                    page.wait_for_timeout(1500)
                    
                    jd_elem = page.locator(".job-detail .text")
                    jd_text = jd_elem.inner_text() if jd_elem.count() > 0 else ""
                    
                    jobs.append({
                        "title": title,
                        "company": company,
                        "salary": salary,
                        "jd_text": jd_text.strip(),
                        "url": page.url
                    })
                    
                    # 返回搜索结果页
                    page.go_back()
                    page.wait_for_timeout(1000)
                    
                except Exception as e:
                    print(f"  ⚠️ 读取岗位失败：{e}")
                    continue
            
            browser.close()
            return jobs
            
    except ImportError:
        print("⚠️ Playwright 未安装，使用模拟数据")
        return []
    except Exception as e:
        print(f"⚠️ 搜索出错：{e}")
        return []


# ━━━ 第二步：JD 解析 + 简历匹配 ━━━

JD_PARSER_PROMPT = """你是一个 JD 分析师。从岗位描述中提取结构化信息。

输出格式（只输出 JSON，不要任何解释）：
{
  "硬性要求": ["必须会Python", "本科以上"],
  "加分项": ["有AI项目经验优先", "了解LangChain"],
  "工作内容": ["参与Agent开发", "Prompt优化"],
  "技术栈关键词": ["Python", "LangChain", "DeepSeek"]
}"""


MATCHER_PROMPT = """你是人岗匹配师。对比候选人的技能和 JD 的要求，输出匹配度分析。

分析规则：
1. 硬性要求每命中一条 +20 分，未命中一条 -15 分
2. 加分项每命中一条 +10 分
3. 技能栈重叠度 +10 分（完全重叠 10 分，部分重叠 5 分，零重叠 0 分）
4. 总分 = 硬性要求得分 + 加分项得分 + 技能重叠分，最大 100 分

输出格式（只输出 JSON，不要任何解释）：
{
  "score": 75,
  "strengths": ["LangGraph经验与Agent开发要求完美匹配", "Python熟练"],
  "weaknesses": ["缺少云服务部署经验", "不了解Spark"],
  "brief": "一句话总结为什么匹配或不匹配"
}"""


def filter_and_match(jobs: list[dict], skills: list[str], llm: Any) -> list[dict]:
    """逐条解析 JD 并计算匹配度"""
    results = []
    
    for job in jobs:
        jd_text = job.get("jd_text", "")
        if not jd_text:
            continue
        
        # 🔥 输入隔离：JD 文本用标签包裹
        isolated_input = f"<job_description>\n{jd_text}\n</job_description>"
        
        # 第一步：解析 JD
        parse_msg = [
            {"role": "system", "content": JD_PARSER_PROMPT},
            {"role": "user", "content": isolated_input},
            {"role": "assistant", "content": "{"}  # 🔥 预填充：强制 JSON 开头
        ]
        try:
            parsed = llm.invoke(parse_msg).content
            if not parsed.startswith("{"):
                parsed = "{" + parsed
        except Exception:
            continue
        
        # 第二步：匹配
        skills_text = "\n".join(f"- {s}" for s in skills)
        match_input = f"""<jd_requirements>\n{parsed}\n</jd_requirements>

<candidate_skills>
{skills_text}
</candidate_skills>"""
        
        match_msg = [
            {"role": "system", "content": MATCHER_PROMPT},
            {"role": "user", "content": match_input},
            {"role": "assistant", "content": "{"}
        ]
        try:
            match_result = llm.invoke(match_msg).content
            if not match_result.startswith("{"):
                match_result = "{" + match_result
            import json
            match_data = json.loads(match_result)
        except Exception:
            match_data = {"score": 50, "strengths": [], "weaknesses": [], "brief": "解析失败"}
        
        results.append({
            **job,
            "score": match_data.get("score", 50),
            "strengths": match_data.get("strengths", []),
            "weaknesses": match_data.get("weaknesses", []),
            "brief": match_data.get("brief", ""),
            "jd_parsed": parsed
        })
    
    # 按匹配度从高到低排序
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


# ━━━ 第三步：面试题 + 开场白 ━━━

INTERVIEW_PROMPT = """你是面试出题官。根据 JD + 公司业务 + 候选人简历缺口，定制 3~5 道面试题。

出题规则：
1. 一道问技术匹配（JD 要求的技能）
2. 一道问项目经验（候选人简历中可能被深挖的点）
3. 一道问公司业务理解（为什么不选竞品？你怎么看这个业务？）
4. 如果 JD 有特定技术栈要求，追加一道技术细节题
5. 如果候选人简历有明显缺口（JD 要求但简历没体现），追加一道「你怎么补这个短板？」

输出格式（只输出 JSON）：
{
  "interview_questions": [
    "题1",
    "题2"
  ],
  "company_background": "公司 2~3 句话简介（业务方向/规模/融资阶段）",
  "opening_line": "开场白草稿（30 字以内，突出匹配点，不提缺口）"
}"""


def generate_interview_prep(results: list[dict], skills: list[str], llm: Any) -> list[dict]:
    """为高匹配岗位生成面试题和开场白"""
    enriched = []
    
    for item in results:
        if item["score"] < 50:
            item["interview_questions"] = ["匹配度较低，暂不生成面试题"]
            item["company_background"] = ""
            item["opening_line"] = ""
            enriched.append(item)
            continue
        
        # 构造输入
        prep_input = f"""<job_info>
公司：{item.get('company', '未知')}
岗位：{item.get('title', '未知')}
JD解析结果：{item.get('jd_parsed', '')}
</job_info>

<candidate_skills>
{chr(10).join(f'- {s}' for s in skills)}
</candidate_skills>

<match_gaps>
{item.get('weaknesses', [])}
</match_gaps>"""
        
        prep_msg = [
            {"role": "system", "content": INTERVIEW_PROMPT},
            {"role": "user", "content": prep_input},
            {"role": "assistant", "content": "{"}
        ]
        
        try:
            prep_result = llm.invoke(prep_msg).content
            if not prep_result.startswith("{"):
                prep_result = "{" + prep_result
            import json
            prep_data = json.loads(prep_result)
            item["interview_questions"] = prep_data.get("interview_questions", [])
            item["company_background"] = prep_data.get("company_background", "")
            item["opening_line"] = prep_data.get("opening_line", "")
        except Exception:
            item["interview_questions"] = ["生成失败"]
            item["company_background"] = ""
            item["opening_line"] = ""
        enriched.append(item)
    
    return enriched
