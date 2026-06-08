'use client';

export const SYNTHI_WORKFLOW_ROOT = '.synthi/workflows';
export const SYNTHI_AGENTS_SECTION_START = '<!-- SYNTHI_BROWSER_WORKFLOWS_START -->';
export const SYNTHI_AGENTS_SECTION_END = '<!-- SYNTHI_BROWSER_WORKFLOWS_END -->';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function safeWorkflowDirectoryName(input, fallback = 'workflow') {
  const raw = cleanText(input) || cleanText(fallback) || 'workflow';
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return normalized || 'workflow';
}

export function workflowParameterEnvName(input) {
  const normalized = cleanText(input)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'WORKFLOW_PARAMETER';
}

export function workflowHandoffEntry({ generated, manifest }) {
  const script = asObject(generated);
  const toolManifest = asObject(manifest);
  const workflowId = cleanText(script.workflow_id) || cleanText(toolManifest.workflow_id) || 'workflow';
  const title = cleanText(toolManifest.title) || cleanText(script.title) || cleanText(script.name) || workflowId;
  const directory = safeWorkflowDirectoryName(workflowId, title);
  const basePath = `${SYNTHI_WORKFLOW_ROOT}/${directory}`;

  return {
    workflow_id: workflowId,
    title,
    status: cleanText(toolManifest.status) || 'generated',
    generated_at: new Date().toISOString(),
    script_path: `${basePath}/workflow.spec.mjs`,
    manifest_path: `${basePath}/manifest.json`,
    readme_path: `${basePath}/README.md`,
    runner_dependency: '@playwright/test',
    base_url_env: 'PLAYWRIGHT_BASE_URL',
    default_run_mode: toolManifest.default_run_mode || null,
    parameters: Array.isArray(toolManifest.parameters)
      ? toolManifest.parameters.map((parameter) => ({
        ...asObject(parameter),
        env_name: workflowParameterEnvName(asObject(parameter).name),
      }))
      : [],
    mutation: asObject(toolManifest.mutation),
    source_identity: asObject(toolManifest.source_identity),
  };
}

export function mergeWorkflowIndex(existingRaw, entry) {
  let existing = {};
  try {
    const parsed = JSON.parse(cleanText(existingRaw) || '{}');
    existing = asObject(parsed);
  } catch {
    existing = {};
  }

  const workflows = Array.isArray(existing.workflows)
    ? existing.workflows.filter((item) => asObject(item).workflow_id !== entry.workflow_id)
    : [];

  return {
    kind: 'synthi_browser_workflow_index',
    schema_version: 1,
    updated_at: entry.generated_at,
    workflows: [entry, ...workflows],
  };
}

export function agentsManagedWorkflowSection() {
  return [
    SYNTHI_AGENTS_SECTION_START,
    '## Synthi Browser Workflows',
    '',
    'Synthi-generated browser workflows live under `.synthi/workflows/`.',
    'Before creating new browser automation, inspect `.synthi/workflows/index.json` and reuse an existing workflow when it matches the task.',
    'Each workflow entry points to a generated Playwright script and a private MCP tool manifest.',
    'Run scripts with a caller-provided `PLAYWRIGHT_BASE_URL`; do not hardcode workspace preview ports or local browser paths.',
    'For workflows with mutation boundaries, stop at the generated prefix unless an isolated CI profile or explicit confirmation is available.',
    SYNTHI_AGENTS_SECTION_END,
  ].join('\n');
}

export function upsertAgentsWorkflowSection(existingRaw) {
  const existing = cleanText(existingRaw);
  const section = agentsManagedWorkflowSection();
  const start = existing.indexOf(SYNTHI_AGENTS_SECTION_START);
  const end = existing.indexOf(SYNTHI_AGENTS_SECTION_END);

  if (start >= 0 && end > start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + SYNTHI_AGENTS_SECTION_END.length).trimStart();
    return [before, section, after].filter(Boolean).join('\n\n') + '\n';
  }

  const prefix = existing || '# Agent Instructions\n';
  return `${prefix.trimEnd()}\n\n${section}\n`;
}

export function workflowReadme(entry) {
  const params = Array.isArray(entry.parameters) && entry.parameters.length
    ? entry.parameters
      .map((param) => `- \`${param.env_name}\` (${param.name}): ${param.label || param.value_shape || 'workflow parameter'}`)
      .join('\n')
    : '- No workflow parameters.';
  return [
    `# ${entry.title}`,
    '',
    'This workflow was taught in Synthi and exported for agent reuse.',
    '',
    '## Files',
    '',
    `- Playwright script: \`${entry.script_path}\``,
    `- Private MCP manifest: \`${entry.manifest_path}\``,
    '',
    '## Run',
    '',
    'Set `PLAYWRIGHT_BASE_URL` to the app or forwarded preview URL before running the script.',
    '',
    '```bash',
    `PLAYWRIGHT_BASE_URL="$PLAYWRIGHT_BASE_URL" npx playwright test ${entry.script_path}`,
    '```',
    '',
    '## Parameters',
    '',
    params,
    '',
    '## Safety',
    '',
    entry.mutation?.requires_ci_isolation
      ? 'This workflow reaches a mutation boundary. Use prefix replay unless an isolated CI profile or explicit confirmation is available.'
      : 'No mutation isolation requirement was reported by the exported manifest.',
    '',
  ].join('\n');
}

export function buildAgentWorkflowHandoffFiles({ generated, manifest, existingIndexRaw = '', existingAgentsRaw = '' }) {
  const script = asObject(generated);
  if (!cleanText(script.code)) throw new Error('workflow_export_missing_playwright_code');

  const entry = workflowHandoffEntry({ generated: script, manifest });
  const index = mergeWorkflowIndex(existingIndexRaw, entry);
  const manifestBody = asObject(manifest);

  return {
    entry,
    files: [
      { path: entry.script_path, content: script.code.endsWith('\n') ? script.code : `${script.code}\n` },
      { path: entry.manifest_path, content: JSON.stringify(manifestBody, null, 2) + '\n' },
      { path: entry.readme_path, content: workflowReadme(entry) },
      { path: `${SYNTHI_WORKFLOW_ROOT}/index.json`, content: JSON.stringify(index, null, 2) + '\n' },
      { path: 'AGENTS.md', content: upsertAgentsWorkflowSection(existingAgentsRaw) },
    ],
  };
}
