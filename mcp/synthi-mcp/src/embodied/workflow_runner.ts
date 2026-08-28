/**
 * Cross-substrate workflow orchestration: a competency whose steps may run
 * in DIFFERENT worlds (edit file -> verify in another world -> report), with
 * each node authorized against its own license scope and dispatched through
 * its substrate's capabilities.
 *
 * The orchestrator knows nothing about any substrate: nodes carry their
 * substrate kind + realm, authorization goes through governance.authorizeRun,
 * and execution goes through the registered adapter bundle. A node that
 * cannot run (unlicensed, capability missing) fails the workflow with a
 * human-readable reason - never a silent skip.
 */

import { getAdapter, requireCapability, type SessionHandle } from "./substrate.js";
import { authorizeRun, type CompetencyLicense, type EntrustmentLevel } from "./governance.js";
import { classifyFromEvidence } from "./classifier.js";

export interface WorkflowNodeInput {
  node_id: string;
  substrate_kind: string;
  realm: { realm_kind: string; realm_id: string };
  /** Opaque action for the target world's ActorCap. */
  action: unknown;
  /** Effect check id interpreted by the node's verifier hook. */
  expect?: string;
}

export interface WorkflowDefinition {
  workflow_id: string;
  competency_id: string;
  required_level: EntrustmentLevel;
  nodes: readonly WorkflowNodeInput[];
}

export interface WorkflowNodeResult {
  node_id: string;
  ok: boolean;
  applied_tick?: number;
  classifier_trunk?: string;
  human_explanation?: string;
}

export interface WorkflowRunResult {
  workflow_id: string;
  ok: boolean;
  node_results: WorkflowNodeResult[];
  refused_at?: string;
  refusal_reason?: string;
}

export interface OrchestrationHost {
  /** Handles per (substrate, realm) pair, attached upstream under consent. */
  handleFor(substrateKind: string, realm: { realm_kind: string; realm_id: string }): Promise<SessionHandle>;
  licenses: readonly CompetencyLicense[];
  now: number;
  leaseProofFor(substrateKind: string, realm: { realm_kind: string; realm_id: string }): {
    lease_id: string;
    realm: { realm_kind: string; realm_id: string };
    capability: "act";
    expires_at_ms: number;
  };
}

/**
 * Run every node in order; stop at first failure with classification.
 * Authorization is per-node (substrate + realm + level) - a workflow is
 * never granted blanket trust.
 */
export async function runCrossSubstrateWorkflow(
  definition: WorkflowDefinition,
  host: OrchestrationHost,
): Promise<WorkflowRunResult> {
  const nodeResults: WorkflowNodeResult[] = [];

  for (const node of definition.nodes) {
    const decision = authorizeRun(host.licenses, {
      competency_id: definition.competency_id,
      substrate_kind: node.substrate_kind,
      realm: node.realm,
      required_level: definition.required_level,
      now: host.now,
    });
    if (!decision.authorized) {
      return {
        workflow_id: definition.workflow_id,
        ok: false,
        node_results: nodeResults,
        refused_at: node.node_id,
        refusal_reason: decision.human_reason,
      };
    }

    let bundle;
    try {
      bundle = getAdapter(node.substrate_kind);
    } catch {
      return {
        workflow_id: definition.workflow_id,
        ok: false,
        node_results: nodeResults,
        refused_at: node.node_id,
        refusal_reason: `No adapter available for "${node.substrate_kind}".`,
      };
    }

    const actor = (() => {
      try {
        return requireCapability(node.substrate_kind, (b) => b.actor, "actor");
      } catch {
        return undefined;
      }
    })();
    if (!actor) {
      return {
        workflow_id: definition.workflow_id,
        ok: false,
        node_results: nodeResults,
        refused_at: node.node_id,
        refusal_reason: "This world cannot perform actions right now.",
      };
    }

    const handle = await host.handleFor(node.substrate_kind, node.realm);
    const result = await actor.act(handle, node.action, host.leaseProofFor(node.substrate_kind, node.realm));

    if (!result.ok) {
      const classified = classifyFromEvidence({
        kind: "app_rejection",
        validation_errors: 1,
        state_conflict: false,
      });
      nodeResults.push({
        node_id: node.node_id,
        ok: false,
        classifier_trunk: classified.trunk,
        human_explanation: result.refusal_reason ?? "The action was not performed.",
      });
      return { workflow_id: definition.workflow_id, ok: false, node_results: nodeResults };
    }

    nodeResults.push({ node_id: node.node_id, ok: true, applied_tick: result.applied_tick });
  }

  return { workflow_id: definition.workflow_id, ok: true, node_results: nodeResults };
}
