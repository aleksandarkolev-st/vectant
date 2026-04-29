import urllib.request


def fetch_status(url):
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status
