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
    root.entry("templateEvidenceStatus".to_string())
        .or_insert_with(|| Value::String("missing".to_string()));
    root.entry("templateEvidenceInvalidationReasons".to_string())
        .or_insert_with(|| json!(["template_evidence_missing"]));
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
    if template_status != "fresh" {
        blocked.push("template_evidence_missing");
    }

    json!({
        "deviceOnlyAllowed": profile_current && supports_device_only,
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
    let template_status = root
        .get("templateEvidenceStatus")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let template_fresh = template_status == "fresh";
    let template_reason = if template_status == "stale" {
        "template_evidence_stale"
    } else {
        "template_evidence_missing"
    };
    let affected_roles = reload_plan
        .get("affectedGeneratedRoles")
        .and_then(Value::as_array)
        .map(|roles| roles.len())
        .unwrap_or(0);

    let device_only_safety = profile_current && supports_device_only;
    let warm_safety = profile_current && template_fresh;
    let warm_requires_consent = warm_safety && requires_rdc;
    let mut device_only_reasons = Vec::new();
    if device_only_safety {
        device_only_reasons.extend([
            "arbiter.safe",
            "arbiter.under_latency_budget",
            "arbiter.no_state_loss",
        ]);
    } else {
        if !profile_current {
            device_only_reasons.push(profile_reason);
        }
        if profile_current && !supports_device_only {
            device_only_reasons.push("toolchain_capability_no_device_only_reload");
        }
    }

    let mut warm_reasons = Vec::new();
    if warm_safety {
        warm_reasons.extend(["arbiter.safe", "arbiter.no_state_loss"]);
        if warm_requires_consent {
            warm_reasons.extend(["device_linker_bound", "arbiter_user_consent_required"]);
        }
    } else {
        if !profile_current {
            warm_reasons.push(profile_reason);
        }
        if !template_fresh {
            warm_reasons.push(template_reason);
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
    let warm_consent_reason = if warm_requires_consent {
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
            "estimatedMs": if requires_rdc { 8000 } else { 5000 },
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
}
