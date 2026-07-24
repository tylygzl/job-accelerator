"""Run a small score regression set for the Job Accelerator matcher.

Default mode avoids real LLM calls so it is cheap and fast:
    python eval_accuracy.py

Use --llm when you want to test the configured LLM chain:
    python eval_accuracy.py --llm
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import sys
import time
from pathlib import Path
from typing import Any

from pipeline import match_jd


DEFAULT_CASES = Path(__file__).with_name("tests") / "eval_cases.json"


def load_cases(path: Path) -> tuple[str, list[dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return str(data.get("resume_text", "")), list(data.get("cases", []))


def risk_label(value: Any) -> str:
    return {"低": "low", "中": "mid", "高": "high"}.get(str(value), str(value))


def evaluate_case(case: dict[str, Any], resume_text: str, use_llm: bool) -> dict[str, Any]:
    started = time.perf_counter()
    case_resume_text = str(case.get("resume_text") or resume_text)
    report = match_jd(
        case["jd_text"],
        resume_text=case_resume_text,
        llm=None if use_llm else False,
    )
    score = int(report.get("match_score", 0))
    min_score = int(case["expected_score_min"])
    max_score = int(case["expected_score_max"])
    opening = str(report.get("opening_message", "")).strip()
    in_range = min_score <= score <= max_score
    empty_words = ["我热爱", "学习能力强", "快速学习", "希望给机会", "我重点匹配"]
    opening_ok = not case.get("require_opening") or (len(opening) >= 20 and not any(word in opening for word in empty_words))
    return {
        "id": case["id"],
        "label": case["label"],
        "score": score,
        "expected": f"{min_score}-{max_score}",
        "risk": risk_label(report.get("risk_level", "")),
        "opening_ok": opening_ok,
        "passed": in_range and opening_ok,
        "opening": opening,
        "seconds": time.perf_counter() - started,
    }


def evaluate_case_safe(case: dict[str, Any], resume_text: str, use_llm: bool) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        return evaluate_case(case, resume_text, use_llm)
    except Exception as exc:
        min_score = int(case.get("expected_score_min", 0))
        max_score = int(case.get("expected_score_max", 100))
        return {
            "id": case.get("id", "<unknown>"),
            "label": case.get("label", ""),
            "score": "-",
            "expected": f"{min_score}-{max_score}",
            "risk": "",
            "opening_ok": False,
            "passed": False,
            "opening": "",
            "seconds": time.perf_counter() - started,
            "error": f"{type(exc).__name__}: {exc}",
        }


def filter_cases(cases: list[dict[str, Any]], case_ids: list[str] | None) -> list[dict[str, Any]]:
    if not case_ids:
        return cases
    wanted = {item.strip() for raw in case_ids for item in raw.split(",") if item.strip()}
    selected = [case for case in cases if case.get("id") in wanted]
    missing = sorted(wanted - {case.get("id") for case in selected})
    if missing:
        raise ValueError(f"Unknown case id(s): {', '.join(missing)}")
    return selected


def run_cases(cases: list[dict[str, Any]], resume_text: str, use_llm: bool, jobs: int) -> list[dict[str, Any]]:
    jobs = max(1, min(jobs, len(cases)))
    if jobs == 1:
        results = []
        for index, case in enumerate(cases, 1):
            print(f"[eval] {index}/{len(cases)} {case['id']}", flush=True)
            results.append(evaluate_case_safe(case, resume_text, use_llm))
        return results

    results_by_id: dict[str, dict[str, Any]] = {}
    print(f"[eval] running {len(cases)} cases with {jobs} workers", flush=True)
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {
            executor.submit(evaluate_case_safe, case, resume_text, use_llm): case
            for case in cases
        }
        for future in as_completed(futures):
            case = futures[future]
            result = future.result()
            results_by_id[str(case["id"])] = result
            status = "PASS" if result["passed"] else "FAIL"
            print(f"[eval] done {case['id']} {status} in {result['seconds']:.1f}s", flush=True)
    return [results_by_id[str(case["id"])] for case in cases]


def print_results(results: list[dict[str, Any]], use_llm: bool) -> None:
    mode = "configured LLM chain" if use_llm else "local fallback smoke"
    print(f"\nJob Accelerator eval ({mode})")
    print("-" * 98)
    print(f"{'case':<24} {'score':<7} {'expected':<10} {'risk':<6} {'opening':<8} {'time':<8} result")
    print("-" * 98)
    for row in results:
        mark = "PASS" if row["passed"] else "FAIL"
        opening = "ok" if row["opening_ok"] else "bad"
        print(
            f"{row['id']:<24} {row['score']:<7} {row['expected']:<10} "
            f"{row['risk']:<6} {opening:<8} {row['seconds']:.1f}s   {mark}"
        )
    print("-" * 98)
    failures = [row for row in results if not row["passed"]]
    if failures:
        print("\nFailures:")
        for row in failures:
            print(f"- {row['id']}: score={row['score']} expected={row['expected']}")
            if row.get("error"):
                print(f"  error={row['error']}")
            if row["opening"] and not row["opening_ok"]:
                print(f"  opening={row['opening']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate matcher score ranges on fixed JD cases.")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="Path to eval_cases.json")
    parser.add_argument("--llm", action="store_true", help="Use the real DeepSeek/LLM chain")
    parser.add_argument("--case", dest="case_ids", action="append", help="Run one case id; repeat or comma-separate ids")
    parser.add_argument("--jobs", type=int, default=1, help="Parallel workers. Use 2 for full --llm eval.")
    args = parser.parse_args()

    resume_text, cases = load_cases(args.cases)
    try:
        cases = filter_cases(cases, args.case_ids)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not cases:
        print(f"No cases found in {args.cases}", file=sys.stderr)
        return 2

    results = run_cases(cases, resume_text, args.llm, args.jobs)
    print_results(results, args.llm)
    return 0 if all(row["passed"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
