param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($installer) -ne ".exe") {
  throw "The Windows installer smoke test requires an NSIS .exe bundle."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
$installDir = [IO.Path]::GetFullPath((Join-Path $tempRoot "vectant-local-support-installer-$([Guid]::NewGuid().ToString('N'))"))
if (-not $installDir.StartsWith($tempRoot + "\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "The installer smoke target escaped the temporary directory."
}

$appProcess = $null
$uninstaller = $null
try {
  $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDir") -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "NSIS installer exited with code $($install.ExitCode)." }

  $app = Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "*.exe" |
    Where-Object { $_.Name -notmatch "uninstall" } |
    Select-Object -First 1
  if (-not $app) { throw "The installed Local Support executable was not found." }
  $uninstaller = Get-ChildItem -LiteralPath $installDir -File -Filter "*uninstall*.exe" | Select-Object -First 1
  if (-not $uninstaller) { throw "The generated NSIS uninstaller was not found." }

  $appProcess = Start-Process -FilePath $app.FullName -WorkingDirectory $installDir -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(15)
  $listener = $null
  do {
    if (-not (Get-Process -Id $appProcess.Id -ErrorAction SilentlyContinue)) {
      throw "The installed Local Support app exited during startup."
    }
    $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $appProcess.Id -and $_.LocalAddress -eq "127.0.0.1" } |
      Select-Object -First 1
    if (-not $listener) { Start-Sleep -Milliseconds 250 }
  } while (-not $listener -and (Get-Date) -lt $deadline)
  if (-not $listener) { throw "The installed Local Support app opened no loopback-only listener." }

  $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($listener.LocalPort)/health" -TimeoutSec 5
  $healthBody = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -ne 200 -or $healthBody.ok -ne $true -or $healthBody.service -ne "vectant-local-support-app") {
    throw "The installed Local Support health response was invalid."
  }
  $statusAccepted = $false
  $statusCode = $null
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($listener.LocalPort)/v1/status/installer-smoke" -TimeoutSec 5 | Out-Null
    $statusAccepted = $true
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
  }
  if ($statusAccepted) { throw "The installed Local Support status endpoint accepted an unprotected request." }
  if ($statusCode -notin @(401, 403)) { throw "The installed Local Support status boundary returned $statusCode instead of 401/403." }

  Write-Output "Installed app launched with loopback listener $($listener.LocalAddress):$($listener.LocalPort)."
  Write-Output "Installed app health and protected status boundary checks passed."
  Stop-Process -Id $appProcess.Id -Force
  $appProcess = $null

  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "NSIS uninstaller exited with code $($uninstall.ExitCode)." }
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $app.FullName) { throw "The application executable remained after uninstall." }
  if (Get-Process -Name "vectant-local-support-desktop" -ErrorAction SilentlyContinue) {
    throw "A Local Support process remained after uninstall."
  }
  Write-Output "Installer launch and uninstall smoke test passed."
} finally {
  if ($appProcess -and (Get-Process -Id $appProcess.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($uninstaller -and (Test-Path -LiteralPath $uninstaller.FullName)) {
    Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
  }
}
