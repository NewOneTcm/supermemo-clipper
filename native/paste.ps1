# Native messaging host: reads one length-prefixed JSON message from stdin,
# activates the SuperMemo window, creates a new element (Alt+N) and pastes
# (Ctrl+V), then replies on stdout.
param()

$ErrorActionPreference = "Stop"

function Read-Message {
    $buf = New-Object byte[] 4
    $n = [Console]::OpenStandardInput().Read($buf, 0, 4)
    if ($n -lt 4) { return $null }
    $len = [BitConverter]::ToInt32($buf, 0)
    $body = New-Object byte[] $len
    $read = 0
    $stdin = [Console]::OpenStandardInput()
    while ($read -lt $len) {
        $read += $stdin.Read($body, $read, $len - $read)
    }
    return [Text.Encoding]::UTF8.GetString($body)
}

function Write-Message($obj) {
    $json = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $obj -Compress))
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write([BitConverter]::GetBytes($json.Length), 0, 4)
    $stdout.Write($json, 0, $json.Length)
    $stdout.Flush()
}

$null = Read-Message

# Foreground-lock workaround: AttachThreadInput + SetForegroundWindow is more
# reliable than AppActivate alone when another app currently owns foreground.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

try {
    # 1) Process check first: title matching alone can't tell "not running"
    #    apart from "running but window not found".
    $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "sm*" } |
            Select-Object -First 1
    if (-not $proc) {
        $proc = Get-Process | Where-Object { $_.ProcessName -like "sm*" } | Select-Object -First 1
    }
    if (-not $proc) {
        Write-Message @{ ok = $false; code = "not_running"; error = "SuperMemo process not found" }
        exit 0
    }

    # 2) Activate the window, retrying once after a short settle delay.
    $shell = New-Object -ComObject WScript.Shell
    $activated = $false
    foreach ($attempt in 1..2) {
        if ($proc.MainWindowHandle -ne 0) {
            [FG]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
            $activated = [FG]::SetForegroundWindow($proc.MainWindowHandle)
        }
        if (-not $activated) { $activated = $shell.AppActivate("SuperMemo") }
        if ($activated) { break }
        Start-Sleep -Milliseconds 300
        $proc.Refresh()
    }
    if (-not $activated) {
        Write-Message @{ ok = $false; code = "activate_failed"; error = "SuperMemo window could not be activated" }
        exit 0
    }

    # 3) New element, wait for it to take focus, then paste.
    Start-Sleep -Milliseconds 250
    $shell.SendKeys("%n")   # Alt+N: new element/page in SuperMemo
    Start-Sleep -Milliseconds 400
    $shell.SendKeys("^v")   # Ctrl+V: paste clipboard content

    Write-Message @{ ok = $true }
} catch {
    Write-Message @{ ok = $false; code = "error"; error = $_.Exception.Message }
}
