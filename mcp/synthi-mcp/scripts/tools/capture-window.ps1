param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$ProcessName = "",

  [string]$TitlePattern = "",

  [int]$WaitMilliseconds = 1200000
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Error $_
  exit 1
}

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SynthiTargetWindowCapture {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@

function Get-TargetWindows {
  $windowMatches = New-Object System.Collections.ArrayList
  $processNames = @()
  if ($ProcessName.Trim()) {
    $processNames = $ProcessName.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }

  $callback = [SynthiTargetWindowCapture+EnumWindowsProc]{
    param([IntPtr]$Handle, [IntPtr]$Param)

    if (-not [SynthiTargetWindowCapture]::IsWindowVisible($Handle)) {
      return $true
    }

    $length = [SynthiTargetWindowCapture]::GetWindowTextLength($Handle)
    if ($length -le 0) {
      return $true
    }

    $text = New-Object System.Text.StringBuilder ($length + 1)
    [void][SynthiTargetWindowCapture]::GetWindowText($Handle, $text, $text.Capacity)
    $title = $text.ToString()

    [uint32]$windowProcessId = 0
    [void][SynthiTargetWindowCapture]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId)
    $process = Get-Process -Id ([int]$windowProcessId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      return $true
    }

    if ($processNames.Count -gt 0 -and ($processNames -notcontains $process.ProcessName)) {
      return $true
    }

    if ($TitlePattern.Trim() -and ($title -notmatch $TitlePattern)) {
      return $true
    }

    $windowMatches.Add([PSCustomObject]@{
      Handle = $Handle
      Title = $title
      ProcessId = [int]$windowProcessId
      ProcessName = $process.ProcessName
    }) | Out-Null
    return $true
  }

  [void][SynthiTargetWindowCapture]::EnumWindows($callback, [IntPtr]::Zero)
  return $windowMatches
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
$target = $null
do {
  $target = Get-TargetWindows | Select-Object -First 1
  if ($null -ne $target) {
    break
  }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

if ($null -eq $target) {
  throw "No matching window found. ProcessName='$ProcessName' TitlePattern='$TitlePattern'"
}

[void][SynthiTargetWindowCapture]::ShowWindow($target.Handle, 9)
[void][SynthiTargetWindowCapture]::SetForegroundWindow($target.Handle)
Start-Sleep -Milliseconds 500

$rect = New-Object SynthiTargetWindowCapture+Rect
if (-not [SynthiTargetWindowCapture]::GetWindowRect($target.Handle, [ref]$rect)) {
  throw "Failed to read target window bounds."
}

$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$dir = Split-Path -Parent $OutputPath
if ($dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::Black)
  $hdc = $graphics.GetHdc()
  try {
    $rendered = [SynthiTargetWindowCapture]::PrintWindow($target.Handle, $hdc, 2)
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
  if (-not $rendered) {
    throw "PrintWindow failed for process=$($target.ProcessName) pid=$($target.ProcessId) title=$($target.Title)"
  }
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "captured_window_print path=$OutputPath width=$width height=$height process=$($target.ProcessName) pid=$($target.ProcessId) title=$($target.Title)"
