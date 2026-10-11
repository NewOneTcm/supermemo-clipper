# CF_HTML source repair for the SuperMemo clipper.
#
# Why this is here at all
# ----------------------
# SuperMemo renders a note in an IE (mshtml) component, and IE resolves any URL
# that is not absolute against the BASE URL of the document. For a clipboard
# paste the base URL is the `SourceURL:` line of the CF_HTML stream. Chrome
# writes the URL of the document that performed the copy, and for this
# extension that document is the *popup*:
#
#     SourceURL:chrome-extension://<id>/popup/popup.html
#
# IE cannot use that as a base - `chrome-extension:` is not a scheme it can
# build a URL moniker from - so it falls back to its own internal `res://` base
# (Microsoft documents the fallback: setting a relative img src in IE reads
# back as "res://<module path>/<src>"). Windows cannot open a res:// link, so
# the shell gets it and pops Windows' "How do you want to open this 'res'
# link?" dialog.
#
# Manual Ctrl+C never showed that dialog because a page copy writes the PAGE
# url as SourceURL. The fix is therefore to make the automatic path look like
# the manual one: rewrite SourceURL to the page the note came from, right
# before SuperMemo is asked to paste.
#
# Rules
# -----
# * Byte-exact. CF_HTML offsets are byte offsets into a UTF-8 stream, and the
#   note itself is UTF-8; nothing here may round-trip the payload through a
#   .NET string (System.Windows.Forms decodes it with the ANSI code page, which
#   silently corrupts every non-ASCII character).
# * Never break a paste. Any doubt at all -> skip, say why, and let the caller
#   send Ctrl+N exactly as before.
# * ASCII-only literals. PowerShell 5.1 reads a .ps1 without a BOM using the
#   system ANSI code page, so non-ASCII *string literals* here would be
#   mojibake and can even swallow a closing quote.
#
# Requires the CLIP class from fghelper.cs (raw Win32 clipboard access).

$SCRIPT:CF_RE = @{
    StartHTML     = "StartHTML:(\d+)"
    EndHTML       = "EndHTML:(\d+)"
    StartFragment = "StartFragment:(\d+)"
    EndFragment   = "EndFragment:(\d+)"
    SourceURL     = "SourceURL:([^\r\n]*)"
}

function Get-CfHeaderText($bytes) {
    # The header is ASCII and lives before the first '<' of the markup.
    $scan = [Math]::Min(2048, $bytes.Length)
    $lt = -1
    for ($i = 0; $i -lt $scan; $i++) { if ($bytes[$i] -eq 0x3C) { $lt = $i; break } }
    if ($lt -lt 0) { return $null }
    return [Text.Encoding]::ASCII.GetString($bytes, 0, $lt)
}

function Read-CfNumber($header, $key) {
    $m = [regex]::Match($header, $SCRIPT:CF_RE[$key])
    if (-not $m.Success) { return -1 }
    $v = 0
    if (-not [int]::TryParse($m.Groups[1].Value, [ref]$v)) { return -1 }
    return $v
}

# Byte-exact rebuild: same Version and line order as Chrome, only SourceURL is
# replaced. Every number is zero-padded to 10 digits, so the header length does
# not depend on the values - which is what makes it safe to compute the new
# offsets from a placeholder template first.
function New-CfHtml($body, $startFragRel, $endFragRel, $sourceUrl) {
    $pad = { param($n) $n.ToString("D10") }
    $tpl = "Version:0.9`r`n" +
           "StartHTML:" + (& $pad 0) + "`r`n" +
           "EndHTML:" + (& $pad 0) + "`r`n" +
           "StartFragment:" + (& $pad 0) + "`r`n" +
           "EndFragment:" + (& $pad 0) + "`r`n" +
           "SourceURL:" + $sourceUrl + "`r`n"

    $startHtml = [Text.Encoding]::ASCII.GetByteCount($tpl)
    $endHtml = $startHtml + $body.Length
    $startFrag = $startHtml + $startFragRel
    $endFrag = $startHtml + $endFragRel

    $head = "Version:0.9`r`n" +
            "StartHTML:" + (& $pad $startHtml) + "`r`n" +
            "EndHTML:" + (& $pad $endHtml) + "`r`n" +
            "StartFragment:" + (& $pad $startFrag) + "`r`n" +
            "EndFragment:" + (& $pad $endFrag) + "`r`n" +
            "SourceURL:" + $sourceUrl + "`r`n"
    $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
    if ($headBytes.Length -ne $startHtml) { return $null }

    $out = New-Object byte[] ($headBytes.Length + $body.Length)
    [Array]::Copy($headBytes, 0, $out, 0, $headBytes.Length)
    [Array]::Copy($body, 0, $out, $headBytes.Length, $body.Length)
    return $out
}

# Returns a hashtable:
#   status        skipped | current | would-fix | fixed | verify-failed
#   source_before SourceURL currently on the clipboard
#   source_after  SourceURL the payload should (or does) carry
#   bytes         size of the rebuilt stream
#   detail        why it was skipped / failed (empty when fine)
function Repair-ClipboardSourceUrl($pageUrl, $forReal) {
    $r = @{ status = "skipped"; source_before = ""; source_after = ""; bytes = 0; detail = "" }

    # Everything below must be non-fatal: the caller sends Ctrl+N either way.
    try {
    if (-not ([System.Management.Automation.PSTypeName]'CLIP').Type) {
        $r.detail = "clipboard helper (CLIP) not loaded"
        return $r
    }
    if (-not $pageUrl) { $r.detail = "no page url in the message"; return $r }
    if ($pageUrl -notmatch '^(?i)(https?|file)://') { $r.detail = "page url is not http/https/file"; return $r }
    if ($pageUrl -match '[^\x20-\x7E]') { $r.detail = "page url is not plain ASCII"; return $r }

    $cf = $null
    for ($i = 0; $i -lt 6 -and -not $cf; $i++) {
        $cf = [CLIP]::ReadFormat("HTML Format")
        if (-not $cf) { Start-Sleep -Milliseconds 60 }
    }
    if (-not $cf) { $r.detail = "no CF_HTML on the clipboard"; return $r }

    $header = Get-CfHeaderText $cf
    if (-not $header) { $r.detail = "CF_HTML header not found"; return $r }

    $startHtml = Read-CfNumber $header "StartHTML"
    $endHtml = Read-CfNumber $header "EndHTML"
    $startFrag = Read-CfNumber $header "StartFragment"
    $endFrag = Read-CfNumber $header "EndFragment"
    $old = [regex]::Match($header, $SCRIPT:CF_RE["SourceURL"])
    if ($old.Success) { $r.source_before = $old.Groups[1].Value.Trim() }

    if ($startHtml -lt 0 -or $endHtml -le $startHtml -or $endHtml -gt $cf.Length) {
        $r.detail = "CF_HTML offsets are not usable (" + $startHtml + ".." + $endHtml + " of " + $cf.Length + ")"
        return $r
    }
    if ($startFrag -lt $startHtml -or $endFrag -le $startFrag -or $endFrag -gt $endHtml) {
        $r.detail = "CF_HTML fragment offsets are not usable (" + $startFrag + ".." + $endFrag + ")"
        return $r
    }
    if ($r.source_before -eq $pageUrl) { $r.status = "current"; $r.source_after = $pageUrl; return $r }

    $body = New-Object byte[] ($endHtml - $startHtml)
    [Array]::Copy($cf, $startHtml, $body, 0, $body.Length)

    $newCf = New-CfHtml $body ($startFrag - $startHtml) ($endFrag - $startHtml) $pageUrl
    if (-not $newCf) { $r.detail = "CF_HTML rebuild failed"; return $r }

    $text = [CLIP]::ReadText()
    $r.bytes = $newCf.Length
    $r.source_after = $pageUrl

    if (-not $forReal) { $r.status = "would-fix"; return $r }

    $ok = $false
    for ($i = 0; $i -lt 5 -and -not $ok; $i++) {
        $ok = [CLIP]::Write("HTML Format", $newCf, $text)
        if (-not $ok) { Start-Sleep -Milliseconds 80 }
    }
    if (-not $ok) { $r.detail = "clipboard write failed (locked?)"; return $r }

    # Read it back: what matters is what SuperMemo will see, not what we think
    # we wrote.
    $back = [CLIP]::ReadFormat("HTML Format")
    if (-not $back) { $r.status = "verify-failed"; $r.detail = "clipboard has no CF_HTML after the write"; return $r }
    $backHeader = Get-CfHeaderText $back
    if (-not $backHeader) { $r.status = "verify-failed"; $r.detail = "no header after the write"; return $r }
    $backSrc = [regex]::Match($backHeader, $SCRIPT:CF_RE["SourceURL"])
    $backFragS = Read-CfNumber $backHeader "StartFragment"
    $backFragE = Read-CfNumber $backHeader "EndFragment"
    $sameNote = ($backFragE - $backFragS) -eq ($endFrag - $startFrag)
    if (-not $backSrc.Success -or $backSrc.Groups[1].Value.Trim() -ne $pageUrl -or -not $sameNote) {
        $r.status = "verify-failed"
        $r.detail = "readback mismatch (source='" + $backSrc.Groups[1].Value + "', note bytes " +
                    ($backFragE - $backFragS) + " vs " + ($endFrag - $startFrag) + ")"
        return $r
    }

    $r.status = "fixed"
    return $r

    } catch {
        # Never let a clipboard hiccup stop the paste: the caller treats
        # "skipped" as "send Ctrl+N exactly as before".
        $r.status = "skipped"
        $r.detail = "error: " + $_.Exception.Message
        return $r
    }
}
