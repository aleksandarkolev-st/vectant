import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWorkflowArtifact } from "./broker.js";
import type { PrivateWorkflowToolManifestV7 } from "./private_tool_manifest.js";

export interface PrivateWorkflowToolRegistration {
  workflow_id: string;
  tool_name: string;
  manifest: PrivateWorkflowToolManifestV7;
  workflow_artifact?: BrowserWorkflowArtifact;
  registered_at: number;
}

export interface PrivateWorkflowMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PRIVATE_TOOL_PREFIX = "synthi_app_";
const PRIVATE_TOOL_STORE_FILE_MODE = 0o600;

export interface PrivateWorkflowToolRegistryEvent {
  type: "list_changed";
  registration: PrivateWorkflowToolRegistration;
}

export type PrivateWorkflowToolRegistryListener = (event: PrivateWorkflowToolRegistryEvent) => void;

export interface PrivateWorkflowToolStore {
  save(registration: PrivateWorkflowToolRegistration): void;
  get(toolName: string): PrivateWorkflowToolRegistration | null;
  list(): PrivateWorkflowToolRegistration[];
  clear(): void;
}

export class InMemoryPrivateWorkflowToolStore implements PrivateWorkflowToolStore {
  private readonly registrations = new Map<string, PrivateWorkflowToolRegistration>();

  save(registration: PrivateWorkflowToolRegistration): void {
    this.registrations.set(registration.tool_name, cloneRegistration(registration));
  }

  get(toolName: string): PrivateWorkflowToolRegistration | null {
    const registration = this.registrations.get(toolName);
    return registration ? cloneRegistration(registration) : null;
  }

  list(): PrivateWorkflowToolRegistration[] {
    return [...this.registrations.values()].map(cloneRegistration);
  }

  clear(): void {
    this.registrations.clear();
  }
}

export interface EncryptedFilePrivateWorkflowToolStoreOptions {
  file_path: string;
  key: string;
  scope_id?: string;
}

interface PersistedPrivateWorkflowToolScope {
  registrations: Record<string, PrivateWorkflowToolRegistration>;
}

interface EncryptedPrivateWorkflowToolStoreDocument {
  schema_version: "synthi_private_workflow_tool_store_v1";
  scopes: Record<string, PersistedPrivateWorkflowToolScope>;
}

interface EncryptedPrivateWorkflowToolStoreEnvelope {
  schema_version: "synthi_private_workflow_tool_store_envelope_v1";
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedFilePrivateWorkflowToolStore implements PrivateWorkflowToolStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  private readonly scopeId: string;

  constructor(options: EncryptedFilePrivateWorkflowToolStoreOptions) {
    if (!options.file_path.trim()) throw new Error("private_workflow_tool_store_file_required");
    if (!options.key.trim()) throw new Error("private_workflow_tool_store_key_required");
    this.filePath = options.file_path;
    this.encryptionKey = createHash("sha256").update(options.key, "utf8").digest();
    this.scopeId = normalizePrivateToolScopeId(options.scope_id);
  }

  save(registration: PrivateWorkflowToolRegistration): void {
    this.updateScope((scope) => {
      scope.registrations[registration.tool_name] = cloneRegistration(registration);
    });
  }

  get(toolName: string): PrivateWorkflowToolRegistration | null {
    const registration = this.scope().registrations[toolName];
    return registration ? cloneRegistration(registration) : null;
  }

  list(): PrivateWorkflowToolRegistration[] {
    return Object.values(this.scope().registrations).map(cloneRegistration);
  }

  clear(): void {
    const document = this.readDocument();
    document.scopes[this.scopeId] = emptyPersistedPrivateToolScope();
    this.writeDocument(document);
  }

  private scope(): PersistedPrivateWorkflowToolScope {
    const document = this.readDocument();
    return clonePersistedPrivateToolScope(document.scopes[this.scopeId] ?? emptyPersistedPrivateToolScope());
  }

  private updateScope(mutator: (scope: PersistedPrivateWorkflowToolScope) => void): void {
    const document = this.readDocument();
    const scope = clonePersistedPrivateToolScope(document.scopes[this.scopeId] ?? emptyPersistedPrivateToolScope());
    mutator(scope);
    document.scopes[this.scopeId] = scope;
    this.writeDocument(document);
  }

  private readDocument(): EncryptedPrivateWorkflowToolStoreDocument {
    if (!existsSync(this.filePath)) return emptyPrivateToolStoreDocument();
    let envelope: EncryptedPrivateWorkflowToolStoreEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as EncryptedPrivateWorkflowToolStoreEnvelope;
      if (
        envelope.schema_version !== "synthi_private_workflow_tool_store_envelope_v1" ||
        envelope.algorithm !== "aes-256-gcm" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("invalid_private_workflow_tool_store_envelope");
      }
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_private_workflow_tool_store_envelope") throw err;
      throw new Error("private_workflow_tool_store_parse_failed");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const document = JSON.parse(plaintext) as EncryptedPrivateWorkflowToolStoreDocument;
      if (document.schema_version !== "synthi_private_workflow_tool_store_v1" || typeof document.scopes !== "object") {
        throw new Error("invalid_private_workflow_tool_store_document");
      }
      return normalizePrivateToolDocument(document);
    } catch {
      throw new Error("private_workflow_tool_store_decrypt_failed");
    }
  }

  private writeDocument(document: EncryptedPrivateWorkflowToolStoreDocument): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(normalizePrivateToolDocument(document)), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedPrivateWorkflowToolStoreEnvelope = {
      schema_version: "synthi_private_workflow_tool_store_envelope_v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const tempPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(tempPath, JSON.stringify(envelope), { encoding: "utf8", mode: PRIVATE_TOOL_STORE_FILE_MODE });
      renameSync(tempPath, this.filePath);
      chmodSync(this.filePath, PRIVATE_TOOL_STORE_FILE_MODE);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }
}

export class PrivateWorkflowToolRegistry {
  private readonly listeners = new Set<PrivateWorkflowToolRegistryListener>();

  constructor(private store: PrivateWorkflowToolStore = new InMemoryPrivateWorkflowToolStore()) {}

  publish(
    manifest: PrivateWorkflowToolManifestV7,
    options: { reservedToolNames?: Iterable<string>; now?: number; workflowArtifact?: BrowserWorkflowArtifact } = {}
  ): { ok: true; registration: PrivateWorkflowToolRegistration } | { ok: false; error: string; tool_name: string } {
    const toolName = manifest.tool_name;
    if (!toolName.startsWith(PRIVATE_TOOL_PREFIX)) {
      return { ok: false, error: "private_tool_name_must_use_synthi_app_prefix", tool_name: toolName };
    }
    if (options.workflowArtifact && options.workflowArtifact.workflow_id !== manifest.workflow_id) {
      return { ok: false, error: "private_tool_workflow_artifact_mismatch", tool_name: toolName };
    }
    if (manifest.status === "blocked") {
      return { ok: false, error: "private_tool_manifest_blocked", tool_name: toolName };
    }
    const reserved = new Set(options.reservedToolNames ?? []);
    if (reserved.has(toolName)) {
      return { ok: false, error: "private_tool_name_reserved", tool_name: toolName };
    }
    const registration: PrivateWorkflowToolRegistration = {
      workflow_id: manifest.workflow_id,
      tool_name: toolName,
      manifest,
      ...(options.workflowArtifact ? { workflow_artifact: options.workflowArtifact } : {}),
      registered_at: options.now ?? Date.now(),
    };
    this.store.save(registration);
    this.emit({ type: "list_changed", registration });
    return { ok: true, registration: cloneRegistration(registration) };
  }

  get(toolName: string): PrivateWorkflowToolRegistration | null {
    return this.store.get(toolName);
  }

  list(): PrivateWorkflowToolRegistration[] {
    return this.store.list()
      .sort((a, b) => a.tool_name.localeCompare(b.tool_name))
      .map(cloneRegistration);
  }

  resetForTests(): void {
    this.store.clear();
    this.listeners.clear();
  }

  useStoreForTests(store: PrivateWorkflowToolStore): void {
    this.store = store;
  }

  onListChanged(listener: PrivateWorkflowToolRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PrivateWorkflowToolRegistryEvent): void {
    const snapshot = { ...event, registration: cloneRegistration(event.registration) };
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Tool publication should not fail because one observer is gone.
      }
    }
  }
}

export const privateWorkflowToolRegistry = new PrivateWorkflowToolRegistry(createDefaultPrivateWorkflowToolStore());

export function privateWorkflowToolDefinition(registration: PrivateWorkflowToolRegistration): PrivateWorkflowMcpToolDefinition {
  const manifest = registration.manifest;
  return {
    name: manifest.tool_name,
    description: [
      manifest.description,
      manifest.mutation.requires_confirmation
        ? "Defaults to prefix-only replay. Use ciOnly for a configured isolated mutation replay, or sameSession with confirm_mutation=true for an explicit human-approved live session."
        : "Runs the taught workflow through the Synthi-hosted browser runtime.",
    ].join(" "),
    inputSchema: privateWorkflowToolInputSchema(manifest),
  };
}

function privateWorkflowToolInputSchema(manifest: PrivateWorkflowToolManifestV7): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    run_mode: {
      type: "string",
      enum: manifest.mutation.requires_confirmation
        ? ["prefixOnly", "confirmBeforeCommit", "ciOnly", "sameSession", "coldSession"]
        : ["sameSession", "prefixOnly", "coldSession"],
      description: manifest.mutation.requires_confirmation
        ? "Defaults to prefixOnly for mutation workflows. ciOnly runs through the configured isolated replay profile. sameSession/confirmBeforeCommit require confirm_mutation=true."
        : "Optional replay mode. Defaults to sameSession for non-mutating workflows.",
    },
    confirm_mutation: {
      type: "boolean",
      description: "Required only when requesting sameSession replay for a workflow with mutation steps.",
    },
    mutation_confirmation: {
      type: "string",
      description:
        "Required with confirm_mutation=true for live mutation replay. Use the confirmation_token returned by mutation_confirmation_required.",
    },
    tab_id: {
      type: "string",
      description: "Optional authorized browser tab id. Defaults to the selected Synthi browser tab.",
    },
    workspace_id: {
      type: "string",
      description: "Optional workspace scope for ciOnly replay isolation profile lookup.",
    },
    lease_ms: {
      type: "number",
      description: "Optional browser control lease duration in milliseconds.",
    },
    timeout_ms: {
      type: "number",
      description: "Optional timeout for ciOnly reset and replay commands.",
    },
  };
  const required = new Set<string>();

  for (const parameter of manifest.parameters) {
    properties[parameter.name] = parameterSchema(parameter);
    if (parameter.required) required.add(parameter.name);
  }

  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function parameterSchema(parameter: PrivateWorkflowToolManifestV7["parameters"][number]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: "string",
    description: parameter.label,
  };
  if (parameter.redacted) base["format"] = "password";
  if (parameter.value_shape === "number") {
    base["pattern"] = "^-?\\d+(\\.\\d+)?$";
  }
  if (parameter.value_shape === "email") {
    base["format"] = "email";
  }
  if (parameter.value_shape === "filePath") {
    base["description"] = `${parameter.label} (workspace or runner-visible file path)`;
  }
  return base;
}

function cloneRegistration(registration: PrivateWorkflowToolRegistration): PrivateWorkflowToolRegistration {
  return {
    ...registration,
    manifest: JSON.parse(JSON.stringify(registration.manifest)) as PrivateWorkflowToolManifestV7,
    ...(registration.workflow_artifact
      ? { workflow_artifact: JSON.parse(JSON.stringify(registration.workflow_artifact)) as BrowserWorkflowArtifact }
      : {}),
  };
}

export function createDefaultPrivateWorkflowToolStore(env: NodeJS.ProcessEnv = process.env): PrivateWorkflowToolStore {
  const filePath = env["SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE"]?.trim();
  const key = env["SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY"]?.trim();
  if (!filePath && !key) return new InMemoryPrivateWorkflowToolStore();
  if (!filePath || !key) throw new Error("private_workflow_tool_store_file_and_key_required");
  return new EncryptedFilePrivateWorkflowToolStore({
    file_path: filePath,
    key,
    scope_id: env["SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE"],
  });
}

function emptyPrivateToolStoreDocument(): EncryptedPrivateWorkflowToolStoreDocument {
  return { schema_version: "synthi_private_workflow_tool_store_v1", scopes: {} };
}

function emptyPersistedPrivateToolScope(): PersistedPrivateWorkflowToolScope {
  return { registrations: {} };
}

function clonePersistedPrivateToolScope(scope: PersistedPrivateWorkflowToolScope): PersistedPrivateWorkflowToolScope {
  return {
    registrations: Object.fromEntries(
      Object.entries(scope.registrations ?? {}).map(([key, value]) => [key, cloneRegistration(value)])
    ),
  };
}

function normalizePrivateToolDocument(document: EncryptedPrivateWorkflowToolStoreDocument): EncryptedPrivateWorkflowToolStoreDocument {
  return {
    schema_version: "synthi_private_workflow_tool_store_v1",
    scopes: Object.fromEntries(Object.entries(document.scopes ?? {}).map(([scopeId, scope]) => [
      normalizePrivateToolScopeId(scopeId),
      clonePersistedPrivateToolScope(scope),
    ])),
  };
}

function normalizePrivateToolScopeId(scopeId: string | undefined): string {
  const trimmed = scopeId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}
