# Coloca la ventana principal de un proceso (por defecto MuseScore) en un rectángulo de pantalla (píxeles físicos).
# Uso: powershell -File dock-windows.ps1 -X 0 -Y 0 -Width 1300 -Height 1000 [-Process MuseScore]
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [string]$Process = 'MuseScore'
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CaWin {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@

$p = Get-Process | Where-Object { $_.ProcessName -match $Process -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NOT_FOUND"; exit 2 }
[void][CaWin]::ShowWindow($p.MainWindowHandle, 9)   # SW_RESTORE: sale de maximizada
[void][CaWin]::MoveWindow($p.MainWindowHandle, $X, $Y, $Width, $Height, $true)
Write-Output "OK $($p.ProcessName) $($p.MainWindowTitle)"
