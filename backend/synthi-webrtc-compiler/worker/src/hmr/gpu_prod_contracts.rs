use crate::hmr::gpu_fission::verify_fission_candidates;
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
    root.entry("affectedHeaderGraph".to_string())
        .or_insert_with(|| {
            device_mapping_report
                .get("deviceIncludeGraph")
                .cloned()
                .unwrap_or(Value::Null)
        });
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
    promote_build_metadata(&mut root, &source_context_report);
    let device_tu_topology = root
        .get("deviceTuTopology")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| source_context_report.get("deviceTuTopology").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_device_tu_topology);
    root.insert("deviceTuTopology".to_string(), device_tu_topology);
    let isolation_report = root
        .get("isolationReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("isolation_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_isolation_report);
    root.insert("isolationReport".to_string(), isolation_report);
    promote_runtime_safety_reports(&mut root);
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
    promote_launch_indirection_report(&mut root);

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

    let device_fast_path_verifier_report = root
        .get("lastDeviceFastPathVerifierReport")
        .cloned()
        .unwrap_or(Value::Null);
    let gpu_ai_delta_verifier_report = root
        .get("lastGpuAiDeltaVerifierReport")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(fission_verifier_report) = fission_verifier_report_from_root(&root) {
        root.insert(
            "fissionVerifierReport".to_string(),
            fission_verifier_report,
        );
    }
    let fission_verifier_report = root.get("fissionVerifierReport").cloned();

    if !root.contains_key("runReport") {
        let mut report = run_report(
            &root,
            &selected_compile_command,
            &toolchain_profile,
            &toolchain_hash,
            &reload_plan,
            &cache_report,
        );
        promote_verifier_reports_into_run_report(
            &mut report,
            device_fast_path_verifier_report,
            gpu_ai_delta_verifier_report,
        );
        promote_fission_verifier_report_into_run_report(&mut report, fission_verifier_report);
        root.insert("runReport".to_string(), report);
    } else if let Some(report) = root.get_mut("runReport") {
        promote_verifier_reports_into_run_report(
            report,
            device_fast_path_verifier_report,
            gpu_ai_delta_verifier_report,
        );
        promote_fission_verifier_report_into_run_report(report, fission_verifier_report);
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
    let device_link = gpu.and_then(|g| {
        g.get("device_link")
            .or_else(|| g.get("deviceLink"))
            .and_then(Value::as_object)
    });
    let requires_rdc = string_array(Some(&device_flags)).iter().any(|f| {
        f.contains("-fgpu-rdc")
            || f.contains("--relocatable-device-code")
            || f.contains("-rdc=true")
            || f == "--device-c"
    }) || device_link
        .and_then(|link| {
            link.get("requires_rdc")
                .or_else(|| link.get("requiresRdc"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    let device_link_budget_ms = gpu
        .and_then(|g| {
            g.get("device_link_budget_ms").or_else(|| {
                device_link.and_then(|link| link.get("budget_ms").or_else(|| link.get("budgetMs")))
            })
        })
        .and_then(Value::as_u64)
        .unwrap_or(5_000);
    let estimated_device_link_ms = gpu
        .and_then(|g| {
            g.get("device_link_estimated_ms").or_else(|| {
                device_link
                    .and_then(|link| link.get("estimated_ms").or_else(|| link.get("estimatedMs")))
            })
        })
        .and_then(Value::as_u64)
        .unwrap_or(if requires_rdc { 8_000 } else { 0 });
    let rdc_over_budget = requires_rdc && estimated_device_link_ms > device_link_budget_ms;
    let supports_incremental_device_link = device_link
        .and_then(|link| {
            link.get("supports_incremental")
                .or_else(|| link.get("supportsIncremental"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    let mut device_link_reason_codes = Vec::new();
    if requires_rdc {
        device_link_reason_codes.push(Value::String("rdc_device_link_required".to_string()));
        if !supports_incremental_device_link {
            device_link_reason_codes.push(Value::String(
                "incremental_device_link_unsupported".to_string(),
            ));
        }
        if rdc_over_budget {
            device_link_reason_codes.push(Value::String("rdc_link_over_budget".to_string()));
        }
    }
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
        "supportsIncrementalDeviceLink": supports_incremental_device_link,
        "rdcDeviceLink": {
            "required": requires_rdc,
            "linkerBound": requires_rdc,
            "estimatedMs": estimated_device_link_ms,
            "budgetMs": device_link_budget_ms,
            "overBudget": rdc_over_budget,
            "costSource": if device_link.is_some() { "manifest_device_link" } else if requires_rdc { "default_policy" } else { "not_required" },
            "reasonCodes": device_link_reason_codes,
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
    roles.insert(
        "deviceRoles".to_string(),
        device_roles_from_manifest(manifest, module_files),
    );
    Value::Object(roles)
}

fn device_roles_from_manifest(
    manifest: &Value,
    module_files: Option<&Map<String, Value>>,
) -> Value {
    let gpu = manifest.get("gpu").and_then(Value::as_object);
    if let Some(device_roles) = gpu
        .and_then(|g| g.get("device_roles").or_else(|| g.get("deviceRoles")))
        .and_then(Value::as_array)
    {
        let roles = device_roles
            .iter()
            .filter_map(|role| {
                let role_obj = role.as_object()?;
                let path = role_obj
                    .get("path")
                    .or_else(|| role_obj.get("generatedPath"))
                    .and_then(Value::as_str)?;
                let role_id = role_obj
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| device_role_id_for_path(path));
                Some(json!({
                    "id": role_id,
                    "path": path,
                    "sourceFiles": role_obj
                        .get("source_files")
                        .or_else(|| role_obj.get("sourceFiles"))
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new())),
                    "compiler": role_obj.get("compiler").cloned().unwrap_or(Value::Null),
                    "arch": role_obj
                        .get("arch")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new())),
                    "requiresRdc": role_obj
                        .get("requires_rdc")
                        .or_else(|| role_obj.get("requiresRdc"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "internal": true,
                }))
            })
            .collect::<Vec<_>>();
        if !roles.is_empty() {
            return Value::Array(roles);
        }
    }

    let device_path = module_files
        .and_then(|m| m.get("device"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| legacy_role_path("device"));
    let Some(path) = device_path else {
        return Value::Array(Vec::new());
    };
    Value::Array(vec![json!({
        "id": device_role_id_for_path(&path),
        "path": path,
        "sourceFiles": [],
        "compiler": gpu
            .and_then(|g| g.get("device_compiler"))
            .cloned()
            .unwrap_or(Value::Null),
        "arch": gpu
            .and_then(|g| g.get("arch"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "requiresRdc": false,
        "internal": true,
    })])
}

fn device_role_id_for_path(path: &str) -> String {
    let filename = path
        .rsplit(|ch| ch == '/' || ch == '\\')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("device");
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename);
    let slug = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if slug.is_empty() {
        "device.device".to_string()
    } else {
        format!("device.{slug}")
    }
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

fn promote_build_metadata(root: &mut Map<String, Value>, source_context_report: &Value) {
    let build_metadata = source_context_report.get("buildMetadata");
    insert_if_missing_or_null(
        root,
        "templateEvidence",
        build_metadata
            .and_then(|m| m.get("templateEvidence"))
            .cloned(),
    );
    if let Some(metadata) = build_metadata {
        insert_if_missing_or_null(
            root,
            "templateEvidenceCollectorReport",
            Some(json!({
                "schemaVersion": "synthi.gpu.template_evidence_collector.v1",
                "status": metadata
                    .get("templateEvidenceStatus")
                    .cloned()
                    .unwrap_or_else(|| Value::String("missing".to_string())),
                "evidenceHash": metadata.get("templateEvidenceHash").cloned().unwrap_or(Value::Null),
                "candidateCount": metadata
                    .get("templateEvidenceCandidateCount")
                    .cloned()
                    .unwrap_or(Value::Null),
                "invalidationReasons": metadata
                    .get("templateEvidenceInvalidationReasons")
                    .cloned()
                    .unwrap_or_else(|| json!(["template_evidence_missing"])),
                "source": "source_context_report",
            })),
        );
    }
    insert_if_missing_or_null(
        root,
        "compileDbHash",
        build_metadata
            .and_then(|m| m.get("compileDbHash"))
            .cloned()
            .or_else(|| {
                build_metadata
                    .and_then(|m| m.get("selectedCompileCommand"))
                    .and_then(|cmd| cmd.get("compileDatabaseHash"))
                    .cloned()
            }),
    );
    insert_if_missing_or_null(
        root,
        "cmakeCodemodelHash",
        build_metadata
            .and_then(|m| m.get("cmakeCodemodelHash"))
            .cloned()
            .or_else(|| {
                build_metadata
                    .and_then(|m| m.get("cmakeFileApi"))
                    .and_then(|api| api.get("codemodelHash"))
                    .cloned()
            }),
    );
    let target_resolution = build_metadata.and_then(|m| m.get("targetResolution"));
    insert_if_missing_or_null(
        root,
        "targetResolutionMethod",
        target_resolution
            .and_then(|target| target.get("method"))
            .cloned(),
    );

    let Some(selected_target) = target_resolution
        .and_then(|target| target.get("selectedTarget"))
        .and_then(Value::as_object)
    else {
        return;
    };
    let target_entry = root
        .entry("targetIdentity".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !target_entry.is_object() {
        *target_entry = Value::Object(Map::new());
    }
    if let Some(target) = target_entry.as_object_mut() {
        insert_if_missing_or_null(
            target,
            "buildSystem",
            Some(Value::String("cmake".to_string())),
        );
        insert_if_missing_or_null(target, "targetName", selected_target.get("name").cloned());
        insert_if_missing_or_null(
            target,
            "configuration",
            selected_target.get("configuration").cloned(),
        );
        insert_if_missing_or_null(target, "targetType", selected_target.get("type").cloned());
        insert_if_missing_or_null(
            target,
            "sourceFiles",
            selected_target.get("sourceFiles").cloned(),
        );
    }
}

fn insert_if_missing_or_null(root: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return;
    };
    let replace = match root.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    };
    if replace {
        root.insert(key.to_string(), value);
    }
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

fn accepted_template_effective_flags_hashes(
    root: &Map<String, Value>,
    effective_flags_hash: &str,
) -> Vec<String> {
    let mut hashes = Vec::new();
    if !effective_flags_hash.is_empty() {
        hashes.push(effective_flags_hash.to_string());
    }
    if let Some(items) = root
        .get("sourceContextReport")
        .and_then(|report| report.get("buildMetadata"))
        .and_then(|metadata| metadata.get("templateEvidenceCompileCommands"))
        .and_then(Value::as_array)
    {
        for item in items {
            if let Some(hash) = item.get("effectiveFlagsHash").and_then(Value::as_str) {
                if !hash.is_empty() && !hashes.iter().any(|existing| existing == hash) {
                    hashes.push(hash.to_string());
                }
            }
        }
    }
    hashes
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
    let accepted_flags_hashes =
        accepted_template_effective_flags_hashes(root, effective_flags_hash);
    if evidence_flags_hash.is_empty()
        || !accepted_flags_hashes
            .iter()
            .any(|accepted| accepted == evidence_flags_hash)
    {
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

fn default_isolation_report() -> Value {
    let unsafe_inprocess = std::env::var("SYNTHI_UNSAFE_INPROCESS")
        .map(|v| v == "1")
        .unwrap_or(false);
    json!({
        "schemaVersion": "synthi.gpu.runner_isolation.v1",
        "platform": std::env::consts::OS,
        "isolationBackend": if unsafe_inprocess { "unsafe_inprocess" } else { "process_isolated" },
        "executionMode": if unsafe_inprocess { "unsafe_inprocess" } else { "process_isolated" },
        "unsafeDebugMode": unsafe_inprocess,
        "processTreeCleanup": !unsafe_inprocess,
        "filesystemIsolation": "not_reported",
        "networkPolicy": "not_reported",
        "seccomp": if cfg!(target_os = "linux") { "not_reported" } else { "platform_unsupported" },
        "cgroups": if cfg!(target_os = "linux") { "not_reported" } else { "platform_unsupported" },
        "windowsJobObject": if cfg!(target_os = "windows") { "not_reported" } else { "platform_unsupported" },
        "gpuFaultDomain": "driver_not_fully_sandboxed",
        "gpuKernelKillGuaranteed": false,
        "reasonCodes": if unsafe_inprocess {
            json!(["unsafe_inprocess_enabled", "arbiter_user_consent_required"])
        } else {
            json!([])
        },
    })
}

fn promote_runtime_safety_reports(root: &mut Map<String, Value>) {
    let fault_markers = root
        .get("gpuDriverFaultMarkers")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("gpu_driver_fault_markers").cloned())
        .filter(|v| !v.is_null())
        .or_else(|| {
            root.get("isolationReport")
                .and_then(|report| report.get("gpuDriverFaultMarkers"))
                .cloned()
                .filter(|v| !v.is_null())
        })
        .unwrap_or_else(|| Value::Array(Vec::new()));
    root.insert("gpuDriverFaultMarkers".to_string(), fault_markers.clone());

    let fault_policy = root
        .get("gpuFaultPolicy")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("gpu_fault_policy").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| gpu_fault_policy(root, &fault_markers));
    let tainted = fault_policy
        .get("tainted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    root.insert("gpuFaultPolicy".to_string(), fault_policy);
    root.insert("gpuDeviceTainted".to_string(), Value::Bool(tainted));

    let memory_arena_stats = root
        .get("memoryArenaStats")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("memory_arena_stats").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_memory_arena_stats);
    root.insert("memoryArenaStats".to_string(), memory_arena_stats.clone());

    let memory_policy = root
        .get("memoryRefreshPolicy")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("memory_refresh_policy").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| memory_refresh_policy(root, &memory_arena_stats));
    let planned_refresh = memory_policy
        .get("plannedMemoryRefresh")
        .cloned()
        .unwrap_or(Value::Null);
    root.insert("plannedMemoryRefresh".to_string(), planned_refresh);
    root.insert("memoryRefreshPolicy".to_string(), memory_policy);
}

fn default_memory_arena_stats() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.memory_arena_stats.v1",
        "status": "not_reported",
        "totalReservedBytes": null,
        "liveAllocationBytes": null,
        "liveAllocationCount": null,
        "freeSpanCount": null,
        "largestFreeBlockBytes": null,
        "fragmentationRatio": null,
        "reloadGeneration": null,
        "pendingAllocationBytes": null,
        "recentAllocationFailureReason": null,
        "pointerSafetyProvable": false,
    })
}

fn gpu_fault_policy(root: &Map<String, Value>, markers: &Value) -> Value {
    let explicitly_tainted = root
        .get("gpuDeviceTainted")
        .or_else(|| root.get("gpu_device_tainted"))
        .or_else(|| root.get("gpuSessionTainted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let marker_items = markers.as_array().cloned().unwrap_or_default();
    let mut reason_codes = Vec::new();
    let marker_tainted = !marker_items.is_empty();
    if explicitly_tainted || marker_tainted {
        push_reason_code(&mut reason_codes, "gpu_device_tainted");
    }
    for marker in &marker_items {
        let marker_text = marker
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                marker
                    .get("reasonCode")
                    .or_else(|| marker.get("reason"))
                    .or_else(|| marker.get("kind"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default()
            .to_ascii_lowercase();
        if marker_text.contains("tdr") || marker_text.contains("timeout") {
            push_reason_code(&mut reason_codes, "gpu_driver_tdr");
        }
        if marker_text.contains("device_lost")
            || marker_text.contains("device-lost")
            || marker_text.contains("driver_fault")
        {
            push_reason_code(&mut reason_codes, "gpu_device_tainted");
        }
    }
    let tainted = explicitly_tainted || marker_tainted;
    json!({
        "schemaVersion": "synthi.gpu.driver_fault_policy.v1",
        "status": if tainted { "tainted" } else { "clear" },
        "tainted": tainted,
        "markers": markers,
        "screenshotsAcceptedAsProof": !tainted,
        "requiredRecovery": if tainted {
            Value::String("cold_runner_restart_or_gpu_session_reset".to_string())
        } else {
            Value::Null
        },
        "reasonCodes": reason_codes,
    })
}

fn memory_refresh_policy(root: &Map<String, Value>, stats: &Value) -> Value {
    let reload_generation = numeric_u64(root, stats, &["reloadGeneration", "reload_generation"]);
    let fragmentation = numeric_f64(
        root,
        stats,
        &[
            "vramFragmentationRatio",
            "fragmentationRatio",
            "fragmentation_ratio",
        ],
    );
    let largest_free_block = numeric_u64(
        root,
        stats,
        &["largestFreeBlockBytes", "largest_free_block_bytes"],
    );
    let pending_allocation = numeric_u64(
        root,
        stats,
        &["pendingAllocationBytes", "pending_allocation_bytes"],
    );
    let failure_reason = string_field(
        root,
        stats,
        &[
            "recentAllocationFailureReason",
            "recent_allocation_failure_reason",
            "allocationFailureReason",
        ],
    );
    let pointer_safety_provable = stats
        .get("pointerSafetyProvable")
        .or_else(|| stats.get("pointer_safety_provable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut status = "ok";
    let mut reason_codes = Vec::new();
    if let Some(generation) = reload_generation {
        if generation > 100 {
            status = "refresh_recommended";
            push_reason_code(&mut reason_codes, "vram_session_refresh_recommended");
        } else if generation > 50 {
            status = "warn";
            push_reason_code(&mut reason_codes, "vram_reload_generation_warning");
        }
    }
    if let Some(ratio) = fragmentation {
        if ratio > 0.50 {
            status = "refresh_recommended";
            push_reason_code(&mut reason_codes, "vram_session_refresh_recommended");
        } else if ratio > 0.35 && status == "ok" {
            status = "warn";
            push_reason_code(&mut reason_codes, "vram_fragmentation_warning");
        } else if ratio > 0.35 {
            push_reason_code(&mut reason_codes, "vram_fragmentation_warning");
        }
    }

    let pending_allocation_would_fail = pending_allocation
        .zip(largest_free_block)
        .map(|(pending, largest)| pending > largest)
        .unwrap_or(false);
    let allocation_failed_from_fragmentation = failure_reason
        .as_deref()
        .map(|reason| {
            let lower = reason.to_ascii_lowercase();
            lower.contains("fragment") || lower.contains("largest_free_block")
        })
        .unwrap_or(false);
    if pending_allocation_would_fail || allocation_failed_from_fragmentation {
        status = "refresh_required";
        push_reason_code(&mut reason_codes, "vram_fragmented");
        push_reason_code(&mut reason_codes, "vram_session_refresh_required");
    }

    if status == "ok" && reload_generation.is_none() && fragmentation.is_none() {
        status = "not_reported";
    }
    let planned_refresh = status != "ok" && status != "not_reported";
    json!({
        "schemaVersion": "synthi.gpu.memory_refresh_policy.v1",
        "status": status,
        "reloadGeneration": reload_generation,
        "vramFragmentationRatio": fragmentation,
        "largestFreeBlockBytes": largest_free_block,
        "pendingAllocationBytes": pending_allocation,
        "recentAllocationFailureReason": failure_reason,
        "pointerSafetyProvable": pointer_safety_provable,
        "boundedDefragmentationAllowed": status == "refresh_required" && pointer_safety_provable,
        "plannedMemoryRefresh": {
            "needed": planned_refresh,
            "status": status,
            "reasonCodes": reason_codes,
        },
        "reasonCodes": reason_codes,
    })
}

fn numeric_u64(root: &Map<String, Value>, stats: &Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(value) = root.get(*key).or_else(|| stats.get(*key)) {
            if let Some(number) = value.as_u64() {
                return Some(number);
            }
        }
    }
    None
}

fn numeric_f64(root: &Map<String, Value>, stats: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = root.get(*key).or_else(|| stats.get(*key)) {
            if let Some(number) = value.as_f64() {
                return Some(number);
            }
        }
    }
    None
}

fn string_field(root: &Map<String, Value>, stats: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = root.get(*key).or_else(|| stats.get(*key)) {
            if let Some(text) = value.as_str() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn push_reason_code(reason_codes: &mut Vec<Value>, reason: &str) {
    if !reason_codes
        .iter()
        .any(|code| code.as_str() == Some(reason))
    {
        reason_codes.push(Value::String(reason.to_string()));
    }
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

fn promote_launch_indirection_report(root: &mut Map<String, Value>) {
    let report = root
        .get("launchIndirectionReport")
        .cloned()
        .filter(|v| !v.is_null())
        .or_else(|| root.get("launch_indirection_report").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_launch_indirection_report);
    let table_version = report.get("tableVersion").cloned().unwrap_or(Value::Null);
    let stale_checks = report
        .get("staleLaunchPointerChecks")
        .cloned()
        .filter(|v| !v.is_null())
        .unwrap_or_else(default_stale_launch_pointer_checks);

    root.insert("launchIndirectionReport".to_string(), report);
    root.insert("launchIndirectionTableVersion".to_string(), table_version);
    root.insert("staleLaunchPointerChecks".to_string(), stale_checks);
}

fn default_launch_indirection_report() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.launch_indirection.v1",
        "status": "missing",
        "tableVersion": null,
        "launchSiteCount": 0,
        "generatedLaunchSitesUseIndirection": false,
        "directLaunchBypassCount": 0,
        "loaderOwnsSymbolLookup": false,
        "vendorSymbolLookupBypassCount": 0,
        "stalePointerRisk": "unknown",
        "staleLaunchPointerChecks": default_stale_launch_pointer_checks(),
        "reasonCodes": ["stale_launch_pointer_check_missing"],
    })
}

fn default_stale_launch_pointer_checks() -> Value {
    json!({
        "schemaVersion": "synthi.gpu.stale_launch_pointer_check.v1",
        "status": "missing",
        "runtimeGenerationChecked": false,
        "failureReasonCode": "reload_failed.stale_launch_pointer",
        "reasonCodes": ["stale_launch_pointer_check_missing"],
    })
}

fn launch_indirection_ok(root: &Map<String, Value>) -> bool {
    root.get("launchIndirectionReport")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        == Some("pass")
        && root
            .get("staleLaunchPointerChecks")
            .and_then(|v| v.get("status"))
            .and_then(Value::as_str)
            == Some("pass")
}

fn launch_indirection_block_reason(root: &Map<String, Value>) -> &'static str {
    let report_status = root
        .get("launchIndirectionReport")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let stale_status = root
        .get("staleLaunchPointerChecks")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("missing");
    if report_status == "missing" || stale_status == "missing" {
        "stale_launch_pointer_check_missing"
    } else if root
        .get("launchIndirectionReport")
        .and_then(|v| v.get("stalePointerRisk"))
        .and_then(Value::as_str)
        == Some("detected")
        || stale_status == "fail"
    {
        "stale_launch_pointer_detected"
    } else {
        "launch_indirection_unverified"
    }
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
    let launch_ok = launch_indirection_ok(root);
    if !launch_ok {
        blocked.push(launch_indirection_block_reason(root));
    }
    let gpu_tainted = root
        .get("gpuFaultPolicy")
        .and_then(|v| v.get("tainted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if gpu_tainted {
        blocked.push("gpu_device_tainted");
    }
    let memory_refresh_required = root
        .get("memoryRefreshPolicy")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        == Some("refresh_required");
    if memory_refresh_required {
        blocked.push("vram_session_refresh_required");
    }
    if template_status != "fresh" {
        blocked.push("template_evidence_missing");
    }

    json!({
        "deviceOnlyAllowed": profile_current
            && supports_device_only
            && !multi_device_tu
            && launch_ok
            && !gpu_tainted
            && !memory_refresh_required,
        "warmRebuildAllowed": profile_current
            && template_status == "fresh"
            && launch_ok
            && !gpu_tainted
            && !memory_refresh_required,
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
    let supports_incremental_device_link = toolchain_profile
        .get("supportsIncrementalDeviceLink")
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
    let unsafe_debug_mode = root
        .get("isolationReport")
        .and_then(|v| v.get("unsafeDebugMode"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let multi_device_tu = root
        .get("deviceTuTopology")
        .and_then(|v| v.get("multiDeviceTu"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let launch_ok = launch_indirection_ok(root);
    let launch_block_reason = launch_indirection_block_reason(root);
    let gpu_tainted = root
        .get("gpuFaultPolicy")
        .and_then(|v| v.get("tainted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let memory_refresh_required = root
        .get("memoryRefreshPolicy")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        == Some("refresh_required");
    let memory_refresh_reasons: Vec<String> = root
        .get("memoryRefreshPolicy")
        .and_then(|v| v.get("reasonCodes"))
        .and_then(Value::as_array)
        .map(|codes| {
            codes
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .filter(|codes: &Vec<String>| !codes.is_empty())
        .unwrap_or_else(|| vec!["vram_session_refresh_required".to_string()]);

    let device_only_safety = profile_current
        && supports_device_only
        && !multi_device_tu
        && launch_ok
        && !gpu_tainted
        && !memory_refresh_required;
    let warm_safety =
        profile_current && template_fresh && launch_ok && !gpu_tainted && !memory_refresh_required;
    let device_only_requires_consent = device_only_safety && unsafe_debug_mode;
    let warm_requires_consent =
        warm_safety && (requires_rdc || rdc_over_budget || unsafe_debug_mode);
    let mut device_only_reasons: Vec<String> = Vec::new();
    if device_only_safety {
        device_only_reasons.extend([
            "arbiter.safe".to_string(),
            "arbiter.under_latency_budget".to_string(),
            "arbiter.no_state_loss".to_string(),
        ]);
        if device_only_requires_consent {
            device_only_reasons.push("unsafe_debug_mode".to_string());
            device_only_reasons.push("arbiter_user_consent_required".to_string());
        }
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
        if !launch_ok {
            device_only_reasons.push(launch_block_reason.to_string());
        }
        if gpu_tainted {
            device_only_reasons.push("gpu_device_tainted".to_string());
        }
        if memory_refresh_required {
            for reason in &memory_refresh_reasons {
                if !device_only_reasons.contains(reason) {
                    device_only_reasons.push(reason.clone());
                }
            }
            if !device_only_reasons.contains(&"vram_session_refresh_required".to_string()) {
                device_only_reasons.push("vram_session_refresh_required".to_string());
            }
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
            if requires_rdc && !supports_incremental_device_link {
                warm_reasons.push("incremental_device_link_unsupported".to_string());
            }
            if rdc_over_budget {
                warm_reasons.push("rdc_link_over_budget".to_string());
            }
            if unsafe_debug_mode {
                warm_reasons.push("unsafe_debug_mode".to_string());
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
        if !launch_ok {
            warm_reasons.push(launch_block_reason.to_string());
        }
        if gpu_tainted {
            warm_reasons.push("gpu_device_tainted".to_string());
        }
        if memory_refresh_required {
            for reason in &memory_refresh_reasons {
                if !warm_reasons.contains(reason) {
                    warm_reasons.push(reason.clone());
                }
            }
            if !warm_reasons.contains(&"vram_session_refresh_required".to_string()) {
                warm_reasons.push("vram_session_refresh_required".to_string());
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
    let device_only_consent_reason = if device_only_requires_consent {
        Value::String("unsafe_debug_mode".to_string())
    } else {
        Value::Null
    };
    let warm_consent_reason = if warm_requires_consent && rdc_over_budget {
        Value::String("rdc_link_over_budget".to_string())
    } else if warm_requires_consent && unsafe_debug_mode {
        Value::String("unsafe_debug_mode".to_string())
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
    let mut cold_restart_reasons = vec![
        "state_loss_requires_consent".to_string(),
        "arbiter_user_consent_required".to_string(),
    ];
    if gpu_tainted {
        cold_restart_reasons.push("gpu_device_tainted".to_string());
    }
    if memory_refresh_required {
        cold_restart_reasons.push("vram_session_refresh_required".to_string());
    }
    let cold_restart_consent_reason = if gpu_tainted {
        "gpu_device_tainted"
    } else if memory_refresh_required {
        "vram_session_refresh_required"
    } else {
        "state_loss_requires_consent"
    };

    json!([
        {
            "plan": "device_only",
            "safety": if device_only_safety { "pass" } else { "fail" },
            "estimatedMs": 1000,
            "stateLoss": false,
            "requiresConsent": device_only_requires_consent,
            "consentReason": device_only_consent_reason,
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
            "consentReason": cold_restart_consent_reason,
            "reasonCodes": cold_restart_reasons,
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

fn run_failure_card(root: &Map<String, Value>, reload_plan: &Value) -> Value {
    let reason_codes = run_failure_reason_codes(root, reload_plan);
    let Some(template) = failure_card_template(&reason_codes) else {
        return Value::Null;
    };
    let fallback = reload_plan
        .get("safeFallback")
        .or_else(|| reload_plan.get("selectedFallback"))
        .cloned()
        .or_else(|| {
            reload_plan
                .get("fallbacksAvailable")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .cloned()
        })
        .or_else(|| root.get("selectedPlan").cloned())
        .unwrap_or(Value::Null);

    json!({
        "schemaVersion": "synthi.gpu.failure_card.v1",
        "category": template.category,
        "problem": template.problem,
        "reason": template.reason,
        "changedSymbol": failure_card_changed_symbol(root),
        "chosenFallback": fallback,
        "nextAction": template.next_action,
        "reasonCodes": reason_codes,
        "formatted": format!(
            "Problem:\n  {}\n\nReason:\n  {}\n\nChosen fallback:\n  {}\n\nNext action:\n  {}",
            template.problem,
            template.reason,
            fallback
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| fallback.to_string()),
            template.next_action
        ),
    })
}

fn run_failure_reason_codes(root: &Map<String, Value>, reload_plan: &Value) -> Vec<String> {
    let mut codes = Vec::new();
    append_reason_codes(
        &mut codes,
        root.get("lastDeviceFastPathVerifierReport")
            .and_then(|report| report.get("reasonCodes")),
    );
    append_reason_codes(
        &mut codes,
        root.get("lastGpuAiDeltaVerifierReport")
            .and_then(|report| report.get("reasonCodes")),
    );
    append_reason_codes(&mut codes, reload_plan.get("reasonCodes"));
    append_reason_codes(&mut codes, root.get("arbiterReasonCodes"));

    if root
        .get("consentRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(reason) = root.get("consentReason").and_then(Value::as_str) {
            codes.push(reason.to_string());
        }
        codes.push("arbiter_user_consent_required".to_string());
    }

    dedupe_strings(codes)
}

fn append_reason_codes(codes: &mut Vec<String>, value: Option<&Value>) {
    if let Some(items) = value.and_then(Value::as_array) {
        for item in items {
            if let Some(code) = item.as_str().filter(|s| !s.trim().is_empty()) {
                codes.push(code.to_string());
            }
        }
    }
}

fn dedupe_strings(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        if !out.iter().any(|existing| existing == &item) {
            out.push(item);
        }
    }
    out
}

struct FailureCardTemplate {
    category: &'static str,
    problem: &'static str,
    reason: &'static str,
    next_action: &'static str,
}

fn failure_card_template(reason_codes: &[String]) -> Option<FailureCardTemplate> {
    if has_reason(reason_codes, "abi.kernel_signature_changed") {
        return Some(FailureCardTemplate {
            category: "abi_changed",
            problem: "Device-only reload rejected.",
            reason: "Kernel signature changed.",
            next_action: "Update the host launch path and use a mixed rebuild, or revert the signature change.",
        });
    }
    if has_reason(reason_codes, "abi.constant_global_layout_changed") {
        return Some(FailureCardTemplate {
            category: "constant_layout_changed",
            problem: "Device-only reload rejected.",
            reason: "Device constant or global symbol layout changed.",
            next_action: "Use a mixed or cold reload path that rebuilds ABI metadata, or revert the layout change.",
        });
    }
    if has_reason(reason_codes, "stale_launch_pointer_detected") {
        return Some(FailureCardTemplate {
            category: "stale_launch_pointer_detected",
            problem: "Sidecar reload rejected.",
            reason: "A generated launch path bypasses the launch indirection table or may retain a stale launch pointer.",
            next_action: "Regenerate or repair the internal launch roles so every launch goes through the stable indirection table.",
        });
    }
    if has_reason(reason_codes, "toolchain_capability_missing") {
        return Some(FailureCardTemplate {
            category: "toolchain_capability_missing",
            problem: "Fast GPU reload rejected.",
            reason: "The selected target has no current toolchain capability profile.",
            next_action: "Resolve build metadata and rerun the toolchain capability probe before using device-only or warm rebuild.",
        });
    }
    if has_reason(reason_codes, "toolchain_capability_stale") {
        return Some(FailureCardTemplate {
            category: "toolchain_capability_stale",
            problem: "Fast GPU reload rejected.",
            reason: "The toolchain capability profile is stale for the selected compile command or flags.",
            next_action: "Refresh build metadata and toolchain probes, then retry the reload.",
        });
    }
    if has_reason(reason_codes, "template_evidence_missing") {
        return Some(FailureCardTemplate {
            category: "template_evidence_missing",
            problem: "Warm rebuild rejected.",
            reason: "Compiler-derived template evidence is missing.",
            next_action: "Run the template evidence collector or fall back to AI delta, full re-split, or a normal rebuild.",
        });
    }
    if has_reason(reason_codes, "template_evidence_stale") {
        return Some(FailureCardTemplate {
            category: "template_evidence_stale",
            problem: "Warm rebuild rejected.",
            reason: "Compiler-derived template evidence is stale for the current source, flags, or GPU architecture.",
            next_action: "Refresh template evidence before using warm rebuild.",
        });
    }
    if has_reason(reason_codes, "template_instantiation_unbounded") {
        return Some(FailureCardTemplate {
            category: "template_instantiation_unbounded",
            problem: "Warm rebuild rejected.",
            reason: "Affected template instantiations cannot be bounded.",
            next_action: "Use a full re-split, normal rebuild, or narrow the edit to mapped non-template device code.",
        });
    }
    if has_reason(reason_codes, "header_dependency_unbounded") {
        return Some(FailureCardTemplate {
            category: "header_dependency_unbounded",
            problem: "Direct GPU reload rejected.",
            reason: "The affected header dependency ripple is not bounded.",
            next_action: "Refresh source-context metadata or use a broader rebuild path.",
        });
    }
    if has_reason(reason_codes, "mapping.device_mapping_missing")
        || has_reason(reason_codes, "mapping.source_baseline_missing")
        || has_reason(reason_codes, "mapping.source_baseline_stale")
    {
        return Some(FailureCardTemplate {
            category: "mapping_missing",
            problem: "Device-only reload rejected.",
            reason: "The user source no longer has a valid mapping to an internal generated device role.",
            next_action: "Use AI delta or a full re-split to regenerate mappings.",
        });
    }
    if has_reason(reason_codes, "parser.device_ast_parse_failed") {
        return Some(FailureCardTemplate {
            category: "unsupported_project_shape",
            problem: "Device-only reload rejected.",
            reason:
                "The selected-target parser could not build a reliable before/after device AST.",
            next_action:
                "Fix the parse error or use AI delta/full re-split instead of the direct fast path.",
        });
    }
    if has_reason(reason_codes, "warm_rebuild_budget_exceeded") {
        return Some(FailureCardTemplate {
            category: "warm_rebuild_budget_exceeded",
            problem: "Warm rebuild skipped.",
            reason: "The deterministic warm path exceeded its latency budget.",
            next_action:
                "Use a normal incremental build, AI delta, or request consent for the slower path.",
        });
    }
    if has_reason(reason_codes, "incremental_device_link_unsupported") {
        return Some(FailureCardTemplate {
            category: "incremental_device_link_unsupported",
            problem: "Warm rebuild requires consent.",
            reason: "The selected toolchain does not report supported incremental device linking for this RDC path.",
            next_action: "Ask the developer before running the full device-link path, or use a normal incremental build/cold restart.",
        });
    }
    if has_reason(reason_codes, "device_linker_bound")
        || has_reason(reason_codes, "rdc_link_over_budget")
    {
        return Some(FailureCardTemplate {
            category: "device_linker_bound",
            problem: "Warm rebuild requires consent.",
            reason: "RDC device linking is expected to dominate reload latency.",
            next_action: "Ask the developer before running the linker-bound path or choose a clearer fallback.",
        });
    }
    if has_reason(reason_codes, "multi_role_ai_delta_requires_consent") {
        return Some(FailureCardTemplate {
            category: "multi_role_ai_delta_requires_consent",
            problem: "AI delta requires developer consent.",
            reason: "The proposed AI delta touches multiple generated roles.",
            next_action:
                "Review the proposed role changes or run a full re-split with explicit consent.",
        });
    }
    if has_reason(reason_codes, "state_loss_requires_consent") {
        return Some(FailureCardTemplate {
            category: "state_loss_requires_consent",
            problem: "Reload requires developer consent.",
            reason: "The fallback may lose runner state.",
            next_action: "Ask the developer before cold restart or state-losing reload.",
        });
    }
    if has_reason(reason_codes, "vram_fragmented")
        || has_reason(reason_codes, "vram_session_refresh_required")
    {
        return Some(FailureCardTemplate {
            category: "vram_session_refresh_required",
            problem: "GPU reload paused.",
            reason: "The runtime memory arena reports fragmentation or allocation pressure that requires a planned session refresh.",
            next_action: "Refresh or cold restart the runner before attempting a reload that needs the affected VRAM allocation.",
        });
    }
    if has_reason(reason_codes, "gpu_device_tainted") || has_reason(reason_codes, "gpu_driver_tdr")
    {
        return Some(FailureCardTemplate {
            category: "gpu_device_tainted",
            problem: "GPU validation stopped.",
            reason: "The GPU device or preview session is marked tainted after a suspected driver fault.",
            next_action: "Cold restart the runner or reset the GPU session before accepting screenshots as proof.",
        });
    }
    if has_reason(reason_codes, "screenshot_not_ready") {
        return Some(FailureCardTemplate {
            category: "screenshot_not_ready",
            problem: "Runtime verification incomplete.",
            reason: "The runner did not produce a visible validation frame.",
            next_action: "Wait for a visible frame or inspect runtime/render failures before marking validation passed.",
        });
    }
    if has_reason(reason_codes, "arbiter_user_consent_required") {
        return Some(FailureCardTemplate {
            category: "arbiter_user_consent_required",
            problem: "Reload requires developer consent.",
            reason:
                "The Arbiter selected a costly, disruptive, experimental, or state-affecting path.",
            next_action: "Request developer consent before executing this path.",
        });
    }
    None
}

fn has_reason(reason_codes: &[String], expected: &str) -> bool {
    reason_codes.iter().any(|code| code == expected)
}

fn failure_card_changed_symbol(root: &Map<String, Value>) -> Value {
    let Some(report) = root.get("lastDeviceFastPathVerifierReport") else {
        return Value::Null;
    };
    let evidence = report.get("evidence").unwrap_or(&Value::Null);
    let kernel_signature = evidence.get("kernelSignature").unwrap_or(&Value::Null);
    if kernel_signature
        .get("changed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "kernelSignaturesBefore": kernel_signature
                .pointer("/before/signatures")
                .cloned()
                .unwrap_or(Value::Null),
            "kernelSignaturesAfter": kernel_signature
                .pointer("/after/signatures")
                .cloned()
                .unwrap_or(Value::Null),
        });
    }
    let constant_layout = evidence.get("constantGlobalLayout").unwrap_or(&Value::Null);
    if constant_layout
        .get("changed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "beforeConstantGlobalLayoutHash": constant_layout
                .get("beforeHash")
                .cloned()
                .unwrap_or(Value::Null),
            "afterConstantGlobalLayoutHash": constant_layout
                .get("afterHash")
                .cloned()
                .unwrap_or(Value::Null),
        });
    }
    Value::Null
}

fn run_report(
    root: &Map<String, Value>,
    selected_compile_command: &Value,
    toolchain_profile: &Value,
    toolchain_hash: &str,
    reload_plan: &Value,
    cache_report: &Value,
) -> Value {
    let ranked_options = root
        .get("rankedReloadOptions")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let warm_option = ranked_plan_option(&ranked_options, "warm_rebuild");
    let rdc_device_link = toolchain_profile
        .get("rdcDeviceLink")
        .cloned()
        .unwrap_or(Value::Null);
    let device_link_required = toolchain_profile
        .get("requiresRdc")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let device_link_estimate_ms = rdc_device_link
        .get("estimatedMs")
        .cloned()
        .unwrap_or(Value::Null);
    let device_link_budget_ms = rdc_device_link
        .get("budgetMs")
        .cloned()
        .unwrap_or(Value::Null);
    let device_linker_bound = rdc_device_link
        .get("linkerBound")
        .cloned()
        .unwrap_or_else(|| Value::Bool(device_link_required));
    let device_link_budget_result = if rdc_device_link
        .get("overBudget")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Value::String("over_budget".to_string())
    } else if device_link_required {
        Value::String("within_budget".to_string())
    } else {
        Value::String("not_required".to_string())
    };
    let warm_path_estimate_ms = root
        .get("warmPathEstimateMs")
        .cloned()
        .or_else(|| warm_option.and_then(|option| option.get("estimatedMs").cloned()))
        .unwrap_or(Value::Null);
    let warm_path_budget_result = root
        .get("warmPathBudgetResult")
        .cloned()
        .unwrap_or_else(|| {
            if warm_option
                .and_then(|option| option.get("reasonCodes"))
                .and_then(Value::as_array)
                .map(|codes| {
                    codes
                        .iter()
                        .any(|code| code.as_str() == Some("warm_rebuild_budget_exceeded"))
                })
                .unwrap_or(false)
            {
                Value::String("over_budget".to_string())
            } else {
                Value::String("not_measured".to_string())
            }
        });
    let memory_arena_stats = root.get("memoryArenaStats").cloned().unwrap_or(Value::Null);
    let memory_refresh_policy = root
        .get("memoryRefreshPolicy")
        .cloned()
        .unwrap_or(Value::Null);
    let reload_generation = root
        .get("reloadGeneration")
        .cloned()
        .or_else(|| memory_refresh_policy.get("reloadGeneration").cloned())
        .unwrap_or(Value::Null);
    let vram_fragmentation_ratio = root
        .get("vramFragmentationRatio")
        .cloned()
        .or_else(|| memory_refresh_policy.get("vramFragmentationRatio").cloned())
        .unwrap_or(Value::Null);
    let largest_free_block_bytes = root
        .get("largestFreeBlockBytes")
        .cloned()
        .or_else(|| memory_refresh_policy.get("largestFreeBlockBytes").cloned())
        .unwrap_or(Value::Null);
    let gpu_fault_policy = root.get("gpuFaultPolicy").cloned().unwrap_or(Value::Null);
    let isolation_backend = root
        .get("isolationBackend")
        .cloned()
        .or_else(|| {
            root.get("isolationReport")
                .and_then(|report| {
                    report
                        .get("isolationBackend")
                        .or_else(|| report.get("backend"))
                })
                .cloned()
        })
        .unwrap_or(Value::Null);
    let failure_card = run_failure_card(root, reload_plan);

    let mut report = json!({
        "schemaVersion": RUN_REPORT_SCHEMA_VERSION,
        "runId": root
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "workspaceId": root.get("workspaceId").cloned().unwrap_or(Value::Null),
        "entryFile": root.get("entryFile").cloned().unwrap_or(Value::Null),
        "selectedTarget": root.get("targetIdentity").cloned().unwrap_or(Value::Null),
        "targetResolutionMethod": root
            .get("targetResolutionMethod")
            .cloned()
            .unwrap_or(Value::Null),
        "sourceContextFiles": source_context_paths(root, "included"),
        "omittedFiles": source_context_paths(root, "dropped"),
        "compileDbHash": root.get("compileDbHash").cloned().unwrap_or(Value::Null),
        "cmakeCodemodelHash": root
            .get("cmakeCodemodelHash")
            .cloned()
            .unwrap_or(Value::Null),
        "gpuVendor": toolchain_profile
            .get("gpuVendor")
            .cloned()
            .unwrap_or(Value::Null),
        "gpuArch": toolchain_profile
            .get("gpuArch")
            .cloned()
            .unwrap_or(Value::Null),
        "model": root.get("model").cloned().unwrap_or(Value::Null),
        "splitSchemaVersion": root
            .get("splitSchemaVersion")
            .cloned()
            .unwrap_or_else(|| Value::String(SIDECAR_SCHEMA_VERSION.to_string())),
        "promptSchemaVersion": root
            .get("promptSchemaVersion")
            .cloned()
            .unwrap_or(Value::Null),
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
        "rankedReloadOptions": ranked_options,
        "consentRequired": root.get("consentRequired").cloned().unwrap_or(Value::Null),
        "consentReason": root.get("consentReason").cloned().unwrap_or(Value::Null),
        "failureCard": failure_card,
        "generatedRoles": root.get("generatedRoles").cloned().unwrap_or(Value::Null),
        "compileCommands": root
            .get("compileCommands")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![selected_compile_command.clone()])),
        "deviceLinkCommands": root
            .get("deviceLinkCommands")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "deviceSymbolTableHash": root
            .get("deviceSymbolTableHash")
            .cloned()
            .unwrap_or(Value::Null),
        "affectedHeaderGraph": root
            .get("affectedHeaderGraph")
            .cloned()
            .unwrap_or(Value::Null),
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
        "isolationReport": root.get("isolationReport").cloned().unwrap_or(Value::Null),
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
        "templateArtifactFingerprintChanges": root
            .get("templateArtifactFingerprintChanges")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "templateTriageAgentDecision": root
            .get("templateTriageAgentDecision")
            .cloned()
            .unwrap_or(Value::Null),
        "affectedTemplateInstantiations": root
            .get("affectedTemplateInstantiations")
            .cloned()
            .unwrap_or(Value::Null),
        "warmPathEstimateMs": warm_path_estimate_ms,
        "warmPathActualMs": root
            .get("warmPathActualMs")
            .cloned()
            .unwrap_or(Value::Null),
        "warmPathBudgetResult": warm_path_budget_result,
        "deviceLinkRequired": Value::Bool(device_link_required),
        "deviceLinkEstimateMs": device_link_estimate_ms,
        "deviceLinkActualMs": root
            .get("deviceLinkActualMs")
            .cloned()
            .unwrap_or(Value::Null),
        "deviceLinkBudgetMs": device_link_budget_ms,
        "deviceLinkBudgetResult": device_link_budget_result,
        "deviceLinkerBound": device_linker_bound,
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
        "launchIndirectionTableVersion": root
            .get("launchIndirectionTableVersion")
            .cloned()
            .unwrap_or(Value::Null),
        "launchIndirectionReport": root
            .get("launchIndirectionReport")
            .cloned()
            .unwrap_or(Value::Null),
        "staleLaunchPointerChecks": root
            .get("staleLaunchPointerChecks")
            .cloned()
            .unwrap_or(Value::Null),
        "verifierRules": root.get("verifierRules").cloned().unwrap_or(Value::Null),
        "reloadTimings": reload_plan
            .get("timingsMs")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
        "screenshotTimings": root
            .get("screenshotTimings")
            .cloned()
            .unwrap_or(Value::Null),
        "memoryArenaStats": memory_arena_stats,
        "reloadGeneration": reload_generation,
        "vramFragmentationRatio": vram_fragmentation_ratio,
        "largestFreeBlockBytes": largest_free_block_bytes,
        "plannedMemoryRefresh": root
            .get("plannedMemoryRefresh")
            .cloned()
            .unwrap_or(Value::Null),
        "gpuDriverFaultMarkers": root
            .get("gpuDriverFaultMarkers")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "isolationBackend": isolation_backend,
        "runnerPid": root.get("runnerPid").cloned().unwrap_or(Value::Null),
        "runnerExitStatus": root
            .get("runnerExitStatus")
            .cloned()
            .unwrap_or(Value::Null),
        "crashMarkers": root
            .get("crashMarkers")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "artifactPaths": root
            .get("artifactPaths")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "agenticAcceptedAttempt": root
            .get("agenticReport")
            .and_then(|report| report.get("acceptedAttempt"))
            .cloned()
            .or_else(|| {
                root.get("agenticReport")
                    .and_then(|report| report.get("finalAcceptedAttempt"))
                    .cloned()
            })
            .unwrap_or(Value::Null),
        "agenticVerifierFailures": agentic_verifier_failures(root),
    });
    if let Some(report) = report.as_object_mut() {
        report.insert("memoryRefreshPolicy".to_string(), memory_refresh_policy);
        report.insert("gpuFaultPolicy".to_string(), gpu_fault_policy);
    }
    report
}

fn promote_verifier_reports_into_run_report(
    report: &mut Value,
    device_fast_path_verifier_report: Value,
    gpu_ai_delta_verifier_report: Value,
) {
    let Some(report) = report.as_object_mut() else {
        return;
    };
    report.insert(
        "deviceFastPathVerifierReport".to_string(),
        device_fast_path_verifier_report,
    );
    report.insert(
        "gpuAiDeltaVerifierReport".to_string(),
        gpu_ai_delta_verifier_report,
    );
}

fn promote_fission_verifier_report_into_run_report(
    report: &mut Value,
    fission_report: Option<Value>,
) {
    let Some(report) = report.as_object_mut() else {
        return;
    };
    if let Some(fission_report) = fission_report {
        report.insert("fissionVerifierReport".to_string(), fission_report);
    }
}

fn fission_verifier_report_from_root(root: &Map<String, Value>) -> Option<Value> {
    let candidates = collect_fission_candidates(root);
    if candidates.is_empty() {
        return None;
    }
    Some(verify_fission_candidates(&Value::Array(candidates)))
}

fn collect_fission_candidates(root: &Map<String, Value>) -> Vec<Value> {
    let mut candidates = Vec::new();
    append_fission_candidates(&mut candidates, root.get("fissionCandidate"));
    append_fission_candidates(&mut candidates, root.get("fissionCandidates"));
    append_fission_candidates(
        &mut candidates,
        root.get("lastDeviceFastPathVerifierReport")
            .and_then(|report| report.get("fissionCandidate")),
    );
    append_fission_candidates(
        &mut candidates,
        root.get("lastGpuAiDeltaVerifierReport")
            .and_then(|report| report.get("fissionCandidate")),
    );
    candidates
}

fn append_fission_candidates(candidates: &mut Vec<Value>, value: Option<&Value>) {
    match value {
        Some(Value::Array(items)) => candidates.extend(items.iter().cloned()),
        Some(Value::Object(_)) => {
            if let Some(candidate) = value {
                candidates.push(candidate.clone());
            }
        }
        _ => {}
    }
}

fn ranked_plan_option<'a>(ranked_options: &'a Value, plan: &str) -> Option<&'a Value> {
    ranked_options.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("plan").and_then(Value::as_str) == Some(plan))
    })
}

fn source_context_paths(root: &Map<String, Value>, field: &str) -> Value {
    root.get("sourceContextReport")
        .and_then(|report| report.get(field))
        .and_then(Value::as_array)
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .filter_map(|item| item.get("path").and_then(Value::as_str))
                    .map(|path| Value::String(path.to_string()))
                    .collect(),
            )
        })
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn agentic_verifier_failures(root: &Map<String, Value>) -> Value {
    let Some(attempts) = root
        .get("agenticReport")
        .and_then(|report| report.get("attempts"))
        .and_then(Value::as_array)
    else {
        return Value::Array(Vec::new());
    };

    let mut failures = Vec::new();
    for attempt in attempts {
        let attempt_number = attempt
            .get("attempt")
            .cloned()
            .or_else(|| attempt.get("attemptNumber").cloned())
            .unwrap_or(Value::Null);
        let Some(verifiers) = attempt.get("verifiers").and_then(Value::as_array) else {
            continue;
        };
        for verifier in verifiers {
            if verifier.get("status").and_then(Value::as_str) == Some("pass") {
                continue;
            }
            failures.push(json!({
                "attempt": attempt_number,
                "verifier": verifier
                    .get("name")
                    .or_else(|| verifier.get("rule"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": verifier.get("status").cloned().unwrap_or(Value::Null),
                "reasonCodes": verifier
                    .get("reasonCodes")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            }));
        }
    }
    Value::Array(failures)
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
                "fatbin_strategy": "sidecar_module",
                "device_roles": [
                    {
                        "id": "device.device",
                        "path": "internal/device.hip",
                        "source_files": ["src/gpu/device.hip"],
                        "compiler": "hipcc",
                        "arch": ["gfx1201"],
                        "requires_rdc": false
                    }
                ],
                "device_link": {
                    "requires_rdc": false,
                    "affected_roles": ["device.device"],
                    "supports_incremental": false,
                    "estimated_ms": 0,
                    "budget_ms": 5000
                }
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

    fn launch_indirection_report() -> Value {
        json!({
            "schemaVersion": "synthi.gpu.launch_indirection.v1",
            "status": "pass",
            "tableVersion": 1,
            "launchSiteCount": 1,
            "generatedLaunchSitesUseIndirection": true,
            "directLaunchBypassCount": 0,
            "loaderOwnsSymbolLookup": true,
            "vendorSymbolLookupBypassCount": 0,
            "stalePointerRisk": "none",
            "staleLaunchPointerChecks": {
                "schemaVersion": "synthi.gpu.stale_launch_pointer_check.v1",
                "status": "pass",
                "runtimeGenerationChecked": true,
                "failureReasonCode": "reload_failed.stale_launch_pointer",
                "reasonCodes": ["launch_indirection.runtime_generation_checked"]
            },
            "reasonCodes": ["launch_indirection.host_roles_use_public_wrapper"]
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
        assert!(migrated
            .pointer("/fastPathPolicy/blockedReasonCodes")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("stale_launch_pointer_check_missing")));
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
                    "fatbin_strategy": "sidecar_module",
                    "device_roles": [
                        {
                            "id": "device.device",
                            "path": "internal/device.hip",
                            "source_files": ["src/gpu/device.hip"],
                            "compiler": "hipcc",
                            "arch": ["gfx1201"],
                            "requires_rdc": false
                        }
                    ],
                    "device_link": {
                        "requires_rdc": false,
                        "affected_roles": ["device.device"],
                        "supports_incremental": false,
                        "estimated_ms": 0,
                        "budget_ms": 5000
                    }
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
        assert_eq!(
            migrated
                .pointer("/generatedRoles/deviceRoles/0/id")
                .and_then(Value::as_str),
            Some("device.device")
        );
        assert_eq!(
            migrated
                .pointer("/generatedRoles/deviceRoles/0/sourceFiles/0")
                .and_then(Value::as_str),
            Some("src/gpu/device.hip")
        );
    }

    #[test]
    fn missing_launch_indirection_report_blocks_device_only_policy() {
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
            Some("fallback")
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            device_only.get("safety").and_then(Value::as_str),
            Some("fail")
        );
        assert!(has_reason(
            device_only,
            "stale_launch_pointer_check_missing"
        ));
        assert_eq!(
            migrated
                .pointer("/runReport/staleLaunchPointerChecks/status")
                .and_then(Value::as_str),
            Some("missing")
        );
    }

    #[test]
    fn launch_indirection_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/launchIndirectionTableVersion")
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/launchIndirectionReport/status")
                .and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/staleLaunchPointerChecks/failureReasonCode")
                .and_then(Value::as_str),
            Some("reload_failed.stale_launch_pointer")
        );
    }

    #[test]
    fn detected_stale_launch_pointer_risk_blocks_reload_options() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let mut launch_report = launch_indirection_report();
        launch_report["status"] = Value::String("fail".to_string());
        launch_report["stalePointerRisk"] = Value::String("detected".to_string());
        launch_report["staleLaunchPointerChecks"]["status"] = Value::String("fail".to_string());
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
            "launch_indirection_report": launch_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert!(has_reason(device_only, "stale_launch_pointer_detected"));
        assert!(has_reason(warm_rebuild, "stale_launch_pointer_detected"));
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
                    "device_flags": ["-O3"],
                    "device_link": {
                        "requires_rdc": true,
                        "estimated_ms": 7000,
                        "budget_ms": 5000
                    }
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
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/rdcDeviceLink/costSource")
                .and_then(Value::as_str),
            Some("manifest_device_link")
        );
    }

    #[test]
    fn rdc_warm_rebuild_reports_link_cost_and_requires_consent() {
        let mut manifest = gpu_compile_manifest();
        manifest["gpu"]["device_flags"] = json!(["-O3", "-fgpu-rdc"]);
        manifest["gpu"]["device_link"] = json!({
            "requires_rdc": true,
            "affected_roles": ["device.device"],
            "supports_incremental": false,
            "estimated_ms": 8000,
            "budget_ms": 5000
        });
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
            "launch_indirection_report": launch_indirection_report(),
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
    fn rdc_warm_rebuild_reports_unsupported_incremental_device_link() {
        let mut manifest = gpu_compile_manifest();
        manifest["gpu"]["device_flags"] = json!(["-O3", "-fgpu-rdc"]);
        manifest["gpu"]["device_link"] = json!({
            "requires_rdc": true,
            "affected_roles": ["device.device"],
            "supports_incremental": false,
            "estimated_ms": 3000,
            "budget_ms": 5000
        });
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
            "launch_indirection_report": launch_indirection_report(),
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("ask_developer")
        );
        assert!(has_reason(
            warm_rebuild,
            "incremental_device_link_unsupported"
        ));
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/supportsIncrementalDeviceLink")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/category")
                .and_then(Value::as_str),
            Some("incremental_device_link_unsupported")
        );
    }

    #[test]
    fn arbiter_auto_runs_current_device_only_plan() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
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
    fn unsafe_isolation_mode_requires_consent_for_device_only() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "isolation_report": {
                "schemaVersion": "synthi.gpu.runner_isolation.v1",
                "platform": "linux",
                "isolationBackend": "unsafe_inprocess",
                "executionMode": "unsafe_inprocess",
                "unsafeDebugMode": true,
                "reasonCodes": ["unsafe_inprocess_enabled", "arbiter_user_consent_required"]
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("ask_developer")
        );
        assert_eq!(
            migrated.pointer("/consentReason").and_then(Value::as_str),
            Some("unsafe_debug_mode")
        );
        assert_eq!(
            device_only.get("requiresConsent").and_then(Value::as_bool),
            Some(true)
        );
        assert!(has_reason(device_only, "unsafe_debug_mode"));
        assert_eq!(
            migrated
                .pointer("/runReport/isolationReport/isolationBackend")
                .and_then(Value::as_str),
            Some("unsafe_inprocess")
        );
    }

    #[test]
    fn gpu_driver_fault_taint_blocks_fast_paths_and_screenshot_proof() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "gpuDriverFaultMarkers": [
                {
                    "kind": "tdr_timeout",
                    "reasonCode": "gpu_driver_tdr"
                }
            ]
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
        assert!(has_reason(device_only, "gpu_device_tainted"));
        assert_eq!(
            migrated
                .pointer("/runReport/gpuFaultPolicy/screenshotsAcceptedAsProof")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/category")
                .and_then(Value::as_str),
            Some("gpu_device_tainted")
        );
    }

    #[test]
    fn vram_refresh_warning_is_reported_without_blocking_device_only() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "memoryArenaStats": {
                "schemaVersion": "synthi.gpu.memory_arena_stats.v1",
                "reloadGeneration": 60,
                "fragmentationRatio": 0.36,
                "largestFreeBlockBytes": 4096,
                "pendingAllocationBytes": 1024,
                "pointerSafetyProvable": false
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("auto_run")
        );
        assert_eq!(
            device_only.get("safety").and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/plannedMemoryRefresh/status")
                .and_then(Value::as_str),
            Some("warn")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/vramFragmentationRatio")
                .and_then(Value::as_f64),
            Some(0.36)
        );
    }

    #[test]
    fn fragmented_vram_blocks_reload_before_known_large_allocation_failure() {
        let manifest = gpu_compile_manifest();
        let plan = reload_plan("device_only", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "memoryArenaStats": {
                "schemaVersion": "synthi.gpu.memory_arena_stats.v1",
                "reloadGeneration": 120,
                "fragmentationRatio": 0.62,
                "largestFreeBlockBytes": 64,
                "pendingAllocationBytes": 128,
                "pointerSafetyProvable": false
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let device_only = ranked_option(&migrated, "device_only");

        assert_eq!(
            migrated.pointer("/arbiterDecision").and_then(Value::as_str),
            Some("fallback")
        );
        assert!(has_reason(device_only, "vram_fragmented"));
        assert!(has_reason(device_only, "vram_session_refresh_required"));
        assert_eq!(
            migrated
                .pointer("/runReport/memoryRefreshPolicy/status")
                .and_then(Value::as_str),
            Some("refresh_required")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/category")
                .and_then(Value::as_str),
            Some("vram_session_refresh_required")
        );
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
            "launch_indirection_report": launch_indirection_report(),
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
    fn source_context_template_evidence_enables_bounded_warm_rebuild() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "sourceContextReport": {
                "schemaVersion": "synthi.gpu.source_context.v1",
                "buildMetadata": {
                    "templateEvidenceStatus": "fresh",
                    "templateEvidenceHash": "template-hash",
                    "templateEvidenceCandidateCount": 1,
                    "templateEvidenceInvalidationReasons": [],
                    "templateEvidence": template_evidence(
                        &flags_hash,
                        true,
                        "clang-libtooling+vendor-artifacts"
                    )
                }
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated
                .pointer("/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("fresh")
        );
        assert_eq!(
            migrated
                .pointer("/templateEvidenceCollectorReport/status")
                .and_then(Value::as_str),
            Some("fresh")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("fresh")
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("pass")
        );
        assert!(has_reason(warm_rebuild, "arbiter.safe"));
    }

    #[test]
    fn source_context_template_evidence_accepts_target_compile_command_hash() {
        let manifest = gpu_compile_manifest();
        let focus_flags_hash = effective_flags_hash_for(&manifest);
        let device_flags_hash = stable_hash(&json!([
            "--offload-arch=gfx1201",
            "-O3",
            "src/gpu/kernels.hip"
        ]));
        let plan = reload_plan("warm_rebuild", vec!["device"]);
        let sidecar = json!({
            "compile_manifest": manifest,
            "effectiveFlagsHash": focus_flags_hash,
            "lastReloadPlanReport": plan,
            "launch_indirection_report": launch_indirection_report(),
            "sourceContextReport": {
                "schemaVersion": "synthi.gpu.source_context.v1",
                "buildMetadata": {
                    "templateEvidenceStatus": "fresh",
                    "templateEvidenceHash": "template-hash",
                    "templateEvidenceCandidateCount": 1,
                    "templateEvidenceInvalidationReasons": [],
                    "templateEvidenceCompileCommands": [
                        {
                            "file": "src/app/main.cpp",
                            "effectiveFlagsHash": focus_flags_hash
                        },
                        {
                            "file": "src/gpu/kernels.hip",
                            "effectiveFlagsHash": device_flags_hash
                        }
                    ],
                    "templateEvidence": template_evidence(
                        &device_flags_hash,
                        true,
                        "clang-libtooling+vendor-artifacts"
                    )
                }
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let warm_rebuild = ranked_option(&migrated, "warm_rebuild");

        assert_eq!(
            migrated
                .pointer("/templateEvidenceStatus")
                .and_then(Value::as_str),
            Some("fresh")
        );
        assert_eq!(
            migrated
                .pointer("/templateEvidenceInvalidationReasons")
                .and_then(Value::as_array)
                .map(Vec::is_empty),
            Some(true)
        );
        assert_eq!(
            warm_rebuild.get("safety").and_then(Value::as_str),
            Some("pass")
        );
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
            },
            "deviceIncludeGraph": {
                "schemaVersion": "synthi.gpu.device_include_graph.v1",
                "status": "bounded",
                "deviceTranslationUnits": ["src/gpu/flow.hip"],
                "reachableHeaders": ["src/gpu/flow.cuh"],
                "edges": [
                    {"source": "src/gpu/flow.hip", "includes": ["src/gpu/flow.cuh"]}
                ],
                "missingIncludes": [],
                "reasonCodes": []
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
        assert_eq!(
            migrated
                .pointer("/runReport/affectedHeaderGraph/reachableHeaders/0")
                .and_then(Value::as_str),
            Some("src/gpu/flow.cuh")
        );
    }

    #[test]
    fn fast_path_verifier_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let verifier_report = json!({
            "schemaVersion": "synthi.gpu.device_fast_path_verifier.v1",
            "status": "reject",
            "selectedFallback": "abi_breaking",
            "reasonCodes": ["abi.kernel_signature_changed"],
            "evidence": {
                "kernelSignature": {
                    "changed": true,
                    "before": {"hash": "before"},
                    "after": {"hash": "after"}
                }
            }
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastDeviceFastPathVerifierReport": verifier_report,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/runReport/deviceFastPathVerifierReport/status")
                .and_then(Value::as_str),
            Some("reject")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/deviceFastPathVerifierReport/evidence/kernelSignature/changed")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/category")
                .and_then(Value::as_str),
            Some("abi_changed")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/problem")
                .and_then(Value::as_str),
            Some("Device-only reload rejected.")
        );
    }

    #[test]
    fn fission_candidate_report_is_promoted_into_run_report() {
        let manifest = gpu_compile_manifest();
        let fission_candidate = json!({
            "islandId": "island:sha256:abc",
            "sourceEditId": "edit:abc",
            "sourcePaths": ["src/render.kernel"],
            "sourceSpans": [{"path": "src/render.kernel", "startByte": 10, "endByte": 24}],
            "targetSymbols": ["render_step"],
            "exportedSymbolsExpected": ["render_step"],
            "artifactKind": "partial_device_artifact",
            "includeClosure": [],
            "dependencyClosureHash": "sha256:dependency",
            "abiMembraneId": "abi:membrane",
            "compileRecipeHash": "sha256:recipe",
            "compileCommandHash": "sha256:command",
            "loaderCapabilityRequirement": {"transportClass": "content_addressed_blob"},
            "requiredOracleId": "oracle:render-step",
            "verifierEvidenceIds": ["evidence:source-map", "evidence:abi-membrane"],
            "narrowerCandidateRejections": [
                {
                    "scopeRank": 0,
                    "reasonCode": "fission.edit_crosses_body_boundary",
                    "verifierEvidenceIds": ["evidence:source-map"]
                }
            ]
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "fissionCandidate": fission_candidate,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/fissionVerifierReport/status")
                .and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/fissionVerifierReport/selectedIslandId")
                .and_then(Value::as_str),
            Some("island:sha256:abc")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/fissionVerifierReport/candidates/0/status")
                .and_then(Value::as_str),
            Some("pass")
        );
    }

    #[test]
    fn ai_fission_candidate_missing_oracle_is_rejected_by_deterministic_report() {
        let manifest = gpu_compile_manifest();
        let fission_candidate = json!({
            "islandId": "island:sha256:def",
            "sourceEditId": "edit:def",
            "sourcePaths": ["src/render.kernel"],
            "sourceSpans": [{"path": "src/render.kernel", "startLine": 3, "endLine": 7}],
            "targetSymbols": ["render_step"],
            "exportedSymbolsExpected": ["render_step"],
            "artifactKind": "partial_device_artifact",
            "includeClosure": [],
            "dependencyClosureHash": "sha256:dependency",
            "abiMembraneId": "abi:membrane",
            "compileRecipeHash": "sha256:recipe",
            "compileCommandHash": "sha256:command",
            "loaderCapabilityRequirement": {"transportClass": "content_addressed_blob"},
            "verifierEvidenceIds": ["evidence:source-map"],
            "aiProposalId": "ai:fission:def",
            "narrowerCandidateRejections": [
                {
                    "scopeRank": 0,
                    "reasonCode": "fission.edit_crosses_body_boundary",
                    "verifierEvidenceIds": ["evidence:source-map"]
                }
            ]
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastGpuAiDeltaVerifierReport": {
                "schemaVersion": "synthi.gpu.ai_delta_verifier.v1",
                "status": "pass",
                "fissionCandidate": fission_candidate,
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/runReport/fissionVerifierReport/status")
                .and_then(Value::as_str),
            Some("reject")
        );
        assert!(
            migrated
                .pointer("/runReport/fissionVerifierReport/candidates/0/reasonCodes")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|code| code == "fission.output_oracle_missing")
        );
    }

    #[test]
    fn ai_fission_candidate_with_ai_only_evidence_is_rejected_by_deterministic_report() {
        let manifest = gpu_compile_manifest();
        let fission_candidate = json!({
            "islandId": "island:sha256:ghi",
            "sourceEditId": "edit:ghi",
            "sourcePaths": ["src/render.kernel"],
            "sourceSpans": [{"path": "src/render.kernel", "startLine": 3, "endLine": 7}],
            "targetSymbols": ["render_step"],
            "exportedSymbolsExpected": ["render_step"],
            "artifactKind": "partial_device_artifact",
            "includeClosure": [],
            "dependencyClosureHash": "sha256:dependency",
            "abiMembraneId": "abi:membrane",
            "compileRecipeHash": "sha256:recipe",
            "compileCommandHash": "sha256:command",
            "loaderCapabilityRequirement": {"transportClass": "content_addressed_blob"},
            "requiredOracleId": "oracle:render-step",
            "verifierEvidenceIds": ["ai:fission:proposal"],
            "aiProposalId": "ai:fission:proposal",
            "narrowerCandidateRejections": [
                {
                    "scopeRank": 0,
                    "reasonCode": "fission.edit_crosses_body_boundary",
                    "verifierEvidenceIds": ["evidence:source-map"]
                }
            ]
        });
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastGpuAiDeltaVerifierReport": {
                "schemaVersion": "synthi.gpu.ai_delta_verifier.v1",
                "status": "pass",
                "fissionCandidate": fission_candidate,
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/runReport/fissionVerifierReport/status")
                .and_then(Value::as_str),
            Some("reject")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/fissionVerifierReport/candidates/0/deterministicVerifierEvidenceIds")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert!(
            migrated
                .pointer("/runReport/fissionVerifierReport/candidates/0/reasonCodes")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|code| code == "fission.deterministic_verifier_evidence_missing")
        );
    }

    #[test]
    fn run_report_emits_failure_card_for_template_evidence_rejection() {
        let manifest = gpu_compile_manifest();
        let sidecar = json!({
            "compile_manifest": manifest,
            "lastReloadPlanReport": {
                "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
                "plan": "unsupported",
                "reasonCodes": [
                    "template_evidence_missing",
                    "template_instantiation_unbounded"
                ],
                "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
                "affectedUserFiles": ["src/gpu/particle_template_math.hpp"],
                "affectedGeneratedRoles": ["device.hip"],
                "timingsMs": {}
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/category")
                .and_then(Value::as_str),
            Some("template_evidence_missing")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/failureCard/chosenFallback")
                .and_then(Value::as_str),
            Some("ai_delta")
        );
        assert!(migrated
            .pointer("/runReport/failureCard/formatted")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Problem:\n  Warm rebuild rejected."));
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
                "compileDbHash": "compile-db-1",
                "cmakeFileApiStatus": "cmake_project_file_api_missing",
                "cmakeCodemodelHash": "codemodel-1",
                "selectedCompileCommand": {
                    "status": "selected",
                    "source": "compile_commands.json",
                    "file": "src/app/main.cpp",
                    "compiler": "clang++",
                    "effectiveFlagsHash": "flags1"
                },
                "targetResolution": {
                    "status": "selected",
                    "method": "single_executable_target_containing_focus",
                    "selectedTarget": {
                        "name": "gpu_app",
                        "configuration": "Debug",
                        "type": "EXECUTABLE",
                        "sourceFiles": ["src/app/main.cpp", "src/gpu/flow.hip"]
                    },
                    "reasonCodes": []
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
        assert_eq!(
            migrated.pointer("/compileDbHash").and_then(Value::as_str),
            Some("compile-db-1")
        );
        assert_eq!(
            migrated
                .pointer("/cmakeCodemodelHash")
                .and_then(Value::as_str),
            Some("codemodel-1")
        );
        assert_eq!(
            migrated
                .pointer("/targetResolutionMethod")
                .and_then(Value::as_str),
            Some("single_executable_target_containing_focus")
        );
        assert_eq!(
            migrated
                .pointer("/targetIdentity/targetName")
                .and_then(Value::as_str),
            Some("gpu_app")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/compileDbHash")
                .and_then(Value::as_str),
            Some("compile-db-1")
        );
        assert_eq!(
            migrated
                .pointer("/runReport/cmakeCodemodelHash")
                .and_then(Value::as_str),
            Some("codemodel-1")
        );
    }

    #[test]
    fn run_report_exposes_prod_next_trace_fields() {
        let manifest = gpu_compile_manifest();
        let flags_hash = effective_flags_hash_for(&manifest);
        let agentic_report = json!({
            "schemaVersion": "synthi.gpu.agentic_split.v1",
            "mode": "full_split",
            "attemptCount": 2,
            "acceptedAttempt": "attempt-002",
            "attempts": [
                {
                    "attempt": 1,
                    "verifiers": [
                        {
                            "name": "runtime.frame_visible",
                            "status": "fail",
                            "reasonCodes": ["screenshot_not_ready"]
                        }
                    ]
                },
                {
                    "attempt": 2,
                    "verifiers": [
                        {
                            "name": "runtime.frame_visible",
                            "status": "pass",
                            "reasonCodes": []
                        }
                    ]
                }
            ]
        });
        let source_context_report = json!({
            "included": [{"path": "src/gpu/flow.hip"}],
            "dropped": [{"path": "docs/design.md"}],
            "criticalDropped": []
        });
        let sidecar = json!({
            "workspaceId": "gpu-workspace",
            "entryFile": "src/app/main.cpp",
            "targetResolutionMethod": "single_target",
            "compile_manifest": manifest,
            "lastReloadPlanReport": reload_plan("warm_rebuild", vec!["device"]),
            "templateEvidence": template_evidence(&flags_hash, true, "clang-libtooling+vendor-artifacts"),
            "agentic_report": agentic_report,
            "source_context_report": source_context_report,
            "launch_indirection_report": launch_indirection_report(),
            "warmPathActualMs": 1800,
            "artifactPaths": [".synthi/generated/gpu/device.hip"]
        });

        let migrated = normalize_split_sidecar(&sidecar);
        let report = migrated.get("runReport").expect("run report");

        assert_eq!(
            report.pointer("/workspaceId").and_then(Value::as_str),
            Some("gpu-workspace")
        );
        assert_eq!(
            report
                .pointer("/sourceContextFiles/0")
                .and_then(Value::as_str),
            Some("src/gpu/flow.hip")
        );
        assert_eq!(
            report.pointer("/omittedFiles/0").and_then(Value::as_str),
            Some("docs/design.md")
        );
        assert_eq!(
            report.pointer("/gpuVendor").and_then(Value::as_str),
            Some("rocm")
        );
        assert_eq!(
            report
                .pointer("/warmPathEstimateMs")
                .and_then(Value::as_u64),
            Some(5000)
        );
        assert_eq!(
            report.pointer("/warmPathActualMs").and_then(Value::as_u64),
            Some(1800)
        );
        assert_eq!(
            report
                .pointer("/deviceLinkRequired")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            report
                .pointer("/deviceLinkBudgetResult")
                .and_then(Value::as_str),
            Some("not_required")
        );
        assert_eq!(
            report
                .pointer("/agenticAcceptedAttempt")
                .and_then(Value::as_str),
            Some("attempt-002")
        );
        assert_eq!(
            report
                .pointer("/agenticVerifierFailures/0/reasonCodes/0")
                .and_then(Value::as_str),
            Some("screenshot_not_ready")
        );
        assert_eq!(
            report.pointer("/artifactPaths/0").and_then(Value::as_str),
            Some(".synthi/generated/gpu/device.hip")
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
