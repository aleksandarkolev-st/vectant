# Synthi environment-variable inventory

**Audited:** 2026-08-29

**Scope:** CodeSite, CodeSite warrants, MCP warrants, Dojo, evidence and proof
signing, Fleet NOTAMs, browser/runtime bridges, service configuration, local
development, deployment manifests, and command-specific proof tooling.

This is an inventory of configuration names and their owners. It intentionally
contains no secret values. Values shown as `<placeholder>` are placeholders only.

## Executive summary

The repository does not have one universal environment file. Configuration is
loaded from several boundaries:

| Runtime | Configuration source | Important behavior |
| --- | --- | --- |
| Root Docker Compose interpolation | Root `.env` by Compose convention | Supplies `${NAME}` substitutions and host-port values. |
| Frontend and AI-engine containers | Explicit `.env.local` `env_file` entries in `docker-compose.yml` | Provider credentials must be in `.env.local`; a blank Compose interpolation can override an `env_file` value. |
| Next frontend run directly | `synthi/.env` or the normal Next environment loading path | The frontend reads `AUTH_SECRET`, OAuth, database, GCS, AI, CodeSite, and browser settings. |
| Collab server run directly | `backend/collab-server/.env` | The collab server has its own storage, Redis, runtime, GCS, and worker settings. |
| AI engine run directly | `ai-backend/ai-engine/.env` | `main.py` loads this file without overriding existing process variables. |
| MCP package | `--env-file`, then `SYNTHI_ENV_FILE`, then `mcp/synthi-mcp/.env` | Host environment values win over file values. |
| Kubernetes | ConfigMaps, Secrets, and ExternalSecrets | Non-sensitive settings belong in ConfigMaps; credentials and signing material belong in Secret Manager or Kubernetes Secrets. |
| Proof and release commands | Command environment plus CLI arguments | These variables are intentionally command-specific and should not be copied into the common application environment. |

The current ignored root `.env` contains 14 keys. The tracked root
`.env.example` contains 54 assignment names. The local root file has five keys
that the root example does not currently declare:

```text
GCP_PROJECT_ID
GCS_BUCKET_NAME
NEXT_PUBLIC_GATEWAY_WS_URL
NEXTAUTH_URL
SYNTHI_AI_MODEL
```

That comparison is name-only; no value from any ignored `.env` file was copied
into this document.

The most important operational finding is that CodeSite warrants and Dojo
production enforcement fail closed when their required policy, durable-store,
signing, ledger, or identity settings are absent. Local defaults that make a
process boot are not evidence that the production path is configured.

## Status legend

- **Required:** the named path rejects, refuses, or cannot perform the operation without the setting.
- **Conditional:** required only when the related mode, provider, deployment, or feature is enabled.
- **Defaulted:** the source has a documented fallback; set it explicitly when multiple services must agree.
- **Secret:** credential, signing key, bearer token, private key, or sensitive connection material.
- **Injected:** normally supplied by Compose, Kubernetes, ExternalSecrets, or a launcher rather than a developer `.env`.
- **Command-only:** consumed by a proof, test, release, or acceptance command and not required by the long-running service.
- **Inherited/tooling:** supplied by the operating system, container runtime, CI runner, or SDK installation.

## Immediate setup checklist

### Local Compose

1. Copy `.env.example` to `.env.local`. Do not commit `.env.local`.
2. Add the five names listed above if they are needed by the selected services.
3. Set a non-empty `COLLAB_INTERNAL_TOKEN`; Compose marks it as required.
4. Set both `AUTH_SECRET` and `NEXTAUTH_SECRET` to the same stable local value. The frontend's primary auth path uses `AUTH_SECRET`, while several adjacent paths accept either name.
5. Put the selected provider credentials in `.env.local`, especially `GEMINI_API_KEY` for the default Gemini/code-intel path. Do not put a blank provider interpolation in the Compose `environment:` block because it can override the `env_file` value.
6. Configure the CodeSite and Dojo sections below when those features are enabled. The local Compose file supplies development fallbacks for some values, but those fallbacks are not production-safe.
7. For a standalone service, also create the service-local file named in the loading table. A root `.env` alone is not guaranteed to reach the collab server, AI engine, or MCP package.

### Production or release-gate deployment

1. Use the Kubernetes ConfigMap and ExternalSecret wiring as the source of truth for deployment names.
2. Set `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1`, durable PostgreSQL stores, external proof signing, an evidence ledger, a signed MCP manifest, and `SYNTHI_DOJO_MCP_BEARER_TOKEN` for the Dojo release overlay.
3. Set every CodeSite warrant identity, capability, limit, retry, and managed audit-signing variable in the production application environment.
4. Supply an explicit trusted CodeSite proof authority. Do not use `AUTH_SECRET` as a substitute for the proof authority.
5. Run Prisma migrations before using Fleet NOTAM publication, warrant audit chains, CodeSite control-plane state, or Dojo stores.
6. Keep the therapeutic production endpoint flag at `0` until its complete external runtime, probe, store, tenant, actor, and upstream contract is provisioned.

## Canonical shared application settings

These names are consumed by more than one service. They are listed here once
and referenced by the feature sections.

| Name | Classification | Use |
| --- | --- | --- |
| `DATABASE_URL` | Required/Secret | Prisma application database and the default database connection. |
| `AUTH_SECRET` | Required/Secret | NextAuth and token-encryption paths. |
| `NEXTAUTH_SECRET` | Conditional/Secret | Compatibility alias used by adjacent auth, browser, and service paths. Set it with `AUTH_SECRET`. |
| `NEXTAUTH_URL` | Required in deployed auth paths | Canonical application origin used for callbacks and CodeSite URL fallback. |
| `GOOGLE_CLIENT_ID` | Conditional/Secret pair | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Conditional/Secret pair | Google OAuth client secret. |
| `GITHUB_ID` | Conditional/Secret pair | GitHub OAuth client ID and GitHub git-provider identity. |
| `GITHUB_SECRET` | Conditional/Secret pair | GitHub OAuth client secret and GitHub git-provider secret. |
| `GITLAB_CLIENT_ID` | Conditional/Secret pair | GitLab OAuth client ID. |
| `GITLAB_CLIENT_SECRET` | Conditional/Secret pair | GitLab OAuth client secret. |
| `GEMINI_API_KEY` | Conditional/Secret | Gemini API, frontend chat, theme generation, and the default AI-engine/code-intel path. |
| `GOOGLE_API_KEY` | Conditional/Secret alias | AI-engine and MCP provider alias accepted by source. |
| `OPENAI_API_KEY` | Conditional/Secret | OpenAI provider when selected. |
| `ANTHROPIC_API_KEY` | Conditional/Secret | Anthropic provider when selected. |
| `AI_BACKEND_AUTH_TOKEN` | Conditional/Secret | Frontend, collab, worker, gateway, and AI-engine service authentication. |
| `AI_ENGINE_AUTH_TOKEN` | Conditional/Secret alias | Legacy/compatibility fallback for `AI_BACKEND_AUTH_TOKEN`. |
| `COLLAB_INTERNAL_TOKEN` | Required for Compose collab boundaries/Secret | Internal frontend-to-collab and service-to-collab authentication. |
| `SYNTHI_COLLAB_INTERNAL_TOKEN` | Conditional/Secret alias | CodeSite compatibility alias for `COLLAB_INTERNAL_TOKEN`. |
| `COLLAB_SERVER_URL` | Required when services are separate | Canonical collab URL. CodeSite accepts several compatibility aliases. |
| `CODE_INTEL_URL` | Conditional | Code-intel service URL; several frontend paths fall back to `AI_ENGINE_URL`. |
| `AI_ENGINE_URL` | Conditional | AI-engine URL used as a code-intel fallback. |
| `REDIS_URL` | Conditional/Injected | Redis sessions, collab event state, signaling, and runtime coordination. |
| `GCP_PROJECT_ID` | Conditional | GCS project; frontend also falls back to `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT`. |
| `GOOGLE_CLOUD_PROJECT` | Conditional/Inherited | GCP project compatibility alias. |
| `GCLOUD_PROJECT` | Conditional/Inherited | GCP project compatibility alias. |
| `GCS_BUCKET_NAME` | Conditional/Secret-adjacent | Workspace, artifact, and Y-Sweet GCS bucket name. |
| `GCP_CLIENT_EMAIL` | Conditional/Secret | Explicit GCP service-account identity when ambient credentials are not used. |
| `GCP_PRIVATE_KEY` | Conditional/Secret | Explicit GCP service-account private key. |
| `GCP_CREDENTIALS` | Conditional/Secret | Alternate credential source accepted by the collab server. |
| `GCS_WORKSPACE_PREFIX` | Conditional | GCS workspace key prefix. |

## CodeSite configuration

The primary implementation is in
[`synthi/src/lib/codesite/runtimeConfig.js`](../synthi/src/lib/codesite/runtimeConfig.js),
[`controlPlane.js`](../synthi/src/lib/codesite/controlPlane.js),
[`proof.js`](../synthi/src/lib/codesite/proof.js), and the CodeSite route under
[`synthi/src/app/api/workspace/[slug]/codesite`](../synthi/src/app/api/workspace/%5Bslug%5D/codesite/%5B%5B...path%5D%5D/route.js).

### CodeSite identity, routing, and internal boundaries

| Name | Classification | Use and requirement |
| --- | --- | --- |
| `SYNTHI_CODESITE_TOKEN` | Secret/Required for protected CodeSite service calls | Bearer token used by CodeSite route helpers and Compose-injected service boundaries. Compose has a local fallback only. |
| `SYNTHI_CODESITE_API_BASE_URL` | Conditional | Explicit CodeSite API base URL. Preferred over compatibility aliases for deployed proofs and bridges. |
| `CODESITE_API_BASE_URL` | Conditional alias | Legacy explicit CodeSite API base URL. |
| `SYNTHI_CODESITE_BASE_URL` | Conditional | CodeSite origin fallback used by activity readiness and route helpers. |
| `SYNTHI_APP_INTERNAL_URL` | Conditional alias/fallback | Internal app origin used when an explicit CodeSite base is absent. |
| `SYNTHI_APP_URL` | Conditional alias/fallback | App origin fallback. |
| `SYNTHI_PUBLIC_APP_URL` | Conditional | Public app origin for deployed service callbacks and runtime links. |
| `NEXTAUTH_URL` | Required in deployed auth/URL fallback paths | Final URL fallback when no explicit CodeSite or app URL is supplied. |
| `COLLAB_SERVER_URL` | Required when collab is separate | Canonical CodeSite collaboration endpoint. |
| `SYNTHI_COLLAB_SERVER_URL` | Conditional alias | CodeSite compatibility alias. |
| `NEXT_PUBLIC_COLLAB_SERVER_URL` | Conditional alias | Frontend-public collab URL fallback. |
| `COLLAB_URL` | Conditional alias | Older collab URL fallback. |
| `COLLAB_INTERNAL_TOKEN` | Required for internal CodeSite/collab routes | Internal CodeSite-to-collab authentication. |
| `SYNTHI_COLLAB_INTERNAL_TOKEN` | Conditional alias/Secret | Compatibility alias for the internal token. |
| `SYNTHI_CODESITE_REPO_ROOT` | Conditional | Explicit repository root for source snapshots and repository policy compilation. Defaults to the process working directory when not supplied. |
| `SYNTHI_CODESITE_ARTIFACT_ROOT` | Conditional | Persistent host root for CodeSite artifacts and proof-linked outputs. |
| `SYNTHI_CODESITE_DISABLE_ARTIFACT_WRITE` | Conditional flag | Set to `1` to disable CodeSite artifact writes. This prevents artifact-backed workflows from completing. |
| `SYNTHI_CODESITE_AUTO_ARTIFACT_SYNC` | Conditional flag | Controls automatic artifact synchronization. Test workers disable this path. |
| `SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS_JSON` | Conditional | JSON form of allowed delivery origins. Preferred form. |
| `SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS` | Conditional alias | Comma-separated allowed delivery origins. |
| `SYNTHI_CODESITE_DELIVERY_SIGNING_SECRET` | Secret/Conditional | Delivery signature secret. Falls back to `SYNTHI_CODESITE_TOKEN` when omitted. |
| `SYNTHI_CODESITE_EXPERTISE_POLICY_JSON` | Conditional | JSON override for the CodeSite expertise and knowledge policy. The built-in policy is used when absent. |

### CodeSite runtime limits and Fleet NOTAM visibility

All numeric values are positive integers. The defaults are from
`runtimeConfig.js` and are used only when a value is omitted or invalid.

| Name | Default | Classification | Use |
| --- | ---: | --- | --- |
| `SYNTHI_CODESITE_ACTIVITY_NOTIFICATION_TIMEOUT_MS` | `1500` | Defaulted | Activity notification delivery timeout; maximum accepted value is 60 seconds. |
| `SYNTHI_CODESITE_READINESS_TIMEOUT_MS` | `3000` | Defaulted | Activity bridge readiness timeout; maximum accepted value is 60 seconds. |
| `SYNTHI_CODESITE_INBOX_DELIVERY_TIMEOUT_MS` | `1500` | Defaulted | Agent inbox delivery timeout; maximum accepted value is 120 seconds. |
| `SYNTHI_CODESITE_INSPECTION_TIMEOUT_MS` | `30000` | Defaulted | Repository or runtime inspection timeout. It cannot exceed the inspection maximum. |
| `SYNTHI_CODESITE_INSPECTION_MAX_TIMEOUT_MS` | `120000` | Defaulted | Upper bound for inspection timeout; capped by the shadow-runner maximum. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_TIMEOUT_MS` | `120000` | Defaulted | External shadow-runner timeout. |
| `SYNTHI_CODESITE_REPO_SCAN_MAX_FILES` | `12000` | Defaulted | Maximum files considered by repository scans. |
| `SYNTHI_CODESITE_SNAPSHOT_MAX_FILES` | `512` | Defaulted | Maximum files in a source snapshot. |
| `SYNTHI_CODESITE_SNAPSHOT_MAX_FILE_BYTES` | `2097152` | Defaulted | Maximum bytes per snapshot file. |
| `SYNTHI_CODESITE_SNAPSHOT_MAX_SCAN_ENTRIES` | `15000` | Defaulted | Maximum scan entries while discovering a repository. |
| `SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES` | `4194304` | Defaulted | Maximum artifact path-history payload. |
| `SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS` | `3` | Defaulted | Maximum active agent delivery channels. |
| `SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE` | `25` | Defaulted | Maximum active Fleet NOTAM advisories applied to one route. |

### CodeSite channels and shadow execution

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_CODESITE_CHANNELS_DISABLED` | Conditional flag | Disables CodeSite agent channels when set to a truthy value. |
| `SYNTHI_CODESITE_MIN_CHANNEL_MODE` | Conditional | Minimum channel security mode. |
| `SYNTHI_CODESITE_REQUIRE_SHADOW_RUNNER_EVIDENCE` | Conditional flag | Requires external shadow-runner evidence rather than accepting the control-plane simulator. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_EVIDENCE_REQUIRED` | Conditional alias flag | Compatibility flag for the same external-evidence requirement. |
| `SYNTHI_CODESITE_SHADOW_MERGE_PROOF_MATURITY` | Conditional | Values such as `mature`, `strict`, or `external_runner` require mature external-runner proof. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON` | Conditional | JSON array or command object for the external shadow runner. Preferred command form. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND` | Conditional | External shadow-runner executable when the JSON form is not used. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_ARGS_JSON` | Conditional | JSON array of executable arguments. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_CWD` | Conditional | Working directory for the external runner. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT` | Conditional/Security boundary | Root within which shadow worktrees may be created. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS` | Conditional/Security-sensitive | Allows inline commands in shadow plans when explicitly enabled. Compose enables this only for local development. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_BINARIES_JSON` | Conditional/Security boundary | JSON allowlist of executable binaries for the standalone shadow-runner command. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_ENV_ALLOWLIST_JSON` | Conditional/Security boundary | Extra environment names allowed to cross into a shadow-runner process. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES` | Conditional | Keeps external-runner worktrees for inspection. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_MAX_COMMAND_TIMEOUT_MS` | Command-only | Maximum per-command timeout in `synthi/scripts/codesite-shadow-runner.mjs`. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_TIMEOUT_MS` | Command-only | Fallback per-command timeout in the standalone shadow-runner. |
| `SYNTHI_CODESITE_SHADOW_RUNNER_OUTPUT_ROOT` | Command-only | Output root for standalone shadow-runner artifacts. |
| `SYNTHI_CODESITE_SHADOW_WORKTREE` | Injected/internal | The shadow runner synthesizes this value for the child process; do not set it as a deployment credential. |

If external evidence is required, the runner command and the evidence chain
must be independently observable. A configured command without valid completed
evidence remains blocked.

### CodeSite proof authority

CodeSite proof verification supports an explicit HMAC authority or Ed25519 key
material. Production must use an explicit authority and trusted keyset. The
application auth secret is not a proof authority.

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY` | Conditional/Required for trusted production proof | Enables strict trusted-authority verification. The release and production paths should set it to `1`. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_BASE_DIR` | Conditional | Base directory for relative authority-file paths. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET` | Secret/Conditional | HMAC proof-authority secret. Use this or an authority file, not both as an accidental split configuration. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE` | Secret/Conditional | File containing the HMAC authority secret. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID` | Conditional | Active Ed25519 proof key ID. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_NAME` | Conditional | Human/deployment identity label for the proof authority. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM` | Secret/Conditional | Inline Ed25519 private key for a signer that owns key material in-process. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE` | Secret/Conditional | File path for the Ed25519 private key. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM` | Conditional | Active Ed25519 public key. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE` | Conditional | File path for the active Ed25519 public key. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON` | Conditional | Trusted keyset JSON for rotation and verification. |
| `SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE` | Conditional | File path for the trusted keyset JSON. |

### CodeSite warrants

These are separate from the MCP `SYNTHI_WARRANT_*` settings. CodeSite reads the
following values from the Next application control-plane process. The
identity/capability and positive-integer policy values are required when the
CodeSite warrant endpoints are used. In `NODE_ENV=production`, managed audit
signing is required; partial signer configuration fails closed.

#### Identity, capabilities, limits, and transaction retries

| Name | Required value | Classification | Use |
| --- | --- | --- | --- |
| `SYNTHI_CODESITE_WARRANT_ISSUER` | Deployment identity issuer | Required/Secret-adjacent | Canonical issuer in every CodeSite warrant principal. Must be a bounded identity string. |
| `SYNTHI_CODESITE_WARRANT_USE_CAPABILITY` | Configured use capability | Required | Capability required by an agent recipient before a warrant can be used. |
| `SYNTHI_CODESITE_WARRANT_ISSUE_CAPABILITY` | Configured issue capability | Required | Capability required to issue or delegate CodeSite warrants. |
| `SYNTHI_CODESITE_WARRANT_MAX_ACTIVE` | Positive integer | Required | Maximum active warrants in the policy. |
| `SYNTHI_CODESITE_WARRANT_MAX_TTL_MS` | Positive integer | Required | Maximum warrant lifetime in milliseconds. |
| `SYNTHI_CODESITE_WARRANT_MAX_INVOCATIONS` | Positive integer | Required | Maximum invocation budget per warrant/grant. |
| `SYNTHI_CODESITE_WARRANT_TRANSACTION_MAX_RETRIES` | Positive integer | Required | Transaction retry ceiling for warrant mutations. |
| `SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRY_DELAY_MS` | Positive integer | Required | Delay between retry attempts. |
| `SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRYABLE_ERROR_CODES_JSON` | JSON array of non-empty strings | Required | Database/error codes eligible for a transaction retry. |

The retryable-error value must be a JSON array, for example
`["serialization_failure","deadlock_detected"]`, using the error vocabulary
of the deployed database driver. A missing, empty, malformed, or non-string
entry causes `codesite_warrant_policy_unconfigured`.

#### Managed audit signing in production

| Name | Required value | Classification | Use |
| --- | --- | --- | --- |
| `SYNTHI_CODESITE_WARRANT_AUDIT_KEY_ID` | Active key ID | Required in production/Secret-adjacent | Key identity placed in the detached audit signature envelope. |
| `SYNTHI_CODESITE_WARRANT_AUDIT_KEY_URI` | Managed key reference | Required in production/Secret-adjacent | Key URI or deployment-managed key reference. |
| `SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_COMMAND` | Managed signer command | Required in production/Injected | Executable invoked to sign the canonical audit payload. Private key custody remains with the signer boundary. |
| `SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_ARGS_JSON` | JSON string array | Conditional | Arguments for the managed signer command. Set when the command needs arguments. |
| `SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_TIMEOUT_MS` | Positive integer | Required in production | Maximum signer invocation time. |
| `SYNTHI_CODESITE_WARRANT_AUDIT_TRUSTED_KEYS_JSON` | Trusted public-key JSON | Required in production | Keyset used to verify the active and rotated audit signatures. |

The trusted-key JSON is expected to contain key references and public keys. A
signer response that has the wrong key reference, invalid Ed25519 signature,
invalid JSON, a non-zero exit, an oversized response, or a timeout is rejected.

### Fleet NOTAMs

Fleet NOTAMs are CodeSite governance records backed by the application database
and Prisma migrations. There is no independent `FLEET_NOTAM_API_KEY` or
separate Fleet service credential in the runtime source.

Fleet NOTAM operation depends on:

| Dependency | Configuration |
| --- | --- |
| Database and schema | `DATABASE_URL` plus migrations `20260826120000_add_codesite_fleet_notams` and `20260827110000_add_codesite_fleet_notam_lifecycle`. |
| CodeSite identity and authorization | `AUTH_SECRET`/`NEXTAUTH_SECRET`, `COLLAB_INTERNAL_TOKEN`, CodeSite agent identity/capabilities, and the normal project membership checks. |
| Route visibility | `SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE`, default `25`. |
| Evidence and publication | CodeSite proof authority and the promoted policy-delta/evidence path. A UI claim does not replace persisted evidence. |
| Local proof command | `FLEET_PROOF_BASE` and `FLEET_PROOF_OUT` are command-only output/base overrides for `scripts/fleet-notams-visual-proof.mjs`. |

The Fleet NOTAM UI publishes promoted policy deltas, supports adopt/mute/dismiss/
reactivate/withdraw/supersede lifecycle operations, and reads persisted
advisories. Missing records, migrations, authorization, or proof evidence are
runtime/data problems rather than missing Fleet-specific environment names.

## MCP warrant and broker configuration

The MCP tool gate is implemented in
[`mcp/synthi-mcp/src/tools/warrant.ts`](../mcp/synthi-mcp/src/tools/warrant.ts).
It is distinct from the CodeSite control-plane warrant authority.

| Name | Default | Classification | Use |
| --- | ---: | --- | --- |
| `SYNTHI_WARRANT_MODE` | `off` | Conditional | `off` leaves the gate inert, `warn` records violations while dispatching, and `enforce` rejects calls without a covering warrant. |
| `SYNTHI_WARRANT_ADMIN_KEY` | unset | Secret/Conditional | Organization administration key supplied in warrant-management call metadata. |
| `SYNTHI_WARRANT_MAX_ACTIVE` | `100` | Defaulted | Maximum in-memory active warrants. |
| `SYNTHI_WARRANT_MAX_TTL_MS` | `86400000` | Defaulted | Maximum local warrant TTL in milliseconds. |
| `SYNTHI_WARRANT_MAX_INVOCATIONS` | `10000` | Defaulted | Maximum local grant invocation budget. |
| `SYNTHI_WARRANT_STORE` | unset | Conditional/local-only | Encrypted journal path for local warrant state. It is forbidden in production. |
| `SYNTHI_WARRANT_STORE_KEY` | unset | Secret/Conditional/local-only | Encryption key for `SYNTHI_WARRANT_STORE`. It is forbidden in production with the file store. |
| `SYNTHI_WARRANT_CONTEXT_PROVIDER_MODULE` | unset | Conditional | Module loaded when the host supplies an external warrant identity/context provider. |

In production, do not rely on the MCP in-memory or encrypted-file warrant store
for durable authority. Use the CodeSite authority or the externally verified
host context expected by the deployment.

### MCP broker, replay, and quota controls

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_BROKER_INPUT_MODE` | Conditional | `shadow` observes input arbitration; `enforce` requires a valid lease and fresh frame binding. |
| `SYNTHI_BROKER_AUTH_SECRET` | Secret/Conditional | Broker force-release authentication secret. |
| `SYNTHI_BROKER_AUTH_ISSUER` | Conditional | Broker auth issuer. |
| `SYNTHI_BROKER_AUTH_AUDIENCE` | Conditional | Broker auth audience. |
| `SYNTHI_BROKER_REPLAY_PERSIST_PATH` | Conditional | Replay evidence persistence path. |
| `SYNTHI_BROKER_REPLAY_SHORT_MS` | Defaulted | Short replay horizon. |
| `SYNTHI_BROKER_REPLAY_LONG_MS` | Defaulted | Long replay retention horizon. |
| `SYNTHI_BROKER_WORKER_POOL_SIZE` | Defaulted | Broker worker pool size. |
| `SYNTHI_BROKER_WORKER_QUEUE_SIZE` | Defaulted | Broker worker queue size. |
| `SYNTHI_QUOTA_MODE` | Defaulted | `off`, `warn`, or `enforce` quota behavior. |
| `SYNTHI_QUOTA_VISION_COST_USD_PER_HR` | Defaulted | Rolling vision-cost ceiling. |
| `SYNTHI_QUOTA_TOOL_CALLS_PER_MIN` | Defaulted | Rolling tool-call ceiling. |
| `SYNTHI_QUOTA_SCREENSHOTS_PER_MIN` | Defaulted | Rolling screenshot ceiling. |

## Dojo configuration

The core Dojo enforcement and store resolver is in
[`mcp/synthi-mcp/src/dojo/config/enforcement.ts`](../mcp/synthi-mcp/src/dojo/config/enforcement.ts).
The MCP HTTP boundary is in
[`mcp/synthi-mcp/src/http.ts`](../mcp/synthi-mcp/src/http.ts), and manifest
signing is in
[`mcp/synthi-mcp/src/dojo/mcp/manifest_signing.ts`](../mcp/synthi-mcp/src/dojo/mcp/manifest_signing.ts).

### Dojo production enforcement flags

Boolean values must use `1`, `0`, `true`, `false`, `yes`, `no`, `on`, or `off`.

| Name | Production release value | Classification | Use |
| --- | --- | --- | --- |
| `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT` | `1` | Required for production | Selects Dojo production enforcement. |
| `SYNTHI_DOJO_REQUIRE_DURABLE_STORE` | `1` | Required for production | Rejects an ephemeral control-plane store. |
| `SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING` | `1` | Required for production | Rejects the local development signing fallback. |
| `SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER` | `1` | Required for production | Requires a production-capable evidence ledger. |

### Dojo control-plane and evidence-ledger stores

| Name | Classification | Use and valid production shape |
| --- | --- | --- |
| `SYNTHI_DOJO_CONTROL_PLANE_STORE` | Required/Injected | Set to `postgres` for the production overlay. `memory` and inline modes are not durable. |
| `SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL` | Required/Secret | PostgreSQL URL for the durable Dojo control plane when it is not embedded in the store value. |
| `SYNTHI_DOJO_STORE_FILE` | Conditional/local-only | Legacy encrypted-file store path. It is not production-capable. |
| `SYNTHI_DOJO_STORE_KEY` | Secret/Conditional/local-only | Legacy encrypted-file store key. |
| `SYNTHI_DOJO_STORE_SCOPE` | Conditional/local-only | Legacy encrypted-file store scope. |
| `SYNTHI_DOJO_EVIDENCE_LEDGER_STORE` | Required/Injected | Set to `postgres` for the production overlay. Inline records are not production-capable. |
| `SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL` | Required/Secret | PostgreSQL URL for the durable evidence ledger. |
| `SYNTHI_DOJO_THERAPEUTIC_STORE_DIR` | Conditional/local-only | File-backed therapeutic/Dojo store directory used by local feature-gated paths. |

For production, configure the store kind and its PostgreSQL URL together. A
store name by itself does not prove that the underlying store exists or is
durable.

### Dojo proof signing

The Dojo proof signer supports a local development key, inline key material, or
a managed signer command. Production must use an externally controlled signing
boundary.

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_DOJO_PROOF_SIGNING_PROVIDER` | Required in production | Provider name. The release overlay uses `managed-key-service`. |
| `SYNTHI_DOJO_PROOF_SIGNING_KEY_ID` | Required in production | Active proof-signing key identity. |
| `SYNTHI_DOJO_PROOF_SIGNING_KEY` | Conditional/local-only | Local development signing key. The built-in local value is not production-safe. |
| `SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM` | Secret/Conditional | Inline private key for a non-managed signer path. |
| `SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM` | Required for verification | Public key used to verify Dojo proofs. |
| `SYNTHI_DOJO_PROOF_SIGNING_COMMAND` | Required for command-managed signing | Managed signer executable. |
| `SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS` | Conditional | JSON or configured argument list for the managed signer. |
| `SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI` | Required for managed signing | KMS/HSM or managed-key URI. |
| `SYNTHI_DOJO_PROOF_ISSUER` | Defaulted | Dojo proof issuer; source default is `synthi-dojo-license-kernel`. Set explicitly across deployments that verify issuer identity. |

The release overlay's external-secret contract currently supplies the managed
key ID, signer command, command arguments, managed-key URI, and public key.
Private key custody should remain in the managed signer rather than being
placed in the MCP container.

### Dojo MCP manifest signing

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_DOJO_MCP_MANIFEST_ISSUER` | Required for signed production manifests | Manifest issuer. |
| `SYNTHI_DOJO_MCP_MANIFEST_KEY_ID` | Required for signed production manifests | Active manifest-signing key ID. |
| `SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM` | Required/Injected | Release overlay uses `ed25519`. |
| `SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY` | Conditional/local-only | Development signing secret/key compatibility path. Do not use the built-in development key in production. |
| `SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM` | Secret/Conditional | Manifest signing private key when signing in-process. |
| `SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM` | Required for verification | Manifest verification public key. |

### Dojo MCP HTTP boundary

| Name | Default | Classification | Use |
| --- | --- | --- | --- |
| `SYNTHI_MCP_HTTP_HOST` | loopback | Defaulted | HTTP bind address. A non-loopback address requires a bearer token. |
| `SYNTHI_MCP_HTTP_PORT` | `9467` | Defaulted | MCP HTTP port. |
| `SYNTHI_MCP_HTTP_PATH` | `/mcp` | Defaulted | MCP HTTP endpoint path. |
| `SYNTHI_MCP_HTTP_HEALTH_PATH` | `/healthz` | Defaulted | Health endpoint path. |
| `SYNTHI_MCP_HTTP_MAX_BODY_BYTES` | `1048576` | Defaulted | Maximum HTTP request body. |
| `SYNTHI_MCP_HTTP_BEARER_TOKEN` | unset | Secret/Required off-loopback | HTTP bearer token. Falls back to `SYNTHI_DOJO_MCP_BEARER_TOKEN`. |
| `SYNTHI_DOJO_MCP_BEARER_TOKEN` | unset | Secret/Required for protected Dojo MCP | Dojo MCP bearer token and fallback for the HTTP boundary. |
| `SYNTHI_MCP_HTTP_BEARER_HEADER` | `authorization` | Defaulted | Header name carrying the bearer token. |

### Dojo identity, private stores, and hosted browser readiness

These names are feature-gated but are part of a deployed Dojo/browser runtime
contract when the corresponding feature is enabled.

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_TENANT_ID` | Required in hosted production context | Tenant identity. |
| `SYNTHI_ORGANIZATION_ID` | Conditional | Organization identity. |
| `SYNTHI_WORKSPACE_ID` | Required in hosted production context | Workspace identity. |
| `SYNTHI_WORKSPACE_SLUG` | Conditional | Human/project workspace slug. |
| `SYNTHI_AGENT_ID` | Required in hosted production context | Agent identity. |
| `SYNTHI_ACTOR_ID` | Conditional | Actor identity alias used by readiness/context paths. |
| `SYNTHI_AGENT_SUBJECT` | Conditional | Agent subject identity. |
| `SYNTHI_WORKSPACE_URL` | Required in hosted browser context | Workspace URL fallback. |
| `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE` | Required for durable private-tool store | Encrypted private workflow-tool store path. |
| `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY` | Secret/Required for durable private-tool store | Private-tool store encryption key. |
| `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE` | Required for durable private-tool store | Store scope. |
| `SYNTHI_AUTH_CHECKPOINT_STORE_FILE` | Required for durable auth checkpoints | Encrypted auth-checkpoint store path. |
| `SYNTHI_AUTH_CHECKPOINT_STORE_KEY` | Secret/Required for durable auth checkpoints | Auth-checkpoint encryption key. |
| `SYNTHI_AUTH_CHECKPOINT_SCOPE` | Required for durable auth checkpoints | Checkpoint scope. |
| `SYNTHI_DOJO_ARTIFACT_EXECUTION_MODE` | Conditional | Artifact execution mode selected by browser/Dojo tools. |

#### Hosted browser runtime

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_HOSTED_BROWSER_CDP_URL` | Required when no target template is supplied | Hosted browser CDP endpoint. |
| `SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE` | Required alternative | Runtime-specific CDP target template. |
| `SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY` | Required for loopback endpoint | Declares the topology when the endpoint is loopback. |
| `SYNTHI_HOSTED_BROWSER_CDP_HEADERS_JSON` | Conditional | JSON headers for the CDP connection. |
| `SYNTHI_HOSTED_BROWSER_CDP_PORT` | Conditional | Hosted CDP port. |
| `SYNTHI_HOSTED_BROWSER_WORKSPACE_URL` | Required alternative to `SYNTHI_WORKSPACE_URL` | Workspace URL for the hosted runtime. |
| `SYNTHI_HOSTED_BROWSER_RUNTIME_ID` | Conditional | Hosted runtime identity. |
| `SYNTHI_HOSTED_BROWSER_SESSION_ID` | Conditional | Hosted browser session identity. |
| `SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST` | Required in production | Allowed browser/workspace origins. |
| `SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS` | Required in production | Session lifetime; readiness rejects a value over one hour. |
| `SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS` | Required in production | Must not be false in the production readiness contract. |
| `SYNTHI_HOSTED_BROWSER_ALLOW_LOCAL_NETWORK` | Conditional/security-sensitive | Local-network access policy. |
| `SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST` | Conditional | Local bridge bind host. |
| `SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT` | Conditional | Bridge port; source default is `9466`. |
| `SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL` | Required for remote bridge | Remote workflow bridge URL. |
| `SYNTHI_BROWSER_WORKFLOW_BRIDGE_TARGET_TEMPLATE` | Conditional | Per-runtime bridge target template. |
| `SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN` | Secret/Required for non-loopback bridge | Bridge authentication token. |
| `SYNTHI_BROWSER_BRIDGE_HOST` | Conditional/local | Lower-level browser bridge bind host. |
| `SYNTHI_BROWSER_BRIDGE_PORT` | Conditional/local | Lower-level browser bridge port. |
| `SYNTHI_BROWSER_BRIDGE_PUBLIC_URL` | Conditional | Public URL for the lower-level bridge. |
| `SYNTHI_BROWSER_BRIDGE_TOKEN` | Secret/Conditional | Lower-level bridge token. |
| `SYNTHI_BROWSER_CDP_URL` | Local-only | Direct local CDP endpoint. It should be absent from production deployments. |
| `SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS` | Defaulted | Direct CDP connection timeout. |
| `SYNTHI_BROWSER_EXTERNAL_OPEN_BODY_LIMIT_BYTES` | Defaulted | External-open request body limit. |
| `SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS` | Defaulted | External-open timeout. |
| `SYNTHI_BROWSER_PREVIEW_ALLOWED_ORIGINS` | Conditional | Allowed preview origins. |
| `SYNTHI_BROWSER_PREVIEW_ALLOWED_HOST_SUFFIXES` | Conditional | Allowed preview host suffixes. |
| `SYNTHI_PREVIEW_DISCOVERY_PORTS` | Conditional | Preview-discovery port list. |
| `SYNTHI_PREVIEW_SCAN_PORTS` | Conditional | Preview scan port list. |
| `SYNTHI_WORKFLOW_PREVIEW_PORTS` | Conditional | Workflow-specific preview ports. |

### Therapeutic production endpoint contract

`SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED` is `0` in the current Dojo release
overlay. If it is enabled, the MCP HTTP readiness path requires all of the
following runtime, store, probe, tenant, actor, and upstream values:

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED` | Feature gate | Enables the therapeutic production endpoint contract. Keep `0` until provisioned. |
| `SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_CONTEXT_PATH` | Required when enabled | Path or endpoint for runtime auth context. |
| `SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_TOKEN` | Secret/Required when enabled | Runtime auth bearer. |
| `SYNTHI_THERAPEUTIC_PROD_RUNTIME_SESSION_ID` | Required when enabled | Runtime session identity. |
| `SYNTHI_THERAPEUTIC_PROD_TENANT_ID` | Required when enabled | Therapeutic tenant identity. |
| `SYNTHI_THERAPEUTIC_PROD_ORGANIZATION_ID` | Required when enabled | Therapeutic organization identity. |
| `SYNTHI_THERAPEUTIC_PROD_WORKSPACE_ID` | Required when enabled | Therapeutic workspace identity. |
| `SYNTHI_THERAPEUTIC_PROD_ACTOR_ID` | Required when enabled | Acting identity. |
| `SYNTHI_THERAPEUTIC_PROD_ACTOR_ROLES` | Required when enabled | CSV roles; must include the required proof-broker or incident-commander role. |
| `SYNTHI_THERAPEUTIC_PROD_STORE_PATH` | Defaulted/Required when enabled | Runtime-state store path; source default is `/therapeutic/runtime-state`. |
| `SYNTHI_THERAPEUTIC_PROD_PROBE_PATH` | Defaulted/Required when enabled | Incident-response probe path; source default is `/therapeutic/incident-response`. |
| `SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN` | Secret/Required when enabled | Store endpoint bearer. |
| `SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN` | Secret/Required when enabled | Probe endpoint bearer. |
| `SYNTHI_THERAPEUTIC_PROD_POSTGRES_URL` | Secret/Required when enabled | Therapeutic PostgreSQL URL. Falls back to `SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL` or `DATABASE_URL`. |
| `SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_URL` | Required when enabled | HTTPS upstream probe URL. |
| `SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_AUTH_TOKEN` | Secret/Required when enabled | Upstream probe bearer. |

The release-gate manifest also names these deployment-contract aliases, which
must be provided if the release gate is used:

```text
SYNTHI_THERAPEUTIC_PROD_RUNTIME_URL
SYNTHI_THERAPEUTIC_PROD_PROBE_URL
SYNTHI_THERAPEUTIC_PROD_STORE_URL
```

## MCP transport, vision, and workflow settings

These settings are not all Dojo-specific, but missing values can prevent the
MCP, browser workflow, vision, or CodeSite integrations from working.

### Session, signaling, API, and vision

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_ENV_FILE` | Conditional | MCP env-file override after an explicit CLI `--env-file`. |
| `ALLOW_WORKFLOW_MUTATION` | Command-only/security-sensitive | Must be `1` only inside an isolated, resettable mutation replay. |
| `SYNTHI_SESSION_ID` | Conditional | Runtime/session identity. |
| `SYNTHI_SIGNALING_URL` | Conditional | WebRTC/signaling endpoint. |
| `SYNTHI_MCP_ROLE` | Conditional | MCP role selection. |
| `SYNTHI_AGENT_TOKEN` | Secret/Conditional | Agent access token. |
| `SYNTHI_AGENT_ID` | Conditional | Agent identity. |
| `SYNTHI_AGENT_SUBJECT` | Conditional | Agent subject. |
| `SYNTHI_AGENT_TOKEN_SECRET` | Secret/Conditional | Token verification secret. |
| `SYNTHI_STUN_URL` | Conditional | STUN endpoint. |
| `SYNTHI_TURN_URL` | Conditional | TURN endpoint. |
| `SYNTHI_TURN_USERNAME` | Secret/Conditional | TURN username. |
| `SYNTHI_TURN_CREDENTIAL` | Secret/Conditional | TURN credential. |
| `SYNTHI_TURN_URLS` | Conditional | Multiple TURN URLs. |
| `SYNTHI_TURN_SECRET` | Secret/Conditional | TURN signing secret. |
| `SYNTHI_MCP_ICE_POLICY` | Conditional | ICE policy. |
| `SYNTHI_LEASE_MODE` | Conditional | Input/lease behavior. |
| `SYNTHI_MCP_COMPILE_CHUNK_BYTES` | Defaulted | Chunk size for MCP compile-channel transport. |
| `SYNTHI_API_URL` | Conditional | External Synthi API base URL. |
| `SYNTHI_PAT` | Secret/Conditional | External Synthi personal access token. |
| `SYNTHI_WORKSPACE_SLUG` | Conditional | External API workspace slug. |
| `SYNTHI_COLLAB_BASE_URL` | Conditional | MCP collab base URL. |
| `SYNTHI_COLLAB_SERVER_URL` | Conditional alias | MCP collab server URL. |
| `SYNTHI_VISION_BACKEND` | Defaulted | Vision mode; `agent_side` is the source default and `gemini_api` requires a Gemini-compatible key. |
| `SYNTHI_GEMINI_MODEL` | Conditional | MCP Gemini model. |
| `GEMINI_API_KEY` | Secret/Required for Gemini API mode | Gemini vision/provider key. |
| `GOOGLE_API_KEY` | Secret/Conditional alias | Google provider key alias. |
| `ANTHROPIC_API_KEY` | Secret/Conditional | Anthropic vision/provider key. |
| `SYNTHI_VISION_MODEL` | Conditional | Vision model override. |
| `SYNTHI_LOCAL_VISION_URL` | Conditional | Local vision backend URL. |
| `SYNTHI_ALLOW_THIRD_PARTY_INFERENCE` | Conditional/security policy | Allows third-party inference when explicitly enabled. |
| `SYNTHI_MCP_CALL_TIMEOUT_MS` | Defaulted | MCP hub call timeout. |
| `SYNTHI_MCP_SSRF_ALLOWLIST` | Conditional/security policy | MCP hub SSRF allowlist. |
| `PLAYWRIGHT_BASE_URL` | Conditional | Browser test/workflow base URL. |
| `PLAYWRIGHT_STORAGE_STATE` | Conditional/Secret-adjacent | Playwright storage-state path. |
| `DATABASE_URL` | Conditional/Secret | MCP database-backed features and Dojo PostgreSQL fallback. |
| `RUNTIME_HOST_CLASS` | Conditional | Runtime host classification. |
| `CDP_TOPOLOGY` | Conditional | CDP topology metadata. |

### Workflow evidence and replay

| Name | Classification | Use |
| --- | --- | --- |
| `SYNTHI_WORKFLOW_CI_ARTIFACT_DIR` | Command-only/Conditional | CI replay artifact directory. |
| `SYNTHI_WORKFLOW_CI_NONCE` | Command-only | Replay nonce. |
| `SYNTHI_WORKFLOW_CI_RUN_ID` | Command-only | CI run identity. |
| `SYNTHI_WORKFLOW_CI_RESET_PROFILE_ID` | Command-only | Reset-profile identity. |
| `SYNTHI_WORKFLOW_CI_STATE_SEED_ID` | Command-only | Deterministic state seed. |
| `SYNTHI_WORKFLOW_NETWORK_IDLE_TIMEOUT_MS` | Conditional | Browser network-idle timeout. |
| `SYNTHI_WORKFLOW_REPLAY_ATTESTATION` | Conditional/Secret-adjacent | Replay attestation material or path. |
| `SYNTHI_WORKFLOW_RUNTIME_SCOPE` | Conditional | Runtime scope for workflow execution. |
| `SYNTHI_WORKFLOW_STORAGE_STATE` | Conditional/Secret-adjacent | Workflow storage-state path or reference. |
| `SYNTHI_WORKFLOW_VISUAL_PROOF_DIR` | Command-only | Visual proof output directory. |
| `SYNTHI_WORKFLOW_SPEC` | Conditional | Workflow specification path or payload. |
| `SYNTHI_WORKSPACE_PREVIEW_URL` | Conditional | Workspace preview URL. |
| `SYNTHI_PREVIEW_URL` | Conditional | Preview URL fallback. |
| `SYNTHI_SNAPSHOT_DIR` | Conditional | Snapshot output directory. |

## Frontend-specific configuration

The frontend has additional direct reads beyond the shared and CodeSite values.
These are the complete production-source key families identified in the scan.

### AI providers and repository context

```text
ANTHROPIC_API_BASE
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
AI_FULL_REPO_MAX_CHARS
AI_FULL_REPO_MAX_FILE_CHARS
AI_FULL_REPO_MAX_FILES
GEMINI_API_BASE
GEMINI_API_KEY
GEMINI_MODEL
OPENAI_API_BASE
OPENAI_API_KEY
OPENAI_MODEL
SERPER_API_KEY
GOOGLE_SEARCH_API_KEY
GOOGLE_SEARCH_CX
CODE_INTEL_API_KEY
CODE_INTEL_URL
AI_ENGINE_AUTH_TOKEN
AI_ENGINE_URL
SYNTHI_AI_MODEL
SHADOW_VERIFY_DEFAULT
SHADOW_VERIFY_ENABLED
RAG_CACHE_TTL_MS
RAG_CACHE_MAX_ENTRIES
RAG_CACHE_MAX_BYTES
SYNTHI_MCP_LISTTOOLS_CONCURRENCY
SYNTHI_MCP_MAX_CALLS_PER_TURN
SYNTHI_MCP_MAX_SCHEMA_BYTES
SYNTHI_MCP_MAX_TOOLS_PER_CONN
```

### Frontend URLs, auth, feature flags, and caches

```text
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_CODE_INTEL_URL
NEXT_PUBLIC_COLLAB_SERVER_URL
NEXT_PUBLIC_COLLAB_URL
NEXT_PUBLIC_COMPILE_SIGNAL_URL
NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER
NEXT_PUBLIC_GATEWAY_WS_URL
NEXT_PUBLIC_ICE_SERVERS
NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION
NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING
NEXT_PUBLIC_JUPYTER_NOTEBOOK_VIEWER
NEXT_PUBLIC_PERF_MARKERS
NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS
NEXT_PUBLIC_SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL
NEXT_PUBLIC_SYNTHI_OPERATOR_BRIDGE_URL
NEXT_PUBLIC_SYNTHI_OAUTH_RELAY_EXTENSION_URL
NEXT_PUBLIC_SYNTHI_TERMINAL_WEBGL
NEXT_PUBLIC_TERMINAL_URL
NEXT_PUBLIC_YJS_URL
NEXTAUTH_URL
NEXTAUTH_SECRET
SYNTHI_APP_INTERNAL_URL
SYNTHI_APP_URL
SYNTHI_PUBLIC_APP_URL
SYNTHI_WORKSPACE_AUTH_BYPASS
SYNTHI_WORKSPACE_AUTH_BYPASS_EMAIL
SYNTHI_INTERNAL_API_TOKEN
SYNTHI_OAUTH_RELAY_SECRET
SYNTHI_RUNTIME_ID_SECRET
SYNTHI_TOKEN_ENCRYPTION_KEY
SYNTHI_TOKEN_ENCRYPTION_PASSPHRASE
NEXT_PUBLIC_FILE_CACHE_MB
NEXT_PUBLIC_FILE_CACHE_MAX_FILE_MB
NEXT_PUBLIC_NEXT_EDIT_PREDICTION
NEXT_PUBLIC_NEP_KILL_MIN
NEP_FLAG_DISABLED
NEP_FLAG_DISABLED_REASON
SYNTHI_ENABLE_PROACTIVE
SYNTHI_DEBUG_COMPILER
SYNTHI_DEBUG_LSP
SYNTHI_HEAL_DEBUG
SYNTHI_THEME
```

### Frontend platform, program, payments, GCS, TURN, and local support

```text
AUTH_SECRET
GCP_CLIENT_EMAIL
GCP_PRIVATE_KEY
GCP_PROJECT_ID
GCS_BUCKET_NAME
GCLOUD_PROJECT
GOOGLE_CLOUD_PROJECT
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_ID
GITHUB_ISSUER
GITHUB_SECRET
GITLAB_CLIENT_ID
GITLAB_CLIENT_SECRET
CLOUDFLARE_TURN_API_TOKEN
CLOUDFLARE_TURN_TOKEN_ID
LOCAL_TURN_CREDENTIAL
LOCAL_TURN_URL
LOCAL_TURN_USERNAME
TURN_CREDENTIAL_TTL
PAYMENTS_CHECKOUT_URL
PAYMENTS_HANDOFF_SECRET
PLATFORM_ADMIN_EMAILS
PROGRAM_AI_REJECT_THRESHOLD
PROGRAM_AI_REVIEW_ENABLED
PROGRAM_AI_RISK_THRESHOLD
PROGRAM_IMAGE_MAX_BYTES
PROGRAM_IMAGE_PLATFORM
PROGRAM_LAUNCH_SCOPE
PROGRAM_LOGOS
PROGRAM_PLATFORM_TAKE_BPS
PROGRAM_RECIPES
PROGRAM_SCAN_THRESHOLD
STRIPE_WEBHOOK_SECRET
ENABLE_CONTAINER_RUNTIME
ENABLE_PROGRAM_SEED
CRANE_BIN
TRIVY_BIN
TRIVY_CACHE_DIR
VECTANT_AR_HOST
VECTANT_AR_PROJECT
VECTANT_AR_REPO
VECTANT_DBEAVER_IMAGE
VECTANT_DBEAVER_PORT
VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN
VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET
VECTANT_LOCAL_SUPPORT_LOCAL_API_URL
VECTANT_LOCAL_SUPPORT_ORG_ID
VECTANT_LOCAL_SUPPORT_TEST_REQUESTS
VECTANT_PORTAINER_IMAGE
VECTANT_PORTAINER_PORT
VECTANT_POSTMAN_IMAGE
VECTANT_POSTMAN_PORT
VECTANT_REPOSITORY_ROOT
JUPYTER_ALLOW_DOCKER_HOST
JUPYTER_ALLOW_PRIVATE_HTTP
JUPYTER_ALLOWED_ORIGINS
```

### Frontend rate limits

```text
SYNTHI_RL_AUDIT
SYNTHI_RL_CHANNELS
SYNTHI_RL_CRUD
SYNTHI_RL_EXTCALL
SYNTHI_RL_GIT
SYNTHI_RL_RESOLVE
SYNTHI_RL_TELEMETRY
SYNTHI_RL_TEST
```

These values override per-minute integration limits and default to the limits
defined in `synthi/src/lib/integrations/rateLimit.js`.

The following CodeSite names are also read dynamically by frontend paths and
are covered in the CodeSite sections above:

```text
SYNTHI_CODESITE_CONTROL_PLANE_URL
SYNTHI_CODESITE_AGENT_OVERLAY_ROOT
SYNTHI_CODESITE_FINALIZER_COMMAND
SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS
SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS_JSON
SYNTHI_CODESITE_WARRANT_AUDIT_KEY_ID
SYNTHI_CODESITE_WARRANT_AUDIT_KEY_URI
SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_COMMAND
SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_ARGS_JSON
SYNTHI_CODESITE_WARRANT_AUDIT_SIGNER_TIMEOUT_MS
SYNTHI_CODESITE_WARRANT_AUDIT_TRUSTED_KEYS_JSON
SYNTHI_CODESITE_WARRANT_ISSUER
SYNTHI_CODESITE_WARRANT_USE_CAPABILITY
SYNTHI_CODESITE_WARRANT_ISSUE_CAPABILITY
SYNTHI_CODESITE_WARRANT_MAX_ACTIVE
SYNTHI_CODESITE_WARRANT_MAX_TTL_MS
SYNTHI_CODESITE_WARRANT_MAX_INVOCATIONS
SYNTHI_CODESITE_WARRANT_TRANSACTION_MAX_RETRIES
SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRY_DELAY_MS
SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRYABLE_ERROR_CODES_JSON
SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE
SYNTHI_CODESITE_PROOF_AUTHORITY_BASE_DIR
SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID
SYNTHI_CODESITE_PROOF_AUTHORITY_NAME
SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET
SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM
SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE
SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY
```

## Collab-server configuration

The canonical collab configuration is
[`backend/collab-server/config.js`](../backend/collab-server/config.js). The
tracked file at
[`backend/backend/collab-server/.env.example`](../backend/backend/collab-server/.env.example)
is a stale duplicate; use
[`backend/collab-server/.env.example`](../backend/collab-server/.env.example)
for the current package.

### Core storage, service, and authentication

```text
REPOS_DIR
LEVELDB_DIR
YSWEET_URL
YSWEET_AUTH_KEY
COLLAB_PORT
CODE_INTEL_URL
AI_BACKEND_AUTH_TOKEN
AI_ENGINE_AUTH_TOKEN
CORS_ORIGIN
GCP_PROJECT_ID
GOOGLE_CLOUD_PROJECT
GCLOUD_PROJECT
GCS_BUCKET_NAME
GCP_CLIENT_EMAIL
GCP_PRIVATE_KEY
GCP_CREDENTIALS
GCS_WORKSPACE_PREFIX
GCS_SYNC_ON_FLUSH
CODE_INTEL_AUTO_INDEX
SYNTHI_WORKSPACE_AUTH_BYPASS
COLLAB_ALLOWED_ORIGINS
COLLAB_LOG_FORMAT
COLLAB_LOG_LEVEL
COLLAB_LOG_SERVICE
COLLAB_SHUTDOWN_DEADLINE_MS
COLLAB_WS
DATA_ROOT
CLAUDE_BIN_DIR
GIT_TERMINAL_PROMPT
SYNTHI_INVITE_LINK_STYLE
SYNTHI_NO_HOME_OVERRIDE
SYNTHI_NO_JAIL
SYNTHI_NO_PS1
SYNTHI_FS_POLL_ENABLED
SYNTHI_FS_POLL_INTERVAL_MS
FLUSH_DEBOUNCE_MS
CLOUDFLARE_TURN_TOKEN_ID
CLOUDFLARE_TURN_API_TOKEN
TURN_CREDENTIAL_TTL
AUTH_SECRET
NEXTAUTH_SECRET
COLLAB_INTERNAL_TOKEN
SYNTHI_RUNTIME_ID_SECRET
SYNTHI_TOKEN_ENCRYPTION_KEY
SYNTHI_TOKEN_ENCRYPTION_PASSPHRASE
```

### Redis persistence and repository cache

```text
REDIS_URL
COLLAB_REDIS_PREFIX
COLLAB_REDIS_SESSION_TTL_SEC
COLLAB_REDIS_BLOCK_TTL_SEC
COLLAB_REDIS_EVENT_TTL_SEC
COLLAB_REDIS_VERSION_TTL_SEC
COLLAB_REDIS_INBOX_TTL_SEC
COLLAB_REDIS_MAX_EVENTS
COLLAB_REDIS_MAX_VERSIONS
COLLAB_REDIS_MAX_INBOX
COLLAB_REDIS_MAX_VERSION_BYTES
REPO_CACHE_DIR
REPO_CACHE_MAX
REPO_CACHE_TTL_MS
REPO_CACHE_DELETE_ON_EVICT
REPOS_VOLUME_SUBPATH
```

### Runtime, worker, workspace, terminal, preview, and callback controls

```text
SPAWNER_MODE
DOCKER_SOCKET_PATH
ENABLE_CONTAINER_RUNTIME
ENABLE_CODESITE_DOCKER_RUNTIME
WORKER_IMAGE
WORKER_NETWORK
WORKER_SIGNALING_URL
WORKER_COLLAB_URL
WORKER_AI_BACKEND_URL
WORKER_GST_DEBUG
WORKER_LOG_LEVEL
WORKER_CMD
WORKER_CWD
WORKER_LOG_DIR
IDLE_TIMEOUT_MS
CULL_INTERVAL_MS
RUNTIME_CULL_INTERVAL_MS
MAX_WORKSPACE_PODS
MAX_RUNTIME_CONTAINERS
MAX_RUNTIME_PODS
SPAWNER_CLEANUP_ON_SHUTDOWN
RUNTIME_BACKEND
RUNTIME_IMAGE
RUNTIME_POD_IMAGE
RUNTIME_CPU_LIMIT
RUNTIME_CPU_REQUEST
RUNTIME_MEMORY_LIMIT
RUNTIME_MEMORY_REQUEST
RUNTIME_PRIVILEGED
RUNTIME_REGISTRY_MIRROR
RUNTIME_DOCKER_HOST
RUNTIME_EGRESS_BANDWIDTH
RUNTIME_IDLE_TIMEOUT_MS
RUNTIME_IDLE_TTL_MS
RUNTIME_PERSIST_DOCKER_DATA
RUNTIME_POD_READY_TIMEOUT_MS
RUNTIME_GPU_RESOURCE
RUNTIME_GPU_NODE_SELECTOR_VALUE
RUNTIME_NODE_SELECTOR_KEY
RUNTIME_NODE_SELECTOR_VALUE
RUNTIME_NODE_TAINT_KEY
RUNTIME_NODE_TAINT_VALUE
RUNTIME_NODE_TAINT_EFFECT
WORKSPACE_DATA_VOLUME
WORKSPACE_DATA_MOUNT
WORKSPACE_DATA_VOLUME_ROOT
WORKSPACE_DATA_PVC
WORKSPACE_ROOT
WORKSPACE_REPOS_PATH
WORKSPACE_PREP_STATE_DIR
WORKSPACE_PREP_MAX_PARALLEL
WORKSPACE_PREP_JOB_TIMEOUT_MS
WORKSPACE_PREP_LOCAL_VOLUME
WORKSPACE_PREP_MOUNT_PATH
WORKSPACE_PREP_PVC_NAME
WORKSPACE_PREP_SCAN_DEPTH
WORKSPACE_NODE_SELECTOR_KEY
WORKSPACE_NODE_SELECTOR_VALUE
WORKSPACE_NODE_TAINT_KEY
WORKSPACE_NODE_TAINT_VALUE
WORKSPACE_NODE_TAINT_EFFECT
POD_READY_TIMEOUT_MS
PROXY_SCAN_PORTS
PROXY_TARGET_HOST
K8S_NAMESPACE
SYNTHI_RUNTIME_SHARED_GID
SYNTHI_RUNTIME_WORKSPACE_UMASK
SYNTHI_TERMINAL_BACKEND
SYNTHI_TERMINAL_DEFAULT_PORT
SYNTHI_TERMINAL_DETACH_TTL_MS
SYNTHI_TERMINAL_K8S_CONTAINER
SYNTHI_TERMINAL_PORT_POOL
SYNTHI_TERMINAL_PORT_RANGE_SIZE
SYNTHI_TERMINAL_PORT_RANGE_START
SYNTHI_TERMINAL_REPLAY_BUFFER_CHARS
SYNTHI_TERMINAL_SCOPE_PORTS
SYNTHI_PREVIEW_BIND_HOST
SYNTHI_PREVIEW_EXCLUDE_PORTS
SYNTHI_PREVIEW_INFRA_PORTS
SYNTHI_PREVIEW_PORT_PROBE_TIMEOUT_MS
SYNTHI_PREVIEW_PUBLIC_DOMAIN
SYNTHI_PREVIEW_PUBLIC_PREFIX
SYNTHI_PREVIEW_PUBLIC_PROTOCOL
SYNTHI_PREVIEW_SCAN_PORTS
SYNTHI_PREVIEW_SIDECAR_IMAGE
SYNTHI_PREVIEW_SIDECAR_PORT
SYNTHI_PREVIEW_SIDECAR_PREFIX
SYNTHI_PREVIEW_SIDECAR_TIMEOUT_MS
SYNTHI_PREVIEW_TARGET_TEMPLATE
SYNTHI_RUNTIME_CALLBACK_BODY_LIMIT_BYTES
SYNTHI_RUNTIME_CALLBACK_BODY_PREVIEW_CHARS
SYNTHI_RUNTIME_CALLBACK_RESPONSE_LIMIT_BYTES
SYNTHI_RUNTIME_CALLBACK_TIMEOUT_MS
SYNTHI_BROWSER_EXTERNAL_OPEN_BODY_LIMIT_BYTES
SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS
SYNTHI_BROWSER_WORKFLOW_BRIDGE_IMAGE
SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT
SYNTHI_HOSTED_BROWSER_CDP_PORT
SYNTHI_HOSTED_BROWSER_VIEW_PORT
SYNTHI_HOSTED_BROWSER_VNC_PORT
```

### CodeSite activity and runtime service settings

```text
SYNTHI_CODESITE_ACTIVE_TTL_MS
SYNTHI_CODESITE_ACTIVE_REFRESH_TIMEOUT_MS
SYNTHI_CODESITE_ACTIVITY_PERSISTENCE
SYNTHI_CODESITE_ACTIVITY_STATE_DIR
SYNTHI_CODESITE_ACTIVITY_STATE_FILE
SYNTHI_CODESITE_API_BASE_URL
SYNTHI_CODESITE_BASE_URL
SYNTHI_CODESITE_COOKIE
SYNTHI_CODESITE_HOST_PREWRITE_GUARD
SYNTHI_CODESITE_HOST_SENTINEL_DIR
SYNTHI_CODESITE_READINESS_TIMEOUT_MS
SYNTHI_CODESITE_READINESS_WORKSPACE_SLUG
SYNTHI_CODESITE_TOKEN
SYNTHI_APP_INTERNAL_URL
SYNTHI_APP_URL
SYNTHI_PUBLIC_APP_URL
NEXTAUTH_URL
```

## AI engine and gateway configuration

### AI engine

The AI engine loads `ai-backend/ai-engine/.env` and uses these source-level
settings:

```text
AI_BACKEND_AUTH_TOKEN
AI_ENGINE_AUTH_TOKEN
AI_ENGINE_ALLOWED_ORIGINS
AI_ENGINE_AUTH_DISABLED
AI_ENGINE_MAX_AI_REQUEST_CHARS
COLLAB_SERVER_URL
GEMINI_API_KEY
GOOGLE_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
SYNTHI_OPENAI_MODEL
OPENAI_MAX_OUTPUT_TOKENS
OPENAI_TEMPERATURE
SYNTHI_GEMINI_MODEL
SYNTHI_GEMINI_FALLBACK_MODEL
GEMINI_FALLBACK_MODEL
SYNTHI_GEMINI_PRIVATE_MODEL_ALIASES
SYNTHI_GEMINI_LIVE_MODEL_CHECK
SYNTHI_ANTHROPIC_MODEL
SYNTHI_SPLIT_PROVIDER
SYNTHI_SPLIT_MODEL
SYNTHI_GPU_SPLIT_PROVIDER
SYNTHI_GPU_SPLIT_MODEL
SYNTHI_GPU_DELTA_MODEL
SYNTHI_DIFF_PATCH_PROVIDER
SYNTHI_GPU_VENDOR
SYNTHI_GPU_VENDOR_HINT
SYNTHI_GPU_ARCH
SYNTHI_GPU_ARCH_HINT
SYNTHI_EXTRA_SDL_FUNCTIONS
SPLIT_WORKSPACE_ROOT
CODE_INTEL_API_KEY
CODE_INTEL_REQUIRE_SLUG
CODE_INTEL_LLM_RERANK
CODE_INTEL_MULTI_PASS
CODE_INTEL_DYNAMIC_BUDGETS
CODE_INTEL_RAG
CODE_INTEL_DEBUG
RAG_ROUTING_MODEL
RAG_SYNTHESIS_MODEL
RAG_DEBUG
SHADOW_STATE_DIR
SHADOW_CLOSURE_CROSSOVER_ENABLED
SHADOW_SURGICAL_ENABLED
SHADOW_CONTINUOUS_ENABLED
SYNTHI_AGENT_RUNNER_IMAGE
SYNTHI_AGENT_RUNNER_NETWORK
SYNTHI_AGENT_RUNNER_CREDENTIALS_VOLUME
SYNTHI_AGENT_RUNNER_WORKSPACE_VOLUME
SYNTHI_AGENT_RUNNER_WORKSPACE_VOLUME_ROOT
SYNTHI_AGENT_RUNNER_MEMORY
SYNTHI_AGENT_RUNNER_CPUS
SYNTHI_AGENT_RUNNER_PIDS_LIMIT
SYNTHI_AGENT_CREDENTIALS_VOLUME
SYNTHI_AGENT_WORKSPACE_VOLUME
SYNTHI_AGENT_WORKSPACE_VOLUME_ROOT
SYNTHI_AGENT_MEMORY
SYNTHI_AGENT_CPUS
SYNTHI_AGENT_PIDS_LIMIT
SYNTHI_CODESITE_AGENT_OVERLAY_ROOT
SYNTHI_CODESITE_CONTROL_PLANE_URL
SYNTHI_CODESITE_FINALIZER_COMMAND
VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES
VECTANT_FAILURE_DISTILLER_WORKSPACE_VOLUME
VECTANT_FAILURE_DISTILLER_E2E_IMAGE
SYNTHI_GEMINI_DELTA_MODEL
SYNTHI_DEV_MODE
VECTANT_FAILURE_OBSERVATION_RETENTION_SECONDS
VECTANT_FAILURE_PATCH_APPROVAL_SECONDS
POLICY_PERSIST_DIR
```

`GEMINI_API_KEY` is needed by the default embedding/code-intel path even when
the health endpoint can start without a provider call. `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` are conditional on provider selection.

`SYNTHI_AI_ENGINE_APP`, `SYNTHI_AI_ENGINE_HOST`, and
`SYNTHI_AI_ENGINE_WORKERS` are launcher settings. The launcher defaults the
application to `main:app` and the host to `0.0.0.0`.

### AI gateway

```text
GATEWAY_CLUSTER
GATEWAY_WORKERS
GATEWAY_PORT
GATEWAY_WS_PATH
BACKEND_URL
BACKEND_REQUEST_TIMEOUT_MS
AI_BACKEND_AUTH_TOKEN
GATEWAY_AUTH_TOKEN
GATEWAY_JWT_SECRET
AUTH_SECRET
NEXTAUTH_SECRET
GATEWAY_AUTH_DISABLED
GATEWAY_AUTH_ALLOW_INSECURE_LOCAL
GATEWAY_DEBUG_LOG_PAYLOADS
```

Local Compose disables gateway auth for the local stack. Kubernetes maps the
`AUTH_SECRET` Secret key into `GATEWAY_JWT_SECRET`; this is deployment wiring,
not a second secret that should be copied into source control.

## Signaling, worker, and GPU/HMR configuration

### Signaling server

```text
SIGNALING_PORT
REDIS_URL
NODE_ID
COLLAB_SERVER_URL
SYNTHI_AGENT_TOKEN_SECRET
SYNTHI_TURN_SECRET
SYNTHI_TURN_URLS
SYNTHI_TURN_TTL_SECONDS
```

`SIGNALING_PORT` defaults to `9000`, `REDIS_URL` defaults to local Redis, and
`NODE_ID` defaults to a generated UUID. The phase-four agent/TURN settings are
conditional.

### Worker service boundary

The worker receives many settings from the runtime launcher. The service-level
names are:

```text
SESSION_ID
SYNTHI_SESSION_ID
SIGNALING_URL
COLLAB_SERVER_URL
AI_BACKEND_URL
AI_BACKEND_AUTH_TOKEN
AI_ENGINE_AUTH_TOKEN
SYNTHI_REPOS_PATH
SYNTHI_GEMINI_MODEL
SYNTHI_LOG_LEVEL
SYNTHI_WORKER_VERBOSE
SYNTHI_VSCODE_VERBOSE
GST_DEBUG
DISPLAY
RUST_BACKTRACE
RUST_LIB_BACKTRACE
SYNTHI_GPU_VENDOR
SYNTHI_GPU_ARCH
SYNTHI_GPU_VENDOR_HINT
SYNTHI_GPU_ARCH_HINT
SYNTHI_GPU_HMR
HSA_ENABLE_DXG_DETECTION
SYNTHI_ISOLATION_MODEL
SYNTHI_MAX_CRASHES
SYNTHI_CRASH_SUPERVISOR
SYNTHI_ENABLE_GUARDRAILS
SYNTHI_NAMESPACE_ISOLATION
SYNTHI_SECCOMP_ENABLED
SYNTHI_CGROUP_LIMITS
SYNTHI_SECURITY_AUDIT
SYNTHI_COMPILE_CACHE_DIR
SYNTHI_WORKER_CACHE_DIR
SYNTHI_SYNC_BUILD_OUTPUTS
SYNTHI_SYNC_BUILD_OUTPUTS_MAX_FILES
SYNTHI_SYNC_BUILD_OUTPUTS_MAX_TOTAL_BYTES
SYNTHI_SYNC_BUILD_OUTPUTS_MAX_FILE_BYTES
SYNTHI_SYNC_BUILD_OUTPUTS_CHUNK_CHARS
SYNTHI_SYNC_MAX_FILES
SYNTHI_SYNC_MAX_TOTAL_BYTES
SYNTHI_SYNC_MAX_FILE_BYTES
SYNTHI_SYNC_CHUNK_CHARS
SYNTHI_AI_GPU_SPLIT_HTTP_TIMEOUT_SECS
SYNTHI_AI_HTTP_TIMEOUT_SECS
SYNTHI_AI_SPLIT_ROUTE_TIMEOUT_SECS
SYNTHI_CCACHE_DIR
SYNTHI_NO_CCACHE
SYNTHI_CLANG_OFFLOAD_BUNDLER
SYNTHI_DISABLE_PARALLEL_COMPILE
SYNTHI_GPU_HMR_ARTIFACT_LOADER_TRANSPORT
SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE
SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE_DIR
SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE_SCOPE
SYNTHI_GPU_HMR_DEVICE_COMPILE_TIMEOUT_SECS
SYNTHI_GPU_HMR_DEVICE_DEPFILE_CACHE
SYNTHI_GPU_HMR_DEVICE_FULL_COMPILE_TIMEOUT_SECS
SYNTHI_GPU_HMR_DEVICE_RELOAD_ACK_TIMEOUT_MS
SYNTHI_GPU_LAUNCH_WATCHDOG_MS
SYNTHI_JSON_LOGS
SYNTHI_LOADER_VALIDATION
SYNTHI_PATH_C_SUPERVISOR
SYNTHI_RUNNER_GPU_RELOAD_TERMINAL_TIMEOUT_MS
SYNTHI_RUNNER_POST_RELOAD_CRASH_PROBE_MS
SYNTHI_RUNNER_PROTOCOL_HANDSHAKE_TIMEOUT_MS
SYNTHI_RUNNER_RUNTIME_CONTROL_SESSION_ID
SYNTHI_RUNNER_RUNTIME_CONTROL_WRITE_TIMEOUT_MS
SYNTHI_GPU_HMR_RUNTIME_CONTROL_ACK_TIMEOUT_MS
SYNTHI_RUNNER_STDOUT_MODE
SYNTHI_STORAGE_SKIP_DOWNLOAD_IF_PRESENT
SYNTHI_STRICT_ABI
SYNTHI_SUPERVISED
SYNTHI_SUPERVISOR_PID
SYNTHI_TEST_GPU_ARCH
SYNTHI_TEST_REAL_ROCM_COLD_COMPILE
SYNTHI_UNSAFE_INPROCESS
SYNTHI_WORKSPACE_FILE_REF_TOTAL_BYTES_LIMIT
SYNTHI_XVFB_DISPLAY
SYNTHI_ANDROID_720P
SYNTHI_ANDROID_CAPTURE_XID
SYNTHI_ANDROID_CROP_ASPECT
SYNTHI_ANDROID_CROP_RIGHT_PX
SYNTHI_ANDROID_EMULATOR_GPU
SYNTHI_ANDROID_GRPC_HOST
SYNTHI_ANDROID_GRPC_PORT
SYNTHI_ANDROID_GRPC_TOKEN_PATH
SYNTHI_ANDROID_GRPC_USE_TOKEN
SYNTHI_ANDROID_LEFT_PAD_PX
SYNTHI_ANDROID_LOGCAT_FILTER
SYNTHI_ANDROID_STREAM_MODE
SYNTHI_ANDROID_STREAM_SECS
SYNTHI_ANDROID_TOOLBAR_PAD_PX
SYNTHI_ANDROID_TOOLBAR_WIDTH
SYNTHI_ANDROID_USE_HOST_DISPLAY
SYNTHI_ANDROID_XVFB_DISPLAY
SYNTHI_ANDROID_XVFB_RESOLUTION
SYNTHI_MOBILE_FORCE_REDOWNLOAD
```

The GPU HMR proof path adds command-specific cache, readback, oracle, capture,
and runtime-control names. Those names are not common application credentials;
they are listed under command-specific proof configuration below so a normal
Compose environment is not mistaken for a proof harness.

## Docker Compose settings

The root [`docker-compose.yml`](../docker-compose.yml) reads these names for
interpolation, build arguments, or service environment. Values with defaults
do not need to be added for a normal local boot, but explicit values are useful
when host ports or runtime behavior must be changed.

### Host ports and local stack controls

```text
POSTGRES_HOST_PORT
REDIS_HOST_PORT
YSWEET_HOST_PORT
COLLAB_HOST_PORT
SIGNALING_HOST_PORT
AI_GATEWAY_HOST_PORT
AI_ENGINE_HOST_PORT
FRONTEND_HOST_PORT
COTURN_HOST_PORT
COTURN_RELAY_PORT_MIN
COTURN_RELAY_PORT_MAX
MCP_METRICS_HOST_PORT
DOCKER_SOCKET_GID
SYNTHI_RUNTIME_SHARED_GID
NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS
SYNTHI_CODESITE_TOKEN
COLLAB_INTERNAL_TOKEN
AUTH_SECRET
NEXTAUTH_SECRET
SYNTHI_GEMINI_MODEL
AI_ENGINE_AUTH_DISABLED
VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES
WORKER_CARGO_FEATURES
INSTALL_ROCM
SYNTHI_GPU_HMR
HSA_ENABLE_DXG_DETECTION
```

Compose sets many service URLs, local TURN values, Redis values, container
names, and internal network addresses itself. Those fixed values should not be
duplicated in `.env.local` unless a service is being run outside Compose.

### Proof authority Compose pass-through

```text
SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID
SYNTHI_CODESITE_PROOF_AUTHORITY_NAME
SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET
SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM
SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON
SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE
SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY
```

## Kubernetes, ExternalSecrets, Cloud Run, and Cloud Build

### Kubernetes ConfigMap and Secret wiring

The deployment manifests use the following non-sensitive ConfigMap values:

```text
GCP_PROJECT_ID
GCS_BUCKET_NAME
GCS_WORKSPACE_PREFIX
COLLAB_SERVER_URL
YSWEET_URL
CODE_INTEL_URL
BACKEND_URL
SIGNALING_URL
REDIS_URL
SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL
SYNTHI_BROWSER_WORKFLOW_BRIDGE_TARGET_TEMPLATE
SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT
SYNTHI_HOSTED_BROWSER_CDP_PORT
SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE
SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY
SYNTHI_HOSTED_BROWSER_VIEW_PORT
SYNTHI_HOSTED_BROWSER_VNC_PORT
SYNTHI_PREVIEW_TARGET_TEMPLATE
SYNTHI_PREVIEW_PUBLIC_PREFIX
SYNTHI_PREVIEW_PUBLIC_DOMAIN
SYNTHI_PREVIEW_PUBLIC_PROTOCOL
SYNTHI_PREVIEW_SIDECAR_IMAGE
SYNTHI_PREVIEW_SIDECAR_PORT
SYNTHI_PREVIEW_SCAN_PORTS
SYNTHI_PREVIEW_EXCLUDE_PORTS
SYNTHI_PREVIEW_PORT_PROBE_TIMEOUT_MS
SYNTHI_BROWSER_EXTERNAL_OPEN_BODY_LIMIT_BYTES
SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS
NEXTAUTH_URL
CORS_ORIGIN
SYNTHI_PUBLIC_APP_URL
SYNTHI_APP_INTERNAL_URL
SYNTHI_CODESITE_API_BASE_URL
NEXT_PUBLIC_COLLAB_SERVER_URL
NEXT_PUBLIC_YSWEET_URL
NEXT_PUBLIC_COLLAB_PORT
NEXT_PUBLIC_COMPILE_SIGNAL_URL
NEXT_PUBLIC_GATEWAY_WS_URL
NEXT_PUBLIC_CODE_INTEL_URL
NEXT_PUBLIC_AI_ENGINE_URL
NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER
NEXT_PUBLIC_SYNTHI_LOOPBACK_AUTH_BRIDGE_PATH
NEXT_PUBLIC_VECTANT_OAUTH_RELAY_EXTENSION_URL
SYNTHI_OAUTH_RELAY_TTL_MS
SYNTHI_WORKSPACE_DATA_VOLUME
SYNTHI_WORKSPACE_DATA_PVC
SYNTHI_REPOS_PATH
SYNTHI_WORKSPACE_REPOS_PATH
WORKER_IMAGE
RUNTIME_IMAGE
WORKER_LOG_LEVEL
WORKER_GST_DEBUG
SYNTHI_LOG_LEVEL
SYNTHI_ISOLATION_MODEL
GCS_SYNC_ON_FLUSH
CODE_INTEL_AUTO_INDEX
```

Secret or ExternalSecret-backed names include:

```text
DATABASE_URL
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
AUTH_SECRET
NEXTAUTH_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_ID
GITHUB_SECRET
GCP_CLIENT_EMAIL
GCP_PRIVATE_KEY
CLOUDFLARE_TURN_TOKEN_ID
CLOUDFLARE_TURN_API_TOKEN
AI_BACKEND_AUTH_TOKEN
SYNTHI_RUNTIME_ID_SECRET
SYNTHI_TOKEN_ENCRYPTION_KEY
SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN
SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY
SYNTHI_AUTH_CHECKPOINT_STORE_KEY
GEMINI_API_KEY
OPENAI_API_KEY
YSWEET_AUTH_KEY
SYNTHI_CODESITE_TOKEN
COLLAB_INTERNAL_TOKEN
SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET
```

`k8s/external-secrets.yaml` maps these environment names to remote Secret
Manager object names. The remote object name is not an additional environment
variable.

### Dojo release overlay wiring

[`k8s/overlays/dojo-release-gate/dojo-release-config.yaml`](../k8s/overlays/dojo-release-gate/dojo-release-config.yaml)
sets:

```text
SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1
SYNTHI_DOJO_REQUIRE_DURABLE_STORE=1
SYNTHI_DOJO_CONTROL_PLANE_STORE=postgres
SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING=1
SYNTHI_DOJO_PROOF_SIGNING_PROVIDER=managed-key-service
SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER=1
SYNTHI_DOJO_EVIDENCE_LEDGER_STORE=postgres
SYNTHI_DOJO_MCP_MANIFEST_ISSUER=<deployment issuer>
SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM=ed25519
SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED=0
SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST=<JSON or configured allowlist>
SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS=<no more than 3600000>
SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS=true
SYNTHI_TENANT_ID=<tenant>
```

The overlay ExternalSecret additionally provisions:

```text
SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL
SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL
SYNTHI_DOJO_PROOF_SIGNING_KEY_ID
SYNTHI_DOJO_PROOF_SIGNING_COMMAND
SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS
SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI
SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM
SYNTHI_DOJO_MCP_MANIFEST_KEY_ID
SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM
SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM
SYNTHI_DOJO_MCP_BEARER_TOKEN
REDIS_URL
SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE
SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE
SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY
SYNTHI_AUTH_CHECKPOINT_STORE_FILE
SYNTHI_AUTH_CHECKPOINT_SCOPE
SYNTHI_AUTH_CHECKPOINT_STORE_KEY
```

The overlay comments state that therapeutic production secrets were removed
until the external secrets exist. Enabling the flag without recreating that
secret contract will fail readiness.

### Cloud Run and Cloud Build notes

Cloud Build substitutions are deployment parameters rather than application
`.env` names:

```text
_REGION
_GKE_CLUSTER
_GKE_ZONE
_REGISTRY
_MANIFEST_SOURCE_REGISTRY
_IMAGE_TAG
_KUSTOMIZE_DIR
_KUSTOMIZE_LOAD_RESTRICTOR
_DOJO_RELEASE_KUSTOMIZE_DIR
_NEXT_PUBLIC_COLLAB_SERVER_URL
_NEXT_PUBLIC_YSWEET_URL
_NEXT_PUBLIC_COLLAB_PORT
_NEXT_PUBLIC_COMPILE_SIGNAL_URL
_NEXT_PUBLIC_GATEWAY_WS_URL
_NEXT_PUBLIC_CODE_INTEL_URL
_NEXT_PUBLIC_AI_ENGINE_URL
_NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER
_NEXT_PUBLIC_SYNTHI_LOOPBACK_AUTH_BRIDGE_PATH
_WORKER_INSTALL_ROCM
_ENABLE_VULNERABILITY_SCAN
```

Legacy Cloud Run manifests need special attention:

| Manifest | Finding |
| --- | --- |
| `cloudrun/ai-engine.service.yaml` | Injects `GOOGLE_AI_API_KEY`, but the current AI engine source reads `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Treat `GOOGLE_AI_API_KEY` as a legacy wiring mismatch until that manifest is migrated. |
| `cloudrun/frontend.service.yaml` | Injects frontend URLs, auth, OAuth, database, internal-token, and TURN settings. |
| `cloudrun/ai-gateway.service.yaml` | Sets gateway port/path/cluster/backend values. |

## Local support and release signing

These are not needed for the basic CodeSite/Dojo runtime unless local-support
or desktop updater features are enabled.

### Local-support runtime

```text
VECTANT_LOCAL_SUPPORT_DEVICE_IDENTITY_PATH
VECTANT_LOCAL_SUPPORT_AUDIT_PATH
VECTANT_TEST_DAEMON_READY_FILE
VECTANT_TEST_DAEMON_KEEP_ALIVE
VECTANT_LOCAL_SUPPORT_PAIRING_URL
VECTANT_LOCAL_SUPPORT_RELAY_URL
VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN
VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET
VECTANT_LOCAL_SUPPORT_ORG_ID
VECTANT_LOCAL_SUPPORT_LOCAL_API_URL
VECTANT_LOCAL_SUPPORT_TEST_REQUESTS
VECTANT_LOCAL_SUPPORT_ENABLED
VECTANT_LOCAL_SUPPORT_LOCAL_BEARER
VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET
VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON
```

### Desktop/updater release credentials

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
WINDOWS_PFX_BASE64
WINDOWS_PFX_PASSWORD
UPDATER_PUBLIC_KEY
UPDATER_ENDPOINT
```

These belong in CI or a release-secret manager, not in a shared developer
`.env` file.

## Command-specific CodeSite, Dojo, Fleet, and proof variables

The repository contains many proof and release scripts. They deliberately set
or read their own environment so the command can bind its output to a specific
run. These values are not common service configuration.

### CodeSite proof and release commands

```text
CODESITE_PROOF_BASE_URL
CODESITE_PROOF_WORKSPACE_SLUG
CODESITE_PROOF_OUT_DIR
CODESITE_PROOF_ROOT
CODESITE_PROOF_TMPDIR
CODESITE_BROWSER_TMPDIR
CODESITE_PROOF_AUTH_COOKIE
CODESITE_PROOF_AUTH_SECRET
CODESITE_PROOF_USER_ID
CODESITE_PROOF_COLLAB_URL
CODESITE_PROOF_COLLAB_CONTROL_PLANE_URL
CODESITE_PROOF_APP_REPO_ROOT
CODESITE_PROOF_APP_ARTIFACT_BASE
CODESITE_PROOF_APP_ARTIFACT_ROOT
CODESITE_PROOF_APP_ARTIFACT_HOST_ROOT
CODESITE_PROOF_CONTAINER_WORKSPACE_ROOT
CODESITE_PROOF_RUNTIME_IMAGE
CODESITE_PROOF_SCREENSHOT_IMAGE
CODESITE_PROOF_TRUSTED_KEYS_PATH
CODESITE_PROOF_AGENT_EXECUTION_EVIDENCE_DIR
CODESITE_PROOF_CODEX_CLI_PATH
CODESITE_PROOF_CODEX_AGENT_HOME
CODESITE_PROOF_CODEX_AGENT_TIMEOUT_MS
CODESITE_PROOF_CODEX_THREAD_ID
CODESITE_PROOF_CODEX_PROVIDER_SESSION_REFS
CODESITE_RELEASE_GATE_INPUT
CODESITE_RELEASE_GATE_OUT
CODESITE_RELEASE_GATE_HTML
CODESITE_RELEASE_GATE_PNG
CODESITE_RELEASE_GATE_MINIMUM_ASSERTIONS
CODESITE_RELEASE_GATE_REQUIRE_MATURE_SUITE_RUN
CODESITE_RELEASE_GATE_TRUSTED_KEYS_PATH
CODESITE_UI_PROOF_COMMAND
CODESITE_UI_PROOF_NEXT_CLI
CODESITE_UI_PROOF_PORT
CODESITE_UI_PROOF_GIT_HEAD
CODESITE_UI_PROOF_GIT_BRANCH
CODESITE_UI_PROOF_GIT_STATUS
CODESITE_UNMANAGED_HOST_BOUNDARY_IMAGE
CODESITE_HOST_PREWRITE_GUARD_SOURCE_ROOT
CODESITE_DOCKER_RUNTIME
CODESITE_WORKSPACE_OVERLAY
CODESITE_WRITE_DENIED
```

`CODESITE_WRITE_DENIED` is an expected proof/error code in some scripts, not a
normal configuration key. Likewise, `SYNTHI_CODESITE_SHADOW_WORKTREE` is
generated internally by the shadow runner.

### Dojo release and conformance commands

```text
SYNTHI_DOJO_POSTGRES_TEST_URL
SYNTHI_DOJO_MCP_HOST_URL
SYNTHI_DOJO_MCP_BEARER_HEADER
SYNTHI_DOJO_MCP_BEARER_TOKEN
SYNTHI_DOJO_MCP_CONFORMANCE_APP_ORIGIN
SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE
SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING
SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED
SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE
SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_TTL_MS
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_CREDENTIAL_TTL_MS
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_LOCAL_NETWORK_ALLOWED
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_REDACT_SCREENSHOTS
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_SENSITIVE_WORKSPACE
SYNTHI_DOJO_MCP_CONFORMANCE_TENANT_CONTEXT_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_TENANT_ID
SYNTHI_DOJO_MCP_CONFORMANCE_ORGANIZATION_ID
SYNTHI_DOJO_MCP_CONFORMANCE_WORKSPACE_ID
SYNTHI_DOJO_MCP_CONFORMANCE_ACTOR_ID
SYNTHI_DOJO_MCP_CONFORMANCE_ACTOR_TYPE
SYNTHI_DOJO_MCP_CONFORMANCE_ROLES_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_ROLES
SYNTHI_DOJO_MCP_CONFORMANCE_REQUEST_ID
SYNTHI_DOJO_MCP_CONFORMANCE_CORRELATION_ID
SYNTHI_DOJO_MCP_CONFORMANCE_MCP_COMMAND
SYNTHI_DOJO_MCP_CONFORMANCE_MCP_ARGS_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_MCP_CWD
SYNTHI_DOJO_MCP_CONFORMANCE_ALLOW_CUSTOM_STDIO_HOST
SYNTHI_DOJO_MCP_CONFORMANCE_CONTEXT_CLAIMS_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_EVIDENCE_CLAIMS_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_EVIDENCE_MAX_AGE_MS
SYNTHI_DOJO_MCP_CONFORMANCE_EVIDENCE_RECORD_IDS
SYNTHI_DOJO_MCP_CONFORMANCE_EXECUTE_PRODUCTION
SYNTHI_DOJO_MCP_CONFORMANCE_LEDGER_CHECKPOINT_HASH
SYNTHI_DOJO_MCP_CONFORMANCE_OUT_DIR
SYNTHI_DOJO_MCP_CONFORMANCE_PUBLISHED_TOOL_NAME
SYNTHI_DOJO_MCP_CONFORMANCE_RAW_TOOL_ARGS_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_REQUESTED_ACTION
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_BRIDGE_TOKEN
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_EXTERNAL_CONTROL_PLANE_STORE
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_EXTERNAL_PROOF_SIGNING
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_LICENSED_SKILL_FILTERING
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_NO_LOCAL_CDP
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_NON_LOOPBACK_HOST
SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_VERIFIED_EVIDENCE
SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_ACTOR_ID
SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_ACTOR_TYPE
SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_EVIDENCE_REFS
SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_REASON
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_ACTION_URL
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_CREDENTIAL_ID
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_CREDENTIAL_SECRET
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_ID
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_ORIGIN_ALLOWLIST
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_RUN_ID
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_SESSION_ID
SYNTHI_DOJO_MCP_CONFORMANCE_RUNTIME_WORKSPACE_URL
SYNTHI_DOJO_MCP_CONFORMANCE_SELF_CHECK
SYNTHI_DOJO_MCP_CONFORMANCE_SKILL_ID
SYNTHI_DOJO_MCP_CONFORMANCE_SKIP_RAW_BACKING_TOOL_CHECK
SYNTHI_DOJO_MCP_CONFORMANCE_SUBSTRATE_CLAIM
SYNTHI_DOJO_MCP_CONFORMANCE_TIMEOUT_MS
SYNTHI_DOJO_MCP_CONFORMANCE_TOOL_ARGS_JSON
SYNTHI_DOJO_MCP_CONFORMANCE_TRANSPORT
SYNTHI_DOJO_MCP_CONFORMANCE_WORKFLOW_ID
SYNTHI_DOJO_AFFORDANCE_PR_BASE_REF
SYNTHI_DOJO_DOCKER_PORTS_URL
SYNTHI_DOJO_DOCKER_SKIP_UP
SYNTHI_DOJO_DOCKER_WORKSPACE_URL
SYNTHI_DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PATH
SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH
SYNTHI_DOJO_MCP_IAP_BEARER_TOKEN
SYNTHI_DOJO_POSTGRES_MIGRATION_OUT_DIR
SYNTHI_DOJO_POSTGRES_MIGRATION_TARGETS
SYNTHI_DOJO_PROOF_SELF_CHECK_OUT_DIR
SYNTHI_DOJO_PROOF_SELF_CHECK_RUN_ID
SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_PATH
SYNTHI_DOJO_PROOF_SIGNING_TIMEOUT_MS
SYNTHI_DOJO_RELEASE_EXPECTED_MCP_BEARER_HEADER
SYNTHI_DOJO_RELEASE_EXPECTED_MCP_HOST
SYNTHI_DOJO_RELEASE_EXPECTED_MCP_IMAGE
SYNTHI_DOJO_RELEASE_EXPECTED_MCP_PATH
SYNTHI_DOJO_RELEASE_EXPECTED_MCP_PORT
SYNTHI_DOJO_SELF_CHECK_CODE_OWNER
SYNTHI_DOJO_RELEASE_COMPETENCY_SEED_OUT_DIR
SYNTHI_DOJO_RELEASE_SEED_TENANT_ID
SYNTHI_DOJO_RELEASE_SEED_WORKSPACE_ID
SYNTHI_DOJO_RELEASE_SEED_ACTOR_ID
SYNTHI_DOJO_RELEASE_SEED_ACTOR_TYPE
SYNTHI_DOJO_RELEASE_SEED_ORGANIZATION_ID
SYNTHI_DOJO_RELEASE_SEED_ROLES_JSON
SYNTHI_DOJO_RELEASE_SEED_ROLES
SYNTHI_DOJO_RELEASE_SEED_REQUEST_ID
SYNTHI_DOJO_RELEASE_SEED_CORRELATION_ID
SYNTHI_DOJO_RELEASE_SEED_URL
SYNTHI_DOJO_RELEASE_SEED_EVIDENCE_REFS
SYNTHI_DOJO_RELEASE_SEED_NAME
SYNTHI_DOJO_RELEASE_SEED_REASON
SYNTHI_DOJO_RELEASE_SEED_TAB_ID
SYNTHI_DOJO_RELEASE_SEED_ACTION
SYNTHI_DOJO_RELEASE_SEED_ROLE
SYNTHI_DOJO_RELEASE_SEED_STABLE_ENTITY_LABEL
SYNTHI_DOJO_RELEASE_SEED_SOURCE_ID
SYNTHI_DOJO_RELEASE_SEED_SOURCE_FILE_PATH
SYNTHI_DOJO_RELEASE_SEED_SOURCE_LINE
SYNTHI_DOJO_RELEASE_SEED_SOURCE_COLUMN
SYNTHI_DOJO_RELEASE_SEED_SOURCE_TAG
SYNTHI_DOJO_RELEASE_SEED_APP_ORIGIN
SYNTHI_DOJO_SOAK_ITERATIONS
SYNTHI_DOJO_SOAK_EVENTS_PATH
SYNTHI_DOJO_GHOST_VISUAL_PORT
SYNTHI_DOJO_VISUAL_PORT
SYNTHI_DOJO_VISUAL_TURBOPACK
SYNTHI_THERAPEUTIC_PROD_SERVICE_NAME
SYNTHI_THERAPEUTIC_PROD_STORE_READ_URL_TEMPLATE
SYNTHI_THERAPEUTIC_PROD_TIME_WINDOW
```

### GPU/HMR proof command settings

GPU HMR proof settings are intentionally separate from ordinary application
configuration. The exact names vary by proof script, but the scanned command
families include:

```text
SYNTHI_GPU_HMR_FIXTURE
SYNTHI_GPU_WORKER_IMAGE
SYNTHI_WORKER_GPU_IMAGE
SYNTHI_GPU_DISPLAY_DRI
SYNTHI_GPU_DISPLAY_FRAMEBUFFER
SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH
SYNTHI_GPU_HMR_RUNTIME_CAPTURE_PATH
SYNTHI_GPU_HMR_RUNTIME_CONTROL_PATH
SYNTHI_GPU_HMR_RUNTIME_READY_PATH
SYNTHI_GPU_HMR_RUNTIME_EPOCH_PATH
SYNTHI_GPU_HMR_RUNTIME_DISPATCH_PATH
SYNTHI_GPU_HMR_RUNTIME_READBACK_PATH
SYNTHI_GPU_HMR_RUNTIME_LEDGER_PATH
SYNTHI_COMPILE_CACHE_DIR
SYNTHI_WORKER_CACHE_DIR
ROCM_PATH
ROCM_HOME
CUDA_HOME
CUDA_PATH
HSA_OVERRIDE_GFX_VERSION
LD_LIBRARY_PATH
LIBRARY_PATH
SYNTHI_GPU_AGENT_SOURCE_ROOT
SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH
SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
SYNTHI_GPU_AGENT_SOURCE_COMMIT
SYNTHI_GPU_AGENT_SOURCE_AUTHORITY
SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH
SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
SYNTHI_GPU_AGENT_DIRECT_SOURCE_COMMIT
SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY
```

The worker Dockerfile build arguments `WORKER_CARGO_FEATURES`, `INSTALL_ROCM`,
`ROCM_VERSION`, `ROCM_UBUNTU_CODENAME`, `ROCDXG_VERSION`, `NODE_VERSION`, and
`RUSTUP_VERSION` are image-build inputs, not runtime `.env` requirements.

## Variables that should not be added to the common `.env`

The whole-repository scan also finds names that are inherited or generated.
They are recorded here so they are not confused with missing application
configuration:

```text
PATH
HOME
SHELL
COMSPEC
APPDATA
LOCALAPPDATA
SYSTEMROOT
WINDIR
LANG
LC_ALL
NODE_ENV
CI
VITEST_WORKER_ID
KUBERNETES_SERVICE_HOST
ANDROID_HOME
ANDROID_SDK_ROOT
SYNTHI_ANDROID_SDK_ROOT
DART_HOME
DART_SDK
FLUTTER_HOME
FLUTTER_ROOT
FLUTTER_SDK
JAVA_HOME
GRADLE_HOME
SYNTHI_JAVA_HOME
SYNTHI_GRADLE_USER_HOME
SYNTHI_NPM_CACHE_DIR
PUB_CACHE
CARGO_HOME
CARGO_MANIFEST_DIR
CXX
RUSTUP_HOME
USERPROFILE
XDG_CACHE_HOME
```

SDK paths can be supplied by a worker image or local shell when the associated
toolchain is used. They are not universal Synthi service credentials.

## Known gaps and inconsistencies

| Finding | Impact | Action |
| --- | --- | --- |
| Five local root keys are absent from `.env.example`: `GCP_PROJECT_ID`, `GCS_BUCKET_NAME`, `NEXT_PUBLIC_GATEWAY_WS_URL`, `NEXTAUTH_URL`, `SYNTHI_AI_MODEL`. | A copied example can boot with fallback behavior or fail later when GCS, auth callbacks, gateway WebSocket, or the selected AI model is used. | Add the names to the local deployment file used by the selected services. |
| Root Compose uses root `.env` for interpolation but explicit `.env.local` for frontend and AI-engine `env_file`. | Provider/auth keys in root `.env` may not reach those containers. | Put container credentials in `.env.local` or change deployment wiring deliberately. |
| CodeSite warrants use `SYNTHI_CODESITE_WARRANT_*`; MCP warrants use `SYNTHI_WARRANT_*`. | Configuring one namespace does not configure the other. | Set both sets when both the Next CodeSite control plane and MCP tool gate are enabled. |
| Dojo production store, signer, ledger, manifest, bearer, and hosted-browser settings are mostly absent from the root example. | Dojo can boot in development but fail release readiness or refuse production proof. | Use the Dojo release ConfigMap and ExternalSecret contract. |
| `GOOGLE_AI_API_KEY` appears in the root example and legacy Cloud Run AI-engine manifest. | Current AI-engine source uses `GEMINI_API_KEY` or `GOOGLE_API_KEY`; the legacy name can leave the provider effectively unconfigured. | Migrate the Cloud Run manifest or add an explicit compatibility mapping. |
| `backend/backend/collab-server/.env.example` duplicates an older collab template. | Developers can configure the wrong set of names. | Use `backend/collab-server/.env.example` and the canonical `config.js`. |
| Therapeutic production ExternalSecret entries were removed while the feature flag is `0`. | Turning the feature on without restoring those secrets fails readiness. | Recreate the external secret contract before enabling the flag. |
| `SYNTHI_WARRANT_STORE` is explicitly forbidden in MCP production. | A local encrypted journal is not a production authority. | Use the CodeSite/hosted authority and durable deployment stores. |
| Fleet NOTAMs have no separate secret namespace. | Adding guessed Fleet credentials will not make publication work. | Provision database migrations, CodeSite authorization, proof evidence, and the route cap. |

## Source map

The inventory was cross-checked against these canonical sources and deployment
files:

- [`.env.example`](../.env.example)
- [`docker-compose.yml`](../docker-compose.yml)
- [`synthi/src/lib/codesite/runtimeConfig.js`](../synthi/src/lib/codesite/runtimeConfig.js)
- [`synthi/src/lib/codesite/controlPlane.js`](../synthi/src/lib/codesite/controlPlane.js)
- [`synthi/src/lib/codesite/warrantAuthority.js`](../synthi/src/lib/codesite/warrantAuthority.js)
- [`synthi/src/lib/codesite/warrantAuditSigner.js`](../synthi/src/lib/codesite/warrantAuditSigner.js)
- [`synthi/src/lib/codesite/fleetNotams.js`](../synthi/src/lib/codesite/fleetNotams.js)
- [`synthi/src/lib/codesite/proof.js`](../synthi/src/lib/codesite/proof.js)
- [`synthi/src/lib/codesite/deliverySecurity.js`](../synthi/src/lib/codesite/deliverySecurity.js)
- [`synthi/src/lib/codesite/activityBridgeReadiness.js`](../synthi/src/lib/codesite/activityBridgeReadiness.js)
- [`backend/collab-server/config.js`](../backend/collab-server/config.js)
- [`ai-backend/ai-engine/main.py`](../ai-backend/ai-engine/main.py)
- [`ai-backend/gateway/server.js`](../ai-backend/gateway/server.js)
- [`mcp/synthi-mcp/src/tools/warrant.ts`](../mcp/synthi-mcp/src/tools/warrant.ts)
- [`mcp/synthi-mcp/src/dojo/config/enforcement.ts`](../mcp/synthi-mcp/src/dojo/config/enforcement.ts)
- [`mcp/synthi-mcp/src/dojo/mcp/manifest_signing.ts`](../mcp/synthi-mcp/src/dojo/mcp/manifest_signing.ts)
- [`mcp/synthi-mcp/src/browser/deployment_readiness.ts`](../mcp/synthi-mcp/src/browser/deployment_readiness.ts)
- [`mcp/synthi-mcp/src/http.ts`](../mcp/synthi-mcp/src/http.ts)
- [`mcp/synthi-mcp/.env.example`](../mcp/synthi-mcp/.env.example)
- [`k8s/configmap.yaml`](../k8s/configmap.yaml)
- [`k8s/external-secrets.yaml`](../k8s/external-secrets.yaml)
- [`k8s/overlays/dojo-release-gate/dojo-release-config.yaml`](../k8s/overlays/dojo-release-gate/dojo-release-config.yaml)
- [`k8s/overlays/dojo-release-gate/dojo-release-external-secrets.yaml`](../k8s/overlays/dojo-release-gate/dojo-release-external-secrets.yaml)
- [`cloudbuild.yaml`](../cloudbuild.yaml)
- [`cloudrun/ai-engine.service.yaml`](../cloudrun/ai-engine.service.yaml)

Generated `dist`, `.next`, dependency, temporary-output, and fixture files were
not treated as independent runtime configuration sources. Their command-only
and test-only names were retained above when they describe a real proof or
release contract.
