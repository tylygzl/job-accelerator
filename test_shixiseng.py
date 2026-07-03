"""实习僧 · 搜岗+读JD · 终版"""
import re
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto("https://www.shixiseng.com")
    print("登录后回车...")
    input()
    
    page.goto("https://www.shixiseng.com/interns?k=AI应用开发&c=青岛")
    page.wait_for_timeout(3000)
    cards = page.locator(".intern-wrap").all()
    print(f"\n搜到 {len(cards)} 个岗\n")
    
    for i, card in enumerate(cards[:3]):
        try:
            title_el = card.locator("a.title.font")
            company_el = card.locator("a.title:not(.font)")
            
            # 标题
            raw = title_el.inner_text() if title_el.count() else ""
            title = re.sub(r'[\ue000-\ue8ff]', '', raw).strip()
            
            # 公司
            company = company_el.inner_text() if company_el.count() else "?"
            
            # 获取详情页链接
            href = title_el.get_attribute("href") if title_el.count() else ""
            full_url = f"https://www.shixiseng.com{href}" if href.startswith("/") else href
            
            print(f"{i+1}. {title} | {company}")
            
            # 在同一个 page 里打开详情页
            if full_url:
                page.goto(full_url)
                page.wait_for_timeout(2000)
                body = page.locator("body").inner_text()
                
                # 提取薪资（通常格式：xxx-xxx/天）
                salary = "未标注"
                salary_match = re.search(r'(\d{2,4}-\d{2,4}/天)', body)
                if salary_match:
                    salary = salary_match.group(1)
                
                # 提取 JD
                if "职位描述" in body:
                    pos = body.index("职位描述")
                    jd = body[pos:pos+500].replace("\n", " ")
                else:
                    jd = body[:500].replace("\n", " ")
                
                print(f"   💰 {salary}")
                print(f"   📋 {jd[:250]}...\n")
                
                # 回到搜索结果
                page.go_back()
                page.wait_for_timeout(1500)
                
        except Exception as e:
            print(f"   err: {e}\n")
    
    browser.close()
