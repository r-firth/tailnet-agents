"""Model input budgets preserve requests and refer back to durable evidence."""

import json
import unittest

from context import compact, conversation_context, tool_context


class ContextTests(unittest.TestCase):
    def test_total_budget_keeps_current_request_and_recent_evidence(self):
        history = [
            {"id": 0, "kind": "message.user", "payload": {"text": "original request"}}
        ]
        history.extend(
            {
                "id": i,
                "scope": "c",
                "kind": "tool.result",
                "payload": {
                    "name": "terminal_read",
                    "result": {"ok": True, "output": '\\"🌍\n' * 10_000},
                },
            }
            for i in range(1, 105)
        )
        task = {"history": history, "devices": [], "sessions": []}
        rendered = conversation_context(task)
        self.assertLessEqual(len(rendered.encode()), 240_000)
        result = json.loads(rendered)
        self.assertEqual(result["history"][0], history[0])
        self.assertEqual(result["history"][-1]["id"], 104)
        self.assertGreater(result["omitted_history_events"], 0)
        self.assertIn(
            "Context excerpt", result["history"][-1]["payload"]["result"]["output"]
        )

    def test_multiple_tool_receipts_share_one_budget(self):
        receipts = [
            {
                "name": "terminal_read",
                "result": {"ok": True, "output": "output\n" * 40_000},
            }
            for _ in range(12)
        ]
        rendered = tool_context(receipts)
        self.assertLessEqual(len(rendered.encode()), 48_000)
        self.assertEqual(len(json.loads(rendered)["tool_receipts"]), 12)

    def test_pathological_shapes_and_unicode_stay_within_budget(self):
        nested = "evidence" * 10_000
        for _ in range(20):
            nested = {"nested": nested}
        for value in [
            nested,
            {"long key" * 10_000: "value"},
            list(range(100_000)),
            '"\\\n🌍' * 10_000,
        ]:
            with self.subTest(kind=type(value).__name__):
                result = compact(value, 4096)
                self.assertLessEqual(
                    len(
                        json.dumps(
                            result, ensure_ascii=False, separators=(",", ":")
                        ).encode()
                    ),
                    4096,
                )

    def test_small_results_are_unchanged(self):
        value = {"ok": False, "error": "Device unavailable", "session_id": "session-1"}
        self.assertEqual(compact(value), value)
