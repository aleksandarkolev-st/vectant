#!/usr/bin/env python3
"""Operator CLI for Failure Distiller capsules.

Install this module as the ``vectant`` console entry point, or invoke it
directly during local development:

    python vectant_repro.py repro run .vectant/capsules/capsule_x
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict

from analyzer.proactive.healing.failure_distiller import DistillationError, FailureDistiller


def _read_json(path: str) -> Dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DistillationError(f"cannot read JSON input: {path}") from exc


def _emit(value: Dict[str, Any]) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


async def _execute(args: argparse.Namespace) -> Dict[str, Any]:
    # The CLI is a local operator tool.  Production API execution always uses
    # the fail-closed container backend; fixture authors can exercise logical
    # capsules locally without granting that exception to the service.
    distiller = FailureDistiller()
    if args.command == "distill":
        return await distiller.distill(_read_json(args.request))
    if args.command == "run":
        return await distiller.run(args.capsule_path)
    if args.command == "materialize":
        request = {"capsulePath": args.capsule_path}
        if args.destination:
            request["destination"] = args.destination
        return await distiller.materialize(request)
    if args.command == "delete":
        return distiller.discard(args.capsule_path)
    if args.command == "purge-expired":
        return distiller.purge_expired(args.workspace_root)
    if args.command == "metrics":
        return {"ok": True, "metrics": distiller.metrics()}
    if args.command == "vivarium-export":
        return distiller.export_vivarium_manifest(args.capsule_path)
    if args.command == "vivarium-promote":
        return distiller.promote_vivarium_scenario(args.capsule_path, args.mode)
    if args.command == "validate-patch":
        request = _read_json(args.edits)
        request["capsulePath"] = args.capsule_path
        return await distiller.validate_patch(request)
    if args.command == "explain":
        return distiller.explain(args.capsule_path, args.unit)
    raise DistillationError("unsupported repro command")


def main() -> int:
    parser = argparse.ArgumentParser(prog="vectant", description="Create and operate evidence-backed failure capsules")
    repro = parser.add_subparsers(dest="namespace", required=True)
    repro_parser = repro.add_parser("repro", help="Failure capsule commands")
    commands = repro_parser.add_subparsers(dest="command", required=True)
    distill = commands.add_parser("distill", help="Create a capsule from a JSON request")
    distill.add_argument("--request", required=True, help="Distillation request JSON")
    run = commands.add_parser("run", help="Run a capsule's recorded reproducer")
    run.add_argument("capsule_path")
    materialize = commands.add_parser("materialize", help="Create a physical capsule workspace")
    materialize.add_argument("capsule_path")
    materialize.add_argument("--destination")
    delete = commands.add_parser("delete", help="Permanently delete a capsule and record an audit event")
    delete.add_argument("capsule_path")
    purge = commands.add_parser("purge-expired", help="Delete only capsules whose declared retention has expired")
    purge.add_argument("workspace_root")
    commands.add_parser("metrics", help="Show Failure Distiller quality and cost metrics")
    vivarium = commands.add_parser("vivarium-export", help="Export a sanitized deterministic Vivarium scenario manifest")
    vivarium.add_argument("capsule_path")
    promote = commands.add_parser("vivarium-promote", help="Promote an original-world-validated capsule into a Vivarium artifact")
    promote.add_argument("capsule_path")
    promote.add_argument("--mode", choices=["regression", "practice"], default="regression")
    explain = commands.add_parser("explain", help="Explain a retained or removed unit")
    explain.add_argument("capsule_path")
    explain.add_argument("unit")
    validate = commands.add_parser("validate-patch", help="Map and validate production edits")
    validate.add_argument("capsule_path")
    validate.add_argument("--edits", required=True, help="JSON containing an edits array")
    args = parser.parse_args()
    try:
        result = asyncio.run(_execute(args))
    except DistillationError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2
    _emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
