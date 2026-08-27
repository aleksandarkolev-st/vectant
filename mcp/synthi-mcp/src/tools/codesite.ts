import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const CODESITE_TOOL_NAMES = [
  "synthi_codesite_list_projects",
  "synthi_codesite_create_project",
  "synthi_codesite_get_project",
  "synthi_codesite_update_zone_policy",
  "synthi_codesite_update_control_plan",
  "synthi_codesite_register_agent_session",
  "synthi_codesite_list_project_members",
  "synthi_codesite_upsert_project_member",
  "synthi_codesite_revoke_project_member",
  "synthi_codesite_file_flight_plan",
  "synthi_codesite_request_clearance",
  "synthi_codesite_open_transaction",
  "synthi_codesite_abort_transaction",
  "synthi_codesite_revoke_clearance",
  "synthi_codesite_record_policy_decision",
  "synthi_codesite_get_transaction_status",
  "synthi_codesite_preview_transaction",
  "synthi_codesite_dry_run_patch",
  "synthi_codesite_preflight_write",
  "synthi_codesite_apply_patch",
  "synthi_codesite_record_assumption",
  "synthi_codesite_record_read",
  "synthi_codesite_record_write",
  "synthi_codesite_validate_transaction",
  "synthi_codesite_request_commit",
  "synthi_codesite_get_source_state_since",
  "synthi_codesite_get_relevant_context",
  "synthi_codesite_find_experts",
  "synthi_codesite_ask_expert_question",
  "synthi_codesite_record_discovery",
  "synthi_codesite_record_lead",
  "synthi_codesite_publish_shared_skill",
  "synthi_codesite_file_handoff",
  "synthi_codesite_get_shared_knowledge",
  "synthi_codesite_respond_impact_notice",
  "synthi_codesite_get_radar",
  "synthi_codesite_get_metrics",
  "synthi_codesite_get_agent_manifest",
  "synthi_codesite_get_schemas",
  "synthi_codesite_get_active_state",
  "synthi_codesite_list_active_transactions",
  "synthi_codesite_next_event",
  "synthi_codesite_get_inbox",
  "synthi_codesite_ack_event",
  "synthi_codesite_predict_collision",
  "synthi_codesite_shadow_merge_simulate",
  "synthi_codesite_report_counterfactual_run",
  "synthi_codesite_file_rfi",
  "synthi_codesite_file_change_order",
  "synthi_codesite_list_permits",
  "synthi_codesite_issue_permit",
  "synthi_codesite_review_document",
  "synthi_codesite_list_route_revisions",
  "synthi_codesite_propose_route_revision",
  "synthi_codesite_review_route_revision",
  "synthi_codesite_apply_route_revision",
  "synthi_codesite_declare_mayday",
  "synthi_codesite_get_incident_replay",
  "synthi_codesite_resume_mayday",
  "synthi_codesite_file_policy_delta",
  "synthi_codesite_list_learning_catalog",
  "synthi_codesite_adopt_learning_catalog_entry",
  "synthi_codesite_list_fleet_notams",
  "synthi_codesite_publish_fleet_notam",
  "synthi_codesite_decide_fleet_notam",
  "synthi_codesite_withdraw_fleet_notam",
  "synthi_codesite_supersede_fleet_notam",
  "synthi_codesite_promote_policy_delta",
  "synthi_codesite_reject_policy_delta",
  "synthi_codesite_request_landing",
  "synthi_codesite_complete_landing",
  "synthi_codesite_generate_black_box",
  "synthi_codesite_preview_artifacts",
  "synthi_codesite_get_proof_bundle",
  "synthi_codesite_attach_proof_bundle_commit",
  "synthi_codesite_get_line_provenance",
  "synthi_codesite_review_quarantine",
  "synthi_codesite_replay_quarantine",
  "synthi_codesite_apply_quarantine",
] as const;

type CodeSiteToolName = (typeof CODESITE_TOOL_NAMES)[number];
type AgentBoundKnowledgeToolName =
  | "synthi_codesite_record_discovery"
  | "synthi_codesite_record_lead"
  | "synthi_codesite_publish_shared_skill"
  | "synthi_codesite_file_handoff"
  | "synthi_codesite_get_shared_knowledge"
  | "synthi_codesite_respond_impact_notice"
  | "synthi_codesite_find_experts"
  | "synthi_codesite_ask_expert_question";
type RoutedCodeSiteToolName = Exclude<
  CodeSiteToolName,
  "synthi_codesite_get_relevant_context" | AgentBoundKnowledgeToolName
>;

type JsonObject = Record<string, unknown>;

interface CodeSiteRequest {
  method: "GET" | "POST";
  path: string;
  body?: JsonObject;
  query?: Record<string, string>;
}

const CONTROL_ARG_KEYS = new Set([
  "agent_session_id",
  "auth_token",
  "base_url",
  "body",
  "bundle_id",
  "codesite_api_base_url",
  "collab_base_url",
  "cookie",
  "document_id",
  "event_id",
  "execution_plan_id",
  "display_callsign",
  "filesystem_user_id",
  "file_path",
  "incident_id",
  "include",
  "include_inactive",
  "include_muted",
  "inspection_run_id",
  "line_anchor",
  "line_number",
  "learning_id",
  "max_content_bytes",
  "member_id",
  "mutation_lease_id",
  "path",
  "policy_delta_id",
  "route",
  "notam_id",
  "project_id",
  "quarantine_id",
  "route_revision_id",
  "runtime_scope",
  "selected_paths",
  "since",
  "transaction_id",
  "workspace_slug",
  "user_id",
  "session_id",
]);

const COMMON_PROPERTIES = {
  base_url: {
    type: "string",
    description: "Synthi app origin. Defaults to SYNTHI_CODESITE_BASE_URL, SYNTHI_APP_URL, or http://127.0.0.1:3000.",
  },
  codesite_api_base_url: {
    type: "string",
    description: "Optional full /api/workspace/:slug/codesite base URL. Supports {workspace_slug}.",
  },
  workspace_slug: {
    type: "string",
    description: "Workspace slug. Defaults to SYNTHI_CODESITE_WORKSPACE or SYNTHI_WORKSPACE_SLUG.",
  },
  project_id: {
    type: "string",
    description: "CodeSite project id. Defaults to SYNTHI_CODESITE_PROJECT_ID where relevant.",
  },
  auth_token: {
    type: "string",
    description: "Optional bearer token. Defaults to SYNTHI_CODESITE_TOKEN.",
  },
  cookie: {
    type: "string",
    description: "Optional Cookie header. Defaults to SYNTHI_CODESITE_COOKIE.",
  },
  collab_base_url: {
    type: "string",
    description: "Optional collab-server origin for CodeSiteFS replay/apply. Defaults to SYNTHI_COLLAB_BASE_URL, COLLAB_SERVER_URL, or http://127.0.0.1:1234.",
  },
  body: {
    type: "object",
    description: "Raw control-plane payload. Convenience top-level fields are merged into this payload.",
  },
} as const;

const KNOWLEDGE_REFERENCE_PROPERTIES = {
  paths: { type: "array", items: { type: "string" }, maxItems: 32 },
  symbols: { type: "array", items: { type: "string" }, maxItems: 32 },
  contracts: { type: "array", items: { type: "string" }, maxItems: 32 },
  workstream_ids: { type: "array", items: { type: "string" }, maxItems: 32 },
  transaction_ids: { type: "array", items: { type: "string" }, maxItems: 32 },
} as const;

const KNOWLEDGE_COMMON_PROPERTIES = {
  title: { type: "string", minLength: 1, maxLength: 160 },
  summary: { type: "string", minLength: 1, maxLength: 4096 },
  references: {
    type: "object",
    properties: KNOWLEDGE_REFERENCE_PROPERTIES,
    additionalProperties: false,
  },
  evidence_refs: { type: "array", items: { type: "string" }, maxItems: 64 },
  tags: { type: "array", items: { type: "string" }, maxItems: 32 },
  visibility: { type: "string", enum: ["project", "restricted", "owner_private"] },
  redaction_class: { type: "string", enum: ["project_fact", "owner_private"] },
  expires_at: { type: "string", format: "date-time" },
} as const;

const SHARED_SKILL_RECIPE_PROPERTIES = {
  commands: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
  required_permissions: { type: "array", items: { type: "string" }, maxItems: 32 },
  required_tools: { type: "array", items: { type: "string" }, maxItems: 32 },
  required_environment_keys: { type: "array", items: { type: "string" }, maxItems: 32 },
  usage_conditions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
  working_directory: { type: "string", maxLength: 512 },
  action_class: { type: "string", enum: ["read_only", "workspace_mutation"] },
} as const;

const IMPACT_NOTICE_ACTIONS = ["acknowledge", "refresh", "rebase_requested", "abort", "dismiss"] as const;
const SHARED_KNOWLEDGE_STATUSES = [
  "draft", "verified", "rejected", "invalidated", "archived",
  "open", "claimed", "escalated", "resolved", "dismissed",
  "pending_review", "published", "deprecated", "revoked",
  "pending", "acknowledged", "rebasing", "irrelevant", "aborted", "expired",
  "ready", "reopened", "completed", "declined", "cancelled",
  "answered", "stale",
] as const;

export const CODESITE_TOOLS = [
  {
    name: "synthi_codesite_get_relevant_context",
    description: "Read the compact CodeSite working context bound to this attached agent process.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  agentBoundCodeSiteTool(
    "synthi_codesite_find_experts",
    "Find project agents with demonstrated expertise on given paths/symbols/contracts.",
    {
      paths: { type: "array", items: { type: "string" }, maxItems: 32 },
      symbols: { type: "array", items: { type: "string" }, maxItems: 32 },
      contracts: { type: "array", items: { type: "string" }, maxItems: 32 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    [],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_record_discovery",
    "Record a redacted, evidence-backed project discovery as the currently attached agent.",
    {
      ...KNOWLEDGE_COMMON_PROPERTIES,
      status: { type: "string", enum: ["draft", "verified"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      verification: { type: "string", enum: ["unverified", "verified", "rejected"] },
    },
    ["title", "summary", "references", "evidence_refs", "confidence"],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_record_lead",
    "Record a project-scoped lead as the currently attached agent.",
    {
      ...KNOWLEDGE_COMMON_PROPERTIES,
      status: { type: "string", enum: ["open", "claimed", "escalated"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
    },
    ["title", "summary", "references", "confidence"],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_publish_shared_skill",
    "Publish an evidence-backed, redacted skill recipe for this project as the currently attached agent.",
    {
      ...KNOWLEDGE_COMMON_PROPERTIES,
      status: { type: "string", enum: ["draft", "pending_review", "published"] },
      skill_key: { type: "string", minLength: 1, maxLength: 128 },
      recipe: {
        type: "object",
        properties: SHARED_SKILL_RECIPE_PROPERTIES,
        required: ["commands", "required_permissions", "usage_conditions"],
        additionalProperties: false,
      },
    },
    ["title", "summary", "references", "evidence_refs", "skill_key", "recipe"],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_file_handoff",
    "File an evidence-backed handoff from the currently attached agent to another project agent.",
    {
      ...KNOWLEDGE_COMMON_PROPERTIES,
      status: { type: "string", enum: ["draft", "ready"] },
      to_agent_session_id: { type: "string", minLength: 1, maxLength: 128 },
      unresolved_risks: { type: "array", items: { type: "string" }, maxItems: 32 },
      required_actions: { type: "array", items: { type: "string" }, maxItems: 32 },
    },
    ["title", "summary", "references", "evidence_refs", "to_agent_session_id"],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_get_shared_knowledge",
    "Read redacted shared knowledge relevant to the currently attached agent.",
    {
      kind: { type: "string", enum: ["discovery", "lead", "shared_skill", "impact_notice", "handoff", "agent_question"] },
      status: { type: "string", enum: SHARED_KNOWLEDGE_STATUSES },
      since: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      path: { type: "string" },
      symbol: { type: "string" },
      contract: { type: "string" },
      workstream_id: { type: "string" },
    },
    [],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_respond_impact_notice",
    "Respond to an impact notice delivered to the currently attached agent.",
    {
      notice_id: { type: "string", minLength: 1, maxLength: 128 },
      action: { type: "string", enum: IMPACT_NOTICE_ACTIONS },
      reason: { type: "string", maxLength: 2048 },
      evidence_refs: { type: "array", items: { type: "string" }, maxItems: 64 },
    },
    ["notice_id", "action"],
  ),
  agentBoundCodeSiteTool(
    "synthi_codesite_ask_expert_question",
    "Ask a routed question to the best-matched expert agents; answers become shared project knowledge.",
    {
      ...KNOWLEDGE_COMMON_PROPERTIES,
      urgency: { type: "string", enum: ["low", "normal", "high"] },
      suggested_expert_agent_session_ids: { type: "array", items: { type: "string" }, maxItems: 8 },
      allow_unrouted: { type: "boolean" },
    },
    ["title", "summary", "references"],
  ),
  codeSiteTool("synthi_codesite_list_projects", "List visible CodeSite projects for a workspace.", {}, []),
  codeSiteTool("synthi_codesite_create_project", "Create a CodeSite project and owner membership for a workspace.", {
    title: { type: "string" },
    request: { type: "string" },
    zonePolicy: { type: "object" },
    controlPlan: { type: "object" },
  }, []),
  codeSiteTool("synthi_codesite_get_project", "Read one CodeSite project with its control-plane summary.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_update_zone_policy", "Update a CodeSite project zone policy.", {
    project_id: { type: "string" },
    zonePolicy: { type: "object" },
    restrictedAirspace: { type: "array", items: {} },
    noFlyZones: { type: "array", items: {} },
  }, []),
  codeSiteTool("synthi_codesite_update_control_plan", "Update a CodeSite project control plan, including explicit multi-workspace learning intake preferences.", {
    project_id: { type: "string" },
    controlPlan: { type: "object" },
    towerMode: { type: "string" },
    releaseGates: { type: "array", items: {} },
    learningNetwork: {
      type: "object",
      properties: {
        workspace: { type: "boolean" },
        network: { type: "boolean" },
      },
    },
  }, []),
  codeSiteTool("synthi_codesite_register_agent_session", "Register a real agent session/callsign with the CodeSite tower.", {
    project_id: { type: "string" },
    providerSessionRef: { type: "string" },
    agentProvider: { type: "string" },
    agentRuntime: { type: "string" },
    displayCallsign: { type: "string" },
    permissions: { type: "array", items: {} },
    dojoPilotLicenseRef: { type: "string" },
    dojoProofRef: { type: "string" },
    dojoEvidenceRefs: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_list_project_members", "List humans and agents with access to a CodeSite project.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_upsert_project_member", "Grant or update CodeSite project member permissions.", {
    project_id: { type: "string" },
    userId: { type: "string" },
    role: { type: "string" },
    permissions: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_revoke_project_member", "Revoke a CodeSite project member.", {
    project_id: { type: "string" },
    member_id: { type: "string" },
    reason: { type: "string" },
  }, ["member_id"]),
  codeSiteTool("synthi_codesite_file_flight_plan", "File an ATC flight plan by creating a CodeSite execution plan.", {
    agent_session_id: { type: "string" },
    route: { type: "array", items: { type: "string" } },
    mission: { type: "string" },
    status: { type: "string" },
  }, ["agent_session_id"]),
  codeSiteTool("synthi_codesite_request_clearance", "Request a path/tool scoped MutationLease from an execution plan.", {
    execution_plan_id: { type: "string" },
    allowedPaths: { type: "array", items: { type: "string" } },
    allowedTools: { type: "array", items: { type: "string" } },
    expiresAt: { type: "string" },
  }, ["execution_plan_id"]),
  codeSiteTool("synthi_codesite_open_transaction", "Open a serializable MutationTransaction under an active clearance.", {
    mutation_lease_id: { type: "string" },
    readSet: { type: "array", items: { type: "string" } },
    writeSet: { type: "array", items: { type: "string" } },
    isolation: { type: "string" },
  }, ["mutation_lease_id"]),
  codeSiteTool("synthi_codesite_abort_transaction", "Abort a CodeSite mutation transaction and notify tower activity.", {
    transaction_id: { type: "string" },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_revoke_clearance", "Revoke a CodeSite mutation lease/clearance.", {
    mutation_lease_id: { type: "string" },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["mutation_lease_id"]),
  codeSiteTool("synthi_codesite_record_policy_decision", "Record a policy decision against a mutation lease.", {
    mutation_lease_id: { type: "string" },
    decision: { type: "string" },
    reasonCodes: { type: "array", items: { type: "string" } },
    decisionBody: { type: "object" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["mutation_lease_id"]),
  codeSiteTool("synthi_codesite_get_transaction_status", "Read the current transaction status and validation decision.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_preview_transaction", "Preview transaction validation without committing.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_dry_run_patch", "Dry-run a patch file list against CodeSite mutation policy.", {
    transaction_id: { type: "string" },
    files: { type: "array", items: { type: "object" } },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_preflight_write", "Ask CodeSiteFS for a pre-mutation write decision before a terminal, runtime, Yjs, MCP, scaffold, or patch adapter mutates a file.", {
    path: { type: "string" },
    file_path: { type: "string" },
    tool: { type: "string" },
    source: { type: "string" },
    operation: { type: "string" },
    mutation_lease_id: { type: "string" },
    disposition: { type: "string" },
    quarantine: { type: "boolean" },
    processAncestry: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_apply_patch", "Apply file patches through collab-server write-files-batch after CodeSite transaction dry-run approval.", {
    transaction_id: { type: "string" },
    mutation_lease_id: { type: "string" },
    files: { type: "array", items: { type: "object" } },
    collab_base_url: { type: "string" },
    user_id: { type: "string" },
    session_id: { type: "string" },
    displayCallsign: { type: "string" },
    allowedPaths: { type: "array", items: { type: "string" } },
    blockedPaths: { type: "array", items: { type: "string" } },
    allowedTools: { type: "array", items: { type: "string" } },
  }, ["transaction_id", "files"]),
  codeSiteTool("synthi_codesite_record_assumption", "Record an assumption lease used by a transaction.", {
    transaction_id: { type: "string" },
    assumptionKey: { type: "string" },
    dependsOn: { type: "array", items: {} },
    usedBy: { type: "array", items: {} },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_record_read", "Record a transaction read-set path.", {
    transaction_id: { type: "string" },
    path: { type: "string" },
    file_path: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_record_write", "Record and policy-check a transaction write-set path.", {
    transaction_id: { type: "string" },
    path: { type: "string" },
    file_path: { type: "string" },
    tool: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_validate_transaction", "Run serializable validation for an open transaction.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_request_commit", "Request a proof-carrying commit for a validated transaction.", {
    transaction_id: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    commitSha: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_get_source_state_since", "Read source-state validation for the transaction's base snapshot.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_get_radar", "Read machine-readable CodeSite radar/control state.", {}, []),
  codeSiteTool("synthi_codesite_get_metrics", "Read CodeSite ATC, transaction, software quality, and trust success metrics for the project.", {}, []),
  codeSiteTool("synthi_codesite_get_agent_manifest", "Read the machine-consumable CodeSite agent manifest for a project.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_get_schemas", "Read CodeSite JSON schemas advertised to agents.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_get_active_state", "Read workspace-level CodeSite active enforcement and mayday state.", {}, []),
  codeSiteTool("synthi_codesite_list_active_transactions", "List active CodeSite transactions for operator takeover and coordination.", {}, []),
  codeSiteTool("synthi_codesite_next_event", "Poll the next CodeSite event after an optional event id.", {
    since: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_get_inbox", "Poll durable tower-routed inbox items for an agent session.", {
    agent_session_id: { type: "string" },
  }, ["agent_session_id"]),
  codeSiteTool("synthi_codesite_ack_event", "Acknowledge an inbox event for an agent session.", {
    agent_session_id: { type: "string" },
    event_id: { type: "string" },
  }, ["agent_session_id", "event_id"]),
  codeSiteTool("synthi_codesite_predict_collision", "Predict route/lease collisions for the project.", {}, []),
  codeSiteTool("synthi_codesite_shadow_merge_simulate", "Run the shadow merge strategy simulator.", {
    strategies: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_report_counterfactual_run", "Record a counterfactual ATC memory run.", {
    project_id: { type: "string" },
    shadowJobRef: { type: "string" },
    repoSnapshot: { type: "string" },
    baseSnapshot: { type: "string" },
    choices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          universe: { type: "string" },
          strategy: { type: "string" },
          result: { type: "string" },
          inspectionCost: { type: "number" },
          staleAssumptions: { type: "number" },
          predictedCollisionRisk: { type: "number" },
          reworkRiskReduction: { type: "number" },
          affectedRoutes: { type: "array", items: { type: "string" } },
          evidenceRefs: { type: "array", items: { type: "string" } },
          incidents: { type: "array", items: { type: "string" } },
        },
      },
    },
    universes: { type: "array", items: { type: "object" } },
    arbiterVerdict: { type: "object" },
    outcome: { type: "object" },
    userChoice: { type: "object" },
    humanOverride: { type: "object" },
    applyResult: { type: "object" },
    laterManualEdits: { type: "array", items: { type: "object" } },
    validityStrength: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    airspaceClassFeedback: { type: "array", items: { type: "object" } },
    inspectionFindings: { type: "array", items: { type: "object" } },
    towerReroutes: { type: "array", items: { type: "object" } },
    clearanceViolations: { type: "array", items: { type: "object" } },
    blackBoxPatterns: { type: "array", items: { type: "object" } },
  }, ["project_id"]),
  codeSiteTool("synthi_codesite_file_rfi", "File a tower-mediated request for information document.", {
    title: { type: "string" },
    toSessionId: { type: "string" },
    requiresResponse: { type: "boolean" },
  }, []),
  codeSiteTool("synthi_codesite_file_change_order", "File a tower-mediated change-order document.", {
    title: { type: "string" },
    toSessionId: { type: "string" },
    blocking: { type: "boolean" },
  }, []),
  codeSiteTool("synthi_codesite_list_permits", "List project permits that can satisfy restricted-route governance gates.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_issue_permit", "Issue a CodeSite governance permit for restricted routes, plans, leases, or documents.", {
    project_id: { type: "string" },
    executionPlanId: { type: "string" },
    mutationLeaseId: { type: "string" },
    documentId: { type: "string" },
    permitType: { type: "string" },
    title: { type: "string" },
    scope: { type: "object" },
    approval: { type: "object" },
    expiresAt: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_review_document", "Record a measured governance document review for an RFI, submittal, change order, or permit.", {
    document_id: { type: "string" },
    decision: { type: "string" },
    summary: { type: "string" },
    reviewTimeMs: { type: "number" },
    baselineReviewTimeMs: { type: "number" },
    permitId: { type: "string" },
    routeRevisionId: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["document_id"]),
  codeSiteTool("synthi_codesite_list_route_revisions", "List proposed, approved, and applied CodeSite route revisions for a project.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_propose_route_revision", "Propose a CodeSite route revision/change order for an execution plan.", {
    execution_plan_id: { type: "string" },
    proposedRoute: { type: "array", items: { type: "string" } },
    documentId: { type: "string" },
    affectedLeases: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["execution_plan_id"]),
  codeSiteTool("synthi_codesite_review_route_revision", "Approve or reject a proposed CodeSite route revision.", {
    route_revision_id: { type: "string" },
    decision: { type: "string" },
    reviewedBy: { type: "string" },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["route_revision_id"]),
  codeSiteTool("synthi_codesite_apply_route_revision", "Apply an approved CodeSite route revision to its execution plan and affected leases.", {
    route_revision_id: { type: "string" },
    appliedBy: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["route_revision_id"]),
  codeSiteTool("synthi_codesite_declare_mayday", "Declare a mayday incident and record replay evidence.", {
    severity: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    affectedZones: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_get_incident_replay", "Read mayday or near-miss incident replay evidence.", {
    incident_id: { type: "string" },
  }, ["incident_id"]),
  codeSiteTool("synthi_codesite_resume_mayday", "Resume work from a mayday incident after replay and recovery evidence is attached.", {
    incident_id: { type: "string" },
    resolution: { type: "string" },
    replayRefs: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["incident_id"]),
  codeSiteTool("synthi_codesite_file_policy_delta", "Propose a CodeSite policy delta learned from replayed near-miss or incident evidence.", {
    project_id: { type: "string" },
    learnedFromIncidents: { type: "array", items: { type: "string" } },
    ruleCandidate: { type: "object" },
    triggerConditions: { type: "array", items: {} },
    expectedRiskReduction: { type: "number" },
    confidence: { type: "number" },
    replayRefs: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_list_learning_catalog", "List portable, redacted lessons available to this project. Workspace lessons are automatic; multi-workspace lessons require this project's learning-network opt-in.", {
    project_id: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_adopt_learning_catalog_entry", "Record that this project adopted a portable learning-catalog entry. Raw source-project context is never exposed.", {
    project_id: { type: "string" },
    learning_id: { type: "string" },
  }, ["learning_id"]),
  codeSiteTool("synthi_codesite_list_fleet_notams", "List cross-project fleet NOTAM advisories visible to a project. Visibility never affects clearance; only locally adopted advisories do.", {
    project_id: { type: "string" },
    include_own: { type: "boolean" },
    include_muted: { type: "boolean" },
    include_inactive: { type: "boolean" },
    route: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_publish_fleet_notam", "Publish a promoted, evidence-backed policy delta as a cross-project advisory.", {
    project_id: { type: "string" },
    policy_delta_id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    expires_at: { type: "string" },
  }, ["policy_delta_id"]),
  codeSiteTool("synthi_codesite_decide_fleet_notam", "Locally adopt, mute, dismiss, or reactivate a fleet NOTAM for this project. Only adopted advisories affect clearance decisions; visibility never does.", {
    project_id: { type: "string" },
    notam_id: { type: "string" },
    state: { type: "string", enum: ["adopt", "mute", "dismiss", "reactivate"] },
    reason: { type: "string" },
  }, ["notam_id", "state"]),
  codeSiteTool("synthi_codesite_withdraw_fleet_notam", "Withdraw an active fleet NOTAM published by this project. Withdrawal immediately removes it from visibility and clearance, while preserving lifecycle evidence.", {
    project_id: { type: "string" },
    notam_id: { type: "string" },
    reason: { type: "string" },
  }, ["notam_id"]),
  codeSiteTool("synthi_codesite_supersede_fleet_notam", "Replace this project's active fleet NOTAM with a new promoted policy delta. The old advisory records its replacement and no longer affects clearance.", {
    project_id: { type: "string" },
    notam_id: { type: "string" },
    policy_delta_id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    expires_at: { type: "string" },
    reason: { type: "string" },
  }, ["notam_id", "policy_delta_id"]),
  codeSiteTool("synthi_codesite_promote_policy_delta", "Promote a proposed CodeSite policy delta after validation/replay evidence.", {
    project_id: { type: "string" },
    policy_delta_id: { type: "string" },
    targetState: { type: "string" },
    validationStatus: { type: "string" },
    reviewedBy: { type: "string" },
    replayRefs: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["policy_delta_id"]),
  codeSiteTool("synthi_codesite_reject_policy_delta", "Reject a proposed CodeSite policy delta with review and replay evidence.", {
    project_id: { type: "string" },
    policy_delta_id: { type: "string" },
    reviewedBy: { type: "string" },
    reason: { type: "string" },
    replayRefs: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["policy_delta_id"]),
  codeSiteTool("synthi_codesite_request_landing", "Request a landing inspection run for changed paths.", {
    executionPlanId: { type: "string" },
    changedPaths: { type: "array", items: { type: "string" } },
    callsign: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_complete_landing", "Complete a landing inspection run with inspection evidence.", {
    inspection_run_id: { type: "string" },
    status: { type: "string" },
    inspectionSignals: { type: "array", items: { type: "object" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, ["inspection_run_id"]),
  codeSiteTool("synthi_codesite_generate_black_box", "Generate/export the repo-local CodeSite black-box artifact projection.", {}, []),
  codeSiteTool("synthi_codesite_preview_artifacts", "Preview repo-local CodeSite artifacts before export.", {
    project_id: { type: "string" },
    include: { type: "string" },
    max_content_bytes: { type: "number" },
  }, []),
  codeSiteTool("synthi_codesite_get_proof_bundle", "Retrieve a CodeSite proof bundle with transaction, incident, landing, and line-provenance context.", {
    bundle_id: { type: "string" },
  }, ["bundle_id"]),
  codeSiteTool("synthi_codesite_attach_proof_bundle_commit", "Attach a Git commit SHA and expected trailers to a CodeSite proof bundle.", {
    bundle_id: { type: "string" },
    commitSha: { type: "string" },
    commitMessage: { type: "string" },
    trailers: { type: "object" },
  }, ["bundle_id"]),
  codeSiteTool("synthi_codesite_get_line_provenance", "Read causal line provenance for a workspace file and optional line/range selector.", {
    project_id: { type: "string" },
    file_path: { type: "string" },
    line_anchor: { type: "string" },
    line_number: { type: "number" },
  }, ["file_path"]),
  codeSiteTool("synthi_codesite_review_quarantine", "List CodeSiteFS quarantine manifests, or fetch one manifest for human/agent review.", {
    quarantine_id: { type: "string" },
    transaction_id: { type: "string" },
    agent_session_id: { type: "string" },
    display_callsign: { type: "string" },
    callsign: { type: "string" },
    user_id: { type: "string" },
    filesystem_user_id: { type: "string" },
    runtime_scope: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_replay_quarantine", "Dry-run selected CodeSiteFS quarantine paths against the current repo and record reviewed/replayed timeline events.", {
    quarantine_id: { type: "string" },
    transaction_id: { type: "string" },
    selected_paths: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    agent_session_id: { type: "string" },
    display_callsign: { type: "string" },
    callsign: { type: "string" },
    user_id: { type: "string" },
    filesystem_user_id: { type: "string" },
    runtime_scope: { type: "string" },
  }, ["quarantine_id", "transaction_id", "selected_paths"]),
  codeSiteTool("synthi_codesite_apply_quarantine", "Apply selected CodeSiteFS quarantine paths through the active CodeSite transaction boundary.", {
    quarantine_id: { type: "string" },
    transaction_id: { type: "string" },
    selected_paths: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    mutation_lease_id: { type: "string" },
    agent_session_id: { type: "string" },
    display_callsign: { type: "string" },
    callsign: { type: "string" },
    user_id: { type: "string" },
    filesystem_user_id: { type: "string" },
    runtime_scope: { type: "string" },
  }, ["quarantine_id", "transaction_id", "selected_paths"]),
] as const;

export async function dispatchCodeSiteTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  if (!isCodeSiteToolName(toolName)) return null;
  try {
    const input = objectArg(args);
    if (toolName === "synthi_codesite_get_relevant_context") {
      return await dispatchRelevantAgentContext(input);
    }
    if (isAgentBoundKnowledgeToolName(toolName)) {
      return await dispatchAgentBoundKnowledgeTool(toolName, input);
    }
    if (toolName === "synthi_codesite_apply_patch") {
      return await dispatchCodeSiteApplyPatch(input);
    }
    const request = buildCodeSiteRequest(toolName, input);
    if (!request) return errorResponse("codesite_tool_not_implemented", { tool: toolName });
    const response = await callCodeSite(input, request);
    if (!("data" in response)) return response;
    if (toolName === "synthi_codesite_next_event") {
      const events = Array.isArray(response.data["events"]) ? response.data["events"] : [];
      return jsonResponse({
        ok: true,
        tool: toolName,
        next_event: events[0] ?? null,
        event_count: events.length,
        request: response.request,
      });
    }
    if (toolName === "synthi_codesite_get_inbox") {
      const inbox = Array.isArray(response.data["inbox"]) ? response.data["inbox"] : [];
      const nextInboxItem = inbox.find((item) => (
        typeof item === "object"
        && item !== null
        && (item as JsonObject)["acknowledgedAt"] == null
      )) ?? inbox[0] ?? null;
      return jsonResponse({
        ok: true,
        tool: toolName,
        next_inbox_item: nextInboxItem,
        inbox_count: inbox.length,
        request: response.request,
      });
    }
    return jsonResponse({
      ok: true,
      tool: toolName,
      request: response.request,
      response: response.data,
    });
  } catch (err) {
    return errorFromException("codesite_tool_failed", err);
  }
}

async function dispatchAgentBoundKnowledgeTool(
  toolName: AgentBoundKnowledgeToolName,
  args: JsonObject,
): Promise<ToolResponse> {
  assertNoForgedAgentAuthority(args);
  validateAgentBoundKnowledgeArguments(toolName, args);
  const agentSessionId = envString("SYNTHI_CODESITE_AGENT_SESSION_ID");
  const agentToken = envString("SYNTHI_CODESITE_AGENT_TOKEN");
  if (!agentSessionId || !agentToken) {
    return errorResponse("codesite_agent_knowledge_environment_required");
  }

  const apiBase = resolveApiBase({});
  const basePath = `/agent-sessions/${encodeURIComponent(agentSessionId)}`;
  let method: "GET" | "POST" = "POST";
  let path = `${basePath}/knowledge`;
  let body: JsonObject | undefined;
  let url = new URL(`${apiBase}${path}`);

  if (toolName === "synthi_codesite_get_shared_knowledge") {
    method = "GET";
    for (const key of SHARED_KNOWLEDGE_FILTER_KEYS) {
      const value = args[key];
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  } else if (toolName === "synthi_codesite_respond_impact_notice") {
    path = `${basePath}/inbox/${encodeURIComponent(requiredString(args, "notice_id"))}/respond`;
    url = new URL(`${apiBase}${path}`);
    body = withoutUndefined({
      action: args["action"],
      reason: args["reason"],
      evidence_refs: args["evidence_refs"],
    });
  } else if (toolName === "synthi_codesite_find_experts") {
    method = "GET";
    path = `${basePath}/experts`;
    url = new URL(`${apiBase}${path}`);
    for (const key of ["paths", "symbols", "contracts"] as const) {
      const values = boundedStringListArg(args[key], "codesite_agent_knowledge_arguments_invalid", 32);
      if (values.length > 0) url.searchParams.set(key, values.join(","));
    }
    if (args["limit"] !== undefined) url.searchParams.set("limit", String(args["limit"]));
  } else if (toolName === "synthi_codesite_ask_expert_question") {
    method = "POST";
    path = `${basePath}/questions`;
    url = new URL(`${apiBase}${path}`);
    body = withoutUndefined({
      title: args["title"],
      summary: args["summary"],
      references: args["references"],
      urgency: args["urgency"],
      suggested_expert_agent_session_ids: args["suggested_expert_agent_session_ids"],
      allow_unrouted: args["allow_unrouted"],
    });
  } else {
    body = { ...args, kind: knowledgeKindForTool(toolName) };
  }

  const request = { method, path, url: url.toString() };
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${agentToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    return errorResponse("codesite_agent_knowledge_request_failed", {
      status: response.status,
      request,
    });
  }
  const data = sanitizeKnowledgeResponse(parseJsonObject(await response.text()));
  return jsonResponse({
    ok: true,
    tool: toolName,
    request,
    response: data as JsonObject,
  });
}

async function dispatchRelevantAgentContext(args: JsonObject): Promise<ToolResponse> {
  if (Object.keys(args).length > 0) {
    return errorResponse("codesite_agent_context_arguments_forbidden");
  }
  const agentSessionId = envString("SYNTHI_CODESITE_AGENT_SESSION_ID");
  const agentToken = envString("SYNTHI_CODESITE_AGENT_TOKEN");
  if (!agentSessionId || !agentToken) {
    return errorResponse("codesite_agent_context_environment_required");
  }
  const apiBase = resolveApiBase({});
  const path = `/agent-sessions/${encodeURIComponent(agentSessionId)}/relevant-context`;
  const url = new URL(`${apiBase}${path}`);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${agentToken}`,
    },
  });
  if (!response.ok) {
    return errorResponse("codesite_agent_context_request_failed", {
      status: response.status,
      request: { method: "GET", path, url: url.toString() },
    });
  }
  const data = parseJsonObject(await response.text());
  return jsonResponse({
    ok: true,
    tool: "synthi_codesite_get_relevant_context",
    request: { method: "GET", path, url: url.toString() },
    response: data,
  });
}

function codeSiteTool(
  name: CodeSiteToolName,
  description: string,
  properties: JsonObject,
  required: string[]
): { name: CodeSiteToolName; description: string; inputSchema: JsonObject } {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPERTIES,
        ...properties,
      },
      required,
    },
  };
}

function agentBoundCodeSiteTool(
  name: AgentBoundKnowledgeToolName,
  description: string,
  properties: JsonObject,
  required: string[],
): { name: AgentBoundKnowledgeToolName; description: string; inputSchema: JsonObject } {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function buildCodeSiteRequest(toolName: RoutedCodeSiteToolName, args: JsonObject): CodeSiteRequest | null {
  switch (toolName) {
    case "synthi_codesite_list_projects":
      return {
        method: "GET",
        path: "/projects",
      };
    case "synthi_codesite_create_project":
      return {
        method: "POST",
        path: "/projects",
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_project":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}`,
      };
    case "synthi_codesite_update_zone_policy":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/zone-policy`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_update_control_plan":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/control-plan`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_register_agent_session":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/agent-sessions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_list_project_members":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/members`,
      };
    case "synthi_codesite_upsert_project_member":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/members`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_revoke_project_member":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/members/${encodeURIComponent(requiredString(args, "member_id"))}/revoke`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_file_flight_plan":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/execution-plans`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_request_clearance":
      return {
        method: "POST",
        path: `/execution-plans/${encodeURIComponent(requiredString(args, "execution_plan_id"))}/mutation-leases`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_open_transaction":
      return {
        method: "POST",
        path: `/mutation-leases/${encodeURIComponent(requiredString(args, "mutation_lease_id"))}/transactions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_abort_transaction":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/abort`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_revoke_clearance":
      return {
        method: "POST",
        path: `/mutation-leases/${encodeURIComponent(requiredString(args, "mutation_lease_id"))}/revoke`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_record_policy_decision":
      return {
        method: "POST",
        path: `/mutation-leases/${encodeURIComponent(requiredString(args, "mutation_lease_id"))}/policy-decisions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_transaction_status":
      return {
        method: "GET",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/status`,
      };
    case "synthi_codesite_preview_transaction":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/preview`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_dry_run_patch":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/dry-run-patch`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_preflight_write":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/codesitefs-events`,
        body: bodyFromArgs(args, {
          ...pathOverlay(args),
          ...(optionalString(args["mutation_lease_id"]) ? { mutationLeaseId: optionalString(args["mutation_lease_id"]) as string } : {}),
        }),
      };
    case "synthi_codesite_apply_patch":
      return null;
    case "synthi_codesite_record_assumption":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/assumptions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_record_read":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/record-read`,
        body: bodyFromArgs(args, pathOverlay(args)),
      };
    case "synthi_codesite_record_write":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/record-write`,
        body: bodyFromArgs(args, pathOverlay(args)),
      };
    case "synthi_codesite_validate_transaction":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/validate`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_request_commit":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/commit`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_source_state_since":
      return {
        method: "GET",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/source-state-since`,
      };
    case "synthi_codesite_get_radar":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/control-state`,
      };
    case "synthi_codesite_get_metrics":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/metrics`,
      };
    case "synthi_codesite_get_agent_manifest":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/agent-manifest`,
      };
    case "synthi_codesite_get_schemas":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/schemas`,
      };
    case "synthi_codesite_get_active_state":
      return {
        method: "GET",
        path: "/active-state",
      };
    case "synthi_codesite_list_active_transactions":
      return {
        method: "GET",
        path: "/transactions/active",
      };
    case "synthi_codesite_next_event":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/events`,
        query: optionalString(args["since"]) ? { since: optionalString(args["since"]) as string } : undefined,
      };
    case "synthi_codesite_get_inbox":
      return {
        method: "GET",
        path: `/agent-sessions/${encodeURIComponent(requiredString(args, "agent_session_id"))}/inbox`,
      };
    case "synthi_codesite_ack_event":
      return {
        method: "POST",
        path: `/agent-sessions/${encodeURIComponent(requiredString(args, "agent_session_id"))}/inbox/${encodeURIComponent(requiredString(args, "event_id"))}/ack`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_predict_collision":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/collision-predict`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_shadow_merge_simulate":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/shadow-merge-simulate`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_report_counterfactual_run":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/counterfactual-runs`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_list_fleet_notams": {
      const query: Record<string, string> = {};
      if (args["include_own"] !== undefined) query.includeOwn = args["include_own"] === true ? "true" : "false";
      if (args["include_muted"] !== undefined) query.include_muted = args["include_muted"] === true ? "true" : "false";
      if (args["include_inactive"] !== undefined) query.include_inactive = args["include_inactive"] === true ? "true" : "false";
      if (optionalString(args["route"])) query.route = String(args["route"]);
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/fleet-notams`,
        ...(Object.keys(query).length ? { query } : {}),
      };
    }
    case "synthi_codesite_publish_fleet_notam":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/fleet-notams/publish`,
        body: {
          policy_delta_id: requiredString(args, "policy_delta_id"),
          ...(optionalString(args["title"]) ? { title: optionalString(args["title"]) } : {}),
          ...(optionalString(args["summary"]) ? { summary: optionalString(args["summary"]) } : {}),
          ...(optionalString(args["expires_at"]) ? { expiresAt: optionalString(args["expires_at"]) } : {}),
        },
      };
    case "synthi_codesite_decide_fleet_notam":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/fleet-notams/${encodeURIComponent(requiredString(args, "notam_id"))}/decision`,
        body: {
          state: requiredString(args, "state"),
          ...(optionalString(args["reason"]) ? { reason: optionalString(args["reason"]) } : {}),
        },
      };
    case "synthi_codesite_withdraw_fleet_notam":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/fleet-notams/${encodeURIComponent(requiredString(args, "notam_id"))}/withdraw`,
        body: {
          ...(optionalString(args["reason"]) ? { reason: optionalString(args["reason"]) } : {}),
        },
      };
    case "synthi_codesite_supersede_fleet_notam":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/fleet-notams/${encodeURIComponent(requiredString(args, "notam_id"))}/supersede`,
        body: {
          policy_delta_id: requiredString(args, "policy_delta_id"),
          ...(optionalString(args["title"]) ? { title: optionalString(args["title"]) } : {}),
          ...(optionalString(args["summary"]) ? { summary: optionalString(args["summary"]) } : {}),
          ...(optionalString(args["expires_at"]) ? { expiresAt: optionalString(args["expires_at"]) } : {}),
          ...(optionalString(args["reason"]) ? { reason: optionalString(args["reason"]) } : {}),
        },
      };
    case "synthi_codesite_file_rfi":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/documents`,
        body: bodyFromArgs(args, { kind: "rfi" }),
      };
    case "synthi_codesite_file_change_order":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/documents`,
        body: bodyFromArgs(args, { kind: "change_order" }),
      };
    case "synthi_codesite_list_permits":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/permits`,
      };
    case "synthi_codesite_issue_permit":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/permits`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_review_document":
      return {
        method: "POST",
        path: `/documents/${encodeURIComponent(requiredString(args, "document_id"))}/reviews`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_list_route_revisions":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/route-revisions`,
      };
    case "synthi_codesite_propose_route_revision":
      return {
        method: "POST",
        path: `/execution-plans/${encodeURIComponent(requiredString(args, "execution_plan_id"))}/route-revisions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_review_route_revision":
      return {
        method: "POST",
        path: `/route-revisions/${encodeURIComponent(requiredString(args, "route_revision_id"))}/review`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_apply_route_revision":
      return {
        method: "POST",
        path: `/route-revisions/${encodeURIComponent(requiredString(args, "route_revision_id"))}/apply`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_declare_mayday":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/incidents`,
        body: bodyFromArgs(args, { category: "mayday" }),
      };
    case "synthi_codesite_get_incident_replay":
      return {
        method: "GET",
        path: `/incidents/${encodeURIComponent(requiredString(args, "incident_id"))}/replay`,
      };
    case "synthi_codesite_resume_mayday":
      return {
        method: "POST",
        path: `/incidents/${encodeURIComponent(requiredString(args, "incident_id"))}/resume`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_file_policy_delta":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/policy-deltas`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_list_learning_catalog":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/learning-catalog`,
      };
    case "synthi_codesite_adopt_learning_catalog_entry":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/learning-catalog/${encodeURIComponent(requiredString(args, "learning_id"))}/adopt`,
        body: {},
      };
    case "synthi_codesite_promote_policy_delta":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/policy-deltas/${encodeURIComponent(requiredString(args, "policy_delta_id"))}/promote`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_reject_policy_delta":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/policy-deltas/${encodeURIComponent(requiredString(args, "policy_delta_id"))}/reject`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_request_landing":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/inspection-runs`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_complete_landing":
      return {
        method: "POST",
        path: `/inspection-runs/${encodeURIComponent(requiredString(args, "inspection_run_id"))}/complete`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_generate_black_box":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/artifacts/export`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_preview_artifacts":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/artifacts/preview`,
        query: {
          ...(optionalString(args["include"]) ? { include: optionalString(args["include"]) as string } : {}),
          ...(Number.isFinite(Number(args["max_content_bytes"])) ? { maxContentBytes: String(Number(args["max_content_bytes"])) } : {}),
        },
      };
    case "synthi_codesite_get_proof_bundle":
      return {
        method: "GET",
        path: `/proof-bundles/${encodeURIComponent(requiredString(args, "bundle_id"))}`,
      };
    case "synthi_codesite_attach_proof_bundle_commit":
      return {
        method: "POST",
        path: `/proof-bundles/${encodeURIComponent(requiredString(args, "bundle_id"))}/commit`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_line_provenance":
      return {
        method: "GET",
        path: "/provenance/line",
        query: {
          ...(optionalString(args["project_id"]) ? { projectId: optionalString(args["project_id"]) as string } : {}),
          filePath: requiredString(args, "file_path"),
          ...(optionalString(args["line_anchor"]) ? { lineAnchor: optionalString(args["line_anchor"]) as string } : {}),
          ...(Number.isFinite(Number(args["line_number"])) ? { lineNumber: String(Number(args["line_number"])) } : {}),
        },
      };
    case "synthi_codesite_review_quarantine": {
      const quarantineId = optionalString(args["quarantine_id"]) ?? optionalString(args["quarantineId"]);
      return {
        method: "GET",
        path: quarantineId ? `/quarantines/${encodeURIComponent(quarantineId)}` : "/quarantines",
        query: {
          ...(optionalString(args["transaction_id"]) ? { transactionId: optionalString(args["transaction_id"]) as string } : {}),
          ...(optionalString(args["agent_session_id"]) ? { agentSessionId: optionalString(args["agent_session_id"]) as string } : {}),
          ...(optionalString(args["display_callsign"]) || optionalString(args["callsign"])
            ? { displayCallsign: (optionalString(args["display_callsign"]) ?? optionalString(args["callsign"])) as string }
            : {}),
          ...(optionalString(args["status"]) ? { status: optionalString(args["status"]) as string } : {}),
          ...(optionalString(args["user_id"]) ? { userId: optionalString(args["user_id"]) as string } : {}),
          ...(optionalString(args["filesystem_user_id"]) ? { filesystemUserId: optionalString(args["filesystem_user_id"]) as string } : {}),
          ...(optionalString(args["runtime_scope"]) ? { runtimeScope: optionalString(args["runtime_scope"]) as string } : {}),
        },
      };
    }
    case "synthi_codesite_replay_quarantine":
      return {
        method: "POST",
        path: `/quarantines/${encodeURIComponent(requiredString(args, "quarantine_id"))}/replay`,
        body: bodyFromArgs(args, quarantineActionOverlay(args)),
      };
    case "synthi_codesite_apply_quarantine":
      return {
        method: "POST",
        path: `/quarantines/${encodeURIComponent(requiredString(args, "quarantine_id"))}/apply`,
        body: bodyFromArgs(args, quarantineActionOverlay(args)),
      };
  }
}

async function dispatchCodeSiteApplyPatch(args: JsonObject): Promise<ToolResponse> {
  const transactionId = requiredString(args, "transaction_id");
  const files = filePatchList(args["files"]);
  if (!files.length) return errorResponse("codesite_patch_files_required");

  const dryRunRequest: CodeSiteRequest = {
    method: "POST",
    path: `/transactions/${encodeURIComponent(transactionId)}/dry-run-patch`,
    body: { files },
  };
  const dryRun = await callCodeSite(args, dryRunRequest);
  if (!("data" in dryRun)) return dryRun;

  const dryRunResults = Array.isArray(dryRun.data["results"]) ? dryRun.data["results"] : [];
  const denied = dryRunResults.filter((result) => (
    typeof result === "object"
    && result !== null
    && (result as JsonObject)["ok"] === false
  ));
  if (denied.length > 0) {
    return errorResponse("codesite_patch_policy_denied", {
      transaction_id: transactionId,
      denied,
      dry_run: dryRun.data,
      request: dryRun.request,
    });
  }

  const apply = await callCollabWriteFilesBatch(args, files);
  if (!("data" in apply)) return apply;
  return jsonResponse({
    ok: true,
    tool: "synthi_codesite_apply_patch",
    dry_run: dryRun.data,
    apply: apply.data,
    requests: {
      dry_run: dryRun.request,
      apply: apply.request,
    },
  });
}

async function callCollabWriteFilesBatch(args: JsonObject, files: JsonObject[]): Promise<{
  isError: false;
  data: JsonObject;
  request: JsonObject;
} | ToolResponse> {
  const workspaceSlug = requiredWorkspaceSlug(args);
  const transactionId = requiredString(args, "transaction_id");
  const apiBase = resolveApiBase(args);
  const collabBase = resolveCollabBase(args);
  const url = new URL(`${collabBase}/git/${encodeURIComponent(workspaceSlug)}/write-files-batch`);
  const token = optionalString(args["auth_token"]) ?? envString("SYNTHI_CODESITE_TOKEN");
  const cookie = optionalString(args["cookie"]) ?? envString("SYNTHI_CODESITE_COOKIE");
  const userId = optionalString(args["user_id"]) ?? envString("SYNTHI_CODESITE_USER_ID");
  const sessionId = optionalString(args["session_id"]) ?? envString("SYNTHI_CODESITE_SESSION_ID");
  const codesite = {
    enforce: true,
    mode: "enforce",
    workspaceSlug,
    transactionId,
    mutationLeaseId: optionalString(args["mutation_lease_id"]) ?? optionalString(args["mutationLeaseId"]),
    displayCallsign: optionalString(args["displayCallsign"]) ?? optionalString(args["callsign"]),
    controlPlaneUrl: apiBase,
    authToken: token,
    cookie,
    allowedPaths: stringListArg(args["allowedPaths"] ?? args["allowed_paths"]),
    blockedPaths: stringListArg(args["blockedPaths"] ?? args["blocked_paths"]),
    allowedTools: stringListArg(args["allowedTools"] ?? args["allowed_tools"]),
    processAncestry: ["mcp:synthi_codesite_apply_patch"],
  };
  const body: JsonObject = {
    files,
    syncToGcs: args["syncToGcs"] !== false && args["sync_to_gcs"] !== false,
    codesite,
    ...(userId ? { userId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-codesite-mode": "enforce",
    "x-codesite-transaction-id": transactionId,
    "x-codesite-control-plane-url": apiBase,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (cookie) headers["cookie"] = cookie;
  if (userId) headers["x-user-id"] = userId;
  if (sessionId) headers["x-session-id"] = sessionId;
  if (codesite.mutationLeaseId) headers["x-codesite-lease-id"] = codesite.mutationLeaseId;
  if (codesite.displayCallsign) headers["x-codesite-callsign"] = codesite.displayCallsign;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = parseJsonObject(text);
  const requestSummary = {
    method: "POST",
    path: `/git/${workspaceSlug}/write-files-batch`,
    url: url.toString(),
  };
  if (!response.ok) {
    return errorResponse("codesite_collab_patch_apply_failed", {
      status: response.status,
      request: requestSummary,
      response: data,
    });
  }
  return { isError: false, data, request: requestSummary };
}

async function callCodeSite(args: JsonObject, request: CodeSiteRequest): Promise<{
  isError: false;
  data: JsonObject;
  request: JsonObject;
} | ToolResponse> {
  const apiBase = resolveApiBase(args);
  const url = new URL(`${apiBase}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const token = optionalString(args["auth_token"]) ?? envString("SYNTHI_CODESITE_TOKEN");
  const cookie = optionalString(args["cookie"]) ?? envString("SYNTHI_CODESITE_COOKIE");
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (cookie) headers["cookie"] = cookie;
  if (request.body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  const data = parseJsonObject(text);
  const requestSummary = {
    method: request.method,
    path: request.path,
    url: url.toString(),
  };
  if (!response.ok) {
    return errorResponse("codesite_control_plane_request_failed", {
      status: response.status,
      request: requestSummary,
      response: data,
    });
  }
  return { isError: false, data, request: requestSummary };
}

function resolveApiBase(args: JsonObject): string {
  const workspaceSlug = encodeURIComponent(requiredWorkspaceSlug(args));
  const explicit = optionalString(args["codesite_api_base_url"]) ?? envString("SYNTHI_CODESITE_API_BASE_URL");
  if (explicit) {
    return trimTrailingSlash(explicit.replace("{workspace_slug}", workspaceSlug));
  }
  const origin = trimTrailingSlash(
    optionalString(args["base_url"]) ??
      envString("SYNTHI_CODESITE_BASE_URL") ??
      envString("SYNTHI_APP_URL") ??
      "http://127.0.0.1:3000"
  );
  return `${origin}/api/workspace/${workspaceSlug}/codesite`;
}

function resolveCollabBase(args: JsonObject): string {
  return trimTrailingSlash(
    optionalString(args["collab_base_url"]) ??
      envString("SYNTHI_COLLAB_BASE_URL") ??
      envString("COLLAB_SERVER_URL") ??
      envString("SYNTHI_COLLAB_SERVER_URL") ??
      "http://127.0.0.1:1234"
  );
}

function requiredWorkspaceSlug(args: JsonObject): string {
  const value = optionalString(args["workspace_slug"]) ?? envString("SYNTHI_CODESITE_WORKSPACE") ?? envString("SYNTHI_WORKSPACE_SLUG");
  if (!value) throw new Error("missing_workspace_slug");
  return value;
}

function requiredProjectId(args: JsonObject): string {
  const value = optionalString(args["project_id"]) ?? envString("SYNTHI_CODESITE_PROJECT_ID");
  if (!value) throw new Error("missing_project_id");
  return value;
}

function bodyFromArgs(args: JsonObject, overlay: JsonObject = {}): JsonObject {
  const rawBody = objectOpt(args["body"]);
  const forwarded: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (CONTROL_ARG_KEYS.has(key) || value === undefined) continue;
    forwarded[key] = value;
  }
  return { ...forwarded, ...rawBody, ...overlay };
}

function pathOverlay(args: JsonObject): JsonObject {
  const path = optionalString(args["path"]) ?? optionalString(args["file_path"]);
  return path ? { path } : {};
}

function quarantineActionOverlay(args: JsonObject): JsonObject {
  const transactionId = requiredString(args, "transaction_id");
  const mutationLeaseId = optionalString(args["mutation_lease_id"]) ?? optionalString(args["mutationLeaseId"]);
  const agentSessionId = optionalString(args["agent_session_id"]) ?? optionalString(args["agentSessionId"]);
  const displayCallsign = optionalString(args["display_callsign"]) ?? optionalString(args["displayCallsign"]) ?? optionalString(args["callsign"]);
  const paths = selectedPathList(args);
  if (paths.length === 0) {
    throw new Error("missing_selected_paths");
  }
  const userId = optionalString(args["user_id"]) ?? optionalString(args["userId"]);
  const filesystemUserId = optionalString(args["filesystem_user_id"]) ?? optionalString(args["filesystemUserId"]);
  const runtimeScope = optionalString(args["runtime_scope"]) ?? optionalString(args["runtimeScope"]);
  return {
    transactionId,
    paths,
    ...(mutationLeaseId ? { mutationLeaseId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(displayCallsign ? { displayCallsign } : {}),
    ...(userId ? { userId } : {}),
    ...(filesystemUserId ? { filesystemUserId } : {}),
    ...(runtimeScope ? { runtimeScope } : {}),
  };
}

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    return { value: parsed };
  } catch {
    return { text };
  }
}

const AGENT_BOUND_WRITER_ARGUMENTS: Record<
  Exclude<
    AgentBoundKnowledgeToolName,
    | "synthi_codesite_get_shared_knowledge"
    | "synthi_codesite_respond_impact_notice"
    | "synthi_codesite_find_experts"
    | "synthi_codesite_ask_expert_question"
  >,
  { allowed: readonly string[]; required: readonly string[] }
> = {
  synthi_codesite_record_discovery: {
    allowed: [...Object.keys(KNOWLEDGE_COMMON_PROPERTIES), "status", "confidence", "verification"],
    required: ["title", "summary", "references", "evidence_refs", "confidence"],
  },
  synthi_codesite_record_lead: {
    allowed: [...Object.keys(KNOWLEDGE_COMMON_PROPERTIES), "status", "confidence", "priority"],
    required: ["title", "summary", "references", "confidence"],
  },
  synthi_codesite_publish_shared_skill: {
    allowed: [...Object.keys(KNOWLEDGE_COMMON_PROPERTIES), "status", "skill_key", "recipe"],
    required: ["title", "summary", "references", "evidence_refs", "skill_key", "recipe"],
  },
  synthi_codesite_file_handoff: {
    allowed: [...Object.keys(KNOWLEDGE_COMMON_PROPERTIES), "status", "to_agent_session_id", "unresolved_risks", "required_actions"],
    required: ["title", "summary", "references", "evidence_refs", "to_agent_session_id"],
  },
};

const SHARED_KNOWLEDGE_FILTER_KEYS = [
  "kind",
  "status",
  "since",
  "limit",
  "path",
  "symbol",
  "contract",
  "workstream_id",
] as const;

const KNOWLEDGE_KINDS = new Set(["discovery", "lead", "shared_skill", "impact_notice", "handoff", "agent_question"]);
const KNOWLEDGE_STATUSES = new Set<string>(SHARED_KNOWLEDGE_STATUSES);
const IMPACT_ACTIONS_REQUIRING_EVIDENCE = new Set(["rebase_requested", "abort", "dismiss"]);

function boundedStringListArg(value: unknown, error: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(error);
  }
  const entries = value.map((item) => (item as string).trim()).filter(Boolean);
  if (entries.length !== value.length || entries.length > maximum) {
    throw new Error(error);
  }
  return entries;
}

function validateAgentBoundKnowledgeArguments(toolName: AgentBoundKnowledgeToolName, args: JsonObject): void {
  if (toolName === "synthi_codesite_find_experts") {
    assertAllowedKeys(args, ["paths", "symbols", "contracts", "limit"]);
    for (const key of ["paths", "symbols", "contracts"] as const) {
      if (args[key] !== undefined) boundedStringListArg(args[key], "codesite_agent_knowledge_arguments_invalid", 32);
    }
    const limit = args["limit"];
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10)) {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    if (!["paths", "symbols", "contracts"].some((key) => Array.isArray(args[key]) && args[key].length > 0)) {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    return;
  }
  if (toolName === "synthi_codesite_ask_expert_question") {
    assertAllowedKeys(
      args,
      [...Object.keys(KNOWLEDGE_COMMON_PROPERTIES), "urgency", "suggested_expert_agent_session_ids", "allow_unrouted"],
    );
    requireArguments(args, ["title", "summary", "references"]);
    if (typeof args["title"] !== "string" || args["title"].length < 1 || args["title"].length > 160) {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    if (typeof args["summary"] !== "string" || args["summary"].length < 1 || args["summary"].length > 4096) {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    const references = requiredObject(args["references"], "codesite_knowledge_references_invalid");
    assertAllowedKeys(references, Object.keys(KNOWLEDGE_REFERENCE_PROPERTIES));
    for (const value of Object.values(references)) {
      if (value !== undefined) boundedStringListArg(value, "codesite_knowledge_references_invalid", 32);
    }
    const urgency = args["urgency"];
    if (urgency !== undefined && !["low", "normal", "high"].includes(urgency as string)) {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    if (args["suggested_expert_agent_session_ids"] !== undefined) {
      boundedStringListArg(args["suggested_expert_agent_session_ids"], "codesite_agent_knowledge_arguments_invalid", 8);
    }
    if (args["allow_unrouted"] !== undefined && typeof args["allow_unrouted"] !== "boolean") {
      throw new Error("codesite_agent_knowledge_arguments_invalid");
    }
    return;
  }
  if (toolName === "synthi_codesite_get_shared_knowledge") {
    assertAllowedKeys(args, SHARED_KNOWLEDGE_FILTER_KEYS);
    const kind = optionalString(args["kind"]);
    const status = optionalString(args["status"]);
    if (kind && !KNOWLEDGE_KINDS.has(kind)) throw new Error("codesite_shared_knowledge_kind_invalid");
    if (status && !KNOWLEDGE_STATUSES.has(status)) throw new Error("codesite_shared_knowledge_status_invalid");
    const limit = args["limit"];
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      throw new Error("codesite_shared_knowledge_limit_invalid");
    }
    return;
  }
  if (toolName === "synthi_codesite_respond_impact_notice") {
    assertAllowedKeys(args, ["notice_id", "action", "reason", "evidence_refs"]);
    requireArguments(args, ["notice_id", "action"]);
    const action = requiredString(args, "action");
    if (!(IMPACT_NOTICE_ACTIONS as readonly string[]).includes(action)) {
      throw new Error("codesite_impact_notice_action_invalid");
    }
    if (IMPACT_ACTIONS_REQUIRING_EVIDENCE.has(action)) {
      if (!optionalString(args["reason"])) throw new Error("codesite_impact_notice_reason_required");
      if (stringListArg(args["evidence_refs"]).length === 0) {
        throw new Error("codesite_impact_notice_evidence_required");
      }
    }
    return;
  }
  const contract = AGENT_BOUND_WRITER_ARGUMENTS[toolName];
  assertAllowedKeys(args, contract.allowed);
  requireArguments(args, contract.required);
  if (args["references"] !== undefined) {
    const references = requiredObject(args["references"], "codesite_knowledge_references_invalid");
    assertAllowedKeys(references, Object.keys(KNOWLEDGE_REFERENCE_PROPERTIES));
  }
  if (toolName === "synthi_codesite_publish_shared_skill") {
    const recipe = requiredObject(args["recipe"], "codesite_shared_skill_recipe_invalid");
    assertAllowedKeys(recipe, Object.keys(SHARED_SKILL_RECIPE_PROPERTIES));
    requireArguments(recipe, ["commands", "required_permissions", "usage_conditions"]);
  }
}

function knowledgeKindForTool(
  toolName: Exclude<AgentBoundKnowledgeToolName, "synthi_codesite_get_shared_knowledge" | "synthi_codesite_respond_impact_notice">,
): "discovery" | "lead" | "shared_skill" | "handoff" {
  if (toolName === "synthi_codesite_record_discovery") return "discovery";
  if (toolName === "synthi_codesite_record_lead") return "lead";
  if (toolName === "synthi_codesite_publish_shared_skill") return "shared_skill";
  return "handoff";
}

function assertNoForgedAgentAuthority(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) throw new Error("codesite_agent_knowledge_arguments_invalid");
  seen.add(value as object);
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const sourceIdentity = [
      "agent_session_id", "from_agent_session_id", "source_agent_session_id", "created_by_agent_session_id",
      "owner_agent_session_id", "project_id", "workspace_slug", "user_id", "owner_user_id", "created_by_user_id",
      "actor_id", "actor_type", "source", "session_id", "terminal_session_id", "runtime_session_id", "runtime_scope",
      "execution_host", "provider", "provider_id", "provider_session_ref", "provider_session_bound",
      "auth_token", "base_url", "codesite_api_base_url", "collab_base_url", "cookie", "body",
    ].includes(normalized);
    const privateMaterial = /(token|secret|credential|password|passwd|cookie|prompt|transcript|provider_session)/i.test(normalized);
    if (sourceIdentity || privateMaterial) {
      throw new Error("codesite_agent_knowledge_identity_arguments_forbidden");
    }
    assertNoForgedAgentAuthority(child, seen);
  }
  seen.delete(value as object);
}

function assertAllowedKeys(args: JsonObject, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(args).some((key) => !allowedKeys.has(key))) {
    throw new Error("codesite_agent_knowledge_arguments_invalid");
  }
}

function requireArguments(args: JsonObject, required: readonly string[]): void {
  if (required.some((key) => args[key] === undefined || args[key] === null || args[key] === "")) {
    throw new Error("codesite_agent_knowledge_arguments_required");
  }
}

function requiredObject(value: unknown, error: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as JsonObject;
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sanitizeKnowledgeResponse(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 8192);
  if (depth >= 8) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => sanitizeKnowledgeResponse(entry, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 8192);
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => !/(token|secret|credential|password|cookie|prompt|transcript|provider[_]?session[_]?ref)/i.test(key))
      .slice(0, 256)
      .map(([key, entry]) => [key, sanitizeKnowledgeResponse(entry, depth + 1)]),
  );
}

function isAgentBoundKnowledgeToolName(toolName: CodeSiteToolName): toolName is AgentBoundKnowledgeToolName {
  return [
    "synthi_codesite_find_experts",
    "synthi_codesite_record_discovery",
    "synthi_codesite_record_lead",
    "synthi_codesite_publish_shared_skill",
    "synthi_codesite_file_handoff",
    "synthi_codesite_get_shared_knowledge",
    "synthi_codesite_respond_impact_notice",
    "synthi_codesite_ask_expert_question",
  ].includes(toolName as AgentBoundKnowledgeToolName);
}

function isCodeSiteToolName(toolName: string): toolName is CodeSiteToolName {
  return (CODESITE_TOOL_NAMES as readonly string[]).includes(toolName);
}

function objectArg(args: unknown): JsonObject {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return args as JsonObject;
}

function objectOpt(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function filePatchList(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item }));
}

function stringListArg(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function selectedPathList(args: JsonObject): string[] {
  return stringListArg(args["selected_paths"] ?? args["selectedPaths"] ?? args["paths"]);
}

function requiredString(args: JsonObject, field: string): string {
  const value = optionalString(args[field]);
  if (!value) throw new Error(`missing_${field}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function envString(name: string): string | undefined {
  return optionalString(process.env[name]);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
