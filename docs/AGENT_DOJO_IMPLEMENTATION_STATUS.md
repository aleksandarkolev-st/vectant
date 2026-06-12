# Agent Dojo Implementation Status

**Status:** source-of-truth maturity baseline  
**Date:** 2026-06-11  
**Scope:** current Agent Dojo implementation in `mcp/synthi-mcp`

This document prevents current scaffolded Vivarium Cortex artifacts from being mistaken for mature runtime subsystems. The machine-readable source lives in:

```text
mcp/synthi-mcp/src/dojo/status/implementation_status.ts
```

## Status Classes

| Status | Meaning |
|---|---|
| `executable` | The current code executes a real local behavior or enforces a current runtime path. |
| `deterministic_projection` | The current code builds useful deterministic artifacts from workflow contracts, traces, or stored skill data, but does not execute the mature runtime implied by the product term. |
| `report_only` | The current code returns a summary, dossier, plan, or view model. It is not an enforcement or execution subsystem. |
| `planned` | The capability is described in the plan but does not have a current implementation entry. |

## Current Honest Baseline

Agent Dojo currently implements a repo-local proof-gated competency system with several mature foundations:

- workflow demonstration to `SkillSeed`
- workflow contract to `DojoSkill`
- executable Skill Cortex graph IR and graph runtime v1
- materialized synthetic Vivarium fixtures and oracle-backed scenario runs
- runtime-backed Wind Tunnel and checkride runner foundations
- durable proof replay repository and append-only evidence ledger store modules
- license and proof capsule issuance/validation with strict evidence-claim mode, Ed25519 signing support, and an external command signer adapter
- proof-gated backing private workflow tool and raw workflow boundary checks
- case-law records that can bind guardrail predicates
- source/API contract, linter, candidate, substrate, and React codemod foundations
- dedicated Dojo product UX surfaces and governance view models
- repo artifact export
- compact UI status surface plus dedicated Dojo routes

It does not yet prove the full mature Vivarium Cortex universe in production:

- no managed KMS/HSM proof signer configured by default or proven in deployed-host release gates
- no externally deployed tenant-aware control plane proven against a production database
- no live non-loopback MCP host conformance proof in the current validation bundle
- no broad arbitrary-app source/API promotion guarantee
- no complete chaos, soak, performance, privacy, and compliance release gate bundle
- some UI surfaces are read-only governance/inspection views rather than full operator workflows

## Current Tool Classification

| Tool | Status |
|---|---|
| `synthi_dojo_list_competencies` | `executable` |
| `synthi_dojo_get_skill` | `deterministic_projection` |
| `synthi_dojo_get_skill_cortex` | `deterministic_projection` |
| `synthi_dojo_get_workspace_organoid` | `deterministic_projection` |
| `synthi_dojo_get_wind_tunnel_report` | `deterministic_projection` |
| `synthi_dojo_get_counterfactual_twin` | `deterministic_projection` |
| `synthi_dojo_get_evil_twin_report` | `deterministic_projection` |
| `synthi_dojo_get_training_report` | `report_only` |
| `synthi_dojo_get_skill_passport` | `report_only` |
| `synthi_dojo_get_skill_genome` | `report_only` |
| `synthi_dojo_get_antibodies` | `deterministic_projection` |
| `synthi_dojo_get_agent_ready_ui_contract` | `deterministic_projection` |
| `synthi_dojo_get_cost_policy` | `report_only` |
| `synthi_dojo_get_universe_dossier` | `report_only` |
| `synthi_dojo_get_lifecycle` | `report_only` |
| `synthi_dojo_get_governance_report` | `report_only` |
| `synthi_dojo_get_metrics` | `report_only` |
| `synthi_dojo_get_source_affordance_pr_plan` | `deterministic_projection` |
| `synthi_dojo_get_registry` | `report_only` |
| `synthi_dojo_get_skill_assurance_case` | `report_only` |
| `synthi_dojo_get_entrustment_level` | `deterministic_projection` |
| `synthi_dojo_get_license` | `executable` |
| `synthi_dojo_get_guardrails` | `deterministic_projection` |
| `synthi_dojo_get_case_law` | `deterministic_projection` |
| `synthi_dojo_explain_block` | `report_only` |
| `synthi_dojo_explain_failure` | `report_only` |
| `synthi_dojo_debug_counterfactual` | `deterministic_projection` |
| `synthi_dojo_run_time_machine_debugger` | `deterministic_projection` |
| `synthi_dojo_run_ghost_mode` | `report_only` |
| `synthi_dojo_request_permission_upgrade` | `executable` |
| `synthi_dojo_review_permission_upgrade` | `executable` |
| `synthi_dojo_review_case_law` | `executable` |
| `synthi_dojo_generate_vivarium_scenarios` | `deterministic_projection` |
| `synthi_dojo_run_vivarium_scenario` | `executable` |
| `synthi_dojo_run_wind_tunnel` | `executable` |
| `synthi_dojo_run_checkride` | `executable` |
| `synthi_dojo_publish_skill` | `executable` |
| `synthi_dojo_recertify_skill` | `deterministic_projection` |
| `synthi_dojo_get_license_health` | `executable` |
| `synthi_dojo_revoke_license` | `executable` |
| `synthi_dojo_record_case_law` | `executable` |
| `synthi_dojo_export_artifacts` | `executable` |
| `synthi_dojo_issue_proof_capsule` | `executable` |
| `synthi_dojo_validate_proof_capsule` | `executable` |
| `synthi_dojo_revoke_proof_capsule` | `executable` |
| `synthi_dojo_run_with_proof_capsule` | `executable` |

## Current Report Classification

| Report Or Artifact | Status |
|---|---|
| `skill_seed` | `deterministic_projection` |
| `skill_cortex` | `deterministic_projection` |
| `workspace_organoid` | `deterministic_projection` |
| `vivarium_scenarios` | `deterministic_projection` |
| `vivarium_run` | `executable` |
| `wind_tunnel` | `executable` |
| `checkride` | `executable` |
| `case_law` | `report_only` |
| `guardrails` | `deterministic_projection` |
| `permission_license` | `executable` |
| `proof_capsule` | `executable` |
| `evidence_ledger` | `report_only` |
| `source_affordance_pr_plan` | `deterministic_projection` |
| `mcp_manifest` | `executable` |
| `universe_dossier` | `report_only` |

## Claim Boundary

Safe current claim:

```text
Agent Dojo implements a repo-local proof-gated competency system with executable graph
runtime foundations, materialized synthetic Vivarium scenarios, evidence/proof/ledger
foundations, scoped licenses, repo exports, source/API scaffolding, governance views, and
MCP tool exposure.
```

Unsafe current claim:

```text
Agent Dojo has completed production deployment proof for non-loopback hosted MCP,
managed KMS/HSM signing deployment, broad arbitrary-app source/API graduation, complete governance
operator workflows, and chaos/soak/performance/compliance release gates.
```
