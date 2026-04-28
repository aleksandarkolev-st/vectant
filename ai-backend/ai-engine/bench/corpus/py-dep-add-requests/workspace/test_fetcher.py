from unittest.mock import patch

import fetcher


class _StubResp:
    status_code = 200


def test_uses_requests_get():
    with patch.object(fetcher, "requests", create=True) as r:
        r.get.return_value = _StubResp()
        assert fetcher.fetch_status("http://example.com") == 200
        r.get.assert_called_once()
        # Timeout argument is required.
        kwargs = r.get.call_args.kwargs
        assert kwargs.get("timeout") == 5


def test_requirements_pin():
    text = open("requirements.txt").read()
    assert "requests" in text
