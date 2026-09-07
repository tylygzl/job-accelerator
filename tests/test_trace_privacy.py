from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


class TracePrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)
        self.headers: dict[str, str] = {}
        if server._ACCESS_TOKEN:
            self.headers["x-job-accelerator-token"] = server._ACCESS_TOKEN

        self.original_trace_enabled = server._TRACE_ENABLED
        self.original_trace_detail = server._TRACE_DETAIL
        self.original_trace_path = server._TRACE_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        server._TRACE_ENABLED = True
        server._TRACE_DETAIL = "full"
        server._TRACE_PATH = Path(self.tmpdir.name) / "match_trace.jsonl"

    def tearDown(self) -> None:
        server._TRACE_ENABLED = self.original_trace_enabled
        server._TRACE_DETAIL = self.original_trace_detail
        server._TRACE_PATH = self.original_trace_path
        self.tmpdir.cleanup()

    def test_match_trace_does_not_store_raw_private_text(self) -> None:
        jd_text = (
            "岗位：AI 应用开发实习生\n"
            "宣讲联系人张三，手机号 13800138000，山东理工大学专场。\n"
            "要求熟悉 Python、FastAPI、RAG、向量检索和 LLM API。"
        )
        resume_text = (
            "姓名：张三\n"
            "电话：13800138000\n"
            "学校：山东理工大学\n"
            "项目：rag-engine，使用 Python、FastAPI、FAISS 做 RAG 检索和评测。"
        )

        response = self.client.post(
            "/match",
            json={"jd_text": jd_text, "resume_text": resume_text, "mode": "fast"},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(server._TRACE_PATH.exists())

        lines = server._TRACE_PATH.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        serialized = json.dumps(record, ensure_ascii=False)

        for private_text in ["张三", "13800138000", "山东理工大学", "宣讲联系人", "姓名：", "电话：", "学校："]:
            self.assertNotIn(private_text, serialized)

        for forbidden_key in ["preview", "text", "match_reason", "advice", "opening_message", "llm_return_result"]:
            self.assertFalse(self._has_key(record, forbidden_key), forbidden_key)

        self.assertEqual(set(record["user_input"]["jd_text"].keys()), {"chars", "sha256"})
        self.assertEqual(set(record["user_input"]["resume_text"].keys()), {"chars", "sha256"})
        self.assertIn("skills", record["job_skills"]["counts"])
        self.assertIn("skills", record["resume_skills"]["counts"])

    def test_relative_trace_path_resolves_under_user_data_dir(self) -> None:
        path = server.resolve_trace_path("logs/match_trace.jsonl")
        repo_root = Path(__file__).resolve().parents[1]
        self.assertTrue(path.is_absolute())
        self.assertFalse(path.is_relative_to(repo_root))
        self.assertIn(".job-accelerator", str(path))

    def _has_key(self, value: object, target: str) -> bool:
        if isinstance(value, dict):
            return target in value or any(self._has_key(item, target) for item in value.values())
        if isinstance(value, list):
            return any(self._has_key(item, target) for item in value)
        return False


if __name__ == "__main__":
    unittest.main()
