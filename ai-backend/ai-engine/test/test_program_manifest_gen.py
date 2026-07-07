"""Tests for vectant.programs.json manifest generation (Gemini).

unittest.TestCase so it runs under bare `python` here (no pytest / Gemini SDK
needed — the provider is faked) and under pytest in CI.
"""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from program_manifest_gen import generate_manifest


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


PAYLOAD = {"files": {"package.json": '{"scripts":{"dev":"next dev"}}'}, "workspace_name": "team"}
MANIFEST = {
    "packageId": "team-app", "version": "1.0.0", "runtimeType": "web",
    "launch": "npm run dev", "ports": [3000], "permissions": ["program.launch"],
}


class GenerateManifestTest(unittest.TestCase):
    def test_returns_parsed_manifest(self):
        prov = FakeProvider(reply=json.dumps(MANIFEST))
        out = asyncio.run(generate_manifest(PAYLOAD, provider=prov))
        self.assertEqual(out["manifest"]["packageId"], "team-app")
        self.assertEqual(prov.calls[0]["mode"], "rule_translate")

    def test_extracts_json_from_fence(self):
        prov = FakeProvider(reply="```json\n" + json.dumps(MANIFEST) + "\n```")
        out = asyncio.run(generate_manifest(PAYLOAD, provider=prov))
        self.assertEqual(out["manifest"]["runtimeType"], "web")

    def test_failclosed_on_unparseable(self):
        out = asyncio.run(generate_manifest(PAYLOAD, provider=FakeProvider(reply="sorry, no idea")))
        self.assertIn("error", out)
        self.assertNotIn("manifest", out)

    def test_failclosed_on_exception(self):
        out = asyncio.run(generate_manifest(PAYLOAD, provider=FakeProvider(exc=RuntimeError("down"))))
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
