"""GPU edit classifier and GPU diff-patch helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional

try:
    from pydantic import BaseModel
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

from agents.abi_stamper import constant_layout_hash, stamp_device_source
from gpu_hmr.reason_codes import UnknownReasonCodeError, assert_registered_reason_codes
from llm.prompts import GPU_DIFF_PATCH_PROMPT


ReloadPlan = str
VALID_RELOAD_PLANS = {"host_only", "device_only", "mixed", "abi_breaking"}
VALID_GPU_EDIT_MODULES = {"core", "gui", "shared", "host_runner", "device"}
VALID_GPU_EDIT_OPS = {"insert_after", "insert_before", "replace", "delete"}
DEVICE_PATHS = {"device.cu", "device.hip"}
_QUOTED_INCLUDE_RE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.MULTILINE)
_SHA256_DIGEST_RE = re.compile(r"^(?:sha256:)?[0-9a-fA-F]{64}$")
FISSION_CANDIDATE_STRING_FIELDS = {
    "abiMembraneId",
    "aiProposalId",
    "artifactScope",
    "artifactKind",
    "candidateSource",
    "compileCommandHash",
    "compileRecipeHash",
    "dependencyClosureHash",
    "expectedAbiScope",
    "generatedRolePath",
    "islandId",
    "originalHostLaunchMappingId",
    "plannerSource",
    "replacementScope",
    "requiredOracleId",
    "safeExportSupersetReason",
    "scope",
    "sourceEditId",
}
FISSION_CANDIDATE_SHA256_FIELDS = {
    "compileCommandHash",
    "compileRecipeHash",
    "dependencyClosureHash",
}
FISSION_CANDIDATE_STRING_LIST_FIELDS = {
    "abiEvidenceIds",
    "abiMembraneEvidenceIds",
    "attachmentInstrumentationProposalIds",
    "compileCommandEvidenceIds",
    "compileEvidenceIds",
    "compileRecipeEvidenceIds",
    "dependencyClosureEvidenceIds",
    "evidenceIds",
    "exportedSymbolsExpected",
    "includeClosure",
    "includeClosureEvidenceIds",
    "loaderCapabilityEvidenceIds",
    "loaderEvidenceIds",
    "oracleEvidenceIds",
    "originalHostAttachmentInstrumentationProposalIds",
    "originalHostLaunchMappingEvidenceIds",
    "originalHostPathEvidenceIds",
    "outputOracleEvidenceIds",
    "proofEvidenceIds",
    "proofFailureReasonCodes",
    "rejectionEvidenceIds",
    "safeExportSupersetEvidenceIds",
    "sourceMappingEvidenceIds",
    "sourceMapEvidenceIds",
    "sourcePaths",
    "symbolOwnershipEvidenceIds",
    "symbols",
    "targetSymbols",
    "verifierEvidenceIds",
}
FISSION_CANDIDATE_OBJECT_FIELDS = {
    "loaderCapabilityRequirement",
    "oracleProposal",
    "originalHostPathRequirement",
    "outputOracleProposal",
    "runtimeAttachmentRequirement",
    "runtimeOwnershipRequirement",
}
FISSION_CANDIDATE_BOOL_FIELDS = {
    "aiGenerated",
    "aiProposalIdRequired",
    "generatedRolePathRequired",
    "llmGenerated",
    "originalHostLaunchMappingRequired",
    "requiresOriginalHostPath",
}
FISSION_CANDIDATE_NON_NEGATIVE_INT_FIELDS = {
    "compileCostEstimateMs",
    "compileCostMs",
    "compileEstimateMs",
    "estimatedCompileMs",
    "historicalCompileMs",
    "historicalTimingMs",
    "lastCompileMs",
    "meanCompileMs",
    "p50CompileMs",
}
FISSION_CANDIDATE_ALIASES = {
    "hostLaunchAttachmentProposals": "attachmentInstrumentationProposals",
    "launchAttachmentProposals": "attachmentInstrumentationProposals",
    "oracleProposal": "outputOracleProposal",
    "originalHostAttachmentInstrumentationProposals": "attachmentInstrumentationProposals",
    "originalHostAttachmentProposalIds": "originalHostAttachmentInstrumentationProposalIds",
    "symbols": "targetSymbols",
}
FISSION_ATTACHMENT_PROPOSAL_REQUIRED_BOUNDARY_APIS = {
    "synthi_gpu_launch_original_host_path",
    "synthi_gpu_launch_source_location",
    "synthi_original_host_path_with_provenance",
}
FISSION_ATTACHMENT_PROPOSAL_ACTIONS = {
    "upgrade_runtime_boundary_to_original_host_attachment",
    "attach_runtime_object_dispatch_boundary",
    "wrap_source_launch_with_synthi_runtime_boundary",
    "instrument_host_launch_boundary",
}
FISSION_ATTACHMENT_PROPOSAL_STRING_FIELDS = {
    "dispatchEntryId",
    "hostPathId",
    "instrumentationAction",
    "kernel",
    "path",
    "proposalId",
    "reason",
    "runtimeProofBoundary",
    "snippetHash",
    "sourceLaunchSiteId",
    "sourceHash",
    "sourcePath",
    "sourceProvenance",
}
FISSION_ATTACHMENT_PROPOSAL_RUNTIME_EVIDENCE_BOOL_FIELDS = {
    "dispatchBoundaryObserved",
    "dispatchEntryRuntimeVerified",
    "launchArgProvenanceComplete",
    "runtimeSessionScoped",
}
FISSION_OUTPUT_ORACLE_STRING_FIELDS = {
    "artifact",
    "artifactId",
    "artifact_id",
    "expected",
    "expectedHash",
    "expectedValue",
    "expected_hash",
    "expected_value",
    "id",
    "kind",
    "oracleId",
    "oracle_id",
    "outputTarget",
    "outputTargetId",
    "output_target",
    "output_target_id",
    "probeMode",
    "producer",
    "producerId",
    "producerSubsystem",
    "producer_id",
    "producer_subsystem",
    "readbackPlan",
    "runtimeSession",
    "runtimeSessionId",
    "runtime_session",
    "runtime_session_id",
    "sessionId",
    "session_id",
    "target",
    "visualEvidenceRef",
    "visualRef",
    "visual_evidence_ref",
    "visual_ref",
}
FISSION_OUTPUT_ORACLE_NUMERIC_FIELDS = {
    "absoluteTolerance",
    "absTolerance",
    "absolute_tolerance",
    "abs_tolerance",
    "tolerance",
}
FISSION_REJECTION_STRING_FIELDS = {
    "artifactKind",
    "artifactScope",
    "reasonCode",
    "replacementScope",
    "scope",
}
FISSION_REJECTION_STRING_LIST_FIELDS = {
    "evidenceIds",
    "proofEvidenceIds",
    "reasonCodes",
    "rejectionEvidenceIds",
    "verifierEvidenceIds",
}
HOST_PATH_TO_MODULE = {
    "core.cpp": "core",
    "gui.cpp": "gui",
    "shared.h": "shared",
    "host_runner.cpp": "host_runner",
}


class GpuDiffPatchRequest(BaseModel):
    diff: str
    core_content: str = ""
    gui_content: str = ""
    shared_content: str = ""
    host_runner_content: str = ""
    device_content: str = ""
    architecture: Optional[str] = None
    mapping_report: Optional[Any] = None
    compile_manifest: Optional[Any] = None
    reload_plan_report: Optional[Any] = None
    reload_plan: Optional[ReloadPlan] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


@dataclass(frozen=True)
class ModDeltaClassification:
    reload_plan: ReloadPlan
    changed_paths: List[str]
    old_kernel_hashes: Dict[str, str]
    new_kernel_hashes: Dict[str, str]
    reason: str

    def to_dict(self) -> dict:
        return {
            "reload_plan": self.reload_plan,
            "changed_paths": self.changed_paths,
            "old_kernel_hashes": self.old_kernel_hashes,
            "new_kernel_hashes": self.new_kernel_hashes,
            "reason": self.reason,
        }


def classify_mod_delta(
    before_files: Mapping[str, str],
    after_files: Mapping[str, str],
    manifest_gpu: Optional[Mapping[str, object]] = None,
) -> ModDeltaClassification:
    """Classify a file delta into the worker reload plan."""
    all_paths = sorted(set(before_files) | set(after_files))
    changed = [p for p in all_paths if before_files.get(p, "") != after_files.get(p, "")]

    old_device = _device_source(before_files)
    new_device = _device_source(after_files)
    old_hashes = stamp_device_source(old_device)
    new_hashes = stamp_device_source(new_device)

    if _rdc_enabled(manifest_gpu):
        return ModDeltaClassification(
            reload_plan="abi_breaking",
            changed_paths=changed,
            old_kernel_hashes=old_hashes,
            new_kernel_hashes=new_hashes,
            reason="rdc-enabled-forces-cold-reload",
        )

    device_changed = any(_is_device_path(p) for p in changed)
    host_changed = any(_is_host_path(p) for p in changed)
    constant_changed = constant_layout_hash(old_device) != constant_layout_hash(new_device)
    signatures_changed = old_hashes != new_hashes

    if signatures_changed or constant_changed:
        return ModDeltaClassification(
            reload_plan="abi_breaking",
            changed_paths=changed,
            old_kernel_hashes=old_hashes,
            new_kernel_hashes=new_hashes,
            reason="kernel-signature-or-constant-layout-changed",
        )
    if device_changed and host_changed:
        plan, reason = "mixed", "host-and-device-files-changed"
    elif device_changed:
        plan, reason = "device_only", "device-file-only-edit"
    else:
        plan, reason = "host_only", "host-only-edit"
    return ModDeltaClassification(
        reload_plan=plan,
        changed_paths=changed,
        old_kernel_hashes=old_hashes,
        new_kernel_hashes=new_hashes,
        reason=reason,
    )


def build_gpu_diff_patch_prompt(req: GpuDiffPatchRequest) -> str:
    replacements = {
        "{ARCHITECTURE}": req.architecture or "",
        "{MAPPING_REPORT}": _json_block(req.mapping_report),
        "{COMPILE_MANIFEST}": _json_block(req.compile_manifest),
        "{RELOAD_PLAN_REPORT}": _json_block(req.reload_plan_report),
        "{SHARED_CONTENT}": req.shared_content or "",
        "{CORE_CONTENT}": req.core_content or "",
        "{GUI_CONTENT}": req.gui_content or "",
        "{HOST_RUNNER_CONTENT}": req.host_runner_content or "",
        "{DEVICE_CONTENT}": req.device_content or "",
        "{DIFF}": req.diff or "",
    }
    prompt = GPU_DIFF_PATCH_PROMPT
    for needle, value in replacements.items():
        prompt = prompt.replace(needle, value)
    if req.reload_plan:
        prompt += f"\n\nClassifier reload_plan hint: {req.reload_plan}\n"
    return prompt


def gpu_diff_patch_anchor_failures(
    req: GpuDiffPatchRequest,
    edits: Iterable[Mapping[str, object]],
) -> List[dict]:
    contents = {
        "shared": req.shared_content or "",
        "core": req.core_content or "",
        "gui": req.gui_content or "",
        "host_runner": req.host_runner_content or "",
        "device": req.device_content or "",
    }
    failures: List[dict] = []
    for index, edit in enumerate(edits):
        module = _normalize_module(str(edit.get("module", "")))
        anchor = edit.get("anchor")
        if module not in contents:
            failures.append(
                {
                    "index": index,
                    "module": module,
                    "reason": "unknown_module",
                    "anchor": str(anchor or ""),
                }
            )
            continue
        if not isinstance(anchor, str) or not anchor:
            failures.append(
                {
                    "index": index,
                    "module": module,
                    "reason": "missing_anchor",
                    "anchor": "",
                }
            )
            continue
        content = contents[module]
        count = content.count(anchor)
        if count == 1:
            continue
        failures.append(
            {
                "index": index,
                "module": module,
                "reason": "anchor_missing" if count == 0 else "anchor_ambiguous",
                "anchor": anchor,
                "match_count": count,
            }
        )
    return failures


def gpu_diff_patch_content_failures(
    req: GpuDiffPatchRequest,
    edits: Iterable[Mapping[str, object]],
) -> List[dict]:
    allowed_includes = _allowed_generated_includes(req.compile_manifest)
    failures: List[dict] = []
    for index, edit in enumerate(edits):
        module = _normalize_module(str(edit.get("module", "")))
        content = edit.get("content", "")
        if not isinstance(content, str):
            continue
        for included in _QUOTED_INCLUDE_RE.findall(content):
            normalized = _normalize_path(included)
            basename = normalized.rsplit("/", 1)[-1]
            if normalized in allowed_includes or basename in allowed_includes:
                continue
            failures.append(
                {
                    "index": index,
                    "module": module,
                    "reason": "generated_role_includes_project_header",
                    "include": included,
                }
            )
    return failures


def build_gpu_diff_patch_retry_prompt(
    original_prompt: str,
    failures: Iterable[Mapping[str, object]],
) -> str:
    lines = [
        original_prompt,
        "",
        "DETERMINISTIC VERIFIER REJECTION:",
        "Your previous GPU delta edit list was rejected before the worker applied it.",
        "Return a corrected JSON object using the same schema.",
        "",
        "Anchor rules:",
        "- Every anchor must be copied verbatim from the CURRENT FILES blocks above.",
        "- For module \"device\", the anchor must come from the CURRENT generated device role.",
        "- Do not use a line that appears only in USER DIFF or the original user source.",
        "- Every anchor must appear exactly once in its target module.",
        "",
        "Generated-role include rules:",
        "- Generated roles may quote-include only emitted Synthi role files or synthi_gpu_runtime.h.",
        "- Do not add #include lines for original workspace/project headers.",
        "- Copy or adapt required structs, constants, and helpers into generated roles instead.",
        "",
        "Rejected edits:",
    ]
    for failure in failures:
        anchor = str(failure.get("anchor") or "")
        if len(anchor) > 240:
            anchor = anchor[:237] + "..."
        include = str(failure.get("include") or "")
        if include:
            lines.append(
                "- edit #{index} module={module} reason={reason} include={include!r}".format(
                    index=failure.get("index"),
                    module=failure.get("module"),
                    reason=failure.get("reason"),
                    include=include,
                )
            )
        else:
            lines.append(
                "- edit #{index} module={module} reason={reason} match_count={count} anchor={anchor!r}".format(
                    index=failure.get("index"),
                    module=failure.get("module"),
                    reason=failure.get("reason"),
                    count=failure.get("match_count", "n/a"),
                    anchor=anchor,
                )
            )
    lines += [
        "",
        "Return ONLY the corrected JSON object. No markdown fences, no prose.",
    ]
    return "\n".join(lines)


def _json_block(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True, indent=2)
    except TypeError:
        return str(value)


def _normalize_path(value: str) -> str:
    parts: List[str] = []
    for part in str(value or "").replace("\\", "/").split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _allowed_generated_includes(compile_manifest: object) -> set[str]:
    allowed = {"synthi_gpu_runtime.h"}
    if not isinstance(compile_manifest, Mapping):
        allowed.update({"shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu", "device.hip"})
        return allowed
    module_files = compile_manifest.get("module_files")
    if isinstance(module_files, Mapping):
        for value in module_files.values():
            if not isinstance(value, str) or not value.strip():
                continue
            normalized = _normalize_path(value)
            allowed.add(normalized)
            allowed.add(normalized.rsplit("/", 1)[-1])
    files = compile_manifest.get("files")
    if isinstance(files, list):
        for value in files:
            if not isinstance(value, str) or not value.strip():
                continue
            normalized = _normalize_path(value)
            allowed.add(normalized)
            allowed.add(normalized.rsplit("/", 1)[-1])
    allowed.update({"shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu", "device.hip"})
    return allowed


def validate_gpu_edit_list(edits: object) -> List[dict]:
    if not isinstance(edits, list):
        raise HTTPException(status_code=400, detail="`edits` must be a JSON array")
    cleaned: List[dict] = []
    for i, edit in enumerate(edits):
        if not isinstance(edit, dict):
            raise HTTPException(status_code=400, detail=f"edit #{i} must be an object")
        module = _normalize_module(str(edit.get("module", "")))
        op = edit.get("operation")
        anchor = edit.get("anchor")
        content = edit.get("content", "")
        if module not in VALID_GPU_EDIT_MODULES:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: module must be one of {VALID_GPU_EDIT_MODULES}, got {edit.get('module')!r}",
            )
        if op not in VALID_GPU_EDIT_OPS:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: operation must be one of {VALID_GPU_EDIT_OPS}, got {op!r}",
            )
        if not isinstance(anchor, str) or not anchor:
            raise HTTPException(status_code=400, detail=f"edit #{i}: anchor must be non-empty")
        if not isinstance(content, str):
            raise HTTPException(status_code=400, detail=f"edit #{i}: content must be a string")
        cleaned.append({"module": module, "operation": op, "anchor": anchor, "content": content})
    return cleaned


def parse_gpu_diff_response(raw: str) -> dict:
    text = _strip_json_fence(raw)
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="GPU diff response must be a JSON object")
    plan = parsed.get("reload_plan") or "mixed"
    if plan not in VALID_RELOAD_PLANS:
        raise HTTPException(status_code=400, detail=f"invalid reload_plan {plan!r}")
    edits = validate_gpu_edit_list(parsed.get("edits", []))
    result = {"reload_plan": plan, "edits": edits}
    fission_candidate = validate_fission_candidate(parsed.get("fissionCandidate"))
    if fission_candidate is not None:
        result["fissionCandidate"] = fission_candidate
    return result


def validate_fission_candidate(candidate: object) -> Optional[dict]:
    if candidate is None:
        return None
    if not isinstance(candidate, dict):
        raise HTTPException(status_code=400, detail="`fissionCandidate` must be an object when present")
    cleaned = dict(candidate)
    for source_field, target_field in FISSION_CANDIDATE_ALIASES.items():
        if target_field not in cleaned and source_field in cleaned:
            cleaned[target_field] = cleaned[source_field]
    for field in sorted(FISSION_CANDIDATE_STRING_FIELDS):
        if field in cleaned and cleaned[field] is not None and not isinstance(cleaned[field], str):
            raise HTTPException(status_code=400, detail=f"`fissionCandidate.{field}` must be a string")
    for field in sorted(FISSION_CANDIDATE_SHA256_FIELDS):
        if field in cleaned and cleaned[field] is not None:
            value = cleaned[field]
            if not isinstance(value, str) or not _SHA256_DIGEST_RE.match(value.strip()):
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.{field}` must be a SHA-256 digest",
                )
    for field in sorted(FISSION_CANDIDATE_STRING_LIST_FIELDS):
        if field in cleaned and cleaned[field] is not None:
            cleaned[field] = _validate_fission_string_list(cleaned[field], field)
    if "proofFailureReasonCodes" in cleaned and cleaned["proofFailureReasonCodes"] is not None:
        _validate_registered_reason_codes(
            cleaned["proofFailureReasonCodes"],
            "fissionCandidate.proofFailureReasonCodes",
        )
    for field in sorted(FISSION_CANDIDATE_OBJECT_FIELDS):
        if field in cleaned and cleaned[field] is not None and not isinstance(cleaned[field], dict):
            raise HTTPException(status_code=400, detail=f"`fissionCandidate.{field}` must be an object")
    if "outputOracleProposal" in cleaned and cleaned["outputOracleProposal"] is not None:
        cleaned["outputOracleProposal"] = _validate_fission_output_oracle_proposal(
            cleaned["outputOracleProposal"]
        )
    if "attachmentInstrumentationProposals" in cleaned and cleaned["attachmentInstrumentationProposals"] is not None:
        cleaned["attachmentInstrumentationProposals"] = _validate_fission_attachment_proposals(
            cleaned["attachmentInstrumentationProposals"]
        )
    for field in sorted(FISSION_CANDIDATE_BOOL_FIELDS):
        if field in cleaned and cleaned[field] is not None and type(cleaned[field]) is not bool:
            raise HTTPException(status_code=400, detail=f"`fissionCandidate.{field}` must be a boolean")
    for field in sorted(FISSION_CANDIDATE_NON_NEGATIVE_INT_FIELDS):
        if field in cleaned and cleaned[field] is not None:
            cleaned[field] = _validate_non_negative_int(cleaned[field], f"fissionCandidate.{field}")
    if "sourceSpans" in cleaned and cleaned["sourceSpans"] is not None:
        cleaned["sourceSpans"] = _validate_fission_source_spans(cleaned["sourceSpans"])
    if "narrowerCandidateRejections" in cleaned and cleaned["narrowerCandidateRejections"] is not None:
        cleaned["narrowerCandidateRejections"] = _validate_fission_rejections(
            cleaned["narrowerCandidateRejections"]
        )
    _validate_fission_attachment_proposal_id_coverage(cleaned)
    return cleaned


def _validate_fission_attachment_proposals(value: object) -> List[dict]:
    if not isinstance(value, list):
        raise HTTPException(
            status_code=400,
            detail="`fissionCandidate.attachmentInstrumentationProposals` must be an array",
        )
    cleaned: List[dict] = []
    for i, proposal in enumerate(value):
        if not isinstance(proposal, dict):
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.attachmentInstrumentationProposals[{i}]` must be an object",
            )
        cleaned.append(_validate_fission_attachment_proposal(proposal, i))
    return cleaned


def _validate_fission_attachment_proposal(value: Mapping[str, object], index: int) -> dict:
    cleaned = dict(value)
    for field in sorted(FISSION_ATTACHMENT_PROPOSAL_STRING_FIELDS):
        if field in cleaned and cleaned[field] is not None and not isinstance(cleaned[field], str):
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.attachmentInstrumentationProposals[{index}].{field}` must be a string",
            )
    for field in (
        "proposalId",
        "sourceLaunchSiteId",
        "hostPathId",
        "path",
        "sourceProvenance",
        "instrumentationAction",
    ):
        if not isinstance(cleaned.get(field), str) or not str(cleaned[field]).strip():
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.attachmentInstrumentationProposals[{index}].{field}` must be a non-empty string",
            )
    action = str(cleaned["instrumentationAction"]).strip()
    if action not in FISSION_ATTACHMENT_PROPOSAL_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "`fissionCandidate.attachmentInstrumentationProposals"
                f"[{index}].instrumentationAction` must be an accepted attachment action"
            ),
        )
    for field in ("line", "column"):
        value = cleaned.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    "`fissionCandidate.attachmentInstrumentationProposals"
                    f"[{index}].{field}` must be a positive integer"
                ),
            )
    for field in ("sourceHash", "snippetHash"):
        value = cleaned.get(field)
        if not isinstance(value, str) or not _SHA256_DIGEST_RE.match(value.strip()):
            raise HTTPException(
                status_code=400,
                detail=(
                    "`fissionCandidate.attachmentInstrumentationProposals"
                    f"[{index}].{field}` must be a SHA-256 digest"
                ),
            )
    boundary_apis = _validate_fission_string_list(
        cleaned.get("requiredBoundaryApis"),
        f"attachmentInstrumentationProposals[{index}].requiredBoundaryApis",
    )
    if not any(api in FISSION_ATTACHMENT_PROPOSAL_REQUIRED_BOUNDARY_APIS for api in boundary_apis):
        raise HTTPException(
            status_code=400,
            detail=(
                "`fissionCandidate.attachmentInstrumentationProposals"
                f"[{index}].requiredBoundaryApis` must include an accepted runtime boundary API"
            ),
        )
    runtime_evidence = cleaned.get("runtimeEvidenceRequired")
    if not isinstance(runtime_evidence, dict):
        raise HTTPException(
            status_code=400,
            detail=(
                "`fissionCandidate.attachmentInstrumentationProposals"
                f"[{index}].runtimeEvidenceRequired` must be an object"
            ),
        )
    runtime_evidence_cleaned = dict(runtime_evidence)
    for field in sorted(FISSION_ATTACHMENT_PROPOSAL_RUNTIME_EVIDENCE_BOOL_FIELDS):
        if runtime_evidence_cleaned.get(field) is not True:
            raise HTTPException(
                status_code=400,
                detail=(
                    "`fissionCandidate.attachmentInstrumentationProposals"
                    f"[{index}].runtimeEvidenceRequired.{field}` must be true"
                ),
            )
    cleaned["requiredBoundaryApis"] = boundary_apis
    cleaned["runtimeEvidenceRequired"] = runtime_evidence_cleaned
    return cleaned


def _validate_fission_attachment_proposal_id_coverage(candidate: Mapping[str, object]) -> None:
    proposal_ids = candidate.get("originalHostAttachmentInstrumentationProposalIds")
    if not proposal_ids:
        return
    proposals = candidate.get("attachmentInstrumentationProposals")
    if not isinstance(proposals, list):
        raise HTTPException(
            status_code=400,
            detail=(
                "`fissionCandidate.originalHostAttachmentInstrumentationProposalIds` "
                "requires matching structured attachmentInstrumentationProposals"
            ),
        )
    structured_ids = {
        str(proposal.get("proposalId")).strip()
        for proposal in proposals
        if isinstance(proposal, dict) and isinstance(proposal.get("proposalId"), str)
    }
    for i, proposal_id in enumerate(proposal_ids):
        if proposal_id not in structured_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    "`fissionCandidate.originalHostAttachmentInstrumentationProposalIds"
                    f"[{i}]` must match a structured attachmentInstrumentationProposals entry"
                ),
            )


def _validate_fission_output_oracle_proposal(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(
            status_code=400,
            detail="`fissionCandidate.outputOracleProposal` must be an object",
        )
    cleaned = dict(value)
    for field in sorted(FISSION_OUTPUT_ORACLE_STRING_FIELDS):
        if field in cleaned and cleaned[field] is not None and not isinstance(cleaned[field], str):
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.outputOracleProposal.{field}` must be a string",
            )
    for field in sorted(FISSION_OUTPUT_ORACLE_NUMERIC_FIELDS):
        if field in cleaned and cleaned[field] is not None:
            number = cleaned[field]
            if type(number) not in {int, float} or number < 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.outputOracleProposal.{field}` must be a non-negative number",
                )
    return cleaned


def _validate_fission_string_list(value: object, field: str) -> List[str]:
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail=f"`fissionCandidate.{field}` must be a string array")
    cleaned: List[str] = []
    for i, item in enumerate(value):
        if not isinstance(item, str) or not item:
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.{field}[{i}]` must be a non-empty string",
            )
        cleaned.append(item)
    return cleaned


def _validate_fission_source_spans(value: object) -> List[dict]:
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="`fissionCandidate.sourceSpans` must be an array")
    cleaned: List[dict] = []
    for i, span in enumerate(value):
        if not isinstance(span, dict):
            raise HTTPException(status_code=400, detail=f"`fissionCandidate.sourceSpans[{i}]` must be an object")
        path = span.get("path")
        start_line = span.get("startLine")
        end_line = span.get("endLine")
        start_byte = span.get("startByte")
        end_byte = span.get("endByte")
        if not isinstance(path, str) or not path:
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.sourceSpans[{i}].path` must be a non-empty string",
            )
        has_line_range = start_line is not None or end_line is not None
        has_byte_range = start_byte is not None or end_byte is not None
        if not has_line_range and not has_byte_range:
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.sourceSpans[{i}]` must include a line or byte range",
            )
        if has_line_range:
            if type(start_line) is not int or start_line < 1:
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.sourceSpans[{i}].startLine` must be a positive integer",
                )
            if type(end_line) is not int or end_line < start_line:
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.sourceSpans[{i}].endLine` must be an integer >= startLine",
                )
        if has_byte_range:
            if type(start_byte) is not int or start_byte < 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.sourceSpans[{i}].startByte` must be a non-negative integer",
                )
            if type(end_byte) is not int or end_byte <= start_byte:
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.sourceSpans[{i}].endByte` must be an integer > startByte",
                )
        cleaned_span = dict(span)
        cleaned_span["path"] = path
        if has_line_range:
            cleaned_span["startLine"] = start_line
            cleaned_span["endLine"] = end_line
        if has_byte_range:
            cleaned_span["startByte"] = start_byte
            cleaned_span["endByte"] = end_byte
        cleaned.append(cleaned_span)
    return cleaned


def _validate_fission_rejections(value: object) -> List[dict]:
    if not isinstance(value, list):
        raise HTTPException(
            status_code=400,
            detail="`fissionCandidate.narrowerCandidateRejections` must be an array",
        )
    cleaned: List[dict] = []
    for i, rejection in enumerate(value):
        if not isinstance(rejection, dict):
            raise HTTPException(
                status_code=400,
                detail=f"`fissionCandidate.narrowerCandidateRejections[{i}]` must be an object",
            )
        cleaned_rejection = dict(rejection)
        if "scopeRank" in cleaned_rejection and cleaned_rejection["scopeRank"] is not None:
            cleaned_rejection["scopeRank"] = _validate_non_negative_int(
                cleaned_rejection["scopeRank"],
                f"fissionCandidate.narrowerCandidateRejections[{i}].scopeRank",
            )
        for field in sorted(FISSION_REJECTION_STRING_FIELDS):
            if (
                field in cleaned_rejection
                and cleaned_rejection[field] is not None
                and not isinstance(cleaned_rejection[field], str)
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"`fissionCandidate.narrowerCandidateRejections[{i}].{field}` must be a string",
                )
        for field in sorted(FISSION_REJECTION_STRING_LIST_FIELDS):
            if field in cleaned_rejection and cleaned_rejection[field] is not None:
                cleaned_rejection[field] = _validate_fission_string_list(
                    cleaned_rejection[field],
                    f"narrowerCandidateRejections[{i}].{field}",
                )
        if "reasonCode" in cleaned_rejection and cleaned_rejection["reasonCode"] is not None:
            _validate_registered_reason_codes(
                [cleaned_rejection["reasonCode"]],
                f"fissionCandidate.narrowerCandidateRejections[{i}].reasonCode",
            )
        if "reasonCodes" in cleaned_rejection and cleaned_rejection["reasonCodes"] is not None:
            _validate_registered_reason_codes(
                cleaned_rejection["reasonCodes"],
                f"fissionCandidate.narrowerCandidateRejections[{i}].reasonCodes",
            )
        cleaned.append(cleaned_rejection)
    return cleaned


def _validate_registered_reason_codes(codes: Iterable[str], label: str) -> None:
    try:
        assert_registered_reason_codes(codes)
    except UnknownReasonCodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"`{label}` contains unregistered reason codes: {', '.join(exc.unknown_codes)}",
        ) from exc


def _validate_non_negative_int(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise HTTPException(status_code=400, detail=f"`{label}` must be a non-negative integer")
    return value


def _normalize_module(module: str) -> str:
    if module in HOST_PATH_TO_MODULE:
        return HOST_PATH_TO_MODULE[module]
    if module in DEVICE_PATHS:
        return "device"
    return module


def _strip_json_fence(raw: str) -> str:
    text = (raw or "").strip()
    if "```json" in text:
        return text.split("```json", 1)[1].split("```", 1)[0].strip()
    if text.startswith("```"):
        return text.split("```", 1)[1].split("```", 1)[0].strip()
    return text


def _device_source(files: Mapping[str, str]) -> str:
    return files.get("device.cu") or files.get("device.hip") or files.get("device") or ""


def _is_device_path(path: str) -> bool:
    lower = path.lower()
    return lower in {"device"} or lower.endswith((".cu", ".cuh", ".hip"))


def _is_host_path(path: str) -> bool:
    return not _is_device_path(path) and not path.endswith(".json")


def _rdc_enabled(manifest_gpu: Optional[Mapping[str, object]]) -> bool:
    if not manifest_gpu:
        return False
    if bool(manifest_gpu.get("rdc")):
        return True
    flags = manifest_gpu.get("device_flags") or []
    if isinstance(flags, str):
        flags = [flags]
    return any(re.search(r"(^|=)(true|1)$", str(f)) and "rdc" in str(f) for f in flags) or any(
        str(f) in {"-rdc=true", "--relocatable-device-code=true", "--gpu-rdc"} for f in flags
    )
