"""实习僧搜索 CLI · 翻页版 · 一键搜多页"""
import sys, json, os, re
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright

KEYWORD = sys.argv[1] if len(sys.argv) > 1 else "AI应用开发"
CITY = sys.argv[2] if len(sys.argv) > 2 else "北京"
MAX_RESULTS = int(sys.argv[3]) if len(sys.argv) > 3 else 8
PAGES = int(sys.argv[4]) if len(sys.argv) > 4 else 3  # 搜几页

USER_DATA = os.path.join(os.path.dirname(__file__), "shixiseng_profile")

def extract_card(card):
    """从卡片提取岗位信息"""
    title_el = card.locator("a.title.font")
    company_el = card.locator("a.title:not(.font)")
    title = re.sub(r'[\ue000-\ue8ff]', '', title_el.inner_text() or "").strip()
    company = company_el.inner_text() if company_el.count() else "?"
    href = title_el.get_attribute("href") or ""
    return title, company, href

def read_detail(page, href):
    """打开详情页读 JD + 薪资"""
    jd_text, salary = "", "未标注"
    try:
        page.goto(href, timeout=10000)
        page.wait_for_timeout(1500)
        body = page.locator("body").inner_text()
        
        # 检测已下架
        if "已下架" in body or "已过期" in body or "职位已关闭" in body:
            return None, None
        
        s = re.search(r'(\d{2,4}-\d{2,4}/天)', body)
        if s: salary = s.group(1)
        pos = body.index("职位描述") if "职位描述" in body else 0
        jd_text = body[pos:pos+600].replace("\n", " ")
    except:
        pass
    return jd_text, salary


p = sync_playwright().start()
browser = p.chromium.launch_persistent_context(
    user_data_dir=USER_DATA, headless=False,
    args=["--disable-blink-features=AutomationControlled"]
)
page = browser.new_page()
page.goto("https://www.shixiseng.com")

# 登录检测
page.wait_for_timeout(3000)
if "郭震霖" in (page.locator("body").inner_text() or ""):
    print("✅ 已登录")
else:
    print("🔐 请扫码（120秒）...")
    for _ in range(120):
        page.wait_for_timeout(1000)
        if "郭震霖" in (page.locator("body").inner_text() or ""):
            print("✅ 已登录"); break

# 多页搜岗
all_jobs = []
seen_urls = set()

for pg in range(1, PAGES + 1):
    params = {"keyword": KEYWORD, "city": CITY, "type": "intern", "page": str(pg)}
    page.goto(f"https://www.shixiseng.com/interns?{urlencode(params)}")
    page.wait_for_timeout(3000)
    
    cards = page.locator(".intern-wrap").all()
    print(f"📄 第{pg}页: {len(cards)} 个岗")
    
    for ci, card in enumerate(cards):
        try:
            title, company, href = extract_card(card)
            if not title or not company: continue
            
            full_url = href if href.startswith("http") else f"https://www.shixiseng.com{href}"
            if full_url in seen_urls: continue
            seen_urls.add(full_url)
            
            jd_text, salary = read_detail(page, full_url)
            if jd_text is None:  # 已下架
                print(f"  ⚠️ 跳过（已下架）: {title}")
                continue
            
            all_jobs.append({
                "title": title, "company": company, "salary": salary,
                "jd_text": jd_text, "url": full_url, "location": CITY
            })
            
            if len(all_jobs) >= MAX_RESULTS:
                break
                
        except Exception as e:
            continue
    
    if len(all_jobs) >= MAX_RESULTS:
        break

browser.close()
p.stop()

outfile = os.path.join(os.path.dirname(__file__), "search_results.json")
with open(outfile, "w", encoding="utf-8") as f:
    json.dump(all_jobs, f, ensure_ascii=False, indent=2)

print(f"\n✅ 搜{PAGES}页，去重去下架，最终 {len(all_jobs)} 个岗 → {outfile}")
