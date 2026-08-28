/**
 * Metadata-only skills available to the Vectant atomic router. This is an
 * index for selecting a narrow execution context, never a source of skill
 * instruction bodies or MCP tool schemas.
 */

export interface VectantSkillMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly groups: readonly string[];
  readonly keywords: readonly string[];
}

export const VECTANT_SKILL_METADATA: readonly VectantSkillMetadata[] = Object.freeze([
  Object.freeze({
    id: "vectant-runtime",
    name: "Vectant runtime",
    description: "Manages workspace runtimes, attachments, and project execution.",
    groups: Object.freeze(["runtime", "attachment", "hmr", "project"]),
    keywords: Object.freeze(["attach", "compile", "container", "deploy", "hmr", "runtime", "workspace"]),
  }),
  Object.freeze({
    id: "vectant-browser",
    name: "Vectant browser automation",
    description: "Observes and drives the attached preview through bounded browser actions.",
    groups: Object.freeze(["browser", "input", "observation", "telemetry"]),
    keywords: Object.freeze(["browser", "click", "console", "preview", "screenshot"]),
  }),
  Object.freeze({
    id: "vectant-codesite",
    name: "Vectant CodeSite",
    description: "Uses the CodeSite transaction and control-plane workflow.",
    groups: Object.freeze(["codesite", "control-plane"]),
    keywords: Object.freeze(["codesite", "transaction", "workspace"]),
  }),
  Object.freeze({
    id: "vectant-agent-dojo",
    name: "Vectant Agent Dojo",
    description: "Uses governed Agent Dojo workflows and proof-capsule actions.",
    groups: Object.freeze(["agent-dojo", "governance", "proof"]),
    keywords: Object.freeze(["dojo", "governance", "proof", "capsule"]),
  }),
  Object.freeze({
    id: "vectant-source-identity",
    name: "Vectant source identity",
    description: "Works with source identity, snapshots, and restore flows.",
    groups: Object.freeze(["source-identity", "snapshot"]),
    keywords: Object.freeze(["restore", "snapshot", "source"]),
  }),
  Object.freeze({
    id: "vectant-safety",
    name: "Vectant safety",
    description: "Handles safety, authorization, and human-escalation workflows.",
    groups: Object.freeze(["authentication", "human-escalation", "safety"]),
    keywords: Object.freeze(["approval", "auth", "human", "permission", "safety"]),
  }),
  Object.freeze({
    id: "vectant-validation",
    name: "Vectant validation",
    description: "Verifies a bounded task outcome independently when routing requires it.",
    groups: Object.freeze(["proof", "verification"]),
    keywords: Object.freeze(["check", "test", "validate", "verification", "verify"]),
  }),
  Object.freeze({
    id: "vectant-jupyter",
    name: "Vectant Jupyter",
    description: "Operates registered Jupyter servers and notebook kernels without exposing connection tokens.",
    groups: Object.freeze(["data", "jupyter", "notebook"]),
    keywords: Object.freeze(["cell", "jupyter", "kernel", "notebook", "python"]),
  }),
]);
