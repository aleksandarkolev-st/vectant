param(
    [switch]$Build,
    [switch]$Pull,
    [string]$Image = $env:SYNTHI_WORKER_GPU_IMAGE,
    [string]$Arch = $env:SYNTHI_GPU_ARCH
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

function Convert-NvidiaComputeCapability {
    param([string]$Capability)
    $clean = ($Capability -replace "\s", "").Trim()
    if ($clean -match "^[0-9]+(\.[0-9]+)?$") {
        return "sm_$($clean -replace '\.', '')"
    }
    return $null
}

function Get-NvidiaArch {
    try {
        $cap = (& nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        return Convert-NvidiaComputeCapability $cap
    } catch {
        return $null
    }
}

function Get-RocmArch {
    try {
        $gfx = (& wsl.exe sh -lc "if command -v rocminfo >/dev/null 2>&1; then rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; elif command -v rocm_agent_enumerator >/dev/null 2>&1; then rocm_agent_enumerator 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; fi" 2>$null | Select-Object -First 1)
        if ($gfx) { return $gfx.Trim() }
    } catch {
        # Fall through to Windows GPU-name fallback.
    }

    try {
        $names = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "`n"
        if ($names -match "RX 90(60|70)") {
            return "gfx1201"
        }
    } catch {
        return $null
    }
    return $null
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

if (-not $Arch -or $Arch -eq "auto") {
    if ($vendor -eq "cuda") {
        $Arch = Get-NvidiaArch
    } elseif ($vendor -eq "rocm") {
        $Arch = Get-RocmArch
    } else {
        $Arch = $null
    }
    $archSource = if ($Arch) { "auto-detected" } else { "auto-unresolved" }
} else {
    $archSource = "override"
}

if ($Arch) {
    $env:SYNTHI_GPU_ARCH = $Arch
} elseif (Test-Path Env:SYNTHI_GPU_ARCH) {
    Remove-Item Env:SYNTHI_GPU_ARCH
}

Write-Host "Using GPU override: $override"
Write-Host "Detected vendor: $vendor"
Write-Host "Worker image: $Image"
if ($env:SYNTHI_GPU_ARCH) {
    Write-Host "GPU arch hint: $env:SYNTHI_GPU_ARCH ($archSource)"
} else {
    Write-Host "GPU arch hint: auto (not resolved before startup)"
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
