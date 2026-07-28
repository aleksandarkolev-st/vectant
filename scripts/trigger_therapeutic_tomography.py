#!/usr/bin/env python3
"""
Generate and validate the Agent Therapeutic Tomography demo trace.

This script is intentionally local and deterministic. It does not deploy and it
does not require app login. It builds the MCP package, asks the tomography module
to emit the proof-gated quality-drop trace, writes an app-consumable workflow
state JSON payload, and runs the visual self-check that renders HTML/SVG proof
artifacts into PNG screenshots.

Usage:
  python scripts/trigger_therapeutic_tomography.py
  python scripts/trigger_therapeutic_tomography.py --workspace my-workspace --open
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import webbrowser
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MCP_ROOT = REPO_ROOT / "mcp" / "synthi-mcp"
OUT_DIR = REPO_ROOT / "tmp" / "dojo-therapeutic-tomography"
NPM = "npm.cmd" if os.name == "nt" else "npm"


def run(command: list[str], cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
    print(f"$ {' '.join(command)}", flush=True)
    result = subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result


def node_json(script: str, cwd: Path = REPO_ROOT) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8") as handle:
        handle.write(script)
        script_path = Path(handle.name)
    try:
        result = subprocess.run(
            ["node", str(script_path)],
            cwd=str(cwd),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode != 0:
            print(result.stdout)
            raise SystemExit(result.returncode)
        return json.loads(result.stdout)
    finally:
        script_path.unlink(missing_ok=True)


def build_trace() -> dict:
    dist_module = (MCP_ROOT / "dist" / "dojo" / "tomography" / "index.js").as_posix()
    script = textwrap.dedent(
        f"""
        import * as tomography from "file:///{dist_module}";
        const trace = tomography.buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
        const proof = trace.proof_capsules[0];
        const proofCache = tomography.evaluateProofCache({{
          trace,
          request: proof.requested_access,
          proof_capsule: proof,
        }});
        const probeBundle = tomography.buildSafeProbeBundle({{
          name: "safe_quality_drop_probe_bundle",
          task_class: trace.task_class,
          current_authority_dose: 2,
          contracts: tomography.THERAPEUTIC_ML_QUALITY_DROP_PROBES,
        }});
        const proofMetrics = tomography.summarizeProofMetrics({{
          decisions: [
            {{
              decision: "denied",
              tier: 3,
              blocked_by: trace.blocked_overreach_attempts[0].reason,
              suggested_alternatives: trace.suggested_lower_risk_alternatives,
              verification_latency_ms: 7,
              human_reviewed: true,
              token_count: 0,
            }},
            {{
              decision: "approved",
              tier: 1,
              blocked_by: [],
              suggested_alternatives: [],
              verification_latency_ms: 18,
              cache_hit: proofCache.cache_hit,
              probe_bundle_success: probeBundle.decision === "allowed",
              token_count: 0,
            }},
          ],
        }});
        process.stdout.write(JSON.stringify({{
          trace,
          proofCache,
          probeBundle: {{
            ...probeBundle,
            probes: probeBundle.probes.map((probe) => probe.name),
          }},
          proofMetrics,
        }}, null, 2));
        """
    ).strip()
    return node_json(script)


def write_outputs(payload: dict, workspace: str) -> dict[str, Path]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    trace = payload["trace"]
    workflow_state = {
        "status": "ready",
        "workspace_slug": workspace,
        "tomography": trace,
        "therapeuticTomography": trace,
        "dojo": {
            "tomography": trace,
            "therapeuticTomography": trace,
        },
        "therapeuticProofControls": {
            "probeBundle": payload["probeBundle"],
            "proofCache": payload["proofCache"],
            "proofMetrics": payload["proofMetrics"],
        },
    }
    files = {
        "trace": OUT_DIR / "triggered-therapeutic-trace.json",
        "workflow_state": OUT_DIR / "triggered-workflow-state.json",
        "proof_controls": OUT_DIR / "triggered-proof-controls.json",
    }
    files["trace"].write_text(json.dumps(trace, indent=2) + "\n", encoding="utf-8")
    files["workflow_state"].write_text(json.dumps(workflow_state, indent=2) + "\n", encoding="utf-8")
    files["proof_controls"].write_text(
        json.dumps(
            {
                "probeBundle": payload["probeBundle"],
                "proofCache": payload["proofCache"],
                "proofMetrics": payload["proofMetrics"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default="visual-dojo", help="Workspace slug for the app route.")
    parser.add_argument("--open", action="store_true", help="Open the Docker frontend tomography route.")
    parser.add_argument("--skip-build", action="store_true", help="Use the existing mcp/synthi-mcp dist build.")
    args = parser.parse_args()

    if not args.skip_build:
        run([NPM, "--prefix", "mcp/synthi-mcp", "run", "build"])

    payload = build_trace()
    files = write_outputs(payload, args.workspace)

    run(
        [
            NPM,
            "--prefix",
            "mcp/synthi-mcp",
            "run",
            "proof:dojo:therapeutic-tomography:self-check",
        ]
    )

    trace = payload["trace"]
    proof = trace["proof_capsules"][0]
    print("\nTriggered therapeutic tomography trace:")
    print(f"  task_id: {trace['task_id']}")
    print(f"  diagnosis: {trace['diagnosis']}")
    print(f"  proof_capsule: {proof['id']} approved={proof['approved']}")
    print(f"  avoided_access: {', '.join(trace['avoided_access'])}")
    print("\nWrote:")
    for label, path in files.items():
        print(f"  {label}: {path}")
    print(f"  visual evidence: {OUT_DIR / 'therapeutic-tomography.evidence.json'}")
    print(f"  html screenshot: {OUT_DIR / 'therapeutic-trace-html-render.png'}")
    print(f"  svg screenshot: {OUT_DIR / 'therapeutic-trace-svg-render.png'}")

    if args.open:
        url = f"http://127.0.0.1:3000/workspace/{args.workspace}/dojo/therapeutic-trace"
        print(f"\nOpening Docker frontend route: {url}")
        webbrowser.open(url)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
