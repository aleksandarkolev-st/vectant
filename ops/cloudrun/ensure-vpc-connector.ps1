param(
    [string]$ProjectId = 'overview-synti',
    [string]$Region = 'europe-west10',
    [string]$Network = 'default',
    [string]$ConnectorName = 'synthi-serverless-ew10',
    [string]$IpCidrRange = '10.8.0.0/28',
    [int]$MinInstances = 2,
    [int]$MaxInstances = 3,
    [string]$MachineType = 'e2-micro'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host 'Ensuring required APIs are enabled ...'
gcloud services enable run.googleapis.com vpcaccess.googleapis.com --project $ProjectId | Out-Host

    $existingConnector = gcloud compute networks vpc-access connectors list `
        --project $ProjectId `
        --region $Region `
        --filter "name=$ConnectorName" `
        --format 'value(name)'

if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingConnector)) {
    Write-Host "Updating existing connector $ConnectorName ..."
    gcloud compute networks vpc-access connectors update $ConnectorName `
        --project $ProjectId `
        --region $Region `
        --min-instances $MinInstances `
        --max-instances $MaxInstances `
        --machine-type $MachineType | Out-Host
}
else {
    Write-Host "Creating connector $ConnectorName ..."
    gcloud compute networks vpc-access connectors create $ConnectorName `
        --project $ProjectId `
        --region $Region `
        --network $Network `
        --range $IpCidrRange `
        --min-instances $MinInstances `
        --max-instances $MaxInstances `
        --machine-type $MachineType | Out-Host
}

Write-Host ''
Write-Host 'Connector ready.'
Write-Host 'Use this only for Cloud Run services that must reach private VPC targets; the connector itself has a standing baseline cost and does not preserve true zero-idle economics.'