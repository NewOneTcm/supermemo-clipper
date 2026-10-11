# Round-trip test for the CF_HTML SourceURL repair (dev tool, not shipped).
#
# Runs the REAL repair code (native/cfhtml.ps1 + the CLIP class) against the
# clipboard content that is on the clipboard right now, in three steps:
#
#   1. dry run  - reports the current SourceURL and what it would become,
#                 without touching the clipboard.
#   2. real run - rewrites SourceURL to the page URL and reads it back.
#   3. proof    - the fragment bytes must be IDENTICAL before and after; only
#                 the header may differ. Any change in the note itself is a
#                 failure, and the original clipboard content is restored.
#
# The original payload is always dumped to %TEMP%\supermemo-clipper-clipboard-backup.bin
# first, so nothing can be lost.
#
#   powershell -ExecutionPolicy Bypass -File test\cfhtml-roundtrip.ps1
#
# A passing run deliberately leaves the rewritten payload on the clipboard (that
# is the thing being demonstrated) and prints where the original was backed up.
# To put the original back:
#
#   powershell -ExecutionPolicy Bypass -File test\cfhtml-roundtrip.ps1 -Restore
param([switch]$Restore)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $root -or -not (Test-Path (Join-Path $root "native"))) {
    $root = "D:\develop\supermemo-clipper-v2"
}

# Load the helper exactly like the host does: cached compile, keyed by source.
$helperSrc = Join-Path $root "native\fghelper.cs"
$helperDir = Join-Path $env:LOCALAPPDATA "SuperMemoClipper"
New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
$code = Get-Content $helperSrc -Raw -Encoding UTF8
$sha = New-Object System.Security.Cryptography.SHA1Managed
$stamp = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code))).Replace("-", "").Substring(0, 10).ToLower()
$dll = Join-Path $helperDir ("cfhtml-test-" + $stamp + ".dll")
if (-not ([System.Management.Automation.PSTypeName]'CLIP').Type) {
    try { Add-Type -Path $dll } catch { }
}
if (-not ([System.Management.Automation.PSTypeName]'CLIP').Type) {
    Add-Type -TypeDefinition $code -OutputAssembly $dll
    Add-Type -Path $dll
}
. (Join-Path $root "native\cfhtml.ps1")

function Fail($msg) { Write-Output ("FAIL: " + $msg); exit 1 }

$backup = Join-Path $env:TEMP "supermemo-clipper-clipboard-backup.bin"

if ($Restore) {
    # Undo a previous passing run: the only thing that run changed was the
    # SourceURL inside the CF_HTML block (it wrote the same text flavor back), so
    # putting the saved bytes back restores the clipboard exactly.
    if (-not (Test-Path $backup)) { Fail ("no backup at " + $backup) }
    $orig = [System.IO.File]::ReadAllBytes($backup)
    $text = [CLIP]::ReadText()
    if (-not [CLIP]::Write("HTML Format", $orig, $text)) { Fail "clipboard write refused" }
    $hdr = Get-CfHeaderText $orig
    $src = [regex]::Match($hdr, $CF_RE["SourceURL"])
    Write-Output ("RESTORED " + $orig.Length + " bytes from " + $backup)
    Write-Output ("  SourceURL is back to: " + $src.Groups[1].Value.Trim())
    exit 0
}

$before = [CLIP]::ReadFormat("HTML Format")
if (-not $before) { Fail "no CF_HTML on the clipboard - copy something in the browser first" }
$textBefore = [CLIP]::ReadText()
[System.IO.File]::WriteAllBytes($backup, $before)
Write-Output ("[0] original CF_HTML: " + $before.Length + " bytes -> backed up to " + $backup)

$h = Get-CfHeaderText $before
$hdr = $h -split "`r`n"
foreach ($l in $hdr) { if ($l.Trim()) { Write-Output ("      " + $l.Trim()) } }

$fs = Read-CfNumber $h "StartFragment"
$fe = Read-CfNumber $h "EndFragment"
$noteBefore = $before[$fs..($fe - 1)]

# The page URL is what the note itself says it came from. The URL must stop at
# the first character that cannot be part of one: inside the fragment the
# "#Link:" value is immediately followed by markup (</span>...), so a plain
# \S+ would swallow the rest of the document.
$lm = [regex]::Match([Text.Encoding]::UTF8.GetString($before), "#Link:\s*(https?://[^\s<""']+)")
$pageUrl = $lm.Groups[1].Value.Trim()
if (-not $pageUrl) { $pageUrl = "https://example.com/round-trip-test" }
Write-Output ("[1] page url used for the test: " + $pageUrl)

$dry = Repair-ClipboardSourceUrl $pageUrl $false
Write-Output ("[2] dry run : status=" + $dry.status + " before='" + $dry.source_before + "' after='" + $dry.source_after + "' detail='" + $dry.detail + "'")
if ($dry.status -ne "would-fix" -and $dry.status -ne "current") { Fail ("dry run did not want to fix (" + $dry.status + ": " + $dry.detail + ")") }

$real = Repair-ClipboardSourceUrl $pageUrl $true
Write-Output ("[3] real run: status=" + $real.status + " after='" + $real.source_after + "' bytes=" + $real.bytes + " detail='" + $real.detail + "'")
if ($real.status -ne "fixed" -and $real.status -ne "current") {
    [CLIP]::Write("HTML Format", $before, $textBefore) | Out-Null
    Fail ("repair failed (" + $real.status + ": " + $real.detail + "); clipboard restored")
}

$after = [CLIP]::ReadFormat("HTML Format")
$h2 = Get-CfHeaderText $after
$fs2 = Read-CfNumber $h2 "StartFragment"
$fe2 = Read-CfNumber $h2 "EndFragment"
$noteAfter = $after[$fs2..($fe2 - 1)]

$same = ($noteAfter.Length -eq $noteBefore.Length)
if ($same) {
    for ($i = 0; $i -lt $noteBefore.Length; $i++) {
        if ($noteBefore[$i] -ne $noteAfter[$i]) { $same = $false; break }
    }
}
Write-Output ("[4] note bytes: " + $noteBefore.Length + " -> " + $noteAfter.Length + ", identical=" + $same)
if (-not $same) {
    [CLIP]::Write("HTML Format", $before, $textBefore) | Out-Null
    Fail "the note itself changed - aborting and restoring the clipboard"
}

$txt2 = [CLIP]::ReadText()
Write-Output ("[5] text flavor: " + $textBefore.Length + " -> " + $txt2.Length + " chars, identical=" + ($txt2 -eq $textBefore))
if ($txt2 -ne $textBefore) {
    [CLIP]::Write("HTML Format", $before, $textBefore) | Out-Null
    Fail "the text flavor changed - aborting and restoring the clipboard"
}

# Idempotence: a second run must recognise the good SourceURL and do nothing.
$again = Repair-ClipboardSourceUrl $pageUrl $true
Write-Output ("[6] second run: status=" + $again.status + " (expected current)")
if ($again.status -ne "current") {
    [CLIP]::Write("HTML Format", $before, $textBefore) | Out-Null
    Fail "second run was not a no-op"
}

Write-Output ""
Write-Output "PASS - the note survived byte-for-byte, only SourceURL changed."
Write-Output ("       clipboard SourceURL is now: " + $pageUrl)
Write-Output ("       original payload kept at: " + $backup)
