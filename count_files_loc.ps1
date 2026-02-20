# Count files and lines-of-code (LOC) under a directory, excluding noisy dirs.
# Excludes directories named node_modules, target, and common by default.

param(
    [string]$Path = '.',
    [string[]]$ExcludeDirs = @('node_modules','target','common','dist','build','out','.next','public','vendor'),
    [string[]]$ExcludeFilePatterns = @('\.min\.js$','\.bundle\.js$','\.map$'),
    [string[]]$IncludeExts = @('rs','js','py','proto','jsx')
)

Write-Output "Scanning path: $Path"
$excludePattern = '(^|[\\/])(' + ($ExcludeDirs -join '|') + ')([\\/]|$)'
$excludeFilePattern = if ($ExcludeFilePatterns -and $ExcludeFilePatterns.Length -gt 0) { '(' + ($ExcludeFilePatterns -join '|') + ')' } else { '' }

$totalFiles = 0
$totalLines = 0
$extStats = @{}

Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $notInExcludeDir = -not ($_.FullName -match $excludePattern)
        $notMatchFilePattern = if ($excludeFilePattern -ne '') { -not ($_.Name -match $excludeFilePattern) } else { $true }
        $notInExcludeDir -and $notMatchFilePattern
    } |
    ForEach-Object {
        $file = $_
        $totalFiles++
        try {
            $lines = (Get-Content -LiteralPath $file.FullName -ErrorAction Stop | Measure-Object -Line).Lines
        } catch {
            return
        }
        $totalLines += $lines
        $ext = ($file.Extension -replace '^\.', '')
        if ([string]::IsNullOrEmpty($ext)) { $ext = '<no-ext>' }
        if (-not $extStats.ContainsKey($ext)) { $extStats[$ext] = [PSCustomObject]@{Files=0;Lines=0} }
        $entry = $extStats[$ext]
        $entry.Files += 1
        $entry.Lines += $lines
        $extStats[$ext] = $entry
    }

Write-Output ""
Write-Output "Total files: $totalFiles"
Write-Output "Total lines: $totalLines"
Write-Output ""
Write-Output "Selected extensions summary:"
foreach ($e in $IncludeExts) {
    $key = $e
    if ($extStats.ContainsKey($key)) {
        $v = $extStats[$key]
        Write-Output ("{0,6} files  {1,8} lines  ext: {2}" -f $v.Files, $v.Lines, $key)
    } else {
        Write-Output ("{0,6} files  {1,8} lines  ext: {2}" -f 0, 0, $key)
    }
}
Write-Output ""
Write-Output "Top extensions by files:"
$extStats.GetEnumerator() |
    Sort-Object { -$_.Value.Files } |
    Select-Object -First 20 |
    ForEach-Object {
        $k = $_.Key; $v = $_.Value
        Write-Output ("{0,6} files  {1,8} lines  ext: {2}" -f $v.Files, $v.Lines, $k)
    }

Write-Output ""
Write-Output "To customize exclusions, pass -ExcludeDirs param."
