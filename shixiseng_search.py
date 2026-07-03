"""实习僧搜索模块 · 封装版
所有搜索参数都可配置，不写死任何一个变量。
"""

import re
from urllib.parse import quote, urlencode
from playwright.sync_api import sync_playwright

_BROWSER = None
_PAGE = None


def login() -> None:
    """打开浏览器并等待用户手动登录"""
    global _BROWSER, _PAGE
    p = sync_playwright().start()
    _BROWSER = p.chromium.launch(headless=False)
    _PAGE = _BROWSER.new_page()
    _PAGE.goto("https://www.shixiseng.com")
    print("🔐 请在浏览器中登录实习僧，登录后回到终端按回车...")
    input()


def search(keyword: str, city: str = "", max_results: int = 5,
           months: str = "", days: str = "", degree: str = "",
           salary: str = "-0", page: int = 1) -> list[dict]:
    """
    搜索实习僧岗位，所有参数可配置。
    
    参数：
        keyword: 搜索关键词
        city: 城市（中文，如"青岛""北京"）
        months: 实习月数（如"3"）
        days: 每周天数（如"5"）
        degree: 学历（如"本科"）
        salary: 薪资范围（如"-0"=不限，"100-200"）
        page: 页码
        max_results: 最多返回几个岗
    """
    global _PAGE
    if _PAGE is None:
        login()
    
    # 构造搜索 URL：所有参数通过 urlencode 动态拼接
    params = {
        "keyword": keyword,
        "city": city,
        "months": months,
        "days": days,
        "degree": degree,
        "salary": salary,
        "page": str(page),
        "type": "intern"
    }
    search_url = f"https://www.shixiseng.com/interns?{urlencode(params)}"
    
    _PAGE.goto(search_url)
    _PAGE.wait_for_timeout(3000)
    
    cards = _PAGE.locator(".intern-wrap").all()
    jobs = []
    
    for card in cards[:max_results]:
        try:
            title_el = card.locator("a.title.font")
            company_el = card.locator("a.title:not(.font)")
            
            raw = title_el.inner_text() if title_el.count() else ""
            title = re.sub(r'[\ue000-\ue8ff]', '', raw).strip()
            company = company_el.inner_text() if company_el.count() else "?"
            href = title_el.get_attribute("href") if title_el.count() else ""
            
            # 进详情页读 JD + 薪资
            jd_text = ""
            salary_text = "未标注"
            if href:
                _PAGE.goto(href)
                _PAGE.wait_for_timeout(1500)
                body = _PAGE.locator("body").inner_text()
                
                s = re.search(r'(\d{2,4}-\d{2,4}/天)', body)
                if s:
                    salary_text = s.group(1)
                
                if "职位描述" in body:
                    pos = body.index("职位描述")
                    jd_text = body[pos:pos+600].replace("\n", " ")
                else:
                    jd_text = body[:600].replace("\n", " ")
                
                _PAGE.go_back()
                _PAGE.wait_for_timeout(1000)
            
            jobs.append({
                "title": title,
                "company": company,
                "salary": salary_text,
                "jd_text": jd_text,
                "url": href,
                "location": city or "不限"
            })
        except Exception as e:
            print(f"  ⚠️ 读岗失败：{e}")
            continue
    
    return jobs


def close() -> None:
    """关闭浏览器"""
    global _BROWSER
    if _BROWSER:
        _BROWSER.close()
