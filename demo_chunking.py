"""RAG 切片实操 · 看一眼就懂"""
# 模拟一段招聘 JD 文档
document = """
岗位名称：AI应用开发实习生
工作地点：青岛
薪资：200-300/天

职位描述：
参与公司AI应用平台的设计与开发，负责需求分析、功能设计和项目推进。
与后端开发团队协作，完成产品需求文档编写和原型设计。
跟踪行业动态，研究AI应用落地场景，提出产品优化方案。

岗位要求：
1. 计算机、软件工程或相关专业本科及以上学历
2. 熟悉Python开发，了解主流AI框架
3. 有产品思维，能独立完成需求分析和功能设计
4. 良好的沟通能力和团队协作精神

加分项：
- 有AI Agent开发经验
- 了解LangChain/LangGraph框架
- 有微信小程序开发经验
"""

# 方法一：傻瓜切法（按固定字符数硬切）
print("=" * 40)
print("❌ 固定字符硬切（100 字一块，不重叠）")
chunks_simple = [document[i:i+100] for i in range(0, len(document), 100)]
for i, c in enumerate(chunks_simple):
    print(f"块{i}: {c[:50]}...")

# 方法二：递归字符分割（RAG 手册推荐）
print("\n" + "=" * 40)
print("✅ 递归字符分割（按自然边界切，50 字，20% 重叠）")

from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=120,     # 块大小
    chunk_overlap=30,   # 重叠量
    separators=["\n\n", "\n", "。", ".", "，", " ", ""]
    # 优先级：先按空行切，再按换行切，再按句号切...
)
chunks = splitter.split_text(document)

for i, c in enumerate(chunks):
    print(f"\n块{i} (长度{len(c)}字):")
    print(c)
