$files = Get-ChildItem -Recurse -File -Include *.ts,*.js,*.jsx,*.tsx,*.rs,*.proto,*.py,*.md,*.mjs,*.html,*.css,*.dockerfile,Dockerfile |
    Where-Object {
        $_.FullName -notmatch '\\node_modules\\' -and
        $_.FullName -notmatch '\\build\\'        -and
        $_.FullName -notmatch '\\dist\\'         -and
        $_.FullName -notmatch '\\.next\\'        -and
        $_.FullName -notmatch '\\target\\'       -and
        $_.FullName -notmatch '\\.cargo\\'       -and
        $_.FullName -notmatch '\\out\\'          -and
        $_.FullName -notmatch '\\coverage\\'     -and
        $_.FullName -notmatch '\\__pycache__\\'  -and
        $_.FullName -notmatch '\\.mypy_cache\\'  -and
        $_.FullName -notmatch '\\.pytest_cache\\'
    }

$totalLoc = 0
foreach ($f in $files) {
    $totalLoc += (Get-Content $f.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
}

Write-Host "Files : $($files.Count)"
Write-Host "LOC   : $totalLoc"
