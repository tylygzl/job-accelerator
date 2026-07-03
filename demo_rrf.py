"""RRF 融合排序实操 · 5 行核心代码"""

# 模拟两条搜索路径返回的结果
bm25_results = [
    ("RAG入门教程", "https://a.com/rag"),
    ("大模型部署指南", "https://a.com/deploy"),
    ("Embedding模型对比", "https://a.com/embed"),
]

vector_results = [
    ("RAG进阶实战", "https://b.com/rag-pro"),
    ("RAG入门教程", "https://a.com/rag"),      # 跟 BM25 重复
    ("向量检索原理", "https://b.com/vector"),
]

# --- RRF 核心 ---
K = 60  # 平滑常数，业界默认值

def rrf(results_list):
    """多路结果融合：每条结果分数 = Σ 1/(K+排名)"""
    scores = {}
    for results in results_list:
        for rank, (title, url) in enumerate(results, start=1):
            scores[url] = scores.get(url, 0) + 1 / (K + rank)
    # 按分数从高到低排
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)

# 融合
merged = rrf([bm25_results, vector_results])

print("排序结果（分数越低越靠后）：")
for url, score in merged:
    print(f"  {score:.4f}  →  {url}")

# 为什么不直接拼接两份结果？
# BM25 第 1 名和向量检索第 1 名哪个更重要？RRF 不区分谁来源更高贵，
# 只看排名：排名第 1 就给 1/(60+1)=0.0164，排名第 5 给 1/(60+5)=0.0154。
# 两份结果都排在前面的文档自然总分最高，排在顶前面。
print("\n✅ 核心就一行：scores[url] += 1/(K+rank)")
print("   两份结果都靠前的文档 → 总分最高 → 排最前面")
