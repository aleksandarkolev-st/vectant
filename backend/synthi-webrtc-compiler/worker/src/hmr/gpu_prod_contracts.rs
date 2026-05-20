use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const SIDECAR_SCHEMA_VERSION: &str = "synthi.gpu.split_sidecar.v1";
pub const RELOAD_PLAN_SCHEMA_VERSION: &str = "synthi.gpu.reload_plan.v1";
pub const RUN_REPORT_SCHEMA_VERSION: &str = "synthi.gpu.run_report.v1";
pub const TOOLCHAIN_PROFILE_SCHEMA_VERSION: &str = "synthi.gpu.toolchain_capability.v1";
pub const SELECTED_COMPILE_COMMAND_SCHEMA_VERSION: &str = "synthi.gpu.selected_compile_command.v1";

pub fn normalize_split_sidecar(meta: &Value) -> Value {
    let mut root = meta.as_object().cloned().unwrap_or_default();
    root.entry("schemaVersion".to_string())
        .or_insert_with(|| Value::String(SIDECAR_SCHEMA_VERSION.to_string()));

    let compile_manifest = root.get("compile_manifest").cloned().unwrap_or(Value::Null);
    let selected_compile_command = root
        .get("selectedCompileCommand")
        .cloned()
        .or_else(|| root.get("selected_compile_command").cloned())
        .unwrap_or_else(|| selected_compile_command_from_manifest(&compile_manifest));
    let effective_flags_hash = root
        .get("effectiveFlagsHash")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| effective_flags_hash(&compile_manifest));

    root.insert(
        "selectedCompileCommand".to_string(),
        selected_compile_command.clone(),
    );
    root.insert(
        "effectiveFlagsHash".to_string(),
        Value::String(effective_flags_hash.clone()),
    );

    let toolchain_profile = root
        .get("toolchainCapabilities")
        .cloned()
        .or_else(|| root.get("toolchain_capabilities").cloned())
        .unwrap_or_else(|| {
            toolchain_capabilities_from_manifest(&compile_manifest, &effective_flags_hash)
        });
    let toolchain_hash = stable_hash(&toolchain_profile);
    root.insert(
        "toolchainCapabilities".to_string(),
        toolchain_profile.clone(),
    );
    root.insert(
        "toolchainCapabilityProfileHash".to_string(),
        Value::String(toolchain_hash.clone()),
    );

    root.entry("targetIdentity".to_string())
        .or_insert_with(|| target_identity_from_manifest(&compile_manifest));
    if !root.contains_key("sourceBaselineHashes") {
        let source_hashes = source_hashes_from_meta(&root);
        root.insert("sourceBaselineHashes".to_string(), source_hashes);
    }
    root.entry("generatedRoles".to_string())
        .or_insert_with(|| generated_roles_from_manifest(&compile_manifest));
    root.entry("deviceMappings".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    root.entry("kernelSignatureHashes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    root.entry("constantGlobalLayoutHashes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let device_mapping_report = root
        .get("deviceMappingReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("device_mapping_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_device_mapping_report);
    promote_device_mapping_report(&mut root, &device_mapping_report);
    let source_context_report = root
        .get("sourceContextReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("source_context_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_source_context_report);
    root.insert(
        "sourceContextReport".to_string(),
        source_context_report.clone(),
    );
    let device_tu_topology = root
        .get("deviceTuTopology")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| source_context_report.get("deviceTuTopology").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_device_tu_topology);
    root.insert("deviceTuTopology".to_string(), device_tu_topology);
    promote_template_evidence(&mut root, &effective_flags_hash);
    root.entry("generatedArtifactPolicy".to_string())
        .or_insert_with(generated_artifact_policy);
    let generated_artifact_report = root
        .get("generatedArtifactReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("generated_artifact_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_generated_artifact_report);
    root.insert(
        "generatedArtifactReport".to_string(),
        generated_artifact_report.clone(),
    );
    root.entry("noUserTreePollutionVerified".to_string())
        .or_insert_with(|| {
            generated_artifact_report
                .get("rolesAreInternal")
                .cloned()
                .unwrap_or(Value::Bool(false))
        });

    let fast_path_policy = fast_path_policy(&toolchain_profile, &root);
    root.insert("fastPathPolicy".to_string(), fast_path_policy);

    let reload_plan = root
        .get("lastReloadPlanReport")
        .cloned()
        .or_else(|| root.get("last_reload_plan_report").cloned())
        .unwrap_or_else(|| default_reload_plan(&toolchain_profile));
    root.insert("lastReloadPlanReport".to_string(), reload_plan.clone());

    let cache_report = root
        .get("cacheReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("cache_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_cache_report);
    root.insert("cacheReport".to_string(), cache_report.clone());

    let agentic_report = root
        .get("agenticReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("agentic_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_agentic_report);
    root.insert("agenticReport".to_string(), agentic_report.clone());
    root.entry("agenticMode".to_string()).or_insert_with(|| {
        agentic_report
            .get("mode")
            .cloned()
            .unwrap_or_else(|| Value::String("not_reported".to_string()))
    });
    root.entry("agenticAttemptCount".to_string())
        .or_insert_with(|| {
            agentic_report
                .get("attemptCount")
                .cloned()
                .unwrap_or_else(|| Value::Number(0.into()))
        });
    root.entry("agenticAttempts".to_string())
        .or_insert_with(|| {
            agentic_report
                .get("attempts")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()))
        });
    root.entry("generatedArtifactsPersistedAfterVerification".to_string())
        .or_insert_with(|| {
            agentic_report
                .get("persistedAfterVerification")
                .cloned()
                .unwrap_or(Value::Bool(false))
        });

    if !root.contains_key("arbiterDecision") || !root.contains_key("rankedReloadOptions") {
        let arbiter = decide_arbiter(&root, &toolchain_profile, &reload_plan);
        root.entry("arbiterDecision".to_string())
            .or_insert_with(|| {
                arbiter
                    .get("arbiterDecision")
                    .cloned()
                    .unwrap_or(Value::Null)
            });
        root.entry("selectedPlan".to_string())
            .or_insert_with(|| arbiter.get("selectedPlan").cloned().unwrap_or(Value::Null));
        root.entry("arbiterReasonCodes".to_string())
            .or_insert_with(|| arbiter.get("reasonCodes").cloned().unwrap_or(Value::Null));
        root.entry("rankedReloadOptions".to_string())
            .or_insert_with(|| arbiter.get("rankedOptions").cloned().unwrap_or(Value::Null));
        root.entry("consentRequired".to_string())
            .or_insert_with(|| {
                arbiter
                    .get("consentRequired")
                    .cloned()
                    .unwrap_or(Value::Null)
            });
        root.entry("consentReason".to_string())
            .or_insert_with(|| arbiter.get("consentReason").cloned().unwrap_or(Value::Null));
    }

    if !root.contains_key("runReport") {
        let report = run_report(
            &root,
            &selected_compile_command,
            &toolchain_profile,
            &toolchain_hash,
            &reload_plan,
            &cache_report,
        );
        root.insert("runReport".to_string(), report);
    }

    Value::Object(root)
}

fn selected_compile_command_from_manifest(manifest: &Value) -> Value {
    let host_compiler = manifest
        .get("compiler")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let gpu = manifest.get("gpu").and_then(Value::as_object);
    let device_compiler = gpu
        .and_then(|g| g.get("device_compiler"))
        .and_then(Value::as_str);
    let mut args = Vec::new();
    if let Some(compiler) = device_compiler {
        args.push(Value::String(compiler.to_string()));
    } else {
        args.push(Value::String(host_compiler.to_string()));
    }
    if let Some(std) = manifest.get("std").and_then(Value::as_str) {
        args.push(Value::String(format!("-std={std}")));
    }
    for flag in string_array(manifest.get("common_flags")) {
        args.push(Value::String(flag));
    }
    if let Some(gpu) = gpu {
        for flag in string_array(gpu.get("device_flags")) {
            args.push(Value::String(flag));
        }
        for arch in string_array(gpu.get("arch")) {
            args.push(Value::String(format!("--gpu-arch={arch}")));
        }
    }

    json!({
        "schemaVersion": SELECTED_COMPILE_COMMAND_SCHEMA_VERSION,
        "source": if manifest.is_null() { "missing" } else { "synthi_compile_manifest" },
        "identity": stable_hash(&Value::Array(args.clone())),
        "compiler": host_compiler,
        "deviceCompiler": device_compiler,
        "arguments": args,
    })
}

fn effective_flags_hash(manifest: &Value) -> String {
    let mut material = Map::new();
    for key in [
        "compiler",
        "std",
        "common_flags",
        "core_link_flags",
        "gui_link_flags",
        "runner_link_flags",
    ] {
        if let Some(value) = manifest.get(key) {
            material.insert(key.to_string(), value.clone());
        }
    }
    if let Some(gpu) = manifest.get("gpu") {
        material.insert("gpu".to_string(), gpu.clone());
    }
    stable_hash(&Value::Object(material))
}

fn toolchain_capabilities_from_manifest(manifest: &Value, flags_hash: &str) -> Value {
    let gpu = manifest.get("gpu").and_then(Value::as_object);
    let compiler_id = gpu
        .and_then(|g| g.get("device_compiler"))
        .and_then(Value::as_str)
        .or_else(|| manifest.get("compiler").and_then(Value::as_str))
        .unwrap_or("unknown");
    let vendor = gpu
        .and_then(|g| g.get("vendor"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let arch = gpu
        .and_then(|g| g.get("arch"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(str::to_string);
    let device_flags = gpu
        .and_then(|g| g.get("device_flags"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let requires_rdc = string_array(Some(&device_flags)).iter().any(|f| {
        f.contains("-fgpu-rdc")
            || f.contains("--relocatable-device-code")
            || f.contains("-rdc=true")
            || f == "--device-c"
    });
    let device_link_budget_ms = gpu
        .and_then(|g| g.get("device_link_budget_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(5_000);
    let estimated_device_link_ms = gpu
        .and_then(|g| g.get("device_link_estimated_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(if requires_rdc { 8_000 } else { 0 });
    let rdc_over_budget = requires_rdc && estimated_device_link_ms > device_link_budget_ms;
    let has_gpu = gpu.is_some();
    let supports_device_only = has_gpu && !requires_rdc;

    json!({
        "schemaVersion": TOOLCHAIN_PROFILE_SCHEMA_VERSION,
        "status": if has_gpu { "current" } else { "missing" },
        "compilerId": compiler_id,
        "compilerVersion": null,
        "gpuVendor": vendor,
        "gpuArch": arch,
        "effectiveFlagsHash": flags_hash,
        "requiresRdc": requires_rdc,
        "supportsDeviceOnlyReload": supports_device_only,
        "supportsIncrementalDeviceLink": false,
        "rdcDeviceLink": {
            "required": requires_rdc,
            "linkerBound": requires_rdc,
            "estimatedMs": estimated_device_link_ms,
            "budgetMs": device_link_budget_ms,
            "overBudget": rdc_over_budget,
            "costSource": if requires_rdc { "default_policy" } else { "not_required" },
            "reasonCodes": if rdc_over_budget {
                json!(["rdc_device_link_required", "rdc_link_over_budget"])
            } else if requires_rdc {
                json!(["rdc_device_link_required"])
            } else {
                json!([])
            },
        },
        "supportsSymbolInspection": has_gpu,
        "supportsSafeModuleUnload": has_gpu,
        "supportsGpuTimeoutDetection": if has_gpu { "partial" } else { "none" },
        "deviceLinkAverageMs": null,
        "deviceLinkP95Ms": null,
        "lastProbeRunId": null,
    })
}

fn target_identity_from_manifest(manifest: &Value) -> Value {
    let module_files = manifest.get("module_files").cloned().unwrap_or(Value::Null);
    json!({
        "source": if manifest.is_null() { "missing" } else { "synthi_compile_manifest" },
        "targetName": null,
        "configuration": null,
        "moduleFiles": module_files,
    })
}

fn source_hashes_from_meta(root: &Map<String, Value>) -> Value {
    let mut hashes = Map::new();
    if let Some(split_hash) = root.get("split_hash").and_then(Value::as_str) {
        hashes.insert("primary".to_string(), Value::String(split_hash.to_string()));
    }
    Value::Object(hashes)
}

fn generated_roles_from_manifest(manifest: &Value) -> Value {
    let module_files = manifest.get("module_files").and_then(Value::as_object);
    let mut roles = Map::new();
    for role in ["shared", "core", "gui", "host_runner", "device"] {
        let path = module_files
            .and_then(|m| m.get(role))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| legacy_role_path(role));
        if let Some(path) = path {
            roles.insert(
                role.to_string(),
                json!({
                    "path": path,
                    "internal": true,
                }),
            );
        }
    }
    Value::Object(roles)
}

fn promote_device_mapping_report(root: &mut Map<String, Value>, report: &Value) {
    root.insert("deviceMappingReport".to_string(), report.clone());
    root.entry("deviceMappingStatus".to_string())
        .or_insert_with(|| {
            report
                .get("mappingStatus")
                .cloned()
                .unwrap_or_else(|| Value::String("missing".to_string()))
        });
    replace_empty_field(root, "deviceMappings", report.get("deviceMappings"));
    merge_object_field(
        root,
        "sourceBaselineHashes",
        report.get("sourceBaselineHashes"),
    );
    merge_object_field(
        root,
        "sourceBaselineContents",
        report.get("sourceBaselineContents"),
    );
    replace_empty_field(
        root,
        "kernelSignatureHashes",
        report.get("kernelSignatureHashes"),
    );
    replace_empty_field(
        root,
        "constantGlobalLayoutHashes",
        report.get("constantGlobalLayoutHashes"),
    );
}

fn replace_empty_field(root: &mut Map<String, Value>, key: &str, candidate: Option<&Value>) {
    let Some(candidate) = candidate.filter(|v| !v.is_null()) else {
        return;
    };
    let replace = match root.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(map)) => map.is_empty(),
        _ => false,
    };
    if replace {
        root.insert(key.to_string(), candidate.clone());
    }
}

fn merge_object_field(root: &mut Map<String, Value>, key: &str, candidate: Option<&Value>) {
    let Some(candidate_obj) = candidate.and_then(Value::as_object) else {
        return;
    };
    let entry = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(existing) = entry.as_object_mut() else {
        return;
    };
    for (k, v) in candidate_obj {
        existing.entry(k.clone()).or_insert_with(|| v.clone());
    }
}

fn promote_template_evidence(root: &mut Map<String, Value>, effective_flags_hash: &str) {
    let evidence = root
        .get("templateEvidence")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("template_evidence").cloned())
        .filter(|v| !v.is_null());

    let Some(evidence) = evidence else {
        root.insert(
            "templateEvidence".to_string(),
            json!({
                "schemaVersion": "synthi.gpu.template_evidence.v1",
                "status": "missing",
                "producer": null,
                "entries": [],
            }),
        );
        root.insert(
            "templateEvidenceStatus".to_string(),
            Value::String("missing".to_string()),
        );
        root.insert("templateEvidenceBounded".to_string(), Value::Bool(false));
        root.insert(
            "templateEvidenceHash".to_string(),
            Value::String(stable_hash(&Value::Null)),
        );
        root.insert(
            "affectedTemplateInstantiations".to_string(),
            Value::Array(Vec::new()),
        );
        root.insert(
            "templateEvidenceInvalidationReasons".to_string(),
            json!(["template_evidence_missing"]),
        );
        return;
    };

    let status = evidence
        .get("status")
        .or_else(|| evidence.get("evidenceStatus"))
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let producer = evidence
        .get("producer")
        .and_then(Value::as_str)
        .unwrap_or("");
    let evidence_flags_hash = evidence
        .get("effectiveFlagsHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    let entries = evidence
        .get("entries")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let bounded = evidence
        .get("bounded")
        .or_else(|| evidence.get("impactBounded"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut invalidation = Vec::new();
    if status != "fresh" {
        invalidation.push(if status == "stale" {
            "template_evidence_stale"
        } else {
            "template_evidence_missing"
        });
    }
    if !is_compiler_derived_template_evidence(producer) {
        invalidation.push("template_evidence_not_compiler_derived");
    }
    if evidence_flags_hash.is_empty() || evidence_flags_hash != effective_flags_hash {
        invalidation.push("template_evidence_effective_flags_mismatch");
    }
    if !bounded {
        invalidation.push("template_instantiation_unbounded");
    }
    if entries.as_array().map(Vec::is_empty).unwrap_or(true) {
        invalidation.push("template_evidence_missing_entries");
    }

    invalidation.sort_unstable();
    invalidation.dedup();
    let accepted = invalidation.is_empty();
    root.insert("templateEvidence".to_string(), evidence.clone());
    root.insert(
        "templateEvidenceStatus".to_string(),
        Value::String(if accepted { "fresh" } else { "stale" }.to_string()),
    );
    root.insert("templateEvidenceBounded".to_string(), Value::Bool(bounded));
    root.insert(
        "templateEvidenceHash".to_string(),
        Value::String(stable_hash(&evidence)),
    );
    root.insert("affectedTemplateInstantiations".to_string(), entries);
    root.insert(
        "templateEvidenceInvalidationReasons".to_string(),
        Value::Array(
            invalidation
                .into_iter()
                .map(|reason| Value::String(reason.to_string()))
                .collect(),
        ),
    );
}

fn is_compiler_derived_template_evidence(producer: &str) -> bool {
    let producer = producer.to_ascii_lowercase();
    if producer.is_empty()
        || ["llm", "ai", "agent", "manual", "heuristic"]
            .iter()
            .any(|token| producer.contains(token))
    {
        return false;
    }

    [
        "compiler",
        "clang",
        "llvm",
        "nvcc",
        "hipcc",
        "ptxas",
        "gcc",
        "msvc",
        "linker",
        "objdump",
        "cuobjdump",
        "rocobjdump",
        "fatbin",
    ]
    .iter()
    .any(|token| producer.contains(token))
}

fn generated_artifact_policy() -> Value {
    json!({
        "rolesAreInternal": true,
        "userWorkspaceMaterialization": "forbidden",
        "internalRoot": ".synthi/generated/gpu",
        "forbiddenUserPaths": [
            "core.cpp",
            "gui.cpp",
            "host_runner.cpp",
            "shared.h",
            "device.cu",
            "device.hip"
        ],
    })
}

fn default_device_mapping_report() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.device_mapping.v1",
        "generatedDevicePath": null,
        "mappingStatus": "missing",
        "deviceMappings": [],
        "unmappedKernels": [],
        "sourceBaselineHashes": {},
        "sourceBaselineContents": {},
        "kernelSignatureHashes": {},
        "constantGlobalLayoutHashes": {},
    })
}

fn default_source_context_report() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.source_context.v1",
        "status": "missing",
        "workspaceFileCount": 0,
        "candidateFileCount": 0,
        "includedFileCount": 0,
        "droppedFileCount": 0,
        "included": [],
        "dropped": [],
        "criticalDropped": [],
        "deterministicContextComplete": false,
        "reasonCodes": ["source_context_report_missing"],
        "buildMetadata": {
            "compileCommandsStatus": "missing",
            "cmakeFileApiStatus": "unknown",
            "selectedCompileCommand": {
                "status": "missing",
                "source": "compile_commands.json"
            }
        },
    })
}

fn default_device_tu_topology() -> Value {
    json!({
        "deviceTranslationUnitCount": 0,
        "deviceTranslationUnits": [],
        "multiDeviceTu": false,
        "supportStatus": "unknown",
        "reasonCodes": [],
    })
}

fn default_generated_artifact_report() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.generated_artifact_purity.v1",
        "rolesAreInternal": false,
        "internalRoot": null,
        "userWorkspaceMaterialization": "unknown",
        "mappings": [],
        "missingRoles": [],
        "droppedExtraGeneratedFiles": [],
    })
}

fn fast_path_policy(toolchain_profile: &Value, root: &Map<String, Value>) -> Value {
    let mut blocked = Vec::new();
    let profile_status = toolchain_profile
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let profile_current = profile_status == "current";
    let profile_reason = if profile_status == "stale" {
        "toolchain_capability_stale"
    } else {
        "toolchain_capability_missing"
    };
    let supports_device_only = toolchain_profile
        .get("supportsDeviceOnlyReload")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let template_status = root
        .get("templateEvidenceStatus")
        .and_then(Value::as_str)
        .unwrap_or("missing");

    if !profile_current {
        blocked.push(profile_reason);
    }
    if profile_current && !supports_device_only {
        blocked.push("toolchain_capability_no_device_only_reload");
    }
    let multi_device_tu = root
        .get("deviceTuTopology")
        .and_then(|v| v.get("multiDeviceTu"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if multi_device_tu {
        blocked.push("multi_device_tu_requires_topology_verification");
    }
    if template_status != "fresh" {
        blocked.push("template_evidence_missing");
    }

    json!({
        "deviceOnlyAllowed": profile_current && supports_device_only && !multi_device_tu,
        "warmRebuildAllowed": profile_current && template_status == "fresh",
        "blockedReasonCodes": blocked,
    })
}

fn decide_arbiter(
    root: &Map<String, Value>,
    toolchain_profile: &Value,
    reload_plan: &Value,
) -> Value {
    let ranked_options = ranked_reload_options(root, toolchain_profile, reload_plan);
    let requested_plan = reload_plan
        .get("plan")
        .and_then(Value::as_str)
        .unwrap_or("unsupported");

    if requested_plan == "unsupported"
        && reload_plan
            .get("reasonCodes")
            .and_then(Value::as_array)
            .map(|codes| {
                codes
                    .iter()
                    .any(|code| code.as_str() == Some("reload.no_attempt_recorded"))
            })
            .unwrap_or(false)
    {
        return json!({
            "arbiterDecision": "skip",
            "selectedPlan": null,
            "reasonCodes": ["arbiter.no_reload_attempt_recorded"],
            "rankedOptions": ranked_options,
            "consentRequired": false,
            "consentReason": null,
        });
    }

    let selected = ranked_options
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("plan").and_then(Value::as_str) == Some(requested_plan))
        })
        .cloned();

    let Some(selected) = selected else {
        return json!({
            "arbiterDecision": "unsupported",
            "selectedPlan": requested_plan,
            "reasonCodes": ["arbiter.plan_not_ranked"],
            "rankedOptions": ranked_options,
            "consentRequired": false,
            "consentReason": null,
        });
    };

    let safety = selected
        .get("safety")
        .and_then(Value::as_str)
        .unwrap_or("fail");
    let requires_consent = selected
        .get("requiresConsent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let consent_reason = selected
        .get("consentReason")
        .cloned()
        .unwrap_or(Value::Null);
    let reason_codes = selected
        .get("reasonCodes")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    let decision = if safety == "pass" && !requires_consent {
        "auto_run"
    } else if safety == "fail" {
        "fallback"
    } else if requires_consent {
        "ask_developer"
    } else {
        "skip"
    };

    json!({
        "arbiterDecision": decision,
        "selectedPlan": requested_plan,
        "reasonCodes": reason_codes,
        "rankedOptions": ranked_options,
        "consentRequired": requires_consent,
        "consentReason": consent_reason,
    })
}

fn ranked_reload_options(
    root: &Map<String, Value>,
    toolchain_profile: &Value,
    reload_plan: &Value,
) -> Value {
    let profile_status = toolchain_profile
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let profile_current = profile_status == "current";
    let profile_reason = if profile_status == "stale" {
        "toolchain_capability_stale"
    } else {
        "toolchain_capability_missing"
    };
    let supports_device_only = toolchain_profile
        .get("supportsDeviceOnlyReload")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requires_rdc = toolchain_profile
        .get("requiresRdc")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rdc_device_link = toolchain_profile
        .get("rdcDeviceLink")
        .and_then(Value::as_object);
    let rdc_linker_bound = rdc_device_link
        .and_then(|profile| profile.get("linkerBound"))
        .and_then(Value::as_bool)
        .unwrap_or(requires_rdc);
    let rdc_over_budget = rdc_device_link
        .and_then(|profile| profile.get("overBudget"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let estimated_rdc_ms = rdc_device_link
        .and_then(|profile| profile.get("estimatedMs"))
        .and_then(Value::as_u64)
        .unwrap_or(if requires_rdc { 8_000 } else { 5_000 });
    let template_status = root
        .get("templateEvidenceStatus")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let template_bounded = root
        .get("templateEvidenceBounded")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let template_fresh = template_status == "fresh" && template_bounded;
    let template_reasons = root
        .get("templateEvidenceInvalidationReasons")
        .and_then(Value::as_array)
        .cloned()
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| {
            if template_status == "stale" {
                vec![Value::String("template_evidence_stale".to_string())]
            } else {
                vec![Value::String("template_evidence_missing".to_string())]
            }
        });
    let affected_roles = reload_plan
        .get("affectedGeneratedRoles")
        .and_then(Value::as_array)
        .map(|roles| roles.len())
        .unwrap_or(0);
    let multi_device_tu = root
        .get("deviceTuTopology")
        .and_then(|v| v.get("multiDeviceTu"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let device_only_safety = profile_current && supports_device_only && !multi_device_tu;
    let warm_safety = profile_current && template_fresh;
    let warm_requires_consent = warm_safety && (requires_rdc || rdc_over_budget);
    let mut device_only_reasons: Vec<String> = Vec::new();
    if device_only_safety {
        device_only_reasons.extend([
            "arbiter.safe".to_string(),
            "arbiter.under_latency_budget".to_string(),
            "arbiter.no_state_loss".to_string(),
        ]);
    } else {
        if !profile_current {
            device_only_reasons.push(profile_reason.to_string());
        }
        if profile_current && !supports_device_only {
            device_only_reasons.push("toolchain_capability_no_device_only_reload".to_string());
        }
        if multi_device_tu {
            device_only_reasons.push("multi_device_tu_requires_topology_verification".to_string());
        }
    }

    let mut warm_reasons: Vec<String> = Vec::new();
    if warm_safety {
        warm_reasons.extend([
            "arbiter.safe".to_string(),
            "arbiter.no_state_loss".to_string(),
        ]);
        if warm_requires_consent {
            if requires_rdc {
                warm_reasons.push("rdc_device_link_required".to_string());
            }
            if rdc_linker_bound {
                warm_reasons.push("device_linker_bound".to_string());
            }
            if rdc_over_budget {
                warm_reasons.push("rdc_link_over_budget".to_string());
            }
            warm_reasons.push("arbiter_user_consent_required".to_string());
        }
    } else {
        if !profile_current {
            warm_reasons.push(profile_reason.to_string());
        }
        if !template_fresh {
            for reason in &template_reasons {
                if let Some(reason) = reason.as_str() {
                    warm_reasons.push(reason.to_string());
                }
            }
        }
    }

    let ai_delta_requires_consent = affected_roles > 1;
    let ai_delta_reason_codes = if ai_delta_requires_consent {
        json!([
            "multi_role_ai_delta_requires_consent",
            "arbiter_user_consent_required"
        ])
    } else {
        json!(["arbiter.verifier_required"])
    };
    let warm_consent_reason = if warm_requires_consent && rdc_over_budget {
        Value::String("rdc_link_over_budget".to_string())
    } else if warm_requires_consent {
        Value::String("device_linker_bound".to_string())
    } else {
        Value::Null
    };
    let ai_delta_consent_reason = if ai_delta_requires_consent {
        Value::String("multi_role_ai_delta_requires_consent".to_string())
    } else {
        Value::Null
    };

    json!([
        {
            "plan": "device_only",
            "safety": if device_only_safety { "pass" } else { "fail" },
            "estimatedMs": 1000,
            "stateLoss": false,
            "requiresConsent": false,
            "consentReason": null,
            "reasonCodes": device_only_reasons,
        },
        {
            "plan": "warm_rebuild",
            "safety": if warm_safety { "pass" } else { "fail" },
            "estimatedMs": if requires_rdc { estimated_rdc_ms } else { 5000 },
            "stateLoss": false,
            "requiresConsent": warm_requires_consent,
            "consentReason": warm_consent_reason,
            "reasonCodes": warm_reasons,
        },
        {
            "plan": "ai_delta",
            "safety": "pending_verifier",
            "estimatedMs": 10000,
            "stateLoss": false,
            "requiresConsent": ai_delta_requires_consent,
            "consentReason": ai_delta_consent_reason,
            "reasonCodes": ai_delta_reason_codes,
        },
        {
            "plan": "full_resplit",
            "safety": "pending_verifier",
            "estimatedMs": 30000,
            "stateLoss": false,
            "requiresConsent": true,
            "consentReason": "arbiter_user_consent_required",
            "reasonCodes": ["arbiter_user_consent_required"],
        },
        {
            "plan": "cold_restart",
            "safety": "pass",
            "estimatedMs": 5000,
            "stateLoss": true,
            "requiresConsent": true,
            "consentReason": "state_loss_requires_consent",
            "reasonCodes": ["state_loss_requires_consent", "arbiter_user_consent_required"],
        }
    ])
}

fn default_reload_plan(toolchain_profile: &Value) -> Value {
    let profile_status = toolchain_profile
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let profile_current = profile_status == "current";
    let mut reasons = vec!["reload.no_attempt_recorded"];
    if !profile_current {
        reasons.push(if profile_status == "stale" {
            "toolchain_capability_stale"
        } else {
            "toolchain_capability_missing"
        });
    }
    json!({
        "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
        "plan": "unsupported",
        "reasonCodes": reasons,
        "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
        "affectedUserFiles": [],
        "affectedGeneratedRoles": [],
        "timingsMs": {},
    })
}

fn default_cache_report() -> Value {
    json!({
        "splitCacheHit": false,
        "splitCacheReason": "not_reported",
        "splitCacheKey": null,
    })
}

fn default_agentic_report() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.agentic_split.v1",
        "mode": "not_reported",
        "attemptCount": 0,
        "maxAttempts": 0,
        "boundedRetries": false,
        "accepted": false,
        "persistedAfterVerification": false,
        "repairScope": null,
        "attempts": [],
    })
}

fn run_report(
    root: &Map<String, Value>,
    selected_compile_command: &Value,
    toolchain_profile: &Value,
    toolchain_hash: &str,
    reload_plan: &Value,
    cache_report: &Value,
) -> Value {
    json!({
        "schemaVersion": RUN_REPORT_SCHEMA_VERSION,
        "runId": root
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "selectedTarget": root.get("targetIdentity").cloned().unwrap_or(Value::Null),
        "selectedCompileCommand": selected_compile_command,
        "effectiveFlagsHash": root.get("effectiveFlagsHash").cloned().unwrap_or(Value::Null),
        "toolchainCapabilityProfileHash": toolchain_hash,
        "toolchainCapabilityProfile": toolchain_profile,
        "splitCacheKey": cache_report.get("splitCacheKey").cloned().unwrap_or(Value::Null),
        "splitCacheHit": cache_report
            .get("splitCacheHit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "splitCacheReason": cache_report
            .get("splitCacheReason")
            .and_then(Value::as_str)
            .unwrap_or("not_reported"),
        "patchTier": root.get("patchTier").cloned().unwrap_or(Value::Null),
        "reloadPlan": reload_plan,
        "arbiterDecision": root.get("arbiterDecision").cloned().unwrap_or(Value::Null),
        "rankedReloadOptions": root
            .get("rankedReloadOptions")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "consentRequired": root.get("consentRequired").cloned().unwrap_or(Value::Null),
        "consentReason": root.get("consentReason").cloned().unwrap_or(Value::Null),
        "generatedRoles": root.get("generatedRoles").cloned().unwrap_or(Value::Null),
        "deviceMappingStatus": root
            .get("deviceMappingStatus")
            .cloned()
            .unwrap_or(Value::Null),
        "deviceMappingReport": root
            .get("deviceMappingReport")
            .cloned()
            .unwrap_or(Value::Null),
        "deviceMappings": root.get("deviceMappings").cloned().unwrap_or(Value::Null),
        "sourceContextReport": root
            .get("sourceContextReport")
            .cloned()
            .unwrap_or(Value::Null),
        "deviceTuTopology": root
            .get("deviceTuTopology")
            .cloned()
            .unwrap_or(Value::Null),
        "templateEvidenceHash": root
            .get("templateEvidenceHash")
            .cloned()
            .unwrap_or(Value::Null),
        "templateEvidenceStatus": root
            .get("templateEvidenceStatus")
            .cloned()
            .unwrap_or(Value::Null),
        "templateEvidenceBounded": root
            .get("templateEvidenceBounded")
            .cloned()
            .unwrap_or(Value::Null),
        "templateEvidenceInvalidationReasons": root
            .get("templateEvidenceInvalidationReasons")
            .cloned()
            .unwrap_or(Value::Null),
        "affectedTemplateInstantiations": root
            .get("affectedTemplateInstantiations")
            .cloned()
            .unwrap_or(Value::Null),
        "kernelSignatureHashes": root
            .get("kernelSignatureHashes")
            .cloned()
            .unwrap_or(Value::Null),
        "constantGlobalLayoutHashes": root
            .get("constantGlobalLayoutHashes")
            .cloned()
            .unwrap_or(Value::Null),
        "generatedArtifactReport": root
            .get("generatedArtifactReport")
            .cloned()
            .unwrap_or(Value::Null),
        "noUserTreePollutionVerified": root
            .get("noUserTreePollutionVerified")
            .cloned()
            .unwrap_or(Value::Null),
        "agenticReport": root.get("agenticReport").cloned().unwrap_or(Value::Null),
        "agenticMode": root.get("agenticMode").cloned().unwrap_or(Value::Null),
        "agenticAttemptCount": root.get("agenticAttemptCount").cloned().unwrap_or(Value::Null),
        "agenticAttempts": root.get("agenticAttempts").cloned().unwrap_or(Value::Null),
        "generatedArtifactsPersistedAfterVerification": root
            .get("generatedArtifactsPersistedAfterVerification")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn legacy_role_path(role: &str) -> Option<String> {
    match role {
        "shared" => Some("shared.h".to_string()),
        "core" => Some("core.cpp".to_string()),
        "gui" => Some("gui.cpp".to_string()),
        "host_runner" => Some("host_runner.cpp".to_string()),
        "device" => None,
        _ => None,
    }
}

fn stable_hash(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu_compile_manifest() -> Value {
        json!({
            "compiler": "clang++",
            "std": "c++20",
            "common_flags": ["-shared", "-fPIC"],
            "module_files": {
                "shared": "internal/shared.h",
                "core": "internal/core.cpp",
                "gui": "internal/gui.cpp",
                "host_runner": "internal/runner.cpp",
                "device": "internal/device.hip"
            },
            "gpu": {
                "vendor": "rocm",
                "device_compiler": "hipcc",
                "arch": ["gfx1201"],
                "device_flags": ["-O3"],
                "fatbin_strategy": "sidecar_module"
            }
        })
    }

    fn reload_plan(plan: &str, affected_roles: Vec<&str>) -> Value {
        json!({
            "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
            "plan": plan,
            "reasonCodes": [],
            "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
            "affectedUserFiles": ["src/main.hip"],
            "affectedGeneratedRoles": affected_roles,
            "timingsMs": {},
        })
    }

    fn ranked_option<'a>(sidecar: &'a Value, plan: &str) -> &'a Value {
        sidecar
            .pointer("/rankedReloadOptions")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("plan").and_then(Value::as_str) == Some(plan))
            })
            .unwrap_or_else(|| panic!("missing ranked reload option {plan}"))
    }

    fn has_reason(value: &Value, code: &str) -> bool {
        value
            .get("reasonCodes")
            .and_then(Value::as_array)
            .map(|codes| codes.iter().any(|v| v.as_str() == Some(code)))
            .unwrap_or(false)
    }

    fn has_invalidation(value: &Value, code: &str) -> bool {
        value
            .pointer("/templateEvidenceInvalidationReasons")
            .and_then(Value::as_array)
            .map(|codes| codes.iter().any(|v| v.as_str() == Some(code)))
            .unwrap_or(false)
    }

    fn effective_flags_hash_for(manifest: &Value) -> String {
        normalize_split_sidecar(&json!({ "compile_manifest": manifest.clone() }))
            .pointer("/effectiveFlagsHash")
            .and_then(Value::as_str)
            .expect("effective flags hash")
            .to_string()
    }

    fn template_evidence(flags_hash: &str, bounded: bool, producer: &str) -> Value {
        json!({
            "schemaVersion": "synthi.gpu.template_evidence.v1",
            "status": "fresh",
            "producer": producer,
            "effectiveFlagsHash": flags_hash,
            "bounded": bounded,
            "entries": [
                {
                    "templateName": "BlockReduce<T>",
                    "templateArgs": ["float"],
                    "owningTU": "src/gpu/reduce.hip",
                    "generatedRole": "device",
                    "abiFingerprint": "abi1",
                    "layoutFingerprint": "layout1",
                    "artifactFingerprint": "artifact1"
                }
            ]
        })
    }

    #[test]
    fn old_sidecar_is_migrated_without_enabling_unsafe_fast_path() {
        let sidecar = json!({
            "split_hash": "123",
            "original_source": "int main() { return 0; }",
            "architecture": "arch",
            "compile_manifest": null,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated.get("schemaVersion").and_then(Value::as_str),
            Some(SIDECAR_SCHEMA_VERSION)
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(migrated
            .pointer("/fastPathPolicy/blockedReasonCodes")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("toolchain_capability_missing")));
        assert_eq!(
            migrated
                .pointer("/lastReloadPlanReport/schemaVersion")
                .and_then(Value::as_str),
            Some(RELOAD_PLAN_SCHEMA_VERSION)
        );
        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("skip")
        );
    }

    #[test]
    fn gpu_manifest_records_compile_identity_and_current_capability_profile() {
        let sidecar = json!({
            "split_hash": "456",
            "compile_manifest": {
                "compiler": "clang++",
                "std": "c++20",
                "common_flags": ["-shared", "-fPIC"],
                "module_files": {
                    "shared": "internal/shared.h",
                    "core": "internal/core.cpp",
                    "gui": "internal/gui.cpp",
                    "host_runner": "internal/runner.cpp",
                    "device": "internal/device.hip"
                },
                "gpu": {
                    "vendor": "rocm",
                    "device_compiler": "hipcc",
                    "arch": ["gfx1201"],
                    "device_flags": ["-O3"],
                    "fatbin_strategy": "sidecar_module"
                }
            },
            "cache_report": {
                "splitCacheHit": true,
                "splitCacheReason": "exact_source_hash",
                "splitCacheKey": "99"
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/selectedCompileCommand/deviceCompiler")
                .and_then(Value::as_str),
            Some("hipcc")
        );
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/status")
                .and_then(Value::as_str),
            Some("current")
        );
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/supportsDeviceOnlyReload")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/splitCacheHit")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/generatedRoles/device/internal")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn rdc_manifest_blocks_direct_device_only_policy() {
        let sidecar = json!({
            "compile_manifest": {
                "compiler": "clang++",
                "std": "c++20",
                "common_flags": [],
                "gpu": {
                    "vendor": "rocm",
                    "device_compiler": "hipcc",
                    "arch": ["gfx1201"],
                    "device_flags": ["-fgpu-rdc"]
                }
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/requiresRdc")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn rdc_warm_rebuild_reports_link_cost_and_requires_consent() {
        let mut manifest = gpu_compile_manifest();
        manifest["gpu"]["device_flags"] = json!(["-O3", "-fgpu-rdc"]);
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("ask_developer")
        );
        assert_eq!(
            migrated.pointer("/consentReason").and_then(Value::as_str),
            Some("rdc_link_over_budget")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            warm_rebuild.get("requiresConsent").and_then(Value::as_bool),
            Some(true)
        );
        assert!(has_reason(warm_rebuild, "rdc_device_link_required"));
        assert!(has_reason(warm_rebuild, "rdc_link_over_budget"));
        assert_eq!(
            migrated
                .pointer("/runReport/toolchainCapabilityProfile/rdcDeviceLink/overBudget")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn arbiter_auto_runs_current_device_only_plan() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("auto_run")
        );
        assert_eq!(
            migrated.pointer("/selectedPlan").and_then(Value::as_str),
            Some("device_only")
        );
        assert_eq!(
            migrated
                .pointer("/consentRequired")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/arbiterDecision")
                .and_then(Value::as_str),
            Some("auto_run")
        );
        assert_eq!(
            device_only.get("safety").and_then(Value::as_str),
            Some("pass")
        );
        assert!(has_reason(device_only, "arbiter.safe"));
    }

    #[test]
    fn arbiter_blocks_stale_toolchain_device_only_plan() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let toolchain_profile = json!({
            "schemaVersion": TOOLCHAIN_PROFILE_SCHEMA_VERSION,
            "status": "stale",
            "compilerId": "hipcc",
            "gpuVendor": "rocm",
            "supportsDeviceOnlyReload": true,
            "requiresRdc": false,
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "toolchainCapabilities": toolchain_profile,
            "lastReloadPlanReport": plan,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            device_only.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert!(has_reason(device_only, "toolchain_capability_stale"));
        assert!(migrated
            .pointer("/fastPathPolicy/blockedReasonCodes")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("toolchain_capability_stale")));
    }

    #[test]
    fn warm_rebuild_rejects_missing_template_evidence() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert!(has_reason(warm_rebuild, "template_evidence_missing"));
        assert_eq!(
            migrated
                .pointer("/runReport/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("missing")
        );
    }

    #[test]
    fn warm_rebuild_rejects_stale_template_evidence() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence("stale-effective-flags", true, "clang-libtooling+vendor-artifacts"),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert_eq!(
            migrated
                .pointer("/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("stale")
        );
        assert!(has_reason(
            warm_rebuild,
            "template_evidence_effective_flags_mismatch"
        ));
        assert!(has_invalidation(
            &migrated,
            "template_evidence_effective_flags_mismatch"
        ));
    }

    #[test]
    fn warm_rebuild_rejects_unbounded_template_evidence() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, false, "clang-libtooling+vendor-artifacts"),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert!(has_reason(warm_rebuild, "template_instantiation_unbounded"));
        assert!(has_invalidation(
            &migrated,
            "template_instantiation_unbounded"
        ));
    }

    #[test]
    fn warm_rebuild_rejects_agentic_template_evidence() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "template-triage-agent"),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert!(has_reason(
            warm_rebuild,
            "template_evidence_not_compiler_derived"
        ));
        assert!(has_invalidation(
            &migrated,
            "template_evidence_not_compiler_derived"
        ));
    }

    #[test]
    fn warm_rebuild_accepts_fresh_bounded_template_evidence() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("auto_run")
        );
        assert_eq!(
            migrated.pointer("/selectedPlan").and_then(Value::as_str),
            Some("warm_rebuild")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            migrated
                .pointer("/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("fresh")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/affectedTemplateInstantiations")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert!(has_reason(warm_rebuild, "arbiter.safe"));
    }

    #[test]
    fn arbiter_requires_consent_for_state_loss_restart() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("cold_restart", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let cold_restart = ranked_option(&migrated, "cold_restart");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("ask_developer")
        );
        assert_eq!(
            migrated
                .pointer("/consentRequired")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated.pointer("/consentReason").and_then(Value::as_str),
            Some("state_loss_requires_consent")
        );
        assert!(has_reason(cold_restart, "state_loss_requires_consent"));
    }

    #[test]
    fn arbiter_requires_consent_for_multi_role_ai_delta() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("ai_delta", vec!["device", "host_runner"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let ai_delta = ranked_option(&migrated, "ai_delta");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("ask_developer")
        );
        assert_eq!(
            migrated
                .pointer("/consentRequired")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated.pointer("/consentReason").and_then(Value::as_str),
            Some("multi_role_ai_delta_requires_consent")
        );
        assert!(has_reason(ai_delta, "multi_role_ai_delta_requires_consent"));
    }

    #[test]
    fn agentic_split_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let agentic_report = json!({
            "schemaVersion": "synthi.gpu.agentic_split.v1",
            "mode": "full_split",
            "attemptCount": 2,
            "maxAttempts": 3,
            "boundedRetries": true,
            "accepted": true,
            "persistedAfterVerification": true,
            "repairScope": "generated_artifacts_only",
            "attempts": [
                {
                    "attempt": 1,
                    "accepted": false,
                    "verifiers": [
                        {
                            "name": "generated_role_schema_mapping",
                            "status": "fail",
                            "reasonCodes": ["split_missing_device_file"]
                        }
                    ]
                },
                {
                    "attempt": 2,
                    "accepted": true,
                    "verifiers": [
                        {
                            "name": "generated_role_schema_mapping",
                            "status": "pass",
                            "reasonCodes": []
                        }
                    ]
                }
            ]
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "agentic_report": agentic_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated.pointer("/agenticMode").and_then(Value::as_str),
            Some("full_split")
        );
        assert_eq!(
            migrated
                .pointer("/agenticAttemptCount")
                .and_then(Value::as_i64),
            Some(2)
        );
        assert_eq!(
            migrated
                .pointer("/generatedArtifactsPersistedAfterVerification")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/agenticAttempts")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/agenticReport/repairScope")
                .and_then(Value::as_str),
            Some("generated_artifacts_only")
        );
    }

    #[test]
    fn generated_artifact_purity_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let purity_report = json!({
            "schemaVersion": "synthi.gpu.generated_artifact_purity.v1",
            "rolesAreInternal": true,
            "internalRoot": ".synthi/generated/gpu",
            "userWorkspaceMaterialization": "forbidden",
            "mappings": [
                {
                    "role": "device",
                    "sourcePath": "gpu/flow_device_x.hip",
                    "internalPath": ".synthi/generated/gpu/device.hip"
                }
            ],
            "missingRoles": [],
            "droppedExtraGeneratedFiles": ["src/user_owned.hpp"]
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "generated_artifact_report": purity_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/generatedArtifactPolicy/internalRoot")
                .and_then(Value::as_str),
            Some(".synthi/generated/gpu")
        );
        assert_eq!(
            migrated
                .pointer("/noUserTreePollutionVerified")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/generatedArtifactReport/mappings/0/internalPath")
                .and_then(Value::as_str),
            Some(".synthi/generated/gpu/device.hip")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/noUserTreePollutionVerified")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn device_mapping_report_is_promoted_into_sidecar_contract() {
        let manifest = gpu_compile_manifest();
        let mapping_report = json!({
            "schemaVersion": "synthi.gpu.device_mapping.v1",
            "generatedDevicePath": "internal/device.hip",
            "mappingStatus": "mapped",
            "deviceMappings": [
                {
                    "kind": "kernel",
                    "symbol": "flow",
                    "sourcePath": "src/gpu/flow.hip",
                    "generatedRole": "device",
                    "generatedPath": "internal/device.hip",
                    "mappingConfidence": "same_name_signature",
                    "signatureHash": "0xabc",
                    "sourceBodyRange": {"startByte": 40, "endByte": 80},
                    "generatedBodyRange": {"startByte": 20, "endByte": 60}
                }
            ],
            "unmappedKernels": [],
            "sourceBaselineHashes": {"src/gpu/flow.hip": "hash1"},
            "sourceBaselineContents": {"src/gpu/flow.hip": "__global__ void flow(float* x) {}"},
            "kernelSignatureHashes": {"flow": "0xabc"},
            "constantGlobalLayoutHashes": {
                "src/gpu/flow.hip": "0xc1",
                "generated:device": "0xc1"
            }
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "device_mapping_report": mapping_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/deviceMappingStatus")
                .and_then(Value::as_str),
            Some("mapped")
        );
        assert_eq!(
            migrated
                .pointer("/deviceMappings/0/sourcePath")
                .and_then(Value::as_str),
            Some("src/gpu/flow.hip")
        );
        assert_eq!(
            migrated
                .pointer("/sourceBaselineHashes/src~1gpu~1flow.hip")
                .and_then(Value::as_str),
            Some("hash1")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/kernelSignatureHashes/flow")
                .and_then(Value::as_str),
            Some("0xabc")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/deviceMappingStatus")
                .and_then(Value::as_str),
            Some("mapped")
        );
    }

    #[test]
    fn source_context_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let source_context_report = json!({
            "schemaVersion": "synthi.gpu.source_context.v1",
            "focus": "src/app/main.cpp",
            "workspaceFileCount": 293,
            "candidateFileCount": 51,
            "includedFileCount": 12,
            "droppedFileCount": 281,
            "sourceContextHash": "ctx1",
            "included": [
                {
                    "path": "src/gpu/flow.hip",
                    "includeReason": "device_translation_unit",
                    "priority": 2,
                    "contentHash": "h1"
                }
            ],
            "dropped": [
                {
                    "path": "docs/readme.md",
                    "dropReason": "docs_tests_examples",
                    "priority": 99,
                    "contentHash": "h2"
                }
            ],
            "criticalDropped": [],
            "deterministicContextComplete": true,
            "buildMetadata": {
                "compileCommandsStatus": "selected",
                "cmakeFileApiStatus": "cmake_project_file_api_missing",
                "selectedCompileCommand": {
                    "status": "selected",
                    "source": "compile_commands.json",
                    "file": "src/app/main.cpp",
                    "compiler": "clang++",
                    "effectiveFlagsHash": "flags1"
                }
            }
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "source_context_report": source_context_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/sourceContextReport/sourceContextHash")
                .and_then(Value::as_str),
            Some("ctx1")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/sourceContextReport/buildMetadata/selectedCompileCommand/file")
                .and_then(Value::as_str),
            Some("src/app/main.cpp")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/sourceContextReport/deterministicContextComplete")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn multi_device_tu_topology_blocks_device_only_fast_path() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let source_context_report = json!({
            "schemaVersion": "synthi.gpu.source_context.v1",
            "included": [],
            "dropped": [],
            "criticalDropped": [],
            "deviceTuTopology": {
                "deviceTranslationUnitCount": 2,
                "deviceTranslationUnits": [
                    {"path": "src/gpu/a.hip", "contentHash": "a"},
                    {"path": "src/gpu/b.hip", "contentHash": "b"}
                ],
                "multiDeviceTu": true,
                "supportStatus": "multi_device_tu_requires_topology_verification",
                "reasonCodes": ["multi_device_tu_requires_topology_verification"]
            }
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "source_context_report": source_context_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(has_reason(
            device_only,
            "multi_device_tu_requires_topology_verification"
        ));
        assert_eq!(
            migrated
                .pointer("/runReport/deviceTuTopology/multiDeviceTu")
                .and_then(Value::as_bool),
            Some(true)
        );
    }
}
