# Which activation sequence actually gives SuperMemo a WORKING keyboard?
#
# Verdict per scenario: press Ctrl+F and watch whether SuperMemo's Find dialog
# appears (a window it always has, hidden). That exercises exactly the same
# dispatch path as Ctrl+N, and deselects/creates nothing. The dialog is closed
# with WM_CLOSE, never with a keystroke.
#
# Each scenario starts with some OTHER app in the foreground (the way it is in
# real life: the extension popup owns the focus when the host starts), then
# tries one activation recipe and reports the focus window it produced.
#
# ASCII-only literals (PowerShell 5.1 + BOM-less file + ANSI code page).

param()
$ErrorActionPreference = "Continue"
$LOG = Join-Path $PSScriptRoot "_key2.log"
$lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$lines.Add([string]$s) }

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class K2 {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
        public int cbSize; public int flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gti);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern IntPtr GetWindowLong32(IntPtr h, int i);

    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
    public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
    public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
    public static uint TidOf(IntPtr h) { uint p; return GetWindowThreadProcessId(h, out p); }

    public static List<IntPtr> TopLevel(uint pid) {
        var res = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { if (PidOf(h) == pid) res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }

    public static List<IntPtr> AllTopLevel() {
        var res = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }

    public static List<IntPtr> Descendants(IntPtr parent) {
        var res = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }

    public static long StyleOf(IntPtr h) {
        try { return IntPtr.Size == 8 ? GetWindowLongPtr64(h, -16).ToInt64() : GetWindowLong32(h, -16).ToInt64(); }
        catch { return 0; }
    }

    public static GUITHREADINFO ThreadInfo(uint tid) {
        var g = new GUITHREADINFO();
        g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        GetGUIThreadInfo(tid, ref g);
        return g;
    }

    // The process's GUI threads, in the order their windows appear.
    public static List<uint> GuiThreads(uint pid) {
        var res = new List<uint>();
        foreach (IntPtr h in TopLevel(pid)) {
            uint t = TidOf(h);
            if (!res.Contains(t)) res.Add(t);
        }
        return res;
    }

    public static IntPtr FocusOf(uint pid) {
        foreach (uint t in GuiThreads(pid)) {
            var g = ThreadInfo(t);
            if (g.hwndFocus != IntPtr.Zero) return g.hwndFocus;
        }
        return IntPtr.Zero;
    }

    public static IntPtr ActiveOf(uint pid) {
        foreach (uint t in GuiThreads(pid)) {
            var g = ThreadInfo(t);
            if (g.hwndActive != IntPtr.Zero) return g.hwndActive;
        }
        return IntPtr.Zero;
    }

    // The AttachThreadInput trick (same as fghelper.cs Force).
    public static bool Force(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint tThread = GetWindowThreadProcessId(h, out dummy);
        uint me = GetCurrentThreadId();
        bool jf = (fgThread != 0 && fgThread != me) && AttachThreadInput(me, fgThread, true);
        bool jt = (tThread != 0 && tThread != me) && AttachThreadInput(me, tThread, true);
        bool ok;
        try { ShowWindowAsync(h, 9); BringWindowToTop(h); ok = SetForegroundWindow(h); }
        finally { if (jt) AttachThreadInput(me, tThread, false); if (jf) AttachThreadInput(me, fgThread, false); }
        return ok;
    }

    // SetFocus on a window of ANOTHER process: only possible while our input
    // queue is attached to that process's thread.
    public static bool FocusChild(IntPtr child) {
        uint t = TidOf(child);
        uint me = GetCurrentThreadId();
        bool joined = (t != 0 && t != me) && AttachThreadInput(me, t, true);
        try { return SetFocus(child) != IntPtr.Zero; }
        finally { if (joined) AttachThreadInput(me, t, false); }
    }
}
'@
try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch { Say ("ADD-TYPE FAILED: " + $_.Exception.Message) }

$proc = Get-Process | Where-Object { $_.ProcessName -match "(?i)^sm\d" -or $_.ProcessName -match "(?i)supermemo" } | Select-Object -First 1
if (-not $proc) { Say "no SuperMemo"; $lines | Out-File $LOG -Encoding utf8; exit 1 }
$spid = [uint32]$proc.Id
$frame = [IntPtr][int64]$proc.MainWindowHandle
$elw = [IntPtr]::Zero
foreach ($h in [K2]::TopLevel($spid)) {
    if ([K2]::Cls($h) -eq "TElWind" -and [K2]::IsWindowVisible($h)) { $elw = $h; break }
}
Say ("SuperMemo " + $proc.ProcessName + " pid " + $spid)
Say ("frame(MainWindowHandle) = 0x" + ([int64]$frame).ToString("X") + " " + [K2]::Cls($frame))
Say ("element window         = 0x" + ([int64]$elw).ToString("X") + " " + [K2]::Cls($elw))
Say ""
Say "=== descendants of the element window (class, tabstop) ==="
foreach ($d in [K2]::Descendants($elw)) {
    $st = [K2]::StyleOf($d)
    $tab = (($st -band 0x10000) -ne 0)
    Say ("  0x" + ([int64]$d).ToString("X").PadLeft(9) + "  " + [K2]::Cls($d).PadRight(28) + " tabstop=" + $tab +
         "  vis=" + $(if ([K2]::IsWindowVisible($d)) { "1" } else { "0" }))
}
Say ""

function State($tag) {
    $fg = [K2]::GetForegroundWindow()
    $f = [K2]::FocusOf($spid)
    $a = [K2]::ActiveOf($spid)
    Say ("    " + $tag.PadRight(18) + " fg=0x" + ([int64]$fg).ToString("X").PadLeft(9) + "(" + [K2]::Cls($fg).PadRight(14) + ")" +
         "  active=0x" + ([int64]$a).ToString("X").PadLeft(9) + "(" + [K2]::Cls($a).PadRight(14) + ")" +
         "  focus=0x" + ([int64]$f).ToString("X").PadLeft(9) + "(" + [K2]::Cls($f) + ")")
}

function FindDialogVisible() {
    foreach ($h in [K2]::TopLevel($spid)) {
        if ([K2]::Cls($h) -eq "TMyFindDlg") {
            if ([K2]::IsWindowVisible($h)) { return $h }
            return [IntPtr]::Zero
        }
    }
    return [IntPtr]::Zero
}

$shell = New-Object -ComObject WScript.Shell

# A window from ANOTHER process to hold the foreground between scenarios - the
# stand-in for the extension popup, which is what owns the focus when the host
# really runs. (Getting this wrong invalidates the whole test: with SuperMemo
# itself as the "other app", every scenario starts already focused.)
$other = [IntPtr]::Zero
$cands = @()
foreach ($h in [K2]::AllTopLevel()) {
    if ([K2]::PidOf($h) -eq $spid) { continue }
    if (-not [K2]::IsWindowVisible($h)) { continue }
    $t = [K2]::Title($h)
    if ($t -eq "") { continue }
    $c = [K2]::Cls($h)
    if ($c -eq "TPUtilWindow" -or $c -eq "IME" -or $c -eq "MSCTFIME UI") { continue }
    $cands += ,@($h, $c, $t)
}
Say "=== candidate foreign windows for 'the other app' ==="
$n = 0
foreach ($x in $cands) {
    if ($n -ge 8) { break }
    $t = $x[2]; if ($t.Length -gt 40) { $t = $t.Substring(0, 40) + "..." }
    Say ("  0x" + ([int64]$x[0]).ToString("X").PadLeft(9) + "  " + $x[1].PadRight(28) + "  " + $t)
    $n++
}
foreach ($x in $cands) {
    if ($x[1] -eq "Chrome_WidgetWin_1" -or $x[1] -eq "CabinetWClass" -or $x[1] -like "*Notepad*") { $other = $x[0]; break }
}
if ([int64]$other -eq 0 -and $cands.Count -gt 0) { $other = $cands[0][0] }
Say ("chosen other app = 0x" + ([int64]$other).ToString("X") + " " + [K2]::Cls($other) + " / " + [K2]::Title($other))
Say ""

# Candidate focus targets inside the element window, best first.
$ieServer = [IntPtr]::Zero
$firstTab = [IntPtr]::Zero
foreach ($d in [K2]::Descendants($elw)) {
    if ([K2]::Cls($d) -eq "Internet Explorer_Server" -and $ieServer -eq [IntPtr]::Zero) { $ieServer = $d }
    if ($firstTab -eq [IntPtr]::Zero -and (([K2]::StyleOf($d) -band 0x10000) -ne 0) -and [K2]::IsWindowVisible($d)) { $firstTab = $d }
}
Say ("focus candidates: IE server=0x" + ([int64]$ieServer).ToString("X") + "  first tabstop=0x" + ([int64]$firstTab).ToString("X") + " " + [K2]::Cls($firstTab))
Say ""

function Scenario($name, $recipe) {
    # Start from a non-SuperMemo foreground, like the real host does.
    [void][K2]::Force($other)
    Start-Sleep -Milliseconds 250
    Say ("=== " + $name + " ===")
    State "before"
    $null = & $recipe
    State "after-recipe"
    $shell.SendKeys("^f")
    Start-Sleep -Milliseconds 900
    $dlg = FindDialogVisible
    $reacted = ([int64]$dlg -ne 0)
    Say ("    Ctrl+F reacted : " + $reacted)
    if ($reacted) {
        [void][K2]::PostMessage($dlg, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 400
        Say ("    dialog closed  : " + (([int64](FindDialogVisible)) -eq 0))
    }
    Say ""
    return $reacted
}

$r = @{}
$r["0-direct-then-send"] = Scenario "scenario 0: Force(element) then send immediately" {
    [void][K2]::Force($elw)
}

$r["1-settle-400"] = Scenario "scenario 1: Force(element), settle 400ms, send" {
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 400
}

$r["2-frame-then-element"] = Scenario "scenario 2: Force(frame), then Force(element)" {
    [void][K2]::Force($frame)
    Start-Sleep -Milliseconds 150
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 250
}

$r["3-focus-ieserver"] = Scenario "scenario 3: Force(element), SetFocus(IE server)" {
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 150
    Say ("    FocusChild(ie) ok = " + [K2]::FocusChild($ieServer))
    Start-Sleep -Milliseconds 250
}

$r["4-focus-tabstop"] = Scenario "scenario 4: Force(element), SetFocus(first tabstop)" {
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 150
    Say ("    FocusChild(tab) ok = " + [K2]::FocusChild($firstTab))
    Start-Sleep -Milliseconds 250
}

$r["5-switchto"] = Scenario "scenario 5: SwitchToThisWindow(element)" {
    [K2]::SwitchToThisWindow($elw, $true)
    Start-Sleep -Milliseconds 300
}

$r["6-force-twice"] = Scenario "scenario 6: Force(element) twice" {
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 200
    [void][K2]::Force($elw)
    Start-Sleep -Milliseconds 200
}

Say "=== summary ==="
foreach ($k in $r.Keys) { Say ("  " + $k.PadRight(26) + " Ctrl+F reacted = " + $r[$k]) }

if ([int64]$other -ne 0) { [void][K2]::Force($other) }
$lines | Out-File $LOG -Encoding utf8
exit 0
