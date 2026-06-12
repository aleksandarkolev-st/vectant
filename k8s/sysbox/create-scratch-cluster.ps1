<#
  Slice 0 — create the Sysbox SCRATCH cluster + sysbox-pool on GKE.
  Spec: docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md §4

  This is a THROWAWAY validation cluster, separate from prod synthi-beta-cluster.
  Why a separate cluster (not a pool on prod): prod is on the REGULAR release
  channel, where node auto-upgrade CANNOT be permanently disabled (only deferred
  via maintenance exclusions). Node upgrades recreate nodes from the base image and
  WIPE the Sysbox install. A cluster on --release-channel=None lets us pin the
  version and pass --no-enable-autoupgrade for full control during validation.

  Idempotent: existence is detected by the EXIT CODE of `gcloud ... describe`
  (NOT by capturing stdout — capturing gcloud output into a variable came back
  empty when this script was run via `powershell -File` in the background, which
  made it always re-create). Re-running skips anything that already exists.

  Run explicitly (gated infra — confirm before running):
      powershell -ExecutionPolicy Bypass -File k8s/sysbox/create-scratch-cluster.ps1
  Tear down when done:  see k8s/sysbox/README.md  (delete the cluster + AR image).
#>
# 'Continue' (NOT 'Stop'): gcloud writes normal status to stderr; under 'Stop' a
# captured native-stderr line can derail control flow when run via `powershell -File`.
$ErrorActionPreference = 'Continue'

# ── Parameters (override inline as needed) ───────────────────────────────────
$Project        = 'vectant-proj'
$Zone           = 'europe-west10-a'
$Cluster        = 'synthi-sysbox-scratch'
$ClusterVersion = '1.35.3-gke.2190000'  # pinned to prod parity (= the zone's default static version)
$DefaultMachine = 'e2-medium'   # default pool just hosts kube-system (COS is fine)
$SysboxPool     = 'sysbox-pool'
$SysboxMachine  = 'e2-standard-4'  # Sysbox needs >=4 vCPU

Write-Host "== Preflight: valid static cluster versions in $Zone ==" -ForegroundColor Cyan
gcloud container get-server-config --zone $Zone --project $Project `
  --format="value(validMasterVersions)"

# ── 1. Scratch cluster (Standard, channel=None => auto-upgrade disable allowed) ─
gcloud container clusters describe $Cluster --zone $Zone --project $Project *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Cluster '$Cluster' already exists - skipping create." -ForegroundColor Yellow
} else {
  $clusterArgs = @(
    'container','clusters','create',$Cluster,
    '--project',$Project,
    '--zone',$Zone,
    '--release-channel','None',     # static version => we control upgrades
    '--enable-shielded-nodes',      # Shielded Nodes ON, but Secure Boot stays OFF (default)
    '--machine-type',$DefaultMachine,
    '--num-nodes','1',
    '--no-enable-autoupgrade',
    '--no-enable-autorepair'
  )
  if ($ClusterVersion) { $clusterArgs += @('--cluster-version',$ClusterVersion) }
  Write-Host "RUN: gcloud $($clusterArgs -join ' ')" -ForegroundColor Green
  gcloud @clusterArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "cluster create FAILED with code $LASTEXITCODE"; exit 1 }
}

# ── 2. sysbox-pool (Ubuntu, Secure Boot OFF, no auto-upgrade/repair, tainted) ──
gcloud container node-pools describe $SysboxPool --cluster $Cluster --zone $Zone --project $Project *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Node pool '$SysboxPool' already exists - skipping create." -ForegroundColor Yellow
} else {
  $poolArgs = @(
    'container','node-pools','create',$SysboxPool,
    '--project',$Project,
    '--cluster',$Cluster,
    '--zone',$Zone,
    '--image-type','UBUNTU_CONTAINERD',   # COS is unsupported by Sysbox (read-only rootfs)
    '--machine-type',$SysboxMachine,
    '--num-nodes','1',                     # warm floor 1 during validation (no scale-to-zero)
    '--no-enable-autoupgrade',
    '--no-enable-autorepair',
    '--node-labels','sysbox-install=yes',  # DaemonSet installs Sysbox here
    '--node-taints','workload=sysbox:NoSchedule'  # only runtime pods (which tolerate it) land here
    # Do NOT pass --shielded-secure-boot: Secure Boot must stay OFF so Sysbox can
    # load shiftfs (an unsigned kernel module). OFF is the GKE default.
  )
  Write-Host "RUN: gcloud $($poolArgs -join ' ')" -ForegroundColor Green
  gcloud @poolArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "node-pool create FAILED with code $LASTEXITCODE"; exit 1 }
}

# ── 3. kubeconfig context ─────────────────────────────────────────────────────
gcloud container clusters get-credentials $Cluster --zone $Zone --project $Project

Write-Host ""
Write-Host "Cluster + sysbox-pool ready. Next (see k8s/sysbox/README.md):" -ForegroundColor Cyan
Write-Host "  B3  re-host + digest-pin the Sysbox image, then patch sysbox-install.yaml"
Write-Host "  B4  kubectl apply -k k8s/sysbox/        # installs Sysbox (~1-2 min)"
Write-Host "  C1  kubectl apply -f k8s/sysbox/smoke-pod.yaml; kubectl exec sysbox-smoke-test -- docker run --rm hello-world"
