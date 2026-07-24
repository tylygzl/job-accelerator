"""Run a small score regression set for the Job Accelerator matcher.

Default mode avoids real LLM calls so it is cheap and fast:
    python eval_accuracy.py

Use --llm when you want to test the real DeepSeek chain:
    python eval_accuracy.py --llm
"""

from __future__ import annotations

import argparse
import json
import sys
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
    opening_ok = not case.get("require_opening") or ("tylygzl" in opening and len(opening) >= 20)
    return {
        "id": case["id"],
        "label": case["label"],
        "score": score,
        "expected": f"{min_score}-{max_score}",
        "risk": risk_label(report.get("risk_level", "")),
        "opening_ok": opening_ok,
        "passed": in_range and opening_ok,
        "opening": opening,
    }


def print_results(results: list[dict[str, Any]], use_llm: bool) -> None:
    mode = "DeepSeek real chain" if use_llm else "local fallback smoke"
    print(f"\nJob Accelerator eval ({mode})")
    print("-" * 86)
    print(f"{'case':<22} {'score':<7} {'expected':<10} {'risk':<6} {'opening':<8} result")
    print("-" * 86)
    for row in results:
        mark = "PASS" if row["passed"] else "FAIL"
        opening = "ok" if row["opening_ok"] else "bad"
        print(
            f"{row['id']:<22} {row['score']:<7} {row['expected']:<10} "
            f"{row['risk']:<6} {opening:<8} {mark}"
        )
    print("-" * 86)
    failures = [row for row in results if not row["passed"]]
    if failures:
        print("\nFailures:")
        for row in failures:
            print(f"- {row['id']}: score={row['score']} expected={row['expected']}")
            if row["opening"] and not row["opening_ok"]:
                print(f"  opening={row['opening']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate matcher score ranges on fixed JD cases.")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="Path to eval_cases.json")
    parser.add_argument("--llm", action="store_true", help="Use the real DeepSeek/LLM chain")
    args = parser.parse_args()

    resume_text, cases = load_cases(args.cases)
    if not cases:
        print(f"No cases found in {args.cases}", file=sys.stderr)
        return 2

    results = [evaluate_case(case, resume_text, args.llm) for case in cases]
    print_results(results, args.llm)
    return 0 if all(row["passed"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
