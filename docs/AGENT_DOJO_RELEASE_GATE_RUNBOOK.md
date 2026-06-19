# Agent Dojo Release Gate Runbook

This runbook explains how to prove the mature Agent Dojo release gates without
turning missing external systems into fake local evidence.

The source of truth for gate definitions is:

```text
mcp/synthi-mcp/scripts/dojo-release-gate-manifest.mjs
```

The source of truth for a specific run is the runner report and evidence
manifest produced by:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure --fail-on-missing-env
```

## Local Gate Baseline

For a full local enterprise gate run using the current local Postgres and Docker
fixtures, set the local-only release inputs first:

```powershell
$env:SYNTHI_DOJO_POSTGRES_TEST_URL='postgres://synthi:password@127.0.0.1:15432/synthi'
$env:NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS='1'
$env:AI_ENGINE_HOST_PORT='8081'
$env:POSTGRES_HOST_PORT='15432'
$env:SYNTHI_DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PATH="$PWD\tmp\dojo-hosted-runtime-gateway-release-observation\hosted-runtime-gateway-release-observation.json"
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure --fail-on-missing-env
node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --release-gate-run-report tmp/dojo-release-gate-runner/dojo-release-gate-runner-report.json --release-gate-run-evidence tmp/dojo-release-gate-runner/dojo-release-gate-runner.evidence.json
```

This proves the runnable local gates. It does not prove hosted CDP, deployed MCP
host conformance, real managed-key signing, live chaos, or a real soak session
unless those external inputs are configured.

## Fail-Closed Missing-Env Audit

Use this command before claiming a release candidate. It turns missing required
environment into failed gate results instead of skipped gates:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --dry-run --fail-on-missing-env --out-dir tmp/dojo-release-gate-runner-enterprise-missing-env-audit
```

With the local-only inputs above set, the only remaining blockers should be
external release gates. The report must have:

```text
ok=false
promotion_ready=false
failed > 0 when external release inputs are absent
```

## Release Harness Preflight

Run these before any live Google Cloud evidence collection. They validate the
release manifest, runner, verifier, package contents, and kustomize overlay
without deploying:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:runner:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:verify:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:package-readiness:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:kustomize-overlay:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:kustomize-overlay
```

## Google Cloud Hosting Runbook

This section describes the concrete Google Cloud path for producing external
release evidence. The local self-checks prove that gates fail closed. They do
not replace a deployed Google Cloud run.

### Production Target

The repository already contains the primary Google Cloud deployment shape:

- GKE for the core application, MCP runtime, worker control, collaboration
  services, AI gateway, and signaling.
- Artifact Registry for container images.
- Cloud Build for image builds, vulnerability scans, and GKE rollout.
- Workload Identity for GKE service account access to Google Cloud APIs.
- Secret Manager plus External Secrets Operator for runtime secrets.
- Cloud SQL for production Postgres state.
- Memorystore for production Redis state.
- GCS for workspace files, generated artifacts, evidence exports, and release
  evidence bundles.
- HTTPS load balancing, managed certificate, DNS, and optional Cloud Armor for
  public endpoints.
- A non-loopback hosted browser runtime and non-loopback MCP host for release
  conformance.
- A managed proof-signing service whose private key custody is outside the Node
  process.

Do not use the in-cluster Postgres and Redis manifests as enterprise production
proof. They are useful for beta, local, and controlled staging validation, but
release evidence for mature Dojo must use external durable services.

### One-Time Google Cloud Variables

Set these in the shell used for provisioning and release gates. Adjust values
for the target environment.

```powershell
$env:PROJECT_ID = "vectant-proj"
$env:REGION = "europe-west10"
$env:ZONE = "europe-west10-a"
$env:CLUSTER = "synthi-beta-cluster"
$env:K8S_NAMESPACE = "synthi"
$env:AR_REPO = "synthi"
$env:DOMAIN = "beta.vectant.dev"
$env:GCS_BUCKET = "vectant-synthi-cloud-storage"
$env:CLOUD_SQL_INSTANCE = "synthi-prod-postgres"
$env:REDIS_INSTANCE = "synthi-prod-redis"

gcloud config set project $env:PROJECT_ID
gcloud config set compute/region $env:REGION
gcloud config set compute/zone $env:ZONE
```

If Google Cloud SDK or `kubectl` is installed but not on `PATH`, set
`GCLOUD_BIN` and `KUBECTL_BIN` before running local inventory scripts:

```powershell
$env:GCLOUD_BIN = "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$env:KUBECTL_BIN = "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\kubectl.cmd"
```

### Read-Only Hosted Inventory

Before creating or changing any Google Cloud resource, run a read-only
inventory against the authenticated project. This verifies what is already
implemented in production and writes redacted evidence that can be compared with
the remaining release blockers.

First validate the inventory script without Google Cloud access:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:gcp-release-inventory:self-check
```

Prepare the expected secret inventory flags. Keep this list aligned with
`k8s/external-secrets.yaml` and
`k8s/overlays/dojo-release-gate/dojo-release-external-secrets.yaml`.
`--expected-k8s-secret` checks the Kubernetes Secret object name,
`--expected-secret-manager-secret` checks Google Secret Manager remote secret
names, and `--expected-external-secret-binding` checks the full
`ExternalSecret object -> target Kubernetes Secret -> secretKey -> remoteRef.key`
mapping without reading payloads.

```powershell
$dojoSecretInventoryFlags = @(
  "--expected-k8s-secret=synthi-secrets"
  "--expected-external-secret=synthi-secrets"
  "--expected-external-secret=synthi-dojo-release-secrets"
  "--expected-secret-manager-secret=synthi-database-url"
  "--expected-secret-manager-secret=synthi-redis-url"
  "--expected-secret-manager-secret=synthi-dojo-control-plane-postgres-url"
  "--expected-secret-manager-secret=synthi-dojo-evidence-ledger-postgres-url"
  "--expected-secret-manager-secret=synthi-dojo-proof-signing-key-id"
  "--expected-secret-manager-secret=synthi-dojo-proof-signing-command"
  "--expected-secret-manager-secret=synthi-dojo-proof-signing-command-args"
  "--expected-secret-manager-secret=synthi-dojo-proof-signing-managed-key-uri"
  "--expected-secret-manager-secret=synthi-dojo-proof-signing-public-key-pem"
  "--expected-secret-manager-secret=synthi-dojo-mcp-manifest-key-id"
  "--expected-secret-manager-secret=synthi-dojo-mcp-manifest-private-key-pem"
  "--expected-secret-manager-secret=synthi-dojo-mcp-manifest-public-key-pem"
  "--expected-secret-manager-secret=synthi-dojo-mcp-bearer-token"
  "--expected-secret-manager-secret=synthi-dojo-hosted-browser-cdp-url"
  "--expected-secret-manager-secret=synthi-dojo-hosted-browser-workspace-url"
  "--expected-secret-manager-secret=synthi-dojo-release-workspace-id"
  "--expected-secret-manager-secret=synthi-dojo-release-agent-id"
  "--expected-secret-manager-secret=synthi-private-workflow-tool-store-key"
  "--expected-secret-manager-secret=synthi-private-workflow-tool-store-file"
  "--expected-secret-manager-secret=synthi-private-workflow-tool-scope"
  "--expected-secret-manager-secret=synthi-auth-checkpoint-store-key"
  "--expected-secret-manager-secret=synthi-auth-checkpoint-store-file"
  "--expected-secret-manager-secret=synthi-auth-checkpoint-scope"
  "--expected-external-secret-binding=synthi-secrets:synthi-secrets:DATABASE_URL=synthi-database-url"
  "--expected-external-secret-binding=synthi-secrets:synthi-secrets:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY=synthi-private-workflow-tool-store-key"
  "--expected-external-secret-binding=synthi-secrets:synthi-secrets:SYNTHI_AUTH_CHECKPOINT_STORE_KEY=synthi-auth-checkpoint-store-key"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL=synthi-dojo-control-plane-postgres-url"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL=synthi-dojo-evidence-ledger-postgres-url"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID=synthi-dojo-proof-signing-key-id"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_PROOF_SIGNING_COMMAND=synthi-dojo-proof-signing-command"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS=synthi-dojo-proof-signing-command-args"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI=synthi-dojo-proof-signing-managed-key-uri"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM=synthi-dojo-proof-signing-public-key-pem"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_MCP_MANIFEST_KEY_ID=synthi-dojo-mcp-manifest-key-id"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM=synthi-dojo-mcp-manifest-private-key-pem"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM=synthi-dojo-mcp-manifest-public-key-pem"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_DOJO_MCP_BEARER_TOKEN=synthi-dojo-mcp-bearer-token"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_HOSTED_BROWSER_CDP_URL=synthi-dojo-hosted-browser-cdp-url"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_HOSTED_BROWSER_WORKSPACE_URL=synthi-dojo-hosted-browser-workspace-url"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_WORKSPACE_ID=synthi-dojo-release-workspace-id"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_AGENT_ID=synthi-dojo-release-agent-id"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE=synthi-private-workflow-tool-store-file"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE=synthi-private-workflow-tool-scope"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_AUTH_CHECKPOINT_STORE_FILE=synthi-auth-checkpoint-store-file"
  "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:SYNTHI_AUTH_CHECKPOINT_SCOPE=synthi-auth-checkpoint-scope"
)
```

Then generate a command plan without touching Google Cloud:

```powershell
node mcp/synthi-mcp/scripts/dojo-gcp-release-inventory.mjs `
  --project=$env:PROJECT_ID `
  --region=$env:REGION `
  --zone=$env:ZONE `
  --cluster=$env:CLUSTER `
  --namespace=$env:K8S_NAMESPACE `
  --artifact-repository=$env:AR_REPO `
  --gcs-bucket=$env:GCS_BUCKET `
  --cloud-sql-instance=$env:CLOUD_SQL_INSTANCE `
  --redis-instance=$env:REDIS_INSTANCE `
  --domain=$env:DOMAIN `
  @dojoSecretInventoryFlags `
  --out-dir=tmp/dojo-gcp-release-inventory
```

After confirming the plan contains only read/list/describe/get commands, run the
actual read-only inventory:

```powershell
node mcp/synthi-mcp/scripts/dojo-gcp-release-inventory.mjs `
  --execute `
  --project=$env:PROJECT_ID `
  --region=$env:REGION `
  --zone=$env:ZONE `
  --cluster=$env:CLUSTER `
  --namespace=$env:K8S_NAMESPACE `
  --artifact-repository=$env:AR_REPO `
  --gcs-bucket=$env:GCS_BUCKET `
  --cloud-sql-instance=$env:CLOUD_SQL_INSTANCE `
  --redis-instance=$env:REDIS_INSTANCE `
  --domain=$env:DOMAIN `
  @dojoSecretInventoryFlags `
  --out-dir=tmp/dojo-gcp-release-inventory
```

Expected output:

```text
tmp/dojo-gcp-release-inventory/dojo-gcp-release-inventory.json
tmp/dojo-gcp-release-inventory/dojo-gcp-release-inventory.evidence.json
```

The inventory script intentionally does not print or fetch secret values. It
records secret names, Kubernetes deployment names, endpoint inventory, enabled
APIs, store resources, and command digests only.

Summarize the inventory into an operator-facing blocker report:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:gcp-release-blockers:self-check
node mcp/synthi-mcp/scripts/dojo-gcp-release-blockers.mjs `
  --inventory-report=tmp/dojo-gcp-release-inventory/dojo-gcp-release-inventory.json `
  --out-dir=tmp/dojo-gcp-release-blockers
```

Expected output:

```text
tmp/dojo-gcp-release-blockers/dojo-gcp-release-blockers.json
tmp/dojo-gcp-release-blockers/dojo-gcp-release-blockers.md
```

The blocker script exits nonzero when the release is still blocked. That is
intentional. Use `--allow-blockers` only when you are generating an advisory
report and do not want the shell step to fail. The Markdown report groups
failures by release owner action:

- `cloud_api`: a required Google Cloud API is not enabled or not visible.
- `inventory_access`: the script could not collect a required inventory dataset.
- `cloud_resource`: a named GCP resource could not be verified.
- `kubernetes_context`: local `kubectl` is not pointed at the target cluster.
- `secret_inventory`: Secret Manager or Kubernetes secret names could not be
  verified.
- `deployment_inventory`: required Kubernetes deployments could not be verified.

Do not treat warnings under `secret_inventory`, `deployment_inventory`, or
`kubernetes_context` as proof of absence until the Kubernetes context and
Secret Manager inventory are readable. They mean the release still lacks
verifiable evidence for those surfaces.

Interpret the report carefully:

- `inventory_dataset:*_command_failed` means the script could not query that
  dataset. Fix auth, API enablement, network, or local kube context before
  treating dependent resource checks as true absence.
- `api:<service>` failures with no dataset failure mean the enabled-API list was
  collected and the service is genuinely not enabled for the project.
- Kubernetes checks are read-only and use the current local kube context. The
  script deliberately does not run `gcloud container clusters get-credentials`.
  If you want Kubernetes object inventory in the same report, select the target
  cluster context first, then rerun the inventory.

### Enable Required APIs

```powershell
gcloud services enable `
  artifactregistry.googleapis.com `
  cloudbuild.googleapis.com `
  container.googleapis.com `
  compute.googleapis.com `
  secretmanager.googleapis.com `
  iamcredentials.googleapis.com `
  cloudkms.googleapis.com `
  sqladmin.googleapis.com `
  redis.googleapis.com `
  storage.googleapis.com `
  certificatemanager.googleapis.com `
  logging.googleapis.com `
  monitoring.googleapis.com
```

### Artifact Registry

Create the image repository once:

```powershell
gcloud artifacts repositories create $env:AR_REPO `
  --repository-format=docker `
  --location=$env:REGION `
  --description="Synthi production images"
```

Verify access:

```powershell
gcloud artifacts repositories describe $env:AR_REPO --location=$env:REGION
```

### GCS Artifact And Evidence Bucket

Create or verify the bucket used by the app and release evidence:

```powershell
gcloud storage buckets create "gs://$env:GCS_BUCKET" `
  --location=$env:REGION `
  --uniform-bucket-level-access

gcloud storage buckets describe "gs://$env:GCS_BUCKET"
```

For regulated workspaces, add lifecycle and retention rules before release
evidence is generated. Do not delete evidence objects that are referenced by a
proof capsule, checkride, or ledger checkpoint.

### Cloud SQL Postgres

For production-like Dojo proof, evidence, license, audit, and tenant-state
validation, use Cloud SQL rather than the in-cluster Postgres manifest.

Create the instance:

```powershell
gcloud sql instances create $env:CLOUD_SQL_INSTANCE `
  --database-version=POSTGRES_16 `
  --tier=db-custom-2-8192 `
  --region=$env:REGION `
  --storage-size=100GB `
  --storage-type=SSD `
  --availability-type=REGIONAL `
  --backup-start-time=03:00 `
  --database-flags=cloudsql.iam_authentication=on
```

Create the database and application user:

```powershell
gcloud sql databases create synthi --instance=$env:CLOUD_SQL_INSTANCE
gcloud sql users create synthi --instance=$env:CLOUD_SQL_INSTANCE --password="<strong-generated-password>"
```

Store `DATABASE_URL` in Secret Manager. If using a Cloud SQL Auth Proxy sidecar,
use the proxy host visible inside the pod. If using private IP, use the private
address and ensure the GKE cluster is on the same VPC path.

```powershell
$databaseUrl = "postgresql://synthi:<strong-generated-password>@127.0.0.1:5432/synthi?schema=public"
$databaseUrl | gcloud secrets create synthi-database-url --data-file=-
```

The mature Dojo release gate should also have an explicit Postgres URL for Dojo
store integration tests when those are run outside the cluster:

```powershell
$env:SYNTHI_DOJO_POSTGRES_TEST_URL = "postgresql://synthi:<password>@<cloud-sql-proxy-host>:5432/synthi?schema=public"
```

### Memorystore Redis

Create the managed Redis instance:

```powershell
gcloud redis instances create $env:REDIS_INSTANCE `
  --region=$env:REGION `
  --tier=standard `
  --size=5 `
  --redis-version=redis_7_0
```

Record the host and port:

```powershell
gcloud redis instances describe $env:REDIS_INSTANCE --region=$env:REGION --format="value(host,port)"
```

Store the deployed Redis URL in Secret Manager:

```powershell
$redisUrl = "redis://<memorystore-private-ip>:6379"
$redisUrl | gcloud secrets create synthi-redis-url --data-file=-
```

### GKE Cluster

If the target cluster already exists, fetch credentials:

```powershell
gcloud container clusters get-credentials $env:CLUSTER --zone=$env:ZONE
kubectl get nodes
```

If creating a new cluster, enable Workload Identity and use separate node pools
for system workloads and workspace/browser workloads:

```powershell
gcloud container clusters create $env:CLUSTER `
  --zone=$env:ZONE `
  --workload-pool="$env:PROJECT_ID.svc.id.goog" `
  --num-nodes=3 `
  --machine-type=e2-standard-4 `
  --enable-ip-alias `
  --enable-autoscaling `
  --min-nodes=3 `
  --max-nodes=8

gcloud container node-pools create workspace-pool `
  --cluster=$env:CLUSTER `
  --zone=$env:ZONE `
  --machine-type=e2-standard-4 `
  --num-nodes=1 `
  --enable-autoscaling `
  --min-nodes=1 `
  --max-nodes=10 `
  --node-labels=workload=synthi-workspace `
  --node-taints=workload=synthi-workspace:NoSchedule
```

Verify the namespace and manifests:

```powershell
kubectl apply -f k8s/namespace.yaml
kubectl get namespace $env:K8S_NAMESPACE
kubectl kustomize k8s | kubectl apply --dry-run=server -f -
```

### Secret Manager And External Secrets Operator

The Kubernetes manifests expect Secret Manager values to be synchronized into a
Kubernetes secret named `synthi-secrets`. Install External Secrets Operator once
per cluster:

```powershell
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm upgrade --install external-secrets external-secrets/external-secrets `
  --namespace external-secrets `
  --create-namespace `
  --set installCRDs=true
```

Create the Google service account used by External Secrets Operator if it does
not exist:

```powershell
gcloud iam service-accounts create synthi-eso-sa `
  --display-name="Synthi External Secrets Operator"

gcloud projects add-iam-policy-binding $env:PROJECT_ID `
  --member="serviceAccount:synthi-eso-sa@$env:PROJECT_ID.iam.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"
```

Bind the Kubernetes service account through Workload Identity:

```powershell
gcloud iam service-accounts add-iam-policy-binding `
  "synthi-eso-sa@$env:PROJECT_ID.iam.gserviceaccount.com" `
  --role="roles/iam.workloadIdentityUser" `
  --member="serviceAccount:$env:PROJECT_ID.svc.id.goog[$env:K8S_NAMESPACE/eso-service-account]"
```

Apply the external secret resources:

```powershell
kubectl apply -f k8s/external-secrets.yaml
kubectl -n $env:K8S_NAMESPACE get externalsecret
kubectl -n $env:K8S_NAMESPACE get secret synthi-secrets
```

Store every required application secret in Secret Manager. The left side below
is the Secret Manager remote name. The right side is the Kubernetes
`synthi-secrets` key produced by External Secrets Operator:

```text
synthi-database-url -> DATABASE_URL
synthi-redis-url -> REDIS_URL
synthi-auth-secret -> AUTH_SECRET
synthi-nextauth-secret -> NEXTAUTH_SECRET
synthi-google-client-id -> GOOGLE_CLIENT_ID
synthi-google-client-secret -> GOOGLE_CLIENT_SECRET
synthi-y-sweet-auth-token -> YSWEET_AUTH_KEY
synthi-openai-api-key or equivalent model provider key -> OPENAI_API_KEY
synthi-browser-workflow-bridge-token -> SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN
synthi-dojo-control-plane-postgres-url -> SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL
synthi-dojo-evidence-ledger-postgres-url -> SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL
synthi-dojo-proof-signing-key-id -> SYNTHI_DOJO_PROOF_SIGNING_KEY_ID
synthi-dojo-proof-signing-command -> SYNTHI_DOJO_PROOF_SIGNING_COMMAND
synthi-dojo-proof-signing-command-args -> SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS
synthi-dojo-proof-signing-managed-key-uri -> SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI
synthi-dojo-proof-signing-public-key-pem -> SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM
synthi-dojo-mcp-manifest-key-id -> SYNTHI_DOJO_MCP_MANIFEST_KEY_ID
synthi-dojo-mcp-manifest-private-key-pem -> SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM
synthi-dojo-mcp-manifest-public-key-pem -> SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM
synthi-dojo-mcp-bearer-token -> SYNTHI_DOJO_MCP_BEARER_TOKEN
synthi-dojo-hosted-browser-cdp-url -> SYNTHI_HOSTED_BROWSER_CDP_URL
synthi-dojo-hosted-browser-workspace-url -> SYNTHI_HOSTED_BROWSER_WORKSPACE_URL
synthi-dojo-release-workspace-id -> SYNTHI_WORKSPACE_ID
synthi-dojo-release-agent-id -> SYNTHI_AGENT_ID
synthi-private-workflow-tool-store-file -> SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE
synthi-private-workflow-tool-scope -> SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE
synthi-auth-checkpoint-store-file -> SYNTHI_AUTH_CHECKPOINT_STORE_FILE
synthi-auth-checkpoint-scope -> SYNTHI_AUTH_CHECKPOINT_SCOPE
```

Do not store a production proof private key or default local signing key in
Secret Manager for the Dojo release. The release gate expects managed key
custody.

### Dojo Production Environment

The deployed MCP/runtime pods must be configured to fail closed:

```text
SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1
SYNTHI_DOJO_REQUIRE_DURABLE_STORE=1
SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING=1
SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER=1
```

The release gate shell must use the same production posture:

```powershell
$env:SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1"
$env:SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1"
$env:SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING = "1"
$env:SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1"
```

Readiness must fail if any of these are missing, if an in-memory Dojo store is
used, if proof replay state is process-local, or if the deployed host points to
a loopback CDP endpoint.

### Managed Proof Signing On Google Cloud

The current Dojo managed-key observation contract expects Ed25519 signatures and
the exact managed signer JSON protocol below. Google Cloud KMS asymmetric keys
may not directly satisfy that Ed25519 contract depending on the available
algorithm set in the target project. There are two valid paths:

1. Use a managed signing service or HSM provider that supports Ed25519 and
   expose it through a short-lived authenticated command wrapper.
2. Extend the Dojo signer contract and verifier to accept a Google Cloud KMS
   algorithm such as ECDSA P-256, then add release tests for that algorithm
   before using it as production proof.

Do not claim Cloud KMS proof signing is complete by only storing a local Ed25519
private key in Secret Manager.

The signer command receives this JSON on stdin:

```json
{
  "schema_version": "synthi.dojo.managedKeySignerRequest.v1",
  "algorithm": "ed25519",
  "key_id": "prod-dojo-proof-key",
  "key_uri": "managed://provider/path/to/key",
  "payload": "base64url-payload"
}
```

It must return this JSON on stdout:

```json
{
  "schema_version": "synthi.dojo.managedKeySignerResponse.v1",
  "algorithm": "ed25519",
  "key_id": "prod-dojo-proof-key",
  "key_uri": "managed://provider/path/to/key",
  "key_custody": "managed",
  "signature": "ed25519:base64url-signature"
}
```

Configure the release gate:

```powershell
$env:SYNTHI_DOJO_PROOF_SIGNING_PROVIDER = "managed-key-service"
$env:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID = "prod-dojo-proof-key"
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND = "node"
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS = '["scripts/your-managed-signer-wrapper.mjs"]'
$env:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI = "managed://provider/path/to/key"
$env:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM = @"
-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
"@
```

Then run:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe -- --out-dir ../../tmp/dojo-managed-key-signing-live
```

The observation must produce a signed proof artifact, verifier result, and
release evidence manifest.

### HTTPS, DNS, And Public Endpoints

Reserve a global static IP:

```powershell
gcloud compute addresses create synthi-prod-ip --global
gcloud compute addresses describe synthi-prod-ip --global --format="value(address)"
```

Point DNS for the target domain to that IP. Use a managed certificate or
Certificate Manager certificate. The public endpoints used in release gates must
be HTTPS or WSS and must not be localhost tunnels.

Required public or authenticated endpoints:

```text
https://<domain>/workspace
https://<domain>/ports
https://<domain>/dojo/mcp
wss://<hosted-browser-runtime-cdp>
```

The Dojo release overlay exposes the MCP host through the GKE Ingress at
`/dojo/mcp`. If an environment replaces that route with an internal service,
Cloud Run service, or gateway facade, keep the endpoint authenticated and make
the release gate call the same deployed endpoint that external strict clients
will use.

### Cloud Build Deployment

The repository includes `cloudbuild.yaml`. A standard deployment uses Cloud
Build to build images, scan them, apply the Kubernetes kustomization, run Prisma
migrations, and roll deployments.

```powershell
gcloud builds submit `
  --config cloudbuild.yaml `
  --substitutions `
_REGION=$env:REGION,`
_GKE_CLUSTER=$env:CLUSTER,`
_GKE_ZONE=$env:ZONE,`
_NEXT_PUBLIC_COLLAB_SERVER_URL=https://$env:DOMAIN/collab,`
_NEXT_PUBLIC_YSWEET_URL=https://$env:DOMAIN/collab,`
_NEXT_PUBLIC_COLLAB_PORT=443,`
_NEXT_PUBLIC_COMPILE_SIGNAL_URL=wss://$env:DOMAIN/signal,`
_NEXT_PUBLIC_GATEWAY_WS_URL=wss://$env:DOMAIN/gateway/ws,`
_NEXT_PUBLIC_CODE_INTEL_URL=https://$env:DOMAIN,`
_NEXT_PUBLIC_AI_ENGINE_URL=https://$env:DOMAIN,`
_NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=true,`
_NEXT_PUBLIC_SYNTHI_LOOPBACK_AUTH_BRIDGE_PATH=/auth/loopback,`
_KUSTOMIZE_DIR=k8s,`
_KUSTOMIZE_LOAD_RESTRICTOR=
```

The base kustomization is the safe default for the already-hosted application.
It does not claim the Dojo enterprise release gate by itself. After the Cloud
SQL, Memorystore, External Secrets, managed proof-signing, hosted runtime, and
MCP host blockers are closed, the approved Dojo release-gate rollout should use
the opt-in overlay:

```powershell
gcloud builds submit `
  --config cloudbuild.yaml `
  --substitutions `
_REGION=$env:REGION,`
_GKE_CLUSTER=$env:CLUSTER,`
_GKE_ZONE=$env:ZONE,`
_NEXT_PUBLIC_COLLAB_SERVER_URL=https://$env:DOMAIN/collab,`
_NEXT_PUBLIC_YSWEET_URL=https://$env:DOMAIN/collab,`
_NEXT_PUBLIC_COLLAB_PORT=443,`
_NEXT_PUBLIC_COMPILE_SIGNAL_URL=wss://$env:DOMAIN/signal,`
_NEXT_PUBLIC_GATEWAY_WS_URL=wss://$env:DOMAIN/gateway/ws,`
_NEXT_PUBLIC_CODE_INTEL_URL=https://$env:DOMAIN,`
_NEXT_PUBLIC_AI_ENGINE_URL=https://$env:DOMAIN,`
_NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=true,`
_NEXT_PUBLIC_SYNTHI_LOOPBACK_AUTH_BRIDGE_PATH=/auth/loopback,`
_KUSTOMIZE_DIR=k8s/overlays/dojo-release-gate,`
_DOJO_RELEASE_KUSTOMIZE_DIR=k8s/overlays/dojo-release-gate,`
_KUSTOMIZE_LOAD_RESTRICTOR=LoadRestrictionsNone
```

Before using that overlay in Cloud Build, render it locally and inspect the
output. The checked command writes report and evidence artifacts under
`tmp/dojo-kustomize-overlay-check`:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:kustomize-overlay
```

The raw render command is:

```powershell
kubectl kustomize k8s/overlays/dojo-release-gate --load-restrictor LoadRestrictionsNone |
  Set-Content -Path tmp/dojo-release-gate-render.yaml -Encoding utf8
```

The rendered overlay must include the Dojo fail-closed ConfigMap values, the
Dojo ExternalSecret entries, secret-backed Redis env for static Redis consumers,
the `dojo-mcp-host` Deployment/Service/BackendConfig, and no in-cluster
`postgres` or `redis` workload. The runtime workflow bridge receives the Dojo
ConfigMap and Secret values through the collab-server runtime pod spawner. The
Dojo release overlay also deploys the token-gated HTTP MCP host at `/dojo/mcp`
using the `synthi-mcp-http` image. Cloud Build builds that image only when the
selected kustomize directory equals `_DOJO_RELEASE_KUSTOMIZE_DIR`; the default
base deployment skips the release-only image.

After Cloud Build finishes:

```powershell
kubectl -n $env:K8S_NAMESPACE get pods
kubectl -n $env:K8S_NAMESPACE get svc
kubectl -n $env:K8S_NAMESPACE rollout status deployment/frontend
kubectl -n $env:K8S_NAMESPACE rollout status deployment/collab-server
kubectl -n $env:K8S_NAMESPACE rollout status deployment/signaling-server
kubectl -n $env:K8S_NAMESPACE rollout status deployment/ai-gateway
kubectl -n $env:K8S_NAMESPACE rollout status deployment/ai-engine
kubectl -n $env:K8S_NAMESPACE rollout status deployment/dojo-mcp-host
```

Run the smoke checks from outside the cluster:

```powershell
Invoke-WebRequest "https://$env:DOMAIN/workspace" -UseBasicParsing
Invoke-WebRequest "https://$env:DOMAIN/ports" -UseBasicParsing
```

### Manual GKE Rollout Path

Use this only when Cloud Build is unavailable. It should still use Artifact
Registry images and the same manifests.

```powershell
kubectl apply -k k8s/
kubectl -n $env:K8S_NAMESPACE get pods
kubectl -n $env:K8S_NAMESPACE describe externalsecret synthi-secrets
kubectl -n $env:K8S_NAMESPACE rollout status deployment/frontend
```

For an approved Dojo release-gate rollout, first render the opt-in overlay,
replace the `build-tag-required` image placeholders with the exact release tag
or image digest, then apply the rendered result. Cloud Build performs this
replacement automatically; manual rollout must do the same before `kubectl
apply`.

```powershell
kubectl kustomize k8s/overlays/dojo-release-gate --load-restrictor LoadRestrictionsNone |
  Set-Content -Path tmp/dojo-release-gate-render.yaml -Encoding utf8

# Replace build-tag-required placeholders in tmp/dojo-release-gate-render.yaml
# with the exact release image tag or digest before applying.
kubectl apply -f tmp/dojo-release-gate-render.yaml
```

If image tags are changed manually, update all deployments consistently and
record the digest in the release evidence manifest. Do not mix locally built
images with release evidence.

### Hosted Browser Runtime

Release evidence must use a non-loopback hosted browser/CDP runtime. The value
below must point to the deployed runtime, not a developer workstation:

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL = "wss://<hosted-runtime-domain>/devtools/browser/<session-or-broker>"
$env:FRONTEND_URL = "https://$env:DOMAIN"
$env:COLLAB_URL = "https://$env:DOMAIN"
$env:SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL = "https://<deployed-workflow-bridge>"
$env:SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP = "1"
$env:SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS = "300000"
```

`SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1` starts a local ephemeral
verification bridge by design for fresh MCP evidence. The deployed frontend and
collab URLs must still be set explicitly so the browser workflow is not pointed
at localhost by default.

The hosted runtime must enforce:

- tenant/workspace/session binding
- short-lived credentials
- origin allowlist
- no local network access unless explicitly approved
- screenshot and trace redaction
- audit and evidence emission

Run:

```powershell
npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline
```

After the hosted runtime, workflow, private-tool, and MCP host evidence files
exist, produce the hosted-runtime gateway release observation:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:hosted-runtime-gateway:observe -- --out-dir ../../tmp/dojo-hosted-runtime-gateway-release-observation
$env:SYNTHI_DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PATH = "$PWD\tmp\dojo-hosted-runtime-gateway-release-observation\hosted-runtime-gateway-release-observation.json"
npm --prefix mcp/synthi-mcp run proof:dojo:hosted-runtime-gateway:self-check
```

### Deployed MCP Host

Configure the release gate to use the deployed HTTP MCP host from the Dojo
release overlay. The host is built from `mcp/synthi-mcp/Dockerfile.http`,
deployed as `Deployment/dojo-mcp-host`, exposed through the existing GKE
Ingress at `/dojo/mcp`, protected by IAP at the GKE backend, and token-gated by
`SYNTHI_DOJO_MCP_BEARER_TOKEN` from Secret Manager. Do not point this gate at
the stdio MCP server, the browser workflow bridge, a local tunnel, or a
loopback endpoint.

Before running conformance, verify the rendered and deployed host shape:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:kustomize-overlay
kubectl -n $env:K8S_NAMESPACE get deployment dojo-mcp-host
kubectl -n $env:K8S_NAMESPACE get service dojo-mcp-host
kubectl -n $env:K8S_NAMESPACE get backendconfig dojo-mcp-host-backend-config
kubectl -n $env:K8S_NAMESPACE get ingress synthi-ingress
```

```powershell
$env:SYNTHI_DOJO_MCP_HOST_URL = "https://$env:DOMAIN/dojo/mcp"
$env:SYNTHI_DOJO_MCP_BEARER_TOKEN = "<short-lived-release-token>"
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE = "1"
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING = "1"
$env:SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED = "1"
$env:SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE = "1"
$env:SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING = "1"
```

Run:

```powershell
npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance -- --out-dir ../../tmp/dojo-mcp-host-conformance-live
```

The conformance run must prove:

- non-loopback host
- external durable store
- external or managed proof signing
- bridge token required
- no local CDP leakage
- only licensed skills are visible
- revocation propagates

### Google Cloud Release Gate Sequence

Run this sequence for a release candidate:

1. Run the read-only hosted inventory and compare it with the expected
   production resources.
2. Build and deploy with Cloud Build only after explicit deployment approval.
3. Verify Kubernetes rollouts and external HTTPS endpoints.
4. Verify External Secrets synced from Secret Manager.
5. Run database migrations against Cloud SQL.
6. Run local static/type/unit gates from a clean checkout.
7. Run managed-key signing observation.
8. Run hosted browser workflow E2E against the hosted runtime.
9. Run private tool acceptance against the deployed MCP host.
10. Run deployed MCP host conformance.
11. Run live chaos and soak gates using GKE-safe commands.
12. Run the release gate verifier over the produced evidence.

Suggested evidence directory layout:

```text
tmp/dojo-release/<yyyy-mm-dd>-<git-sha>/
  local/
  docker/
  hosted-browser/
  private-tool/
  mcp-host/
  managed-key/
  chaos/
  soak/
  visual/
  release-gate-verifier.json
```

### GKE Live Chaos Command Examples

The live chaos script expects command JSON values. Verify Kubernetes object
names before setting these. The examples below use label selectors and rollout
restarts so they are repeatable in GKE.

```powershell
$env:SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON = '["kubectl","delete","pod","-n","synthi","-l","app=worker","--ignore-not-found=true"]'
$env:SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON = '["kubectl","rollout","restart","deployment/redis","-n","synthi"]'
$env:SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON = '["kubectl","rollout","restart","deployment/postgres","-n","synthi"]'
$env:SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON = '["kubectl","delete","pod","-n","synthi","-l","app=hosted-browser","--ignore-not-found=true"]'
$env:SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON = '["kubectl","scale","deployment/evidence-store","-n","synthi","--replicas=0"]'
$env:SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON = '["kubectl","scale","deployment/dojo-proof-signer","-n","synthi","--replicas=0"]'
$env:SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON = '["kubectl","rollout","restart","deployment/signaling-server","-n","synthi"]'
```

If production uses Cloud SQL and Memorystore rather than in-cluster deployments,
do not restart managed services directly. Instead, use a controlled network
policy or application-level fault injection window that blocks the app from
reaching the dependency, then remove the block and verify recovery.

Run:

```powershell
npm --prefix mcp/synthi-mcp run chaos:dojo:live
```

### GKE Soak And Performance

Use deployed endpoints and production-like backing services:

```powershell
$env:SYNTHI_SESSION_ID = "<live-session-id>"
$env:SOAK_DURATION_MIN = "60"
$env:SYNTHI_SIGNALING_URL = "wss://$env:DOMAIN/signal"
$env:SOAK_OUTPUT_DIR = "tmp/dojo-soak-performance-gke"

npm --prefix mcp/synthi-mcp run soak
```

The soak evidence should include p95 latency, memory trend, browser session leak
count, proof replay false-allow count, and scenario budget adherence.

### Operational Debug Commands

Use these while collecting release evidence:

```powershell
kubectl -n $env:K8S_NAMESPACE get pods -o wide
kubectl -n $env:K8S_NAMESPACE get events --sort-by=.lastTimestamp
kubectl -n $env:K8S_NAMESPACE logs deployment/frontend --tail=200
kubectl -n $env:K8S_NAMESPACE logs deployment/ai-gateway --tail=200
kubectl -n $env:K8S_NAMESPACE logs deployment/worker --tail=200
gcloud logging read 'resource.type="k8s_container" AND resource.labels.namespace_name="synthi"' --limit=50 --format=json
```

For a failed gate, preserve:

- command stdout/stderr
- Kubernetes events
- pod logs for the failing component
- Cloud Build ID and image digests
- release evidence directory
- exact environment variable names used, with secret values redacted

### Google Cloud Fail-Closed Checklist

Before claiming external release evidence, verify:

- No release gate URL points to localhost, 127.0.0.1, `::1`, or a developer
  tunnel.
- The MCP host is the deployed host, not stdio-only local MCP.
- The hosted CDP endpoint is a managed hosted runtime endpoint.
- Cloud SQL or an equivalent external Postgres store backs proof, license,
  evidence, and audit state.
- Memorystore or an equivalent external Redis backs production runtime
  coordination where Redis is required.
- Proof signing uses managed custody and the managed-key observation passes.
- Raw workflow and private tool bypass tests pass against the deployed host.
- External Secrets Operator synced required secrets from Secret Manager.
- Kubernetes rollouts are healthy and image digests match the release candidate.
- Visual evidence screenshots come from the deployed app or a declared staging
  environment using release-candidate images.
- The release gate verifier passes over the final evidence directory.

## External Release Inputs

These gates require real deployed or long-running systems. Do not satisfy them
with loopback URLs, inline fake signers, generated sample observations, or
fixture-only artifacts.

| Gate | Required inputs | What it proves |
|---|---|---|
| `workflow_e2e_hosted` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `FRONTEND_URL`, `COLLAB_URL`, `SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1` | Hosted browser workflow path runs outside local CDP and exports fresh MCP evidence. |
| `private_tool_stdio_acceptance` | `SYNTHI_HOSTED_BROWSER_CDP_URL` | Strict stdio MCP client can execute proof-gated private tool flow against hosted runtime. |
| `private_tool_codex_acceptance` | `SYNTHI_HOSTED_BROWSER_CDP_URL` | Codex-style client can execute proof-gated private tool flow without local browser leakage. |
| `dojo_mcp_host_conformance` | `SYNTHI_DOJO_MCP_HOST_URL`, optional `SYNTHI_DOJO_MCP_BEARER_TOKEN`, `SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE`, `SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING`, `SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED`, `SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE`, `SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING` | Non-loopback MCP host lists and dispatches only governed competencies. |
| `private_tool_stdio_host_conformance` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD` | Deployed private tool host path works with external store and strict schema. |
| `private_tool_codex_host_conformance` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL` | Deployed Codex private tool path works without shell-only shortcuts. |
| `dojo_managed_key_signing_self_check` | `SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH` from the managed-key observation script | Proof signing is backed by a configured managed signing service and public verifier material. |
| `dojo_live_chaos` | `SYNTHI_CHAOS_ENABLE_LIVE=1`, `SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON`, `SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON`, `SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON`, `SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON`, `SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON`, `SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON`, `SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON` | Real worker, Redis, Postgres, browser, evidence-store, and proof-signing failure modes fail closed. |
| `soak_performance` | `SYNTHI_SESSION_ID`, `SOAK_DURATION_MIN>=60` | Long-running live session stays within latency, memory, leak, false-allow, and false-block budgets. |

## External Blocker Playbooks

Run these playbooks only against real release-candidate infrastructure. The
commands below are intentionally strict: if a required external dependency is
missing, the gate should fail instead of silently substituting local evidence.

### 1. Hosted Browser Workflow E2E

**Gate:** `workflow_e2e_hosted`

**Prerequisites:**

- A hosted browser runtime with a CDP endpoint reachable from this machine.
- The endpoint is not `localhost`, `127.0.0.1`, `::1`, or a forwarded local
  port when claiming production evidence.
- The hosted runtime can reach the target app origin and the MCP server.
- Fresh MCP evidence verification is enabled.

**Command:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
$env:FRONTEND_URL='https://beta.vectant.dev'
$env:COLLAB_URL='https://beta.vectant.dev'
$env:SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP='1'
$env:SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS='300000'
npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline
```

**Expected evidence:**

- Workflow pipeline summary reports zero failed checks.
- Generated workflow scripts execute against the hosted runtime.
- Fresh MCP evidence records are present.
- The summary states hosted attach was used and local attach was not used.
- Generated artifacts do not contain fixed forwarded-port literals.

**Common failures:**

- CDP URL is loopback or a local tunnel.
- Hosted runtime cannot reach the workspace origin.
- `SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP` is missing.
- Existing cached MCP artifacts are reused instead of fresh evidence.

### 2. Private Tool Acceptance, Stdio And Codex Clients

**Gates:** `private_tool_stdio_acceptance`,
`private_tool_codex_acceptance`

**Prerequisites:**

- Same hosted CDP endpoint requirements as workflow E2E.
- Private workflow tool generation is configured for the target app.
- The target app is reachable from the hosted runtime.
- Proof-gated Dojo execution path is available.

**Commands:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
npm --prefix mcp/synthi-mcp run live:browser:private-tool-stdio
npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex
```

**Expected evidence:**

- Strict schema client can call the generated tool.
- Raw backing tool invocation respects the Dojo proof gate.
- Proof capsule path succeeds through the MCP client.
- Generated private tool manifest validates.

**Common failures:**

- Private tool was generated against local browser state.
- Hosted runtime has no authenticated session or wrong workspace cookies.
- Proof capsule is missing, already used, revoked, or scoped to another
  workspace.
- Strict client rejects a schema that a permissive local client accepted.

### 3. Deployed MCP Host Conformance

**Gate:** `dojo_mcp_host_conformance`

**Prerequisites:**

- A deployed MCP host endpoint that is not loopback.
- External control-plane store is enabled for the deployed host.
- External proof signing is enabled for the deployed host.
- Bridge token enforcement is enabled.
- Local CDP leakage is blocked.
- Skill listing filters by licensed caller permissions.

**Command:**

```powershell
$env:SYNTHI_DOJO_MCP_HOST_URL="https://$env:DOMAIN/dojo/mcp"
$env:SYNTHI_DOJO_MCP_BEARER_TOKEN='<short-lived-release-token>'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING='1'
npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance
```

**Expected evidence:**

- Tool manifest is signed and validates.
- Host lists only authorized licensed competencies for the caller.
- Direct raw backing tools are hidden or blocked.
- Proof-gated execution path works through the deployed host.
- Revoked proof, revoked tool, or revoked license fails closed.
- Old proof cannot call a newer license version.
- Bridge or workflow endpoints reject unauthenticated calls; this is proven by
  deployed-host behavior, not by passing a local bridge token to the harness.

**Common failures:**

- Host points to a loopback URL or local MCP process.
- Store is process-local, so revocation does not propagate.
- The host accepts unsigned manifests.
- Caller authorization is evaluated after tool exposure rather than before.

### 4. Deployed Private Tool Host Conformance

**Gates:** `private_tool_stdio_host_conformance`,
`private_tool_codex_host_conformance`

**Prerequisites:**

- Hosted CDP endpoint is non-loopback.
- Private workflow tool store is external and encrypted.
- The external store file is not under the repo checkout, OS temp directory, or
  user home directory. Use a network path, mounted release secret volume, or a
  durable release-controlled path. If the store is mounted under a nonstandard
  approved root, set
  `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_EXTERNAL_STORE_ALLOWED_ROOTS_JSON` to a JSON
  array of allowed root paths before running the host-conformance gates.
- Store key is provided through release secret management.
- Tool scope is explicit and tenant/workspace bounded.
- Acceptance target URL is the deployed target app, not a local fixture.

**Commands:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE='\\<external-store>\private-tools.enc.json'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY='<release-secret-key>'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE='<tenant>/<workspace>/<app-release>'
$env:SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL='https://<target-app-origin>'
$env:SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND='<deployed-mcp-wrapper-command>'
$env:SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON=('["--connect","https://' + $env:DOMAIN + '/dojo/mcp"]')
$env:SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD='<repo-or-wrapper-working-directory>'
npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance
npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance
```

**Expected evidence:**

- External private tool store is used.
- Runtime URL is non-loopback.
- Strict stdio and Codex-style clients both execute the proof path.
- Raw backing tool path is blocked outside Dojo dispatcher context.

**Common failures:**

- Store file is local temp output.
- Store key does not decrypt generated tools across processes.
- Target URL points to a local dev app.
- Codex client path relies on shell-only behavior not present in hosted MCP.

### 5. Managed-Key Proof Signing Observation

**Gate:** `dojo_managed_key_signing_self_check`

**Prerequisites:**

- Real managed signing key exists in KMS/HSM or managed signing service.
- A signer command can sign the provided payload without exposing private key
  material.
- Public Ed25519 verification key is exported or discoverable.
- The signer identity and key URI are release scoped.

**Command:**

```powershell
$env:SYNTHI_DOJO_PROOF_SIGNING_PROVIDER='managed-key-service'
$env:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID='<managed-key-id>'
$env:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI='<kms-or-hsm-key-uri>'
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND='<signer-command>'
$env:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM='<public-ed25519-pem>'
npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe
```

Use the generated observation path in the release gate runner:

```powershell
$env:SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH='<path-from-observe-output>'
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure --fail-on-missing-env
```

**Expected evidence:**

- Observation records provider, key ID, managed key URI, public key fingerprint,
  signed payload digest, and verification result.
- Verification succeeds with public key material outside the signing command.
- No private key or local fallback secret appears in artifacts.

**Common failures:**

- Signer command is a local fixture or inline private key wrapper.
- Public key does not match the managed key.
- Provider or key URI is missing, so the observation cannot prove custody.
- Observation file is stale relative to the release run.

### 6. Live Chaos

**Gate:** `dojo_live_chaos`

**Prerequisites:**

- Release candidate deployment has isolated test tenant/workspace data.
- Operators provide command arrays for each live failure hook.
- Each command is safe for the target environment and reversible.
- Monitoring confirms unsafe actions fail closed during each outage.

List required hooks:

```powershell
npm --prefix mcp/synthi-mcp run chaos:dojo:live:list
```

Run with real command arrays:

```powershell
$env:SYNTHI_CHAOS_ENABLE_LIVE='1'
$env:SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON='["<cmd>","<arg>"]'
npm --prefix mcp/synthi-mcp run chaos:dojo:live
```

**Expected evidence:**

- Live chaos report is written to `tmp/dojo-chaos-runner/live-chaos-runner.report.json`.
- Each scenario records command argv, stdout/stderr digests, start and end time,
  and pass/fail classification.
- Unsafe actions fail closed.
- Evidence records are not partially accepted.
- Proof is not consumed for failed preflight.
- Recovery path is visible after the injected failure ends.

**Common failures:**

- A command env var is a string shell command instead of a JSON argv array.
- Command targets the wrong namespace, container, or service.
- Failure injection succeeds but no Dojo action is attempted during the outage.
- Recovery is not verified after the failure.

### 7. Soak And Performance

**Gate:** `soak_performance`

**Prerequisites:**

- A real live session exists and can run long enough for soak.
- `SOAK_DURATION_MIN` is at least `60`.
- Runtime metrics collection is enabled.
- Test tenant has enough data to exercise proof validation, graph execution,
  evidence append, and browser session lifecycle repeatedly.

**Command:**

```powershell
$env:SYNTHI_SESSION_ID='<live-session-id>'
$env:SOAK_DURATION_MIN='60'
npm --prefix mcp/synthi-mcp run soak
```

**Expected evidence:**

- Soak report covers the full requested duration.
- Proof validation p95 stays inside budget.
- Graph node execution p95 stays inside budget.
- Evidence append p95 stays inside budget.
- Browser session leak count is zero.
- Proof replay false allow count is zero.
- False block rate stays within release budget.
- Memory growth has no leak trend.

**Common failures:**

- Session ID points to an expired or local session.
- Duration is below 60 minutes.
- Metrics are collected only at startup or shutdown, not across the run.
- Long-running browser sessions are not cleaned up.

## Managed-Key Observation

The managed-key release observation must be produced from a real managed signer
command and public verification key:

```powershell
$env:SYNTHI_DOJO_PROOF_SIGNING_PROVIDER='managed-key-service'
$env:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID='<managed-key-id>'
$env:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI='<kms-or-hsm-key-uri>'
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND='<signer-command>'
$env:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM='<public-ed25519-pem>'
npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe
```

The observation script refuses to run when these values are absent. That is
intentional; a local self-check is not release evidence for managed KMS/HSM
custody.

## Live Chaos

List live hooks:

```powershell
npm --prefix mcp/synthi-mcp run chaos:dojo:live:list
```

Run only after the deployment operator provides real command arrays:

```powershell
$env:SYNTHI_CHAOS_ENABLE_LIVE='1'
$env:SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON='["<cmd>","<arg>"]'
npm --prefix mcp/synthi-mcp run chaos:dojo:live
```

Each command env var must be a JSON argv array. The runner executes commands
with `shell: false` and records stdout/stderr digests.

## Soak

Run the legacy live soak only against a real live session:

```powershell
$env:SYNTHI_SESSION_ID='<live-session-id>'
$env:SOAK_DURATION_MIN='60'
npm --prefix mcp/synthi-mcp run soak
```

The release verifier expects zero runtime leaks, zero proof replay false allows,
zero false-block rate, and valid tool latency/memory budgets.

## Verifier Rule

A release candidate is not complete until the verifier covers the release
sections:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --enterprise-release --require-complete-release-gate-coverage
```

If a required artifact is missing, stale, fixture-only, or self-check-only where
release evidence is required, the verifier must fail.
