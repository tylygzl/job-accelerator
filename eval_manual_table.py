"""Fill a manual JD evaluation table with matcher scores.

Typical use:
    python eval_manual_table.py --input tests/manual_eval_template.csv --output tests/manual_eval_results.csv

With your real resume:
    python eval_manual_table.py --resume-file resume.txt --input tests/manual_eval_template.csv --output tests/manual_eval_results.csv

Default mode disables real LLM calls so the table is fast and cheap. Add --llm
only when you want to test the configured model path too.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from pipeline import match_jd


DEFAULT_INPUT = Path(__file__).with_name("tests") / "manual_eval_template.csv"
DEFAULT_OUTPUT = Path(__file__).with_name("tests") / "manual_eval_results.csv"
DEFAULT_RESUME_CASES = Path(__file__).with_name("tests") / "eval_cases.json"

FIELD_ID = "编号"
FIELD_TITLE = "岗位名"
FIELD_COMPANY = "公司"
FIELD_JD = "JD文本"
FIELD_HUMAN = "人工标注"
FIELD_SCORE = "系统分数"
FIELD_SYSTEM = "系统判断"
FIELD_CONSISTENT = "是否一致"
FIELD_REASON = "误判原因"
FIELD_NOTES = "备注"

FIELDS = [
    FIELD_ID,
    FIELD_TITLE,
    FIELD_COMPANY,
    FIELD_JD,
    FIELD_HUMAN,
    FIELD_SCORE,
    FIELD_SYSTEM,
    FIELD_CONSISTENT,
    FIELD_REASON,
    FIELD_NOTES,
]


def load_default_resume() -> str:
    if not DEFAULT_RESUME_CASES.exists():
        return ""
    try:
        data = json.loads(DEFAULT_RESUME_CASES.read_text(encoding="utf-8"))
        return str(data.get("resume_text", ""))
    except Exception:
        return ""


def load_resume(args: argparse.Namespace) -> str:
    if args.resume_text:
        return str(args.resume_text)
    if args.resume_file:
        return Path(args.resume_file).read_text(encoding="utf-8")
    return load_default_resume()


def normalize_human_label(value: str) -> str:
    text = str(value or "").strip()
    aliases = {
        "高": "适合",
        "高匹配": "适合",
        "推荐": "适合",
        "达标": "适合",
        "中": "一般",
        "中等": "一般",
        "一般匹配": "一般",
        "低": "不适合",
        "低匹配": "不适合",
        "不推荐": "不适合",
        "不合适": "不适合",
    }
    return aliases.get(text, text)


def score_to_label(score: int) -> str:
    if score >= 75:
        return "适合"
    if score >= 50:
        return "一般"
    return "不适合"


def build_jd(row: dict[str, str]) -> str:
    parts = [
        row.get(FIELD_TITLE, "") and f"岗位：{row.get(FIELD_TITLE, '')}",
        row.get(FIELD_COMPANY, "") and f"公司：{row.get(FIELD_COMPANY, '')}",
        row.get(FIELD_JD, ""),
    ]
    return "\n\n".join(str(part).strip() for part in parts if str(part).strip())


def evaluate_row(row: dict[str, str], resume_text: str, use_llm: bool) -> dict[str, str]:
    output = {field: str(row.get(field, "")) for field in FIELDS}
    jd_text = build_jd(output)
    if not jd_text.strip():
        return output

    started = time.perf_counter()
    try:
        report = match_jd(jd_text, resume_text=resume_text, llm=None if use_llm else False)
        score = int(report.get("match_score", 0))
        system_label = score_to_label(score)
        human_label = normalize_human_label(output.get(FIELD_HUMAN, ""))
        output[FIELD_SCORE] = str(score)
        output[FIELD_SYSTEM] = system_label
        output[FIELD_CONSISTENT] = "是" if human_label and human_label == system_label else ("否" if human_label else "")
        if output[FIELD_CONSISTENT] == "否" and not output.get(FIELD_REASON):
            output[FIELD_REASON] = "待人工复盘：看 JD 关键词、简历证据和系统命中技能是否一致"
        seconds = time.perf_counter() - started
        output[FIELD_NOTES] = (output.get(FIELD_NOTES, "") + f" | {seconds:.1f}s").strip(" |")
    except Exception as exc:
        output[FIELD_SCORE] = ""
        output[FIELD_SYSTEM] = "运行失败"
        output[FIELD_CONSISTENT] = "否" if output.get(FIELD_HUMAN) else ""
        output[FIELD_REASON] = output.get(FIELD_REASON) or f"{type(exc).__name__}: {exc}"
    return output


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        rows = [{field: str(row.get(field, "")) for field in FIELDS} for row in reader]
    return rows


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def run_rows(rows: list[dict[str, str]], resume_text: str, use_llm: bool, jobs: int) -> list[dict[str, str]]:
    active_rows = [row for row in rows if build_jd(row).strip()]
    if not active_rows:
        return rows

    jobs = max(1, min(jobs, len(active_rows)))
    results_by_id: dict[int, dict[str, str]] = {}
    if jobs == 1:
        for index, row in enumerate(rows):
            results_by_id[index] = evaluate_row(row, resume_text, use_llm)
        return [results_by_id[index] for index in range(len(rows))]

    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {
            executor.submit(evaluate_row, row, resume_text, use_llm): index
            for index, row in enumerate(rows)
        }
        for future in as_completed(futures):
            results_by_id[futures[future]] = future.result()
    return [results_by_id[index] for index in range(len(rows))]


def print_summary(rows: list[dict[str, str]], output: Path) -> None:
    evaluated = [row for row in rows if row.get(FIELD_SCORE)]
    consistent = [row for row in evaluated if row.get(FIELD_CONSISTENT) == "是"]
    inconsistent = [row for row in evaluated if row.get(FIELD_CONSISTENT) == "否"]
    print(f"wrote {output}")
    print(f"evaluated={len(evaluated)} consistent={len(consistent)} inconsistent={len(inconsistent)}")
    if evaluated:
        ratio = len(consistent) / len(evaluated) * 100
        print(f"agreement={ratio:.1f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill a manual JD evaluation CSV with system scores.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Manual evaluation CSV")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output CSV")
    parser.add_argument("--resume-file", type=Path, help="Resume text file used for evaluation")
    parser.add_argument("--resume-text", help="Resume text used for evaluation")
    parser.add_argument("--llm", action="store_true", help="Use configured LLM path")
    parser.add_argument("--jobs", type=int, default=1, help="Parallel workers")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2
    rows = load_rows(args.input)
    resume_text = load_resume(args)
    results = run_rows(rows, resume_text, args.llm, args.jobs)
    write_rows(args.output, results)
    print_summary(results, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
