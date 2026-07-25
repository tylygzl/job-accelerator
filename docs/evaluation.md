# 准确率评估说明

这个项目有两种评估：

1. `eval_accuracy.py`：小规模回归烟测，确认典型岗位不会突然分数大漂移。
2. `eval_manual_table.py`：正式人工评估表，用 20-50 条真实 JD 对照人工判断。

## 正式评估表怎么填

复制 `tests/manual_eval_template.csv`，填 20-50 条真实 JD。

建议列这样理解：

- `岗位名` / `公司`：从 BOSS 页面复制。
- `JD文本`：复制岗位职责、任职要求、加分项，越完整越好。
- `人工标注`：你先不看系统分数，人工标为 `适合`、`一般`、`不适合`。
- `系统分数` / `系统判断` / `是否一致`：由脚本自动填写。
- `误判原因`：人工复盘时填写，例如“JD 要 PyTorch，但简历没有证据”“岗位是销售但标题带 AI”。

运行：

```bash
python eval_manual_table.py --input tests/manual_eval_template.csv --output tests/manual_eval_results.csv
```

如果要用真实简历：

```bash
python eval_manual_table.py --resume-file resume.txt --input tests/manual_eval_template.csv --output tests/manual_eval_results.csv
```

默认不调用真实 LLM，跑得快、便宜，主要评估本地快筛评分。要评估完整模型链路时再加：

```bash
python eval_manual_table.py --llm --jobs 1 --resume-file resume.txt --input tests/manual_eval_template.csv --output tests/manual_eval_results.csv
```

## 怎么看结果

先看一致率：

```text
agreement = 人工标注和系统判断一致的数量 / 已评估数量
```

然后重点复盘不一致行。这个表的目的不是证明系统永远正确，而是找出三类问题：

1. 简历证据没提取出来。
2. JD 关键词太泛，系统误判为高匹配。
3. 岗位标题像技术岗，但实际职责偏销售、运营、标注或培训。

这些误判原因会反过来指导下一轮评分规则和开场白 prompt 优化。
