param(
    [switch]$Build,
    [switch]$Pull,
    [string]$Image = $env:SYNTHI_WORKER_GPU_IMAGE
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if (-not $Image) {
    $Image = "vectant-ade-worker-gpu:local"
}
$env:SYNTHI_WORKER_GPU_IMAGE = $Image

function Test-Nvidia {
    $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    try {
        & nvidia-smi | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-AmdDxg {
    try {
        $out = & wsl.exe sh -lc "test -e /dev/dxg && echo yes || true" 2>$null
        return ($out -join "`n").Trim() -eq "yes"
    } catch {
        return $false
    }
}

$override = $null
$vendor = $null
if (Test-Nvidia) {
    $override = "docker-compose.nvidia.yml"
    $vendor = "cuda"
} elseif (Test-AmdDxg) {
    $override = "docker-compose.gpu-amd.yml"
    $vendor = "rocm"
} else {
    Write-Warning "No NVIDIA GPU or WSL /dev/dxg AMD bridge detected. Falling back to AMD override; worker GPU phases may skip."
    $override = "docker-compose.gpu-amd.yml"
    $vendor = "auto"
}

Write-Host "Using GPU override: $override"
Write-Host "Detected vendor: $vendor"
Write-Host "Worker image: $Image"
if ($env:SYNTHI_GPU_ARCH) {
    Write-Host "GPU arch hint: $env:SYNTHI_GPU_ARCH"
}

$compose = @("compose", "-f", "docker-compose.yml", "-f", $override)
$services = @("redis", "postgres", "y-sweet", "collab-server", "signaling-server", "ai-engine", "ai-gateway", "frontend", "worker", "coturn", "mcp")

if ($Pull) {
    & docker @compose pull worker
}

if ($Build) {
    & docker @compose build worker
}

& docker @compose up -d --force-recreate @services
& docker @compose ps

Write-Host ""
Write-Host "Run GPU HMR harness with:"
Write-Host "  `$env:SYNTHI_GPU_VENDOR='auto'"
Write-Host "  `$env:SYNTHI_GPU_HMR='1'"
Write-Host "  node mcp/synthi-mcp/scripts/gpu-hmr-test.mjs"
