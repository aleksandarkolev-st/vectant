/**
 * @fileoverview The three vectant.programs.json MCP tools, as dependency-light
 * descriptors ({ name, description, inputSchema, handler }). Kept free of the MCP
 * SDK so the handlers are unit-testable directly; server.js binds them to the
 * low-level SDK ListTools/CallTool handlers. Each handler returns
 * { structuredContent, text } — text is the human-readable body, structuredContent
 * the machine payload. Collaborators are injectable via the second `deps` arg.
 */

import { manifestReference, referenceMarkdown } from './manifestSpec.js';
import { validateManifest } from './validate.js';
import { generateManifest as defaultGenerate } from './generateClient.js';

export const PROGRAMS_TOOLS = [
  {
    name: 'describe_manifest_schema',
    description:
      'Return the vectant.programs.json schema: fields, runtime types, permission scopes, host-escape rules, and worked examples. Call this before authoring a manifest.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ structuredContent: manifestReference(), text: referenceMarkdown() }),
  },
  {
    name: 'validate_manifest',
    description:
      'Validate a vectant.programs.json draft (object or JSON string). Advisory — returns { valid, errors[] } collecting every problem in one pass. The authoritative, fail-closed check runs server-side at publish time.',
    inputSchema: {
      type: 'object',
      properties: { manifest: { description: 'The manifest as an object or a JSON string.' } },
      required: ['manifest'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = validateManifest(args?.manifest);
      const text = result.valid
        ? 'valid: no problems found.'
        : `invalid: ${result.errors.length} problem(s)\n${result.errors
            .map((e) => `- [${e.code}]${e.field ? ` ${e.field}:` : ''} ${e.message}`)
            .join('\n')}`;
      return { structuredContent: result, text };
    },
  },
  {
    name: 'generate_manifest',
    description:
      'Generate a vectant.programs.json from workspace files by delegating to the configured Vectant backend. Requires VECTANT_MANIFEST_GENERATE_URL; otherwise returns not_configured and you should author from describe_manifest_schema. Always validate_manifest the result before saving.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'object',
          description: 'Map of { path: contents } describing the workspace (package.json, Dockerfile, requirements.txt, README, …).',
        },
        workspaceName: { type: 'string', description: 'Optional workspace name for context.' },
      },
      required: ['files'],
      additionalProperties: false,
    },
    handler: async (args, deps = {}) => {
      const generate = deps.generate || defaultGenerate;
      const result = await generate({ files: args?.files, workspaceName: args?.workspaceName });
      const text = result.manifest
        ? 'generated a manifest — validate it with validate_manifest before saving.'
        : `not generated: ${result.error || 'unknown'}${result.message ? ` — ${result.message}` : ''}`;
      return { structuredContent: result, text };
    },
  },
];
