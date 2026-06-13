export const DOJO_PRODUCTION_ENFORCEMENT_ENV = "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT";
export const DOJO_REQUIRE_DURABLE_STORE_ENV = "SYNTHI_DOJO_REQUIRE_DURABLE_STORE";
export const DOJO_REQUIRE_EXTERNAL_SIGNING_ENV = "SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING";
export const DOJO_REQUIRE_EVIDENCE_LEDGER_ENV = "SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER";
export const DOJO_CONTROL_PLANE_STORE_ENV = "SYNTHI_DOJO_CONTROL_PLANE_STORE";
export const DOJO_CONTROL_PLANE_POSTGRES_URL_ENV = "SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL";
export const DOJO_STORE_FILE_ENV = "SYNTHI_DOJO_STORE_FILE";
export const DOJO_STORE_KEY_ENV = "SYNTHI_DOJO_STORE_KEY";
export const DOJO_STORE_SCOPE_ENV = "SYNTHI_DOJO_STORE_SCOPE";
export const DOJO_PROOF_SIGNING_KEY_ENV = "SYNTHI_DOJO_PROOF_SIGNING_KEY";
export const DOJO_PROOF_SIGNING_PROVIDER_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PROVIDER";
export const DOJO_PROOF_SIGNING_KEY_ID_ENV = "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID";
export const DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM";
export const DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM";
export const DOJO_PROOF_SIGNING_COMMAND_ENV = "SYNTHI_DOJO_PROOF_SIGNING_COMMAND";
export const DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV = "SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS";
export const DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV = "SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI";
export const DOJO_EVIDENCE_LEDGER_STORE_ENV = "SYNTHI_DOJO_EVIDENCE_LEDGER_STORE";
export const DOJO_EVIDENCE_LEDGER_POSTGRES_URL_ENV = "SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL";
export const DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY = "synthi-dojo-local-development-signing-key";

export type DojoEnforcementMode = "development" | "production";

export interface DojoInvalidEnforcementEnv {
  name: string;
  value: string;
  accepted_values: string[];
}

export interface DojoEnforcementConfig {
  schema_version: "synthi.dojo.enforcementConfig.v1";
  enforcement_mode: DojoEnforcementMode;
  production_enforcement: boolean;
  require_durable_store: boolean;
  require_external_signing: boolean;
  require_evidence_ledger: boolean;
  configured_env: string[];
  invalid_env: DojoInvalidEnforcementEnv[];
}

export type DojoEvidenceLedgerStoreKind = "unconfigured" | "inline" | "postgres" | "external";

export type DojoControlPlaneStoreKind = "unconfigured" | "memory" | "encrypted_file" | "postgres" | "external";

export interface DojoControlPlaneStoreConfig {
  schema_version: "synthi.dojo.controlPlaneStoreConfig.v1";
  store_kind: DojoControlPlaneStoreKind;
  configured: boolean;
  durable: boolean;
  production_capable: boolean;
  configured_env: string[];
  blocked_by: string[];
}

export interface DojoEvidenceLedgerStoreConfig {
  schema_version: "synthi.dojo.evidenceLedgerStoreConfig.v1";
  store_kind: DojoEvidenceLedgerStoreKind;
  configured: boolean;
  production_capable: boolean;
  inline_records_allowed: boolean;
  configured_env: string[];
  blocked_by: string[];
}

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];
const ACCEPTED_BOOLEAN_VALUES = [...TRUE_VALUES, ...FALSE_VALUES];

export function resolveDojoEnforcementConfig(env: NodeJS.ProcessEnv = process.env): DojoEnforcementConfig {
  const production = readBooleanFlag(env, DOJO_PRODUCTION_ENFORCEMENT_ENV);
  const durableStore = readBooleanFlag(env, DOJO_REQUIRE_DURABLE_STORE_ENV);
  const externalSigning = readBooleanFlag(env, DOJO_REQUIRE_EXTERNAL_SIGNING_ENV);
  const evidenceLedger = readBooleanFlag(env, DOJO_REQUIRE_EVIDENCE_LEDGER_ENV);
  const flags = [production, durableStore, externalSigning, evidenceLedger];
  return {
    schema_version: "synthi.dojo.enforcementConfig.v1",
    enforcement_mode: production.value === true ? "production" : "development",
    production_enforcement: production.value === true,
    require_durable_store: durableStore.value === true,
    require_external_signing: externalSigning.value === true,
    require_evidence_ledger: evidenceLedger.value === true,
    configured_env: flags.filter((flag) => flag.configured).map((flag) => flag.name),
    invalid_env: flags.flatMap((flag) => flag.invalid ? [{
      name: flag.name,
      value: flag.raw,
      accepted_values: ACCEPTED_BOOLEAN_VALUES,
    }] : []),
  };
}

export function isDojoDefaultLocalProofSigningKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = nonEmpty(env[DOJO_PROOF_SIGNING_KEY_ENV]);
  return !key || key === DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY;
}

export function configuredDojoStoreEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return configuredDojoControlPlaneStoreEnv(env);
}

export function configuredDojoControlPlaneStoreEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    DOJO_CONTROL_PLANE_STORE_ENV,
    DOJO_CONTROL_PLANE_POSTGRES_URL_ENV,
    DOJO_STORE_FILE_ENV,
    DOJO_STORE_KEY_ENV,
    DOJO_STORE_SCOPE_ENV,
  ].filter((name) => nonEmpty(env[name]));
}

export function resolveDojoControlPlaneStoreConfig(env: NodeJS.ProcessEnv = process.env): DojoControlPlaneStoreConfig {
  const rawStore = nonEmpty(env[DOJO_CONTROL_PLANE_STORE_ENV]);
  const rawPostgresUrl = nonEmpty(env[DOJO_CONTROL_PLANE_POSTGRES_URL_ENV]);
  const legacyFile = nonEmpty(env[DOJO_STORE_FILE_ENV]);
  const legacyKey = nonEmpty(env[DOJO_STORE_KEY_ENV]);
  const legacyScope = nonEmpty(env[DOJO_STORE_SCOPE_ENV]);
  const legacyConfiguredCount = [legacyFile, legacyKey, legacyScope].filter(Boolean).length;
  const configuredEnv = configuredDojoControlPlaneStoreEnv(env);

  if (!rawStore) {
    if (rawPostgresUrl) {
      return controlPlaneStoreConfig("postgres", true, true, true, configuredEnv, []);
    }
    if (legacyConfiguredCount === 3) {
      return controlPlaneStoreConfig("encrypted_file", true, true, false, configuredEnv, [
        "control_plane_store_encrypted_file_not_production_capable",
      ]);
    }
    if (legacyConfiguredCount > 0) {
      return controlPlaneStoreConfig("encrypted_file", false, false, false, configuredEnv, [
        "control_plane_store_encrypted_file_incomplete",
      ]);
    }
    return controlPlaneStoreConfig("unconfigured", false, false, false, [], [
      "control_plane_store_unconfigured",
    ]);
  }

  const storeKind = classifyDojoControlPlaneStore(rawStore);
  if (storeKind === "postgres") {
    const postgresUrlConfigured = isPostgresUrl(rawStore) || Boolean(rawPostgresUrl);
    return controlPlaneStoreConfig("postgres", true, postgresUrlConfigured, postgresUrlConfigured, configuredEnv, [
      ...(!postgresUrlConfigured ? ["control_plane_postgres_url_missing"] : []),
    ]);
  }
  if (storeKind === "memory") {
    return controlPlaneStoreConfig("memory", true, false, false, configuredEnv, [
      "control_plane_store_memory_not_durable",
    ]);
  }
  if (storeKind === "encrypted_file") {
    const complete = legacyConfiguredCount === 3;
    return controlPlaneStoreConfig("encrypted_file", complete, complete, false, configuredEnv, [
      ...(complete
        ? ["control_plane_store_encrypted_file_not_production_capable"]
        : ["control_plane_store_encrypted_file_incomplete"]),
    ]);
  }
  return controlPlaneStoreConfig("external", true, true, false, configuredEnv, [
    "control_plane_store_external_provider_not_implemented",
  ]);
}

export function configuredDojoExternalSigningEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    DOJO_PROOF_SIGNING_PROVIDER_ENV,
    DOJO_PROOF_SIGNING_KEY_ID_ENV,
    DOJO_PROOF_SIGNING_KEY_ENV,
    DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
    DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
    DOJO_PROOF_SIGNING_COMMAND_ENV,
    DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV,
    DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV,
  ].filter((name) => nonEmpty(env[name]));
}

export function configuredDojoEvidenceLedgerEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [DOJO_EVIDENCE_LEDGER_STORE_ENV, DOJO_EVIDENCE_LEDGER_POSTGRES_URL_ENV].filter((name) => nonEmpty(env[name]));
}

export function resolveDojoEvidenceLedgerStoreConfig(env: NodeJS.ProcessEnv = process.env): DojoEvidenceLedgerStoreConfig {
  const rawStore = nonEmpty(env[DOJO_EVIDENCE_LEDGER_STORE_ENV]);
  const rawPostgresUrl = nonEmpty(env[DOJO_EVIDENCE_LEDGER_POSTGRES_URL_ENV]);
  if (!rawStore) {
    if (rawPostgresUrl) {
      return {
        schema_version: "synthi.dojo.evidenceLedgerStoreConfig.v1",
        store_kind: "postgres",
        configured: true,
        production_capable: true,
        inline_records_allowed: false,
        configured_env: configuredDojoEvidenceLedgerEnv(env),
        blocked_by: [],
      };
    }
    return {
      schema_version: "synthi.dojo.evidenceLedgerStoreConfig.v1",
      store_kind: "unconfigured",
      configured: false,
      production_capable: false,
      inline_records_allowed: true,
      configured_env: [],
      blocked_by: ["evidence_ledger_store_unconfigured"],
    };
  }
  const storeKind = classifyDojoEvidenceLedgerStore(rawStore);
  const inline = storeKind === "inline";
  const postgresUrlConfigured = storeKind === "postgres"
    && (isPostgresUrl(rawStore) || Boolean(rawPostgresUrl));
  const productionCapable = storeKind === "external" || (storeKind === "postgres" && postgresUrlConfigured);
  const blockedBy = [
    ...(inline ? ["evidence_ledger_store_inline_not_production_capable"] : []),
    ...(storeKind === "postgres" && !postgresUrlConfigured ? ["evidence_ledger_postgres_url_missing"] : []),
  ];
  return {
    schema_version: "synthi.dojo.evidenceLedgerStoreConfig.v1",
    store_kind: storeKind,
    configured: true,
    production_capable: productionCapable,
    inline_records_allowed: inline,
    configured_env: configuredDojoEvidenceLedgerEnv(env),
    blocked_by: blockedBy,
  };
}

function readBooleanFlag(
  env: NodeJS.ProcessEnv,
  name: string
): { name: string; raw: string; value: boolean | undefined; configured: boolean; invalid: boolean } {
  const raw = nonEmpty(env[name]);
  if (!raw) return { name, raw: "", value: undefined, configured: false, invalid: false };
  const normalized = raw.toLowerCase();
  if (TRUE_VALUES.includes(normalized)) return { name, raw, value: true, configured: true, invalid: false };
  if (FALSE_VALUES.includes(normalized)) return { name, raw, value: false, configured: true, invalid: false };
  return { name, raw, value: undefined, configured: true, invalid: true };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function classifyDojoEvidenceLedgerStore(value: string): DojoEvidenceLedgerStoreKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === "inline" || normalized === "memory" || normalized === "in-memory") return "inline";
  if (
    normalized === "postgres"
    || normalized === "postgresql"
    || isPostgresUrl(normalized)
  ) {
    return "postgres";
  }
  return "external";
}

function classifyDojoControlPlaneStore(value: string): DojoControlPlaneStoreKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === "memory" || normalized === "inline" || normalized === "in-memory") return "memory";
  if (normalized === "encrypted-file" || normalized === "encrypted_file" || normalized === "file") {
    return "encrypted_file";
  }
  if (
    normalized === "postgres"
    || normalized === "postgresql"
    || isPostgresUrl(normalized)
  ) {
    return "postgres";
  }
  return "external";
}

function controlPlaneStoreConfig(
  storeKind: DojoControlPlaneStoreKind,
  configured: boolean,
  durable: boolean,
  productionCapable: boolean,
  configuredEnv: string[],
  blockedBy: string[]
): DojoControlPlaneStoreConfig {
  return {
    schema_version: "synthi.dojo.controlPlaneStoreConfig.v1",
    store_kind: storeKind,
    configured,
    durable,
    production_capable: productionCapable,
    configured_env: configuredEnv,
    blocked_by: blockedBy,
  };
}

function isPostgresUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://");
}
