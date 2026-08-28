import { describe, expect, it } from 'vitest';
import * as mcpSpec from '../manifestSpec.js';
import * as mcpEscape from '../hostEscape.js';
// The backend is the source of truth. This package copies a few constants/rules
// (it ships independently of the Next app and can't import them). These tests fail
// if the copies drift — update packages/programs-mcp to match the backend.
import {
  KNOWN_SCOPES, SUPPORTED_RUNTIME_TYPES, ALLOWED_SURFACES,
} from '../../../../synthi/src/lib/programs/manifest.js';
import {
  HOST_ESCAPE_FLAG_RE, DOCKER_SOCK_RE, HOST_BIND_MOUNT_RE,
} from '../../../../synthi/src/lib/programs/hostEscape.js';

const reEqual = (a, b) => a.source === b.source && a.flags === b.flags;

describe('drift guard: MCP copies match the backend source of truth', () => {
  it('permission scopes match manifest.js', () => {
    expect(mcpSpec.KNOWN_SCOPES).toEqual(KNOWN_SCOPES);
  });

  it('runtime types match manifest.js', () => {
    expect(mcpSpec.SUPPORTED_RUNTIME_TYPES).toEqual(SUPPORTED_RUNTIME_TYPES);
  });

  it('surfaces match manifest.js', () => {
    expect(mcpSpec.ALLOWED_SURFACES).toEqual(ALLOWED_SURFACES);
  });

  it('host-escape regexes match hostEscape.js (source + flags)', () => {
    expect(reEqual(mcpEscape.HOST_ESCAPE_FLAG_RE, HOST_ESCAPE_FLAG_RE)).toBe(true);
    expect(reEqual(mcpEscape.DOCKER_SOCK_RE, DOCKER_SOCK_RE)).toBe(true);
    expect(reEqual(mcpEscape.HOST_BIND_MOUNT_RE, HOST_BIND_MOUNT_RE)).toBe(true);
  });
});
