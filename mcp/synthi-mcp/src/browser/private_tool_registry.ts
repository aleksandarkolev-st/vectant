import type { PrivateWorkflowToolManifestV7 } from "./private_tool_manifest.js";

export interface PrivateWorkflowToolRegistration {
  workflow_id: string;
  tool_name: string;
  manifest: PrivateWorkflowToolManifestV7;
  registered_at: number;
}

export interface PrivateWorkflowMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PRIVATE_TOOL_PREFIX = "synthi_app_";

export class PrivateWorkflowToolRegistry {
  private readonly registrations = new Map<string, PrivateWorkflowToolRegistration>();

  publish(
    manifest: PrivateWorkflowToolManifestV7,
    options: { reservedToolNames?: Iterable<string>; now?: number } = {}
  ): { ok: true; registration: PrivateWorkflowToolRegistration } | { ok: false; error: string; tool_name: string } {
    const toolName = manifest.tool_name;
    if (!toolName.startsWith(PRIVATE_TOOL_PREFIX)) {
      return { ok: false, error: "private_tool_name_must_use_synthi_app_prefix", tool_name: toolName };
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
      registered_at: options.now ?? Date.now(),
    };
    this.registrations.set(toolName, registration);
    return { ok: true, registration: cloneRegistration(registration) };
  }

  get(toolName: string): PrivateWorkflowToolRegistration | null {
    const registration = this.registrations.get(toolName);
    return registration ? cloneRegistration(registration) : null;
  }

  list(): PrivateWorkflowToolRegistration[] {
    return [...this.registrations.values()]
      .sort((a, b) => a.tool_name.localeCompare(b.tool_name))
      .map(cloneRegistration);
  }

  resetForTests(): void {
    this.registrations.clear();
  }
}

export const privateWorkflowToolRegistry = new PrivateWorkflowToolRegistry();

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
  };
}
