param(
    [string]$ProjectId = 'overview-synti',
    [string]$Region = 'europe-west10',
    [string]$Zone = 'europe-west10-a',
    [string]$Namespace = 'synthi',
    [string]$Domain = 'beta.synthi.app',
    [string]$AddressName = 'synthi-edge-ip',
    [string]$UrlMapName = 'synthi-edge-url-map',
    [string]$HttpsProxyName = 'synthi-edge-https-proxy',
    [string]$HttpsForwardingRuleName = 'synthi-edge-https-fr',
    [string]$FrontendNegName = 'synthi-frontend-cr-neg',
    [string]$AiGatewayNegName = 'synthi-ai-gateway-cr-neg',
    [string]$AiEngineNegName = 'synthi-ai-engine-cr-neg',
    [string]$CollabNegName = 'collab-server-alb-neg',
    [string]$SignalingNegName = 'signaling-server-alb-neg',
    [string]$YSweetNegName = 'y-sweet-alb-neg',
    [string]$FrontendBackendServiceName = 'synthi-edge-frontend-bs',
    [string]$AiGatewayBackendServiceName = 'synthi-edge-gateway-bs',
    [string]$AiEngineBackendServiceName = 'synthi-edge-ai-engine-bs',
    [string]$CollabBackendServiceName = 'synthi-edge-collab-bs',
    [string]$SignalingBackendServiceName = 'synthi-edge-signaling-bs',
    [string]$YSweetBackendServiceName = 'synthi-edge-ysweet-bs',
    [string]$CollabHealthCheckName = 'synthi-collab-hc',
    [string]$SignalingHealthCheckName = 'synthi-signaling-hc',
    [string]$YSweetHealthCheckName = 'synthi-ysweet-hc',
    [string]$CertificateName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-GcloudValue {
    param([string[]]$Arguments)

    $output = & gcloud @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: gcloud $($Arguments -join ' ')"
    }

    return ($output | Out-String).Trim()
}

function Invoke-GcloudJson {
    param([string[]]$Arguments)

    $output = & gcloud @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: gcloud $($Arguments -join ' ')"
    }

    if ([string]::IsNullOrWhiteSpace($output)) {
        return $null
    }

    return $output | ConvertFrom-Json
}

function Test-GlobalResourceExists($kind, $name) {
    $result = Invoke-GcloudValue @('compute', $kind, 'list', '--project', $ProjectId, '--filter', "name=$name", '--format', 'value(name)')
    return -not [string]::IsNullOrWhiteSpace($result)
}

function Test-RegionalNegExists($name) {
    $result = Invoke-GcloudValue @('compute', 'network-endpoint-groups', 'list', '--project', $ProjectId, '--filter', "name=$name", '--format', 'value(name)')
    return -not [string]::IsNullOrWhiteSpace($result)
}

function Test-ZonalNegExists($name) {
    $result = Invoke-GcloudValue @('compute', 'network-endpoint-groups', 'list', '--project', $ProjectId, '--filter', "name=$name AND zone:$Zone", '--format', 'value(name)')
    return -not [string]::IsNullOrWhiteSpace($result)
}

function Ensure-GlobalAddress() {
    if (-not (Test-GlobalResourceExists 'addresses' $AddressName)) {
        gcloud compute addresses create $AddressName --global --project $ProjectId | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to create address $AddressName" }
    }
}

function Resolve-CertificateName() {
    if (-not [string]::IsNullOrWhiteSpace($CertificateName)) {
        return $CertificateName
    }

    $certs = Invoke-GcloudJson @('compute', 'ssl-certificates', 'list', '--project', $ProjectId, '--format', 'json')
    $active = $certs | Where-Object {
        $_.managed.status -eq 'ACTIVE' -and $_.managed.domains -contains $Domain
    } | Select-Object -First 1

    if (-not $active) {
        throw "No active managed SSL certificate found for $Domain"
    }

    return $active.name
}

function Get-IapSecretValue($key) {
    $secretJson = kubectl get secret iap-oauth-secret -n $Namespace -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to read iap-oauth-secret from Kubernetes'
    }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($secretJson.data.$key))
}

function Ensure-ServerlessNeg($name, $cloudRunService) {
    if (-not (Test-RegionalNegExists $name)) {
        gcloud compute network-endpoint-groups create $name `
            --project $ProjectId `
            --region $Region `
            --network-endpoint-type=serverless `
            --cloud-run-service=$cloudRunService | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to create serverless NEG $name" }
    }
}

function Wait-ForZonalNeg($name) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (Test-ZonalNegExists $name) {
            return
        }
        Start-Sleep -Seconds 15
    }
    throw "Timed out waiting for zonal NEG $name"
}

function Ensure-HttpHealthCheck($name, $port, $path) {
    $args = @(
        'compute', 'health-checks', 'update', 'http', $name,
        '--project', $ProjectId,
        '--global',
        '--port', $port,
        '--request-path', $path,
        '--check-interval', '15s',
        '--timeout', '5s',
        '--healthy-threshold', '1',
        '--unhealthy-threshold', '2'
    )

    if (-not (Test-GlobalResourceExists 'health-checks' $name)) {
        $args[2] = 'create'
    }

    & gcloud @args | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to ensure health check $name"
    }
}

function Ensure-BackendService($name, $timeoutSec, $drainSec, $healthCheckName, [switch]$Serverless) {
    if (-not (Test-GlobalResourceExists 'backend-services' $name)) {
        $args = @(
            'compute', 'backend-services', 'create', $name,
            '--project', $ProjectId,
            '--global',
            '--load-balancing-scheme=EXTERNAL_MANAGED',
            '--protocol=HTTP'
        )

        if (-not $Serverless) {
            $args += @('--timeout', "${timeoutSec}s", '--connection-draining-timeout', "${drainSec}s")
        }

        if (-not [string]::IsNullOrWhiteSpace($healthCheckName)) {
            $args += @('--health-checks', $healthCheckName)
        }

        & gcloud @args | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to create backend service $name" }
    }
    elseif (-not $Serverless) {
        $args = @(
            'compute', 'backend-services', 'update', $name,
            '--project', $ProjectId,
            '--global',
            '--timeout', "${timeoutSec}s",
            '--connection-draining-timeout', "${drainSec}s"
        )

        if (-not [string]::IsNullOrWhiteSpace($healthCheckName)) {
            $args += @('--health-checks', $healthCheckName)
        }

        & gcloud @args | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to update backend service $name" }
    }
}

function Ensure-BackendAttached($backendServiceName, $negName, $locationFlag, $locationValue, $balancingMode = '', $maxRatePerEndpoint = 0) {
    $backend = Invoke-GcloudValue @('compute', 'backend-services', 'describe', $backendServiceName, '--global', '--project', $ProjectId, '--format', 'value(backends[0].group)')
    if ($backend -like "*$negName") {
        return
    }

    $args = @(
        'compute', 'backend-services', 'add-backend', $backendServiceName,
        '--project', $ProjectId,
        '--global',
        '--network-endpoint-group', $negName,
        $locationFlag, $locationValue
    )

    if (-not [string]::IsNullOrWhiteSpace($balancingMode)) {
        $args += @('--balancing-mode', $balancingMode)
    }

    if ($maxRatePerEndpoint -gt 0) {
        $args += @('--max-rate-per-endpoint', $maxRatePerEndpoint)
    }

    & gcloud @args | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Failed to attach NEG $negName to backend service $backendServiceName" }
}

function Ensure-Iap($backendServiceName, $clientId, $clientSecret) {
    $iapArg = "--iap=enabled,oauth2-client-id=$clientId,oauth2-client-secret=$clientSecret"
    & gcloud compute backend-services update $backendServiceName `
        --project $ProjectId `
        --global `
        $iapArg | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure IAP on backend service $backendServiceName" }
}

function Ensure-UrlMap() {
    $frontendRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$FrontendBackendServiceName"
    $gatewayRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$AiGatewayBackendServiceName"
    $aiEngineRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$AiEngineBackendServiceName"
    $collabRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$CollabBackendServiceName"
    $signalRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$SignalingBackendServiceName"
    $ysweetRef = "https://www.googleapis.com/compute/v1/projects/$ProjectId/global/backendServices/$YSweetBackendServiceName"

    $tmp = New-TemporaryFile
    @"
name: $UrlMapName
defaultService: $frontendRef
hostRules:
- hosts:
  - $Domain
  pathMatcher: synthi-edge-matcher
pathMatchers:
- name: synthi-edge-matcher
  defaultService: $frontendRef
  pathRules:
  - paths:
    - /collab
    - /collab/*
    service: $collabRef
  - paths:
    - /signal
    - /signal/*
    service: $signalRef
  - paths:
    - /ysweet
    - /ysweet/*
    service: $ysweetRef
  - paths:
    - /gateway
    - /gateway/*
    service: $gatewayRef
  - paths:
    - /code-intel
    - /code-intel/*
    - /classify
    - /classify/*
    - /provenance
    - /provenance/*
    - /analyze
    - /analyze/*
    - /heal
    - /heal/*
    - /health
    - /health/*
    service: $aiEngineRef
tests:
- host: $Domain
  path: /
  service: $frontendRef
- host: $Domain
  path: /collab
  service: $collabRef
- host: $Domain
  path: /signal
  service: $signalRef
- host: $Domain
  path: /ysweet
  service: $ysweetRef
- host: $Domain
  path: /gateway/ws
  service: $gatewayRef
- host: $Domain
  path: /code-intel/metrics
  service: $aiEngineRef
"@ | Set-Content -Path $tmp -Encoding ascii

    gcloud compute url-maps import $UrlMapName `
        --project $ProjectId `
        --global `
        --source $tmp `
        --quiet | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Failed to import URL map $UrlMapName" }

    Remove-Item $tmp -Force
}

function Ensure-HttpsProxy($certificateName) {
    if (-not (Test-GlobalResourceExists 'target-https-proxies' $HttpsProxyName)) {
        gcloud compute target-https-proxies create $HttpsProxyName `
            --project $ProjectId `
            --url-map $UrlMapName `
            --ssl-certificates $certificateName | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to create target HTTPS proxy $HttpsProxyName" }
    }
    else {
        gcloud compute target-https-proxies update $HttpsProxyName `
            --project $ProjectId `
            --url-map $UrlMapName `
            --ssl-certificates $certificateName | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to update target HTTPS proxy $HttpsProxyName" }
    }
}

function Ensure-HttpsForwardingRule() {
    if (-not (Test-GlobalResourceExists 'forwarding-rules' $HttpsForwardingRuleName)) {
        gcloud compute forwarding-rules create $HttpsForwardingRuleName `
            --project $ProjectId `
            --global `
            --target-https-proxy $HttpsProxyName `
            --ports 443 `
            --address $AddressName | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Failed to create forwarding rule $HttpsForwardingRuleName" }
    }
}

$certificateName = Resolve-CertificateName
$clientId = Get-IapSecretValue 'client_id'
$clientSecret = Get-IapSecretValue 'client_secret'

Ensure-GlobalAddress

Ensure-ServerlessNeg -name $FrontendNegName -cloudRunService 'synthi-frontend'
Ensure-ServerlessNeg -name $AiGatewayNegName -cloudRunService 'synthi-ai-gateway'
Ensure-ServerlessNeg -name $AiEngineNegName -cloudRunService 'synthi-ai-engine'

Wait-ForZonalNeg -name $CollabNegName
Wait-ForZonalNeg -name $SignalingNegName
Wait-ForZonalNeg -name $YSweetNegName

Ensure-HttpHealthCheck -name $CollabHealthCheckName -port 1235 -path '/debug/status'
Ensure-HttpHealthCheck -name $SignalingHealthCheckName -port 8080 -path '/'
Ensure-HttpHealthCheck -name $YSweetHealthCheckName -port 8080 -path '/ready'

Ensure-BackendService -name $FrontendBackendServiceName -timeoutSec 300 -drainSec 30 -healthCheckName '' -Serverless
Ensure-BackendService -name $AiGatewayBackendServiceName -timeoutSec 3600 -drainSec 60 -healthCheckName '' -Serverless
Ensure-BackendService -name $AiEngineBackendServiceName -timeoutSec 30 -drainSec 0 -healthCheckName '' -Serverless
Ensure-BackendService -name $CollabBackendServiceName -timeoutSec 3600 -drainSec 60 -healthCheckName $CollabHealthCheckName
Ensure-BackendService -name $SignalingBackendServiceName -timeoutSec 3600 -drainSec 60 -healthCheckName $SignalingHealthCheckName
Ensure-BackendService -name $YSweetBackendServiceName -timeoutSec 3600 -drainSec 60 -healthCheckName $YSweetHealthCheckName

Ensure-BackendAttached -backendServiceName $FrontendBackendServiceName -negName $FrontendNegName -locationFlag '--network-endpoint-group-region' -locationValue $Region
Ensure-BackendAttached -backendServiceName $AiGatewayBackendServiceName -negName $AiGatewayNegName -locationFlag '--network-endpoint-group-region' -locationValue $Region
Ensure-BackendAttached -backendServiceName $AiEngineBackendServiceName -negName $AiEngineNegName -locationFlag '--network-endpoint-group-region' -locationValue $Region
Ensure-BackendAttached -backendServiceName $CollabBackendServiceName -negName $CollabNegName -locationFlag '--network-endpoint-group-zone' -locationValue $Zone -balancingMode 'RATE' -maxRatePerEndpoint 100
Ensure-BackendAttached -backendServiceName $SignalingBackendServiceName -negName $SignalingNegName -locationFlag '--network-endpoint-group-zone' -locationValue $Zone -balancingMode 'RATE' -maxRatePerEndpoint 100
Ensure-BackendAttached -backendServiceName $YSweetBackendServiceName -negName $YSweetNegName -locationFlag '--network-endpoint-group-zone' -locationValue $Zone -balancingMode 'RATE' -maxRatePerEndpoint 100

Ensure-Iap -backendServiceName $FrontendBackendServiceName -clientId $clientId -clientSecret $clientSecret
Ensure-Iap -backendServiceName $AiGatewayBackendServiceName -clientId $clientId -clientSecret $clientSecret
Ensure-Iap -backendServiceName $AiEngineBackendServiceName -clientId $clientId -clientSecret $clientSecret
Ensure-Iap -backendServiceName $CollabBackendServiceName -clientId $clientId -clientSecret $clientSecret
Ensure-Iap -backendServiceName $SignalingBackendServiceName -clientId $clientId -clientSecret $clientSecret
Ensure-Iap -backendServiceName $YSweetBackendServiceName -clientId $clientId -clientSecret $clientSecret

Ensure-UrlMap
Ensure-HttpsProxy -certificateName $certificateName
Ensure-HttpsForwardingRule

$address = Invoke-GcloudValue @('compute', 'addresses', 'describe', $AddressName, '--global', '--project', $ProjectId, '--format', 'value(address)')

Write-Host ''
Write-Host 'Standalone ALB ready.'
Write-Host "Address: $address"
Write-Host "Certificate: $certificateName"
Write-Host "URL map: $UrlMapName"