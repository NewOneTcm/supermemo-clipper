# Clipboard forensics for the SuperMemo clipper (dev/user tool).
#
# Reads what is ACTUALLY on the clipboard right now - the CF_HTML stream, i.e.
# the exact bytes Internet Explorer / SuperMemo parses when you press Ctrl+N -
# and reports the header plus every URL-looking value inside the fragment.
#
# Why this exists: SuperMemo renders notes in an IE (mshtml) component. IE
# resolves any URL that is not absolute against the base URL of the document,
# and for a document that has no usable base it falls back to its own internal
# `res://` base (Microsoft documents this: setting a relative img src in IE
# reads back as "res://<module path>/<src>"). Windows cannot open a res://
# link, so ShellExecute hands it to the shell and Windows pops
# "How do you want to open this 'res' link?".
#
# The base URL of a clipboard paste is the CF_HTML `SourceURL:` line. Chrome
# writes the URL of whatever document performed the copy - for this extension
# that is the *popup*, i.e. chrome-extension://<id>/popup/popup.html, which IE
# cannot use as a base at all. Manual Ctrl+C in a web page writes the page URL
# instead, which is why pasting by hand never showed the dialog.
#
#   powershell -ExecutionPolicy Bypass -File native\dump-clipboard.ps1
#
# NOTE: all output strings are ASCII on purpose. PowerShell 5.1 reads a .ps1
# without a BOM using the system ANSI code page, so non-ASCII *string literals*
# in this file would be mojibake and can even swallow the closing quote. Keep
# every literal in this file ASCII (comments in other scripts may differ).
#
# Output: %TEMP%\supermemo-clipper-clipboard.txt (also printed to stdout).

$out = Join-Path $env:TEMP "supermemo-clipper-clipboard.txt"
$lines = New-Object System.Collections.Generic.List[string]
# Every call is parenthesised: `Say "a" + $b` would bind "+" as an argument and
# quietly drop everything after the first string.
function Say($s) { $lines.Add([string]$s) }

Add-Type -AssemblyName System.Windows.Forms

$do = $null
try { $do = [System.Windows.Forms.Clipboard]::GetDataObject() } catch { }
if (-not $do) {
    Say "[!] Cannot read the clipboard (locked by another program?). Copy a web page first, then re-run."
    try {
        [System.IO.File]::WriteAllLines($out, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    Write-Output ($lines -join "`n")
    exit 1
}

$formats = @($do.GetFormats($false))
Say ("Clipboard formats: " + ($formats -join " / "))

$text = [string]$do.GetData("UnicodeText")
if (-not $text) { $text = [string]$do.GetData("Text") }
Say ("Plain text length: " + $text.Trim().Length + " chars")

$html = [string]$do.GetData("HTML Format")
if (-not $html) {
    Say ""
    Say "[!] No HTML Format (CF_HTML) on the clipboard - SuperMemo would only get plain text."
} else {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
    Say ""
    Say ("HTML stream: " + $bytes.Length + " bytes / " + $html.Length + " chars")

    Say ""
    Say "==== CF_HTML header ===="
    # The header is ASCII lines terminated by CRLF, before the markup starts.
    $headEnd = $html.IndexOf("<")
    if ($headEnd -lt 0) { $headEnd = [Math]::Min(400, $html.Length) }
    $header = $html.Substring(0, $headEnd)
    foreach ($line in ($header -split "`r?`n")) {
        if ($line.Trim()) { Say ("  " + $line.Trim()) }
    }

    # CF_HTML offsets are BYTE offsets into the UTF-8 stream, not character
    # offsets into the .NET string. Slicing the string with them silently
    # returns the wrong region - which is exactly how a "the fragment looks
    # clean" report can be wrong.
    $frag = $html
    $mf = [regex]::Match($html, "StartFragment:(\d+)")
    $ef = [regex]::Match($html, "EndFragment:(\d+)")
    if ($mf.Success -and $ef.Success) {
        $fs = [int]$mf.Groups[1].Value
        $fe = [int]$ef.Groups[1].Value
        if ($fs -ge 0 -and $fe -gt $fs -and $fe -le $bytes.Length) {
            $frag = [System.Text.Encoding]::UTF8.GetString($bytes, $fs, $fe - $fs)
            Say ""
            Say ("==== Fragment (byte " + $fs + " -> " + $fe + ", " + ($fe - $fs) + " bytes) ====")
        } else {
            Say ""
            Say ("[!] Fragment offsets " + $fs + ".." + $fe + " do not fit the " + $bytes.Length + "-byte stream.")
        }
    }
    Say ("Fragment length: " + $frag.Length + " chars")

    Say ""
    Say "==== Fragment head (first 400 chars) ===="
    $headLen = [Math]::Min(400, $frag.Length)
    Say ("  " + (($frag.Substring(0, $headLen)) -replace "\s+", " "))
    $lm = [regex]::Match($frag, "#Link:\s*(https?://[^\s<""']+)")
    if ($lm.Success) { Say ("  note '#Link:' = " + $lm.Groups[1].Value) }

    Say ""
    Say "==== Every href/src inside the fragment ===="
    $unsafe = @()
    $all = 0
    foreach ($mm in [regex]::Matches($frag, '(?i)(href|src)\s*=\s*"([^"]*)"')) {
        $attr = $mm.Groups[1].Value.ToLower()
        $val = $mm.Groups[2].Value
        $all++
        $abs = ($val -match '^(?i)(https?|ftp|mailto):') -or
               ($val -match '^(?i)data:image/(png|jpe?g|gif|webp|bmp);base64,')
        if (-not $abs) { $unsafe += ("[" + $attr + "] " + $val) }
    }
    Say ("  total " + $all + ", UNSAFE (not absolute) " + @($unsafe).Count)
    foreach ($u in (@($unsafe) | Select-Object -First 25)) { Say ("  [X] " + $u) }

    Say ""
    Say "==== All scheme:// tokens inside the fragment ===="
    $schemes = [regex]::Matches($frag, '(?i)\b[a-z][a-z0-9+.-]{1,20}://') |
        ForEach-Object { $_.Value.ToLower() } | Sort-Object -Unique
    if (-not $schemes) { Say "  (none)" } else { foreach ($s in $schemes) { Say ("  " + $s) } }

    $hit = $frag.IndexOf("res:", [System.StringComparison]::OrdinalIgnoreCase)
    if ($hit -ge 0) {
        Say ""
        Say "==== 'res:' occurrences in the fragment ===="
        $from = [Math]::Max(0, $hit - 200)
        $len = [Math]::Min(400, $frag.Length - $from)
        Say ("  ..." + ($frag.Substring($from, $len) -replace '\s+', ' ') + "...")
    }
}

try {
    [System.IO.File]::WriteAllLines($out, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
} catch { }
Write-Output ($lines -join "`n")
Write-Output ""
Write-Output ("Written to: " + $out)
