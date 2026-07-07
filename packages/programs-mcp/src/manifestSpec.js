/**
 * @fileoverview Single source of truth for the vectant.programs.json reference
 * this MCP hands to an authoring agent. The constants mirror the backend parser
 * (synthi/src/lib/programs/manifest.js) — keep them in sync. Everything here is
 * pure data (no deps) so it can be unit-tested and reused by the describe tool.
 */

/** Permission scopes a program may declare. `program.launch` is always implied. */
export const KNOWN_SCOPES = [
  'program.launch',
  'workspace.files.read',
  'workspace.files.write',
  'network.outbound',
  'ports.expose',
];

/** Runtime types the program runtime can manage. */
export const SUPPORTED_RUNTIME_TYPES = ['web', 'cli', 'tui', 'background', 'gui', 'container'];

/** Sub-tabs a program session can surface. */
export const ALLOWED_SURFACES = ['app', 'logs', 'terminal', 'ports', 'health', 'settings'];

/** packageId charset: lowercase, starts alnum, 1–64 chars, no `..`. */
export const PACKAGE_ID_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';

/**
 * Scopes the review pipeline treats as sensitive — declaring any of these routes
 * a submission away from AI auto-approve into the manual queue. Surfaced so an
 * authoring agent knows to request them only when genuinely needed.
 */
export const SENSITIVE_SCOPES = ['network.outbound', 'workspace.files.write', 'ports.expose'];

/** Structured, per-field spec. `required` marks the minimal valid manifest. */
export const FIELDS = [
  { name: 'packageId', type: 'string', required: true, notes: `Unique id, ${PACKAGE_ID_PATTERN}. No path traversal.` },
  { name: 'version', type: 'string', required: true, notes: 'Non-empty version, e.g. "1.0.0".' },
  { name: 'launch', type: 'string', required: true, notes: 'The command that starts the program. For container/gui it must reference the source image.' },
  { name: 'runtimeType', type: 'enum', required: false, enum: SUPPORTED_RUNTIME_TYPES, notes: 'Defaults to "cli". web/cli/tui/background run inline; gui/container ship an image and are re-hosted on approval.' },
  { name: 'displayName', type: 'string', required: false, notes: 'Human label; defaults to packageId.' },
  { name: 'description', type: 'string', required: false, notes: 'Short summary shown in the store.' },
  { name: 'workingDir', type: 'string', required: false, notes: 'Relative to the workspace root; "" means root. Absolute paths and ".." are rejected.' },
  { name: 'install', type: 'string | string[]', required: false, notes: 'Setup commands run before first launch.' },
  { name: 'env', type: 'object<string,string>', required: false, notes: 'Environment variables (values coerced to strings).' },
  { name: 'ports', type: 'number[]', required: false, notes: 'Ports the program exposes (1–65535).' },
  { name: 'permissions', type: 'enum[]', required: false, enum: KNOWN_SCOPES, notes: `Requested scopes. "program.launch" is always implied. Sensitive: ${SENSITIVE_SCOPES.join(', ')}.` },
  { name: 'surfaces', type: 'enum[]', required: false, enum: ALLOWED_SURFACES, notes: 'Sub-tabs to show; derived from runtimeType/ports when omitted.' },
  { name: 'health', type: 'object', required: false, notes: 'Optional { type, target, intervalMs } health probe.' },
  { name: 'webGui', type: 'boolean', required: false, notes: 'container-only: the published web port is a KasmVNC client rendered as an interactive full-panel GUI.' },
];

/** Host-escape rules the review gate hard-rejects — never emit these in a command. */
export const HOST_ESCAPE_RULES = [
  'No docker.sock / /var/run/docker mounts.',
  'No host bind mounts (an absolute -v/--volume source). The workspace mount -v "$PWD":/workspace is fine.',
  'No --privileged, --cap-add, --security-opt, or --device flags.',
];

/** A minimal valid web manifest. */
export const EXAMPLE_WEB = {
  packageId: 'my-web-app',
  version: '1.0.0',
  displayName: 'My Web App',
  runtimeType: 'web',
  install: ['npm ci'],
  launch: 'npm run dev',
  ports: [3000],
  permissions: ['program.launch', 'network.outbound'],
};

/** A valid container manifest whose launch references the source image. */
export const EXAMPLE_CONTAINER = {
  packageId: 'my-tool',
  version: '1.0.0',
  displayName: 'My Tool',
  runtimeType: 'container',
  install: ['docker pull registry.example.com/me/my-tool:1.0.0'],
  launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace registry.example.com/me/my-tool:1.0.0',
  ports: [6901],
  permissions: ['program.launch'],
};

/** A rendered markdown reference — what the describe tool returns as its text body. */
export function referenceMarkdown() {
  const fieldRows = FIELDS.map(
    (f) => `| \`${f.name}\` | ${f.type} | ${f.required ? 'yes' : 'no'} | ${f.notes} |`,
  ).join('\n');
  return `# vectant.programs.json

A recipe that makes a program installable and runnable inside a Vectant workspace.
Place it at the workspace root (or a subdirectory). Only the fields below are read.

## Fields

| field | type | required | notes |
|-------|------|----------|-------|
${fieldRows}

## Runtime types
${SUPPORTED_RUNTIME_TYPES.map((r) => `- \`${r}\``).join('\n')}

## Permission scopes (least privilege — request only what you use)
${KNOWN_SCOPES.map((s) => `- \`${s}\`${SENSITIVE_SCOPES.includes(s) ? ' (sensitive — routes to manual review)' : ''}`).join('\n')}

## Host-escape rules (hard-rejected by review)
${HOST_ESCAPE_RULES.map((r) => `- ${r}`).join('\n')}

## Example — web
\`\`\`json
${JSON.stringify(EXAMPLE_WEB, null, 2)}
\`\`\`

## Example — container
\`\`\`json
${JSON.stringify(EXAMPLE_CONTAINER, null, 2)}
\`\`\`
`;
}

/** The structured payload for the describe tool (schema + rules + examples). */
export function manifestReference() {
  return {
    fields: FIELDS,
    runtimeTypes: SUPPORTED_RUNTIME_TYPES,
    scopes: KNOWN_SCOPES,
    sensitiveScopes: SENSITIVE_SCOPES,
    surfaces: ALLOWED_SURFACES,
    packageIdPattern: PACKAGE_ID_PATTERN,
    hostEscapeRules: HOST_ESCAPE_RULES,
    examples: { web: EXAMPLE_WEB, container: EXAMPLE_CONTAINER },
  };
}
