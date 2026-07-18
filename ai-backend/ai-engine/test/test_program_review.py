"""Tests for community-app risk assessment (Phase 2, advisory).

Written as unittest.TestCase so it runs under both `python test/test_program_review.py`
(no pytest needed — the LLM deps are not installed in every dev env) and pytest in
CI. The provider is faked, so no real Gemini call and no google SDK import.
"""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from program_review import assess_program_risk


class FakeProvider:
    def __init__(self, reply=None, exc=None):
        self._reply = reply
        self._exc = exc
        self.calls = []

    async def ask_llm(self, code="", lang="", prompt=None, mode=None, **kwargs):
        self.calls.append({"prompt": prompt, "mode": mode})
        if self._exc:
            raise self._exc
        return self._reply


PAYLOAD = {
    "manifest": {"packageId": "tool", "runtimeType": "container", "permissions": ["program.launch"], "launch": "docker run reg.io/me/tool:1"},
    "scan_summary": {"decisiveCves": [], "severityCounts": {"HIGH": 0}},
    "source_image_ref": "reg.io/me/tool:1",
    "description": "a db client",
}


class AssessProgramRiskTest(unittest.TestCase):
    def test_parses_clean_low_risk_json(self):
        prov = FakeProvider(reply=json.dumps({"risk_score": 0.1, "flags": [], "rationale": "looks fine"}))
        out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
        self.assertEqual(out["risk_score"], 0.1)
        self.assertEqual(out["flags"], [])
        self.assertIn("rationale", out)
        # prompt sent verbatim (rule_translate mode → structured JSON)
        self.assertEqual(prov.calls[0]["mode"], "rule_translate")

    def test_extracts_json_from_fenced_block(self):
        prov = FakeProvider(reply='```json\n{"risk_score": 0.4, "flags": ["network"], "rationale": "calls out"}\n```')
        out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
        self.assertEqual(out["risk_score"], 0.4)
        self.assertEqual(out["flags"], ["network"])

    def test_failclosed_on_unparseable_reply(self):
        prov = FakeProvider(reply="not json at all")
        out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
        self.assertEqual(out["risk_score"], 1.0)
        self.assertIn("ai_unavailable", out["flags"])

    def test_failclosed_on_provider_exception(self):
        prov = FakeProvider(exc=RuntimeError("gemini down"))
        out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
        self.assertEqual(out["risk_score"], 1.0)
        self.assertIn("ai_unavailable", out["flags"])

    def test_clamps_and_coerces_out_of_range_score(self):
        prov = FakeProvider(reply=json.dumps({"risk_score": 5, "flags": "oops", "rationale": 123}))
        out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
        self.assertEqual(out["risk_score"], 1.0)          # clamped to [0,1]
        self.assertIsInstance(out["flags"], list)         # coerced
        self.assertIsInstance(out["rationale"], str)


if __name__ == "__main__":
    unittest.main()
