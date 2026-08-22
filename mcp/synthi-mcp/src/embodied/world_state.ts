/**
 * World state schemas: the typed ontology adapters declare about their worlds.
 *
 * This is the semantic backbone of the embodied pipeline. The State Differ's
 * salience scoring, the compiler's predicate generation, and hardening's
 * downgrade rules all consume this document — so its shape is strict and its
 * validation refuses ambiguity rather than guessing.
 *
 * Division of power (enforced, not suggested):
 * - Adapters declare TYPES and IDENTITY semantics.
 * - Adapters never ship predicates; predicates are compiler-generated from
 *   schema-typed deltas or declared by humans.
 * - Core owns the default semantic weight scale; adapters may add new type
 *   names but may never reorder or override the core scale.
 */

// ---------------------------------------------------------------------------
// Value types (typed leaves; deliberately no opaque "any")
// ---------------------------------------------------------------------------

export type ValueType =
  | { kind: "boolean" }
  | {
      kind: "number";
      unit?: string;
      bounds?: { min?: number; max?: number };
    }
  | { kind: "enum"; values: string[] }
  /** Position on an ordered circular/linear domain (angles, hues, phases). */
  | { kind: "band"; min: number; max: number; unit?: string }
  | { kind: "string"; max_length?: number }
  /** Reference to another entity/path in the same world. */
  | { kind: "ref" };

export interface SemanticTypeDeclaration {
  /** Glob-ish path pattern into observations, e.g. "entities.*.state". */
  path_pattern: string;
  type: ValueType;
  /** Optional semantic class name used for salience weighting. Must name a
   *  core semantic class or one registered by this adapter's extension. */
  semantic_class?: string;
  /** Set when this declaration was discovered at runtime rather than shipped
   *  statically; discovery is always marked and confidence-scored. */
  discovered?: boolean;
  discovery_confidence?: number;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Reality classes an id scheme might or might not survive. */
export type SurvivalClass =
  | "fork"
  | "reset"
  | "restart"
  | "realm_change"
  | "schema_major";

export interface IdentitySpec {
  id_scheme:
    /** Ids persist across every reality class within the realm. */
    | "stable"
    /** Ids are valid within one session/run only. */
    | "session"
    /** Ids are computed from observables each time; stability depends on the
     *  derivation inputs, described by the reidentification rule. */
    | "derived";
  /** Which reality classes this id scheme demonstrably survives. */
  survives: SurvivalClass[];
  /** How to find the same entity again after the guarantee ends. Required
   *  for session/derived schemes; optional refinement for stable ones. */
  reidentification_rule?: string;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export type PartialObservabilityPolicy =
  | "full"
  | "best_effort"
  | "sampled"
  | "event_driven";

export interface ObservabilitySpec {
  fully_observable: boolean;
  /** What state EXISTS but cannot be observed through this substrate.
   *  Declared, never silent: contracts compiled against this schema carry
   *  these as blind spots. */
  hidden_state: string[];
  policy: PartialObservabilityPolicy;
}

// ---------------------------------------------------------------------------
// Semantic weight scale
// ---------------------------------------------------------------------------

/**
 * Core-owned default salience weights per semantic class. Order encodes the
 * pipeline's prior about what tends to matter causally. Adapters EXTEND with
 * new class names; overriding or reordering these defaults is rejected.
 */
export const CORE_SEMANTIC_TYPE_WEIGHTS: Readonly<Record<string, number>> = {
  identity: 1,
  structural_role: 0.9,
  material: 0.8,
  content: 0.75,
  state_flag: 0.7,
  transform: 0.6,
  counter: 0.4,
  timing: 0.3,
  ambient: 0.15,
  cosmetic_transient: 0.1,
};

// ---------------------------------------------------------------------------
// Schema document
// ---------------------------------------------------------------------------

export interface NoiseFingerprint {
  fingerprint_id: string;
  path_pattern: string;
  /** Expected oscillation period hint in ticks, when known. */
  period_hint_ticks?: number;
}

export interface WorldStateSchema {
  schema_id: string;
  /** semver "major.minor.patch"; major bumps break cached predicate bindings. */
  schema_version: string;
  value_types: SemanticTypeDeclaration[];
  identity: IdentitySpec;
  observability: ObservabilitySpec;
  /** Adapter extensions beyond the core semantic classes. */
  semantic_type_extension?: Record<string, number>;
  noise_fingerprints?: NoiseFingerprint[];
}

// ---------------------------------------------------------------------------
// Adapter diff output (stage-1 contract of the State Differ)
// ---------------------------------------------------------------------------

/** One mechanically-detected change between two observations. Produced ONLY
 *  by adapter diff implementations — complete, unfiltered, cheap. */
export interface ChangedValue {
  path: string;
  /** Semantic class if a schema declaration matches the path, else
   *  "undeclared". Declared paths score higher under equal conditions. */
  semantic_class: string;
  before?: unknown;
  after?: unknown;
  changed_at_tick: number;
}

/** Resolve the semantic class for an observation path against a schema. */
export function resolveSemanticClass(
  schema: WorldStateSchema,
  path: string,
): string {
  for (const declaration of schema.value_types) {
    if (pathMatchesPattern(path, declaration.path_pattern)) {
      return declaration.semantic_class ?? "declared_unweighted";
    }
  }
  return "undeclared";
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split(".");
  const patternParts = pattern.split(".");
  let pi = 0;
  for (let pp = 0; pp < patternParts.length; pp += 1) {
    const part: string = patternParts[pp] as string;
    if (part === "**") {
      // "**" consumes zero or more segments; must be last for simplicity.
      return pp === patternParts.length - 1 ? pi <= pathParts.length : false;
    }
    if (pi >= pathParts.length) return false;
    const pathPart: string = pathParts[pi] as string;
    if (!segmentMatches(pathPart, part)) return false;
    pi += 1;
  }
  return pi === pathParts.length;
}

function segmentMatches(segment: string, patternSegment: string): boolean {
  if (patternSegment === "*") return segment.length > 0;
  if (!patternSegment.includes("*")) return segment === patternSegment;
  // single-segment glob: * within a name
  const regex = new RegExp(
    `^${patternSegment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*")}$`,
  );
  return regex.test(segment);
}

// ---------------------------------------------------------------------------
// Weight resolution (extension-safe, override-proof)
// ---------------------------------------------------------------------------

const resolvedWeights = new WeakMap<WorldStateSchema, Map<string, number>>();

/** Effective weight for a semantic class under a schema, combining the
 *  immutable core scale with the schema's extension. Unknown classes weigh
 *  as undeclared (0.05) so novelty can still surface without dominating. */
export function effectiveSemanticWeight(
  schema: WorldStateSchema,
  semanticClass: string,
): number {
  let weights = resolvedWeights.get(schema);
  if (!weights) {
    weights = new Map(Object.entries(CORE_SEMANTIC_TYPE_WEIGHTS));
    for (const [name, weight] of Object.entries(schema.semantic_type_extension ?? {})) {
      if (CORE_SEMANTIC_TYPE_WEIGHTS[name] !== undefined) {
        // Extension attempts on core names were already rejected at
        // validation; defensive skip here keeps runtime safe regardless.
        continue;
      }
      weights.set(name, weight);
    }
    resolvedWeights.set(schema, weights);
  }
  return weights.get(semanticClass) ?? 0.05;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SchemaProblem {
  path: string;
  problem: string;
}

function validateSemver(version: string): boolean {
  const parts = version.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => /^\d+$/.test(part));
}

function validateValueType(type: unknown): string | null {
  if (typeof type !== "object" || type === null) return "type must be an object";
  const candidate = type as ValueType;
  switch (candidate.kind) {
    case "boolean":
      return null;
    case "number":
      if (
        candidate.bounds &&
        candidate.bounds.min !== undefined &&
        candidate.bounds.max !== undefined &&
        candidate.bounds.min > candidate.bounds.max
      ) {
        return "bounds.min exceeds bounds.max";
      }
      return null;
    case "enum":
      if (!Array.isArray(candidate.values) || candidate.values.length === 0) {
        return "enum requires a non-empty values array";
      }
      if (candidate.values.some((v) => typeof v !== "string")) {
        return "enum values must be strings";
      }
      return null;
    case "band":
      if (typeof candidate.min !== "number" || typeof candidate.max !== "number") {
        return "band requires numeric min and max";
      }
      if (candidate.min >= candidate.max) return "band min must be below max";
      return null;
    case "string":
      if (
        candidate.max_length !== undefined &&
        (candidate.max_length < 1 || !Number.isInteger(candidate.max_length))
      ) {
        return "string max_length must be a positive integer";
      }
      return null;
    case "ref":
      return null;
    default:
      return "unknown value type kind";
  }
}

/** Validate a full schema document with precise rejection reasons. */
export function validateWorldStateSchema(
  schema: WorldStateSchema,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];

  if (typeof schema.schema_id !== "string" || schema.schema_id.length === 0) {
    problems.push({ path: "schema_id", problem: "must be a non-empty string" });
  }
  if (typeof schema.schema_version !== "string" || !validateSemver(schema.schema_version)) {
    problems.push({
      path: "schema_version",
      problem: 'must be semver "major.minor.patch"',
    });
  }

  if (!Array.isArray(schema.value_types)) {
    problems.push({ path: "value_types", problem: "must be an array" });
  } else {
    schema.value_types.forEach((declaration, i) => {
      const base = `value_types[${i}]`;
      if (!declaration || typeof declaration.path_pattern !== "string" || declaration.path_pattern.length === 0) {
        problems.push({ path: `${base}.path_pattern`, problem: "must be a non-empty string" });
      }
      const typeProblem = validateValueType(declaration?.type);
      if (typeProblem) problems.push({ path: `${base}.type`, problem: typeProblem });
      if (declaration?.semantic_class && typeof declaration.semantic_class !== "string") {
        problems.push({ path: `${base}.semantic_class`, problem: "must be a string when present" });
      }
      if (declaration?.discovered) {
        const confidence = declaration.discovery_confidence;
        if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
          problems.push({
            path: `${base}.discovery_confidence`,
            problem: "discovered declarations require confidence in [0,1]",
          });
        }
      }
    });

    const seenPatterns = new Set<string>();
    for (const [i, declaration] of schema.value_types.entries()) {
      const pattern = declaration?.path_pattern;
      if (typeof pattern === "string") {
        if (seenPatterns.has(pattern)) {
          problems.push({
            path: `value_types[${i}].path_pattern`,
            problem: `duplicate path pattern "${pattern}"`,
          });
        }
        seenPatterns.add(pattern);
      }
    }
  }

  const identity = schema.identity;
  if (!identity || typeof identity !== "object") {
    problems.push({ path: "identity", problem: "must be an object" });
  } else {
    if (!["stable", "session", "derived"].includes(identity.id_scheme)) {
      problems.push({ path: "identity.id_scheme", problem: "must be stable|session|derived" });
    }
    if (!Array.isArray(identity.survives)) {
      problems.push({ path: "identity.survives", problem: "must be an array" });
    } else {
      const valid: SurvivalClass[] = ["fork", "reset", "restart", "realm_change", "schema_major"];
      for (const entry of identity.survives) {
        if (!valid.includes(entry)) {
          problems.push({ path: "identity.survives", problem: `unknown survival class "${String(entry)}"` });
        }
      }
    }
    if (identity.id_scheme !== "stable" && !identity.reidentification_rule) {
      problems.push({
        path: "identity.reidentification_rule",
        problem: "session/derived schemes must declare how to reidentify entities",
      });
    }
  }

  const observability = schema.observability;
  if (!observability || typeof observability !== "object") {
    problems.push({ path: "observability", problem: "must be an object" });
  } else {
    if (typeof observability.fully_observable !== "boolean") {
      problems.push({ path: "observability.fully_observable", problem: "must be boolean" });
    }
    if (!Array.isArray(observability.hidden_state)) {
      problems.push({ path: "observability.hidden_state", problem: "must be an array" });
    }
    if (
      observability.fully_observable &&
      (observability.hidden_state?.length ?? 0) > 0
    ) {
      problems.push({
        path: "observability",
        problem: "fully_observable=true contradicts declared hidden state",
      });
    }
    if (!["full", "best_effort", "sampled", "event_driven"].includes(observability.policy)) {
      problems.push({ path: "observability.policy", problem: "unknown observability policy" });
    }
    if (observability.policy === "full" && !observability.fully_observable) {
      problems.push({
        path: "observability.policy",
        problem: 'policy "full" requires fully_observable=true',
      });
    }
  }

  if (schema.semantic_type_extension) {
    for (const [name, weight] of Object.entries(schema.semantic_type_extension)) {
      if (CORE_SEMANTIC_TYPE_WEIGHTS[name] !== undefined) {
        problems.push({
          path: `semantic_type_extension.${name}`,
          problem: "core semantic classes cannot be overridden or reordered",
        });
      }
      if (typeof weight !== "number" || weight < 0 || weight > 1) {
        problems.push({
          path: `semantic_type_extension.${name}`,
          problem: "extension weights must lie in [0,1]",
        });
      }
    }
  }

  if (schema.noise_fingerprints) {
    schema.noise_fingerprints.forEach((fingerprint, i) => {
      if (!fingerprint || typeof fingerprint.fingerprint_id !== "string" || fingerprint.fingerprint_id.length === 0) {
        problems.push({ path: `noise_fingerprints[${i}].fingerprint_id`, problem: "must be a non-empty string" });
      }
      if (typeof fingerprint.path_pattern !== "string" || fingerprint.path_pattern.length === 0) {
        problems.push({ path: `noise_fingerprints[${i}].path_pattern`, problem: "must be a non-empty string" });
      }
    });
  }

  return problems;
}

/** Blind spots a contract inherits from compiling against this schema. */
export function blindSpotsOf(schema: WorldStateSchema): string[] {
  return [...(schema.observability?.hidden_state ?? [])];
}
