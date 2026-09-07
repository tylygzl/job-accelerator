from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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


if __name__ == "__main__":
    unittest.main()
