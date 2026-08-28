"""Feature B: the ai-engine base prompt teaches the model about vectant.programs.json.

Loads llm/prompts.py directly (importlib) so it runs on bare python — prompts.py
imports only stdlib, so no Gemini/other deps are pulled.
"""

import importlib.util
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_prompts():
    path = os.path.join(ROOT, "llm", "prompts.py")
    spec = importlib.util.spec_from_file_location("vectant_prompts_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ManifestReferenceTest(unittest.TestCase):
    def test_base_instructions_mention_the_manifest(self):
        mod = _load_prompts()
        self.assertIn("vectant.programs.json", mod.base_instructions)
        self.assertIn("runtimeType", mod.base_instructions)

    def test_build_prompt_carries_the_reference(self):
        mod = _load_prompts()
        out = mod.build_prompt("print('hi')", "python", user_prompt="what is this")
        self.assertIn("vectant.programs.json", out)
        self.assertIn("program.launch", out)  # a scope name, so the model can author permissions


if __name__ == "__main__":
    unittest.main()
