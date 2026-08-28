/**
 * Provider-neutral identity claim carried by a warrant.  The warrant core
 * knows only these stable, tenant-scoped strings; protocol adapters are
 * responsible for authenticating them before a call reaches the core.
 */
export interface WarrantPrincipal {
  issuer: string;
  subject: string;
  workspace: string;
  project?: string;
}

const MAX_PRINCIPAL_FIELD_LENGTH = 512;

export function normalizeWarrantPrincipal(value: unknown): WarrantPrincipal {
  if (!isRecord(value)) throw new Error("A warrant audience must be an object.");
  const issuer = requiredPrincipalField(value, "issuer");
  const subject = requiredPrincipalField(value, "subject");
  const workspace = requiredPrincipalField(value, "workspace");
  const projectRaw = value["project"];
  const project = projectRaw === undefined ? undefined : requiredPrincipalField(value, "project");
  return {
    issuer,
    subject,
    workspace,
    ...(project === undefined ? {} : { project }),
  };
}

/** Exact claim comparison; no provider, runtime, or agent-name assumptions. */
export function sameWarrantPrincipal(left: WarrantPrincipal, right: WarrantPrincipal): boolean {
  return left.issuer === right.issuer
    && left.subject === right.subject
    && left.workspace === right.workspace
    && left.project === right.project;
}

export function cloneWarrantPrincipal(value: WarrantPrincipal): WarrantPrincipal {
  return {
    issuer: value.issuer,
    subject: value.subject,
    workspace: value.workspace,
    ...(value.project === undefined ? {} : { project: value.project }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredPrincipalField(value: Record<string, unknown>, field: string): string {
  const raw = value[field];
  if (typeof raw !== "string") throw new Error(`A warrant audience needs a string '${field}'.`);
  const normalized = raw.trim();
  if (!normalized || normalized.length > MAX_PRINCIPAL_FIELD_LENGTH || /[\r\n]/.test(normalized)) {
    throw new Error(`A warrant audience needs a valid '${field}'.`);
  }
  return normalized;
}
