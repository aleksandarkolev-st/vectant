'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.SPAWNER_MODE = 'local';
process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_IMAGE = 'example.invalid/synthi-browser-workflow-bridge:test';

const { workflowBridgeContainers, workflowBridgeDojoEnv } = require('../workspacePodSpawner');

function envByName(env = []) {
  return new Map(env.map((entry) => [entry.name, entry]));
}

test('workflow bridge pod spec propagates Dojo production config through optional ConfigMap refs', () => {
  const refs = envByName(workflowBridgeDojoEnv());

  for (const name of [
    'SYNTHI_DOJO_PRODUCTION_ENFORCEMENT',
    'SYNTHI_DOJO_REQUIRE_DURABLE_STORE',
    'SYNTHI_DOJO_CONTROL_PLANE_STORE',
    'SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING',
    'SYNTHI_DOJO_PROOF_SIGNING_PROVIDER',
    'SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER',
    'SYNTHI_DOJO_EVIDENCE_LEDGER_STORE',
    'SYNTHI_DOJO_MCP_MANIFEST_ISSUER',
    'SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM',
    'SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST',
    'SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS',
    'SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS',
    'SYNTHI_TENANT_ID',
  ]) {
    const ref = refs.get(name);
    assert.ok(ref, `${name} is propagated`);
    assert.equal(ref.valueFrom.configMapKeyRef.name, 'synthi-config');
    assert.equal(ref.valueFrom.configMapKeyRef.key, name);
    assert.equal(ref.valueFrom.configMapKeyRef.optional, true);
  }
});

test('workflow bridge pod spec propagates Dojo release secrets without local proof private-key fallback', () => {
  const refs = envByName(workflowBridgeDojoEnv());

  for (const name of [
    'SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL',
    'SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL',
    'SYNTHI_DOJO_PROOF_SIGNING_KEY_ID',
    'SYNTHI_DOJO_PROOF_SIGNING_COMMAND',
    'SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS',
    'SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI',
    'SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM',
    'SYNTHI_DOJO_MCP_MANIFEST_KEY_ID',
    'SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM',
    'SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM',
    'SYNTHI_DOJO_MCP_BEARER_TOKEN',
  ]) {
    const ref = refs.get(name);
    assert.ok(ref, `${name} is propagated`);
    assert.equal(ref.valueFrom.secretKeyRef.name, 'synthi-secrets');
    assert.equal(ref.valueFrom.secretKeyRef.key, name);
    assert.equal(ref.valueFrom.secretKeyRef.optional, true);
  }

  assert.equal(refs.has('SYNTHI_DOJO_PROOF_SIGNING_KEY'), false);
  assert.equal(refs.has('SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM'), false);
});

test('workflow bridge container includes Dojo env refs and runtime actor scope', () => {
  const [bridge] = workflowBridgeContainers('ws-runtime:user-42', {
    workspaceSlug: 'alpha',
    filesystemUserId: 'user-42',
  });

  assert.ok(bridge, 'workflow bridge sidecar exists when image is configured');
  const env = envByName(bridge.env);

  assert.equal(env.get('SYNTHI_ACTOR_ID').value, 'user-42');
  assert.equal(env.get('SYNTHI_WORKSPACE_ID').value, 'alpha');
  assert.equal(env.get('SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY').value, 'same-pod');
  assert.equal(env.get('SYNTHI_DOJO_PRODUCTION_ENFORCEMENT').valueFrom.configMapKeyRef.optional, true);
  assert.equal(env.get('SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL').valueFrom.secretKeyRef.optional, true);
  assert.equal(env.get('SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM').valueFrom.secretKeyRef.optional, true);
});

test('workspace service exposes workflow bridge and hosted browser CDP only when sidecar image is configured', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'workspacePodSpawner.js'), 'utf8');

  assert.match(source, /\{ name: 'workflow', port: WORKFLOW_BRIDGE_PORT, targetPort: WORKFLOW_BRIDGE_PORT \}/);
  assert.match(source, /\{ name: 'cdp', port: HOSTED_BROWSER_CDP_PORT, targetPort: HOSTED_BROWSER_CDP_PORT \}/);
});
