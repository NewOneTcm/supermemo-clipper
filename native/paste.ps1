# Native messaging host: reads one length-prefixed JSON message from stdin,
# brings SuperMemo to the foreground, and sends Ctrl+N — SuperMemo's
# "Edit : Add a new article", which creates the element AND pastes the clipboard
# itself, in one step (exactly what a human does when clipping a page).
#
# Why the foreground work is so fussy, and why this file grew a verifier:
# SendKeys delivers to whatever window currently owns the FOREGROUND. This host
# is started by Chrome *in the background*, and Windows' foreground lock
# ("a background app may not steal focus from the user") routinely downgrades
# SetForegroundWindow to a bare title-bar / taskbar FLASH. That is exactly the
# "SuperMemo flashed once but nothing was pasted" symptom: the key went to
# Chrome, not to SuperMemo. So we now
#   (a) take the foreground with the AttachThreadInput trick,
#   (b) VERIFY with GetForegroundWindow that a SuperMemo window really owns it,
#       re-asserting in a short loop — Chrome also grabs focus back at the
#       moment its action popup closes, which is what made this a race,
#   (c) only then send Ctrl+N, and re-check afterwards who owns the foreground,
#   (d) write what actually happened to %TEMP%\supermemo-clipper-last.json.
#
# Two actions, both taken from the JSON message on stdin:
#   { "action": "new_and_paste" }  default: clipboard guard -> Ctrl+N
#   { "action": "diagnose" }       checks only, sends NO keystroke and creates
#                                  NO element, then restores the previous
#                                  foreground window.
param()

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Diagnostics. stdout carries the native-messaging protocol, so anything extra
# written there makes Chrome drop the host — every diagnostic goes to a file.
# ---------------------------------------------------------------------------
$LOG_PATH = Join-Path $env:TEMP "supermemo-clipper-last.json"
$script:Diag = [ordered]@{ host = "supermemo-clipper-v2"; ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") }

function Set-Diag($key, $value) { $script:Diag[$key] = $value }

function Save-Diag {
    try {
        # Written without a BOM: this file is meant to be read by people and by
        # other tools (the popup shows it through the diagnose call), and
        # PowerShell 5.1's `Set-Content -Encoding UTF8` would prepend one.
        $json = $script:Diag | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText(
            $LOG_PATH, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

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
    # -Depth matters: the diagnose payload nests arrays and the previous run's
    # record, and the default depth of 2 silently truncates them.
    $json = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $obj -Compress -Depth 6))
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write([BitConverter]::GetBytes($json.Length), 0, 4)
    $stdout.Write($json, 0, $json.Length)
    $stdout.Flush()
}

# --- window / foreground helper --------------------------------------------
# The P/Invoke layer lives in fghelper.cs so it can be compiled ONCE and then
# merely loaded. Measured on this machine: PowerShell start-up ~1.4s, compiling
# that source inside the host +~1.8s, loading a ready-made assembly +~0.25s. The
# cache is keyed by a hash of the source, so editing the .cs invalidates it.
$helperRoot = $PSScriptRoot
if (-not $helperRoot) { $helperRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$HELPER_SRC = Join-Path $helperRoot "fghelper.cs"
$HELPER_DIR = Join-Path $env:LOCALAPPDATA "SuperMemoClipper"

$helperCode = Get-Content $HELPER_SRC -Raw -Encoding UTF8
$sha = New-Object System.Security.Cryptography.SHA1Managed
$stamp = [BitConverter]::ToString(
    $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($helperCode))
).Replace("-", "").Substring(0, 10).ToLower()
$HELPER_DLL = Join-Path $HELPER_DIR "fghelper-$stamp.dll"

function Test-FgType { [bool]([System.Management.Automation.PSTypeName]'FG').Type }

if (Test-Path $HELPER_DLL) {
    try { Add-Type -Path $HELPER_DLL } catch { }
}
if (-not (Test-FgType)) {
    # First run (or the cached copy was stale / quarantined): compile it and
    # keep the result for every later run.
    try {
        New-Item -ItemType Directory -Force -Path $HELPER_DIR | Out-Null
        Add-Type -TypeDefinition $helperCode -OutputAssembly $HELPER_DLL -ErrorAction Stop
        # -OutputAssembly only writes the file, it does not load it — load what
        # we just built so this run does not pay for a second compile.
        try { Add-Type -Path $HELPER_DLL } catch { }
    } catch { }
}
if (-not (Test-FgType)) {
    # Last resort: compile in memory. Slower, but the host must never fail just
    # because the cache directory was not writable.
    Add-Type -TypeDefinition $helperCode
}

# --- helpers ---------------------------------------------------------------

function Get-ClipboardState {
    $s = @{ usable = $true; formats = @(); textLen = 0; hasHtml = $false; probeError = $null }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $d = [System.Windows.Forms.Clipboard]::GetDataObject()
        $s.formats = @($d.GetFormats($false))
        $t = $d.GetData("UnicodeText")
        if (-not $t) { $t = $d.GetData("Text") }
        $t = [string]$t
        $s.textLen = $t.Trim().Length
        $s.hasHtml = [bool]$d.GetDataPresent("HTML Format")
        if ($s.textLen -eq 0) { $s.usable = $false }
    } catch {
        # Probe unavailable (assembly / apartment): never block on it.
        $s.probeError = $_.Exception.Message
    }
    return $s
}

function Get-SmProcess {
    $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "sm*" } |
         Select-Object -First 1
    if (-not $p) {
        $p = Get-Process | Where-Object { $_.ProcessName -like "sm*" } | Select-Object -First 1
    }
    return $p
}

# CF_HTML source repair (the SourceURL fix) lives in cfhtml.ps1: it is pure
# byte surgery on the clipboard stream, and it is tested on its own.
. (Join-Path $helperRoot "cfhtml.ps1")

# SuperMemo keeps several top-level windows (element windows are titled with the
# element, plus Contents / Read / Statistics ...). Any of them owning the
# foreground is enough — Ctrl+N is an application-level shortcut — so the
# verifier only ever compares process ids, never handles.
function Get-SmWindows($proc) {
    $list = New-Object System.Collections.ArrayList
    if ($proc.MainWindowHandle -ne 0) { [void]$list.Add([IntPtr]$proc.MainWindowHandle) }
    foreach ($h in [FG]::VisibleWindowsOf([uint32]$proc.Id)) {
        $p = [IntPtr]$h
        if ($p -ne [IntPtr]$proc.MainWindowHandle) { [void]$list.Add($p) }
    }
    return ,$list
}

function Set-ForegroundVerified($candidates, $smPid, $shell, $timeoutMs) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    $attempts = 0
    while ((Get-Date) -lt $deadline) {
        $target = $candidates[$attempts % $candidates.Count]
        [void][FG]::Force($target)
        Start-Sleep -Milliseconds 90
        $attempts++
        if ([FG]::ForegroundPid() -eq $smPid) { break }
        # Secondary path: WScript's AppActivate sometimes succeeds where the
        # direct call was refused (it uses a different internal route).
        if ($attempts % 3 -eq 0) { [void]$shell.AppActivate("SuperMemo") }
    }
    return @{
        ok = ([FG]::ForegroundPid() -eq $smPid)
        attempts = $attempts
        title = [FG]::ForegroundTitle()
    }
}

# --- main ------------------------------------------------------------------

$previousForeground = [FG]::GetForegroundWindow()

# Keep the *previous* run's record before this one overwrites the file: the
# popup can't show a result while it is being closed by SuperMemo taking focus,
# so "what did the host actually do last time" is asked for on demand, and the
# answer is this file.
$previousRun = $null
try {
    if (Test-Path $LOG_PATH) {
        $previousRun = Get-Content $LOG_PATH -Raw -Encoding UTF8 | ConvertFrom-Json
    }
} catch { }

$action = "new_and_paste"
$pageUrl = ""
$extVersion = ""
$raw = Read-Message
if ($raw) {
    try {
        $msg = $raw | ConvertFrom-Json
        if ($msg.action) { $action = [string]$msg.action }
        if ($msg.pageUrl) { $pageUrl = [string]$msg.pageUrl }
        if ($msg.version) { $extVersion = [string]$msg.version }
    } catch { }
}
Set-Diag "action" $action
Set-Diag "page_url" $pageUrl
Set-Diag "extension_version" $extVersion

try {
    # 0) Clipboard guard. SuperMemo's article paste reads the clipboard itself
    #    and reports "Error adding new text topic. Cannot open clipboard" when
    #    it is locked or empty — an error we can neither explain nor retry from
    #    here. Probing it first is also the fastest way to tell "we never got
    #    the content copied" apart from "we pasted the wrong thing".
    $clip = Get-ClipboardState
    Set-Diag "clipboard_formats" $clip.formats
    Set-Diag "clipboard_text_len" $clip.textLen
    Set-Diag "clipboard_has_html" $clip.hasHtml
    if ($clip.probeError) { Set-Diag "clipboard_probe_error" $clip.probeError }

    if (-not $clip.usable -and $action -ne "diagnose") {
        Set-Diag "result" "clipboard_empty"
        Save-Diag
        Write-Message @{ ok = $false; code = "clipboard_empty"; error = "clipboard has no text" }
        exit 0
    }

    # 1) Process check first: title matching alone can't tell "not running"
    #    apart from "running but window not found".
    $proc = Get-SmProcess
    if (-not $proc) {
        Set-Diag "result" "not_running"
        Save-Diag
        Write-Message @{ ok = $false; code = "not_running"; error = "SuperMemo process not found" }
        exit 0
    }
    $smPid = [uint32]$proc.Id
    Set-Diag "sm_process" $proc.ProcessName
    Set-Diag "sm_pid" $proc.Id

    # 2) Candidate windows: main window first, then the rest topmost-first.
    $candidates = Get-SmWindows $proc
    Set-Diag "sm_window_count" $candidates.Count
    $titles = @()
    foreach ($h in $candidates) { $titles += [FG]::Title($h) }
    Set-Diag "sm_window_titles" $titles

    if ($candidates.Count -eq 0) {
        Set-Diag "result" "no_window"
        Save-Diag
        Write-Message @{ ok = $false; code = "activate_failed"; error = "SuperMemo has no visible top-level window" }
        exit 0
    }

    # 3) Fight for the foreground, then PROVE we have it before sending keys.
    #    The loop matters: the popup closes the instant SuperMemo comes forward,
    #    which hands the foreground back to Chrome — a one-shot activate loses
    #    that race, the loop wins it.
    $shell = New-Object -ComObject WScript.Shell
    $take = Set-ForegroundVerified $candidates $smPid $shell 2500
    Set-Diag "foreground_attempts" $take.attempts
    Set-Diag "foreground_taken" $take.ok

    if ($action -eq "diagnose") {
        # Dry run of the CF_HTML repair: report what the clipboard's SourceURL
        # is and what it would become, without touching the clipboard.
        $fix = Repair-ClipboardSourceUrl $pageUrl $false
        Set-Diag "clipboard_rewrite" $fix.status
        Set-Diag "clipboard_source_before" $fix.source_before
        Set-Diag "result" "diagnose"
        Save-Diag
        Write-Message @{
            ok = $true
            code = "diagnose"
            action = "diagnose"
            clipboardFormats = $clip.formats
            clipboardTextLen = $clip.textLen
            clipboardHasHtml = $clip.hasHtml
            clipboardProbeError = $clip.probeError
            clipSourceUrl = $fix.source_before
            clipSourceWouldBe = $fix.source_after
            clipSourceStatus = $fix.status
            clipSourceDetail = $fix.detail
            smProcess = $proc.ProcessName
            smPid = $proc.Id
            windowCount = $candidates.Count
            windows = @($titles | Select-Object -First 6)
            foregroundTaken = $take.ok
            foregroundTitle = $take.title
            attempts = $take.attempts
            previousRun = $previousRun
            log = $LOG_PATH
        }
        # Leave the desktop as we found it — the user asked for a check, not a
        # focus steal.
        try { [void][FG]::Force($previousForeground) } catch { }
        exit 0
    }

    if (-not $take.ok) {
        Set-Diag "result" "activate_failed"
        Set-Diag "foreground_title" $take.title
        Save-Diag
        Write-Message @{
            ok = $false
            code = "activate_failed"
            error = "SuperMemo could not take the foreground (currently '" + $take.title + "')"
            fg = $take.title
        }
        exit 0
    }

    # Let the focus land inside the app, then re-verify immediately before the
    # keypress so we never type into whatever grabbed the foreground meanwhile.
    Start-Sleep -Milliseconds 90
    if ([FG]::ForegroundPid() -ne $smPid) {
        [void][FG]::Force($candidates[0])
        Start-Sleep -Milliseconds 90
    }
    $fgTitle = [FG]::ForegroundTitle()
    Set-Diag "foreground_title" $fgTitle
    Set-Diag "foreground_pid" ([FG]::ForegroundPid())
    $windowsBefore = @([FG]::VisibleWindowsOf($smPid)).Count

    # 3b) Make the pasted payload look like a manual Ctrl+C: the CF_HTML
    #     SourceURL must be the PAGE, not the extension popup. Chrome writes the
    #     popup's chrome-extension:// URL, which IE cannot use as a base, and an
    #     unusable base is what turns into a res:// link and Windows' "open this
    #     'res' link?" dialog. SuperMemo is already in the foreground here, so it
    #     reads the clipboard a moment later — write it now, verify it, and only
    #     then send the key. A failure here is logged and ignored: pasting the
    #     note beats refusing to paste it.
    $fix = Repair-ClipboardSourceUrl $pageUrl $true
    Set-Diag "clipboard_rewrite" $fix.status
    Set-Diag "clipboard_source_before" $fix.source_before
    Set-Diag "clipboard_source_after" $fix.source_after
    if ($fix.detail) { Set-Diag "clipboard_rewrite_detail" $fix.detail }

    # 4) Add a new article, in ONE step. Ctrl+N is SuperMemo's
    #    "Edit : Add a new article" — SuperMemo creates the element and pastes
    #    the clipboard into it by itself. That is exactly what a human does when
    #    clipping a page, and it is why this host no longer sends Alt+N + Ctrl+V:
    #      * Alt+N is "Add a note" — it creates a BLANK element and ignores the
    #        clipboard, so it needed the extra Ctrl+V to be useful.
    #      * That Ctrl+V then raced the element editor for focus. If it lost,
    #        it landed on the Contents window, where Ctrl+V means
    #        "Paste element" — which only accepts data SuperMemo's own
    #        Copy element put on the clipboard, so foreign HTML raised an error.
    #    One SendKeys also halves the timing gamble.
    $shell.SendKeys("^n")

    # 5) Report who was holding the foreground when the key went out, and
    #    whether SuperMemo opened anything new — the closest thing to a receipt
    #    we can get without poking around inside SuperMemo.
    Start-Sleep -Milliseconds 800
    $fgAfter = [FG]::ForegroundTitle()
    $fgAfterPid = [FG]::ForegroundPid()
    $windowsAfter = @([FG]::VisibleWindowsOf($smPid)).Count
    Set-Diag "foreground_after" $fgAfter
    Set-Diag "foreground_after_pid" $fgAfterPid
    Set-Diag "sm_windows_before" $windowsBefore
    Set-Diag "sm_windows_after" $windowsAfter
    Set-Diag "result" "sent"
    Save-Diag

    Write-Message @{
        ok = $true
        fg = $fgTitle
        fgAfter = $fgAfter
        attempts = $take.attempts
        newWindow = ($windowsAfter -gt $windowsBefore)
        sourceStatus = $fix.status
        sourceUrl = $fix.source_after
        log = $LOG_PATH
    }
} catch {
    Set-Diag "result" "error"
    Set-Diag "error" $_.Exception.Message
    Save-Diag
    Write-Message @{ ok = $false; code = "error"; error = $_.Exception.Message }
}
