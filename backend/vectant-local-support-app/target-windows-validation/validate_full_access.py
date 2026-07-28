import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = os.environ["VECTANT_TEST_BASE"]
TOKEN = os.environ["VECTANT_TEST_TOKEN"]
CONTROL = "live-test-control-secret-012345678901234567"
HEADERS = {
    "Origin": "https://app.vectant.com",
    "Sec-Fetch-Site": "same-site",
    "X-Vectant-Csrf": "csrf_token_12345678901234567890",
    "Authorization": f"Bearer {TOKEN}",
    "X-Vectant-App-Version": "0.1.0",
    "X-Vectant-Protocol-Version": "local-support-mvp.1",
    "X-Vectant-Policy-Version": "2026.07.05",
}
RUN_ID = secrets.token_hex(6)


def request_id(name):
    return f"req_windows_{RUN_ID}_{name}"


def call(path, method="GET", body=None, extra=None, expected=200):
    headers = dict(HEADERS)
    headers.update(extra or {})
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(BASE + path, data=data, headers=headers, method=method), timeout=30) as response:
            assert response.status == expected, (path, response.status)
            return json.loads(response.read().decode())
    except HTTPError as error:
        raw = error.read().decode()
        if error.code != expected:
            raise AssertionError((path, error.code, raw)) from error
        return json.loads(raw)


def device_proof(session, request_id, capability, actor, expires_at):
    digest = sha256(b"vectant-local-support-device-proof-v1")
    for value in [TOKEN, session["session_id"], request_id, session["device_fingerprint"],
                  session["account_id"], session["org_id"], session["workspace_id"],
                  capability, actor, expires_at, "local-support-mvp.1", "2026.07.05"]:
        digest.update(b"\0" + value.encode())
    return "sha256:" + digest.hexdigest()


unauthenticated = dict(HEADERS)
del unauthenticated["Authorization"]
try:
    urlopen(Request(BASE + "/v1/status/" + request_id("unauth"), headers=unauthenticated), timeout=5)
    raise AssertionError("unauthenticated status unexpectedly succeeded")
except HTTPError as error:
    assert error.code == 401, error.code

status = call("/v1/status/" + request_id("status"))
session, workspace = status["session"], status["workspace"]
capabilities = [
    "enroll", "auto_approval_enable", "graph_read", "graph_node_request",
    "command_execute", "command_context_read", "workspace_file_mutate",
    "workspace_file_revert", "process_inventory", "process_listener_metadata",
    "local_port_discover", "local_port_use",
]
policy = {
    "organization_enabled": True, "emergency_paused": False,
    "mandatory_reconsent_version": 1, "policy_major": 1,
    "allowed_capabilities": capabilities, "allowed_actors": ["support_agent"],
    "max_bytes_per_request": 65536, "max_bytes_per_session": 1048576,
    "max_requests_per_minute": 30, "max_concurrent_reads": 2,
    "max_process_records": 25, "allowed_command_executables": ["where.exe", "ping.exe"],
    "max_command_timeout_seconds": 15, "max_command_output_bytes": 4096,
    "max_command_concurrency": 1, "allowed_loopback_ports": [43999],
}
now = datetime.now(timezone.utc)
# The disposable VM's Windows clock is configured as local time but reported
# as UTC. Keep this validation receipt well inside the production maximum
# lifetime while tolerating that host-only clock skew.
expires_at = (now + timedelta(hours=4)).isoformat()
receipt = {
    "consent_id": "consent_windows_full_access_001", "session_id": session["session_id"],
    "account_id": session["account_id"], "organization_id": session["org_id"],
    "support_actor": "support_agent", "device_fingerprint": session["device_fingerprint"],
    "workspace_hash": workspace["root_hash"], "capabilities": capabilities,
    "auto_approval_enabled": True, "policy_version": "2026.07.05",
    "scanner_version": "scanner-2026.07.05", "app_version": "0.1.0",
    "policy_major": 1, "reconsent_version": 1,
    "created_at": now.isoformat().replace("+00:00", "Z"), "expires_at": expires_at,
    "paused_at": None, "revoked_at": None, "local_confirmation": "native_button",
}
enroll_request_id = request_id("enroll")
enrolled = call("/v1/full-access/enroll", "POST", {"request_id": enroll_request_id, "policy": policy, "receipt": receipt}, {
    "X-Vectant-Local-Control-Secret": CONTROL,
    "X-Vectant-Device-Fingerprint": session["device_fingerprint"],
    "X-Vectant-Device-Proof": device_proof(session, enroll_request_id, "full_access.enroll", "support_agent", expires_at),
})
assert enrolled["decision"] == "full_access_enrolled", enrolled
graph = call("/v1/full-access/graph/" + request_id("graph"))
assert graph["raw_bodies_included"] is False
serialized_graph = json.dumps(graph)
assert ".env" not in serialized_graph and "secrets.json" not in serialized_graph
source = next(node for node in graph["graph_nodes"] if node["relative_path"] == "src/main.py")
node = call("/v1/full-access/graph/node", "POST", {
    "request_id": request_id("node"), "node_id": source["node_id"],
    "expected_content_hash": source["content_hash"], "field": "content",
    "range_start": None, "range_end": None, "max_bytes": 4096,
    "reason": "Validate bounded Windows fixture source read",
})
assert node["decision"] == "auto_accepted" and node["content"]
mutation = call("/v1/full-access/mutation", "POST", {
    "request_id": request_id("mutate"), "node_id": source["node_id"],
    "expected_content_hash": source["content_hash"],
    "replacement": "# temporary Windows local validation mutation\nprint('fixture restored')\n",
})
assert mutation["decision"] == "auto_mutated", mutation
reverted = call("/v1/full-access/mutation/revert", "POST", {
    "request_id": request_id("revert"), "transaction_id": mutation["transaction_id"],
    "current_content_hash": mutation["after_hash"],
})
assert reverted["decision"] == "reverted", reverted
processes = call("/v1/full-access/processes/" + request_id("processes"))
assert processes["decision"] == "auto_accepted" and processes["records"], processes
assert "pid" not in json.dumps(processes).lower()
command = call("/v1/full-access/command", "POST", {
    "request_id": request_id("command"), "executable": "where.exe", "arguments": ["where.exe"],
    "timeout_seconds": 5, "max_output_bytes": 4096,
})
assert command["decision"] == "auto_executed", command
timed_out = call("/v1/full-access/command", "POST", {
    "request_id": request_id("command_timeout"), "executable": "ping.exe", "arguments": ["127.0.0.1", "-t"],
    "timeout_seconds": 1, "max_output_bytes": 4096,
}, expected=403)
assert timed_out["reason"] == "full_access_command_timedout", timed_out
final = call("/v1/status/" + request_id("final"))
assert final["history"]["events"]
print(json.dumps({
    "unauthenticated_status": 401, "enrollment": enrolled["decision"],
    "graph_nodes": len(graph["graph_nodes"]), "node_read": node["decision"],
    "mutation": mutation["decision"], "revert": reverted["decision"],
    "command": command["decision"], "command_timeout": timed_out["reason"],
    "windows_process_records": len(processes["records"]),
}, sort_keys=True))
