param(
    [string]$ProjectId = 'overview-synti',
    [string]$ClusterName = 'synthi-beta-cluster',
    [string]$Zone = 'europe-west10-a',
    [switch]$SkipCorePool,
    [switch]$SkipWorkspacePool,
    [string]$CorePoolName = 'core-pool',
    [string]$WorkspacePoolName = 'workspace-pool',
    [string]$CoreMachineType = 'e2-small',
    [string]$WorkspaceMachineType = 'e2-standard-4',
    [int]$CoreMinNodes = 1,
    [int]$CoreMaxNodes = 1,
    [int]$CoreNumNodes = 1,
    [int]$WorkspaceMinNodes = 0,
    [int]$WorkspaceMaxNodes = 10,
    [int]$WorkspaceNumNodes = 0,
    [string]$DiskType = 'pd-balanced',
    [int]$DiskSizeGb = 50,
    [string]$WorkspaceTaint = 'workload=workspace:NoSchedule',
    [string]$WorkspaceLabels = 'workload=workspace,pool-role=workspace',
    [string]$CoreLabels = 'pool-role=core'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NodePoolNames {
    $output = gcloud container node-pools list `
        --project $ProjectId `
        --cluster $ClusterName `
        --zone $Zone `
        --format 'value(name)'

    return @($output | Where-Object { $_ -and $_.Trim() })
}

function Ensure-NodePool {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$MachineType,
        [Parameter(Mandatory = $true)][int]$MinNodes,
        [Parameter(Mandatory = $true)][int]$MaxNodes,
        [Parameter(Mandatory = $true)][int]$NumNodes,
        [Parameter(Mandatory = $true)][string]$Labels,
        [string]$Taints = ''
    )

    $existing = Get-NodePoolNames
    if ($existing -contains $Name) {
        Write-Host "Updating node pool $Name ..."
        $updateArgs = @(
            'container', 'node-pools', 'update', $Name,
            '--project', $ProjectId,
            '--cluster', $ClusterName,
            '--zone', $Zone,
            '--enable-autoscaling',
            '--min-nodes', $MinNodes,
            '--max-nodes', $MaxNodes,
            '--node-labels', $Labels
        )

        if ($Taints) {
            $updateArgs += @('--node-taints', $Taints)
        }

        & gcloud @updateArgs
        return
    }

    Write-Host "Creating node pool $Name ..."
    $initialNodeCount = $NumNodes
    if ($MinNodes -eq 0 -and $initialNodeCount -lt 1) {
        # GKE node-pool creation requires an initial node count even when the
        # autoscaling floor is zero. Create one bootstrap node and let the
        # autoscaler scale the pool back down once it is idle.
        $initialNodeCount = 1
    }

    $createArgs = @(
        'container', 'node-pools', 'create', $Name,
        '--project', $ProjectId,
        '--cluster', $ClusterName,
        '--zone', $Zone,
        '--machine-type', $MachineType,
        '--disk-type', $DiskType,
        '--disk-size', $DiskSizeGb,
        '--enable-autoscaling',
        '--min-nodes', $MinNodes,
        '--max-nodes', $MaxNodes,
        '--num-nodes', $initialNodeCount,
        '--node-labels', $Labels
    )

    if ($Taints) {
        $createArgs += @('--node-taints', $Taints)
    }

    & gcloud @createArgs
}

if (-not $SkipCorePool) {
    Ensure-NodePool `
        -Name $CorePoolName `
        -MachineType $CoreMachineType `
        -MinNodes $CoreMinNodes `
        -MaxNodes $CoreMaxNodes `
        -NumNodes $CoreNumNodes `
        -Labels $CoreLabels
}

if (-not $SkipWorkspacePool) {
    Ensure-NodePool `
        -Name $WorkspacePoolName `
        -MachineType $WorkspaceMachineType `
        -MinNodes $WorkspaceMinNodes `
        -MaxNodes $WorkspaceMaxNodes `
        -NumNodes $WorkspaceNumNodes `
        -Labels $WorkspaceLabels `
        -Taints $WorkspaceTaint
}

Write-Host ''
Write-Host 'Hybrid node pools are present.'
Write-Host 'Do not drain or delete default-pool until the always-on support tier has moved to Cloud Run or been re-sized for the new core-pool.'
Write-Host 'Workspace pods are configured to target workspace-pool via cloud.google.com/gke-nodepool=workspace-pool and tolerate workload=workspace:NoSchedule.'