from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


class HealthPrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)

    def test_health_does_not_expose_llm_base_url(self) -> None:
        sensitive_url = "https://private-llm-gateway.invalid/v1"
        sensitive_trace_path = "/root/private-job-accelerator/secrets/match_trace.jsonl"
        llm_summary = {
            "provider": "openai-compatible",
            "model": "example-model",
            "base_url": sensitive_url,
            "api_key_configured": True,
            "supported_providers": ["none", "openai-compatible"],
            "proxy_configured": False,
            "local_fallback": False,
        }
        trace_summary = {
            "enabled": True,
            "detail": "summary",
            "path": sensitive_trace_path,
        }

        with (
            patch.object(server, "llm_config_summary", return_value=llm_summary),
            patch.object(server, "trace_summary", return_value=trace_summary),
        ):
            response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        serialized = response.text
        self.assertNotIn("base_url", serialized)
        self.assertNotIn(sensitive_url, serialized)
        self.assertNotIn(sensitive_trace_path, serialized)

        body = response.json()
        self.assertTrue(body["success"])
        data = body["data"]
        self.assertEqual(data["llm"]["provider"], "openai-compatible")
        self.assertEqual(data["llm"]["model"], "example-model")
        self.assertTrue(data["llm"]["api_key_configured"])
        self.assertIn("limits", data)
        self.assertEqual(
            data["trace"],
            {"enabled": True, "detail": "summary", "path_configured": True},
        )


if __name__ == "__main__":
    unittest.main()
