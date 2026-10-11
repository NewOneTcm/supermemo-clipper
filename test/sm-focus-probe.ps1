# Read-only forensic dump of SuperMemo's window + focus state.
#
# Why: the host brings "a SuperMemo window" to the foreground and sends Ctrl+N.
# SuperMemo's keyboard shortcuts are handled by whichever window has FOCUS, not
# merely by whichever window is in front. This tool answers two questions
# without touching anything:
#   1. what are SuperMemo's top-level windows (class names!) and their z-order,
#   2. which window inside SuperMemo carries the keyboard focus, and can we
#      still read that while SuperMemo is in the background (GetGUIThreadInfo)?
#
# ASCII-only string literals on purpose: PowerShell 5.1 reads a BOM-less .ps1
# with the system ANSI code page, so non-ASCII *literals* would be mojibake.
# Window titles (which are Chinese) only ever come from Win32 at runtime.

$ErrorActionPreference = "Continue"
$LOG = Join-Path $PSScriptRoot "_focus.log"
$lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$lines.Add([string]$s) }

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class SMW {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gti);

    public static string Title(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    public static string Cls(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }

    public static List<IntPtr> TopLevel(uint pid) {
        var res = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid) res.Add(h);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static List<IntPtr> Children(IntPtr parent) {
        var res = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
            res.Add(h);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static GUITHREADINFO ThreadInfo(uint tid) {
        var g = new GUITHREADINFO();
        g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        GetGUIThreadInfo(tid, ref g);
        return g;
    }

    public static IntPtr Root(IntPtr h) { return GetAncestor(h, 2); }
}

public class SMT {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@

try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch { Say ("ADD-TYPE FAILED: " + $_.Exception.Message) }

if (-not ([System.Management.Automation.PSTypeName]'SMW').Type) {
    Say "SMW type not available - cannot continue"
    $lines | Out-File $LOG -Encoding utf8
    exit 1
}

# --- process ---------------------------------------------------------------
$proc = Get-Process | Where-Object { $_.ProcessName -match "(?i)^sm\d" -or $_.ProcessName -match "(?i)supermemo" } | Select-Object -First 1
if (-not $proc) {
    Say "no SuperMemo process found"
    $lines | Out-File $LOG -Encoding utf8
    exit 1
}
$pid32 = [uint32]$proc.Id
Say ("process      : " + $proc.ProcessName + "  pid " + $proc.Id)
Say ("MainWindowHandle : 0x" + ([int64]$proc.MainWindowHandle).ToString("X"))

$fg = [SMW]::GetForegroundWindow()
[uint32]$fgPid = 0
[void][SMT]::GetWindowThreadProcessId($fg, [ref]$fgPid)
Say ("foreground   : 0x" + ([int64]$fg).ToString("X") + "  pid " + $fgPid +
     "  class=" + [SMW]::Cls($fg) + "  title=" + [SMW]::Title($fg))
Say ""

# --- top-level windows, in enumeration (z-order) order ---------------------
Say "=== top-level windows of SuperMemo (z-order top first) ==="
$idx = 0
$tops = [SMW]::TopLevel($pid32)
foreach ($h in $tops) {
    $vis = [SMW]::IsWindowVisible($h)
    $t = [SMW]::Title($h)
    if ($t.Length -gt 46) { $t = $t.Substring(0, 46) + "..." }
    Say ("  #" + $idx.ToString().PadLeft(2) + "  hwnd=0x" + ([int64]$h).ToString("X").PadLeft(9) +
         "  " + $(if ($vis) { "vis" } else { "hid" }) +
         "  class=" + [SMW]::Cls($h).PadRight(24) + "  " + $t)
    $idx++
}
Say ""

# --- threads + focus -------------------------------------------------------
Say "=== threads of SuperMemo: GetGUIThreadInfo ==="
$tidSeen = @{}
foreach ($h in $tops) {
    [uint32]$p2 = 0
    $tid = [SMT]::GetWindowThreadProcessId($h, [ref]$p2)
    if ($tidSeen.ContainsKey($tid)) { continue }
    $tidSeen[$tid] = $true
    $g = [SMW]::ThreadInfo([uint32]$tid)
    $f = $g.hwndFocus
    $a = $g.hwndActive
    Say ("  tid " + $tid)
    Say ("     hwndActive = 0x" + ([int64]$a).ToString("X") + "  class=" + [SMW]::Cls($a) +
         "  title=" + [SMW]::Title($a))
    Say ("     hwndFocus  = 0x" + ([int64]$f).ToString("X") + "  class=" + [SMW]::Cls($f) +
         "  title=" + [SMW]::Title($f))
    if ([int64]$f -ne 0) {
        Say ("     focus root = 0x" + ([int64][SMW]::Root($f)).ToString("X") +
             "  class=" + [SMW]::Cls([SMW]::Root($f)) + "  title=" + [SMW]::Title([SMW]::Root($f)))
    }
}

# --- child windows of the main window (structure insight) ------------------
Say ""
Say "=== child windows of each visible top-level window (first 25 each) ==="
foreach ($h in $tops) {
    if (-not [SMW]::IsWindowVisible($h)) { continue }
    $kids = [SMW]::Children($h)
    $t = [SMW]::Title($h)
    if ($t.Length -gt 30) { $t = $t.Substring(0, 30) + "..." }
    Say ("  parent 0x" + ([int64]$h).ToString("X") + " class=" + [SMW]::Cls($h) + "  '" + $t +
         "'  children=" + $kids.Count)
    $n = 0
    foreach ($k in $kids) {
        if ($n -ge 25) { Say ("      ... (" + ($kids.Count - 25) + " more)"); break }
        $kt = [SMW]::Title($k)
        if ($kt.Length -gt 30) { $kt = $kt.Substring(0, 30) + "..." }
        Say ("      " + ("0x" + ([int64]$k).ToString("X")).PadLeft(12) + "  vis=" +
             $(if ([SMW]::IsWindowVisible($k)) { "1" } else { "0" }) +
             "  class=" + [SMW]::Cls($k).PadRight(22) + "  " + $kt)
        $n++
    }
}

$lines | Out-File $LOG -Encoding utf8
exit 0
