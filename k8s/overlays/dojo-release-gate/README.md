# Agent Dojo Release-Gate Overlay

This overlay is intentionally opt-in. It prepares a release-candidate render for
Agent Dojo enterprise gates without changing the default beta deployment under
`k8s/`.

It does three things:

- removes the in-cluster Postgres and Redis resources from the rendered output
- adds fail-closed Dojo production posture values to `synthi-config`
- merges Dojo release-only Secret Manager values into the existing
  `synthi-secrets` Kubernetes Secret through External Secrets Operator

Render locally before any deploy:

```powershell
kubectl kustomize k8s/overlays/dojo-release-gate --load-restrictor LoadRestrictionsNone > tmp/dojo-release-gate-render.yaml
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
```

The proof-signing private key env is deliberately not included. Production proof
signing must go through `managed-key-service` or an external signing command.
The MCP manifest signer still requires an Ed25519 private signing key in the
current runtime and should be replaced with a managed signer before claiming
full key-custody maturity.
