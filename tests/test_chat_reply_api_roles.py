from __future__ import annotations

import sys
import os
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pipeline
import server


class ChatReplyApiRoleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)
        self.headers: dict[str, str] = {}
        if server._ACCESS_TOKEN:
            self.headers["x-job-accelerator-token"] = server._ACCESS_TOKEN

    def post_reply(self, payload: dict) -> dict:
        response = self.client.post("/chat/reply", json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        return body["data"]

    def test_last_role_me_returns_no_action(self) -> None:
        data = self.post_reply(
            {
                "hr_message": "你有 Flutter 或 Rust 相关经验吗？",
                "conversation": [
                    {"role": "hr", "content": "你有 Flutter 或 Rust 相关经验吗？"},
                    {
                        "role": "me",
                        "content": "Flutter 和 Rust 目前不是我的主项目方向，我主要做 Python、FastAPI、RAG 和 Agent 项目。",
                    },
                ],
            }
        )
        self.assertEqual(data["action_policy"], "no_action")
        self.assertFalse(data["should_fill"])
        self.assertEqual(data["draft"], "")
        self.assertIn("用户已回复，避免重复回复", data["reason"])

    def test_last_role_candidate_returns_no_action(self) -> None:
        data = self.post_reply(
            {
                "hr_message": "你有 Flutter 或 Rust 相关经验吗？",
                "conversation": [
                    {"role": "hr", "content": "你有 Flutter 或 Rust 相关经验吗？"},
                    {
                        "role": "candidate",
                        "content": "Flutter 和 Rust 目前不是我的主项目方向，我主要做 Python、FastAPI、RAG 和 Agent 项目。",
                    },
                ],
            }
        )
        self.assertEqual(data["action_policy"], "no_action")
        self.assertFalse(data["should_fill"])
        self.assertEqual(data["draft"], "")
        self.assertIn("用户已回复，避免重复回复", data["reason"])

    def test_last_role_hr_does_not_return_no_action(self) -> None:
        data = self.post_reply(
            {
                "hr_message": "你有做过 RAG 项目吗？",
                "conversation": [
                    {"role": "candidate", "content": "您好，我想了解一下这个岗位。"},
                    {"role": "hr", "content": "你有做过 RAG 项目吗？"},
                ],
                "jd_text": "岗位要求：熟悉 RAG、向量检索和 LLM API。",
                "resume_profile": {
                    "skills": {
                        "must_have": [
                            {
                                "skill": "RAG",
                                "level": "项目经验",
                                "evidence": "做过 rag-engine，包含文档切分、向量检索和评测。",
                            }
                        ],
                        "familiar": [],
                    },
                    "projects": [],
                },
            }
        )
        self.assertNotEqual(data["action_policy"], "no_action")
        self.assertTrue(data["should_fill"])
        self.assertNotEqual(data["draft"], "")

    def project_reply_with_captured_timeout(self, configured_timeout: float) -> list[float]:
        captured: list[float] = []

        def fake_make_chat_model(**kwargs: object) -> object:
            captured.append(float(kwargs["timeout"]))
            return object()

        with (
            patch.dict(os.environ, {"JOB_ACCELERATOR_CHAT_REPLY_LLM": "true"}),
            patch.object(pipeline, "make_chat_model", side_effect=fake_make_chat_model),
            patch.object(pipeline, "_generate_chat_reply_with_llm", return_value="我做过 rag-engine 项目，包含文档切分、FAISS 检索、RRF 融合和评测。"),
        ):
            result = pipeline._build_project_chat_reply(
                intent="ask_project",
                hr_message="你有做过 RAG 项目吗？",
                jd_text="岗位要求：熟悉 RAG、向量检索和 LLM API。",
                resume_profile={
                    "skills": {
                        "must_have": [
                            {
                                "skill": "RAG",
                                "level": "项目经验",
                                "evidence": "做过 rag-engine，包含文档切分、向量检索和评测。",
                            }
                        ]
                    }
                },
                evidence_context="rag-engine：支持文档切分、FAISS 检索、RRF 融合和评测脚本。",
                evidence_sources=["rag-engine"],
                llm_timeout_seconds=configured_timeout,
                started=time.perf_counter(),
            )

        self.assertEqual(result["reply_mode"], "rag_llm")
        self.assertTrue(result["should_fill"])
        self.assertEqual(result["action_policy"], "fill_draft")
        self.assertTrue(result["draft"])
        return captured

    def test_project_reply_timeout_can_use_eight_second_budget(self) -> None:
        captured = self.project_reply_with_captured_timeout(8.0)
        self.assertEqual(len(captured), 1)
        self.assertGreater(captured[0], 7.0)
        self.assertLessEqual(captured[0], 8.0)

    def test_project_reply_timeout_has_runaway_cap(self) -> None:
        captured = self.project_reply_with_captured_timeout(60.0)
        self.assertEqual(len(captured), 1)
        self.assertGreater(captured[0], 14.0)
        self.assertLessEqual(captured[0], pipeline.CHAT_REPLY_LLM_MAX_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
