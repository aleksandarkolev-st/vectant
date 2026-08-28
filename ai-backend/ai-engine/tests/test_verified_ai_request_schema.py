import unittest

from main import VerifiedAiRequest


class VerifiedAiRequestSchemaTests(unittest.TestCase):
    def test_resolves_provider_receipt_shape(self):
        request = VerifiedAiRequest.model_validate(
            {
                "code": 'extern "C" __global__ void kernel() {}',
                "lang": "cpp",
                "provider": "gemini",
                "model": "gemini-3.5-flash",
                "require_provider_call": True,
                "provider_call_request": {
                    "schema_version": "synthi.gpu_hmr.provider_request_binding.v2",
                    "requested_provider": "gemini",
                },
                "provider_call_request_hash": "sha256:" + "a" * 64,
            }
        )

        self.assertEqual(
            request.provider_call_request,
            {
                "schema_version": "synthi.gpu_hmr.provider_request_binding.v2",
                "requested_provider": "gemini",
            },
        )


if __name__ == "__main__":
    unittest.main()
