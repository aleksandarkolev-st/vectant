# Agent Dojo Release-Gate Overlay

This overlay is intentionally opt-in. It prepares a release-candidate render for
Agent Dojo enterprise gates without changing the default beta deployment under
`k8s/`.

It does three things:

- removes the in-cluster Postgres and Redis resources from the rendered output
- removes the beta in-cluster Redis URL from the rendered `synthi-config`
- routes `collab-server` and `signaling-server` Redis through the
  externally-synced `synthi-dojo-release-secrets/REDIS_URL` value
- adds fail-closed Dojo production posture values to `synthi-config`
- syncs Dojo release-only Secret Manager values into a dedicated
  `synthi-dojo-release-secrets` Kubernetes Secret through External Secrets
  Operator

Render locally before any deploy:

```powershell
kubectl kustomize k8s/overlays/dojo-release-gate --load-restrictor LoadRestrictionsNone > tmp/dojo-release-gate-render.yaml
```

Validate the rendered contract against the target release host rather than a
hardcoded domain:

```powershell
node mcp/synthi-mcp/scripts/dojo-kustomize-overlay-check.mjs `
  --expected-dojo-mcp-host=$env:DOMAIN `
  --expected-dojo-mcp-path=/dojo/mcp `
  --expected-dojo-mcp-bearer-header=X-Synthi-Dojo-Mcp-Token
```

The load-restrictor flag is required because the current repository keeps the
base manifests directly under `k8s/` rather than under a nested `k8s/base/`
directory. Do not use this overlay from automation unless that flag is part of
the render command or the Kubernetes tree has been moved to a conventional
base/overlay layout.

Do not apply this overlay until the Google Cloud inventory preflight passes for
Cloud SQL, Memorystore, Cloud KMS or the managed signing service, Secret Manager,
External Secrets Operator, and the deployed MCP host release candidate.

Required Secret Manager names added by this overlay:

```text
synthi-redis-url
synthi-dojo-release-agent-id
synthi-dojo-release-workspace-id
synthi-auth-checkpoint-scope
synthi-auth-checkpoint-store-file
synthi-dojo-control-plane-postgres-url
synthi-dojo-evidence-ledger-postgres-url
synthi-dojo-proof-signing-key-id
synthi-dojo-proof-signing-command
synthi-dojo-proof-signing-command-args
synthi-dojo-proof-signing-managed-key-uri
synthi-dojo-proof-signing-public-key-pem
synthi-dojo-mcp-manifest-key-id
synthi-dojo-mcp-manifest-private-key-pem
synthi-dojo-mcp-manifest-public-key-pem
synthi-dojo-mcp-bearer-token
synthi-dojo-hosted-browser-cdp-url
synthi-dojo-hosted-browser-workspace-url
synthi-private-workflow-tool-scope
synthi-private-workflow-tool-store-file
```

The proof-signing private key env is deliberately not included. Production proof
signing must go through `managed-key-service` or an external signing command.
The MCP manifest signer still requires an Ed25519 private signing key in the
current runtime and should be replaced with a managed signer before claiming
full key-custody maturity.
