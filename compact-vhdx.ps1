$ErrorActionPreference = 'Stop'
$paths = @(
    "D:\wsl\Ubuntu\ext4.vhdx",
    "D:\Docker\wsl\disk\docker_data.vhdx",
    "D:\Docker\engine\disk\docker_data.vhdx",
    "D:\Docker\wsl\main\ext4.vhdx"
)
$log = "D:\wsl\compact-result.log"
"started $(Get-Date -Format o)" | Out-File $log -Encoding utf8
foreach ($p in $paths) {
    if (-not (Test-Path $p)) {
        "skip (missing): $p" | Out-File $log -Append -Encoding utf8
        continue
    }
    $before = (Get-Item $p).Length
    "before $p = $([math]::Round($before/1GB,3)) GB" | Out-File $log -Append -Encoding utf8
    try {
        Optimize-VHD -Path $p -Mode Full
        $after = (Get-Item $p).Length
        $saved = ($before - $after) / 1GB
        "after  $p = $([math]::Round($after/1GB,3)) GB  (saved $([math]::Round($saved,3)) GB)" | Out-File $log -Append -Encoding utf8
    } catch {
        "ERROR on $p : $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
    }
}
"finished $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
