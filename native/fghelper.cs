// Window/foreground helper for the native messaging host.
//
// Kept in its own file (instead of inline in paste.ps1) so it can be compiled
// ONCE and then simply loaded: on the machine this was measured on, PowerShell
// itself takes ~1.4s to start, compiling this source inside the host adds
// another ~1.8s, and loading a ready-made assembly costs ~0.25s. paste.ps1
// caches the compiled copy under %LOCALAPPDATA%\SuperMemoClipper, keyed by a
// hash of this file, so editing anything here invalidates the cache by itself.
//
// Only mscorlib types are used on purpose — paste.ps1 compiles this without
// extra assembly references.
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FG {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gti);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern IntPtr GetWindowLongW(IntPtr h, int i);

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

    public static string Title(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    public static uint PidOf(IntPtr h) {
        uint p;
        GetWindowThreadProcessId(h, out p);
        return p;
    }

    public static uint ForegroundPid() {
        uint p;
        GetWindowThreadProcessId(GetForegroundWindow(), out p);
        return p;
    }

    public static string ForegroundTitle() { return Title(GetForegroundWindow()); }

    // Grab the foreground the way a background process has to: temporarily join
    // our input queue with both the current foreground thread and the target's,
    // which lifts the "background apps may not steal focus" restriction that
    // otherwise downgrades SetForegroundWindow to a bare title-bar flash.
    public static bool Force(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint targetThread = GetWindowThreadProcessId(h, out dummy);
        uint me = GetCurrentThreadId();

        bool joinedFg = (fgThread != 0 && fgThread != me) && AttachThreadInput(me, fgThread, true);
        bool joinedTarget = (targetThread != 0 && targetThread != me) && AttachThreadInput(me, targetThread, true);
        bool ok;
        try {
            ShowWindowAsync(h, 9);          // SW_RESTORE: un-minimise if needed
            BringWindowToTop(h);
            ok = SetForegroundWindow(h);
        } finally {
            if (joinedTarget) AttachThreadInput(me, targetThread, false);
            if (joinedFg) AttachThreadInput(me, fgThread, false);
        }
        return ok;
    }

    // Visible top-level windows of one process, in Z-order (topmost first) —
    // so the first entry is the one the user most likely last worked in.
    public static List<long> VisibleWindowsOf(uint pid) {
        var res = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid) res.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static string ClassName(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }

    public static bool IsVisible(IntPtr h) { return IsWindowVisible(h); }

    // All top-level windows of one process, Z-order (topmost first).
    public static List<long> TopLevelWindowsOf(uint pid) {
        var res = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid) res.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return res;
    }

    // The top-level window that really owns the keyboard inside a process.
    //
    // Means everything here. "SuperMemo is the foreground window" is NOT the
    // same as "SuperMemo will receive the keystroke": its TApplication frame
    // window can be the foreground AND hold the focus, in which case a key sent
    // to it is simply dropped, while every check on the foreground pid still
    // says "success". The window that dispatches the app's shortcuts is the
    // element window (TElWind), and when it is active, GetGUIThreadInfo reports
    // the focus inside it (e.g. one of its buttons).
    //
    // Returns the focus window of the process's GUI thread mapped up to its
    // top-level window, or 0 when the process owns no focus at all (which is
    // also what a background process reports - Windows only fills these fields
    // in once the thread is in the foreground).
    public static long FocusRoot(uint pid) {
        var threads = new List<uint>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p;
            uint t = GetWindowThreadProcessId(h, out p);
            if (p == pid && !threads.Contains(t)) threads.Add(t);
            return true;
        }, IntPtr.Zero);
        foreach (uint t in threads) {
            var g = new GUITHREADINFO();
            g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (!GetGUIThreadInfo(t, ref g)) continue;
            IntPtr hwnd = g.hwndFocus != IntPtr.Zero ? g.hwndFocus : g.hwndActive;
            if (hwnd != IntPtr.Zero) return GetAncestor(hwnd, 2).ToInt64();  // GA_ROOT
        }
        return 0;
    }

    // The focus window itself (not mapped up to its top level). We need the
    // exact window, because "inside the element window" is not precise enough:
    // see FocusVclControl.
    public static long FocusWindow(uint pid) {
        foreach (uint t in GuiThreads(pid)) {
            var g = new GUITHREADINFO();
            g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (!GetGUIThreadInfo(t, ref g)) continue;
            if (g.hwndFocus != IntPtr.Zero) return g.hwndFocus.ToInt64();
            if (g.hwndActive != IntPtr.Zero) return g.hwndActive.ToInt64();
        }
        return 0;
    }

    public static List<uint> GuiThreads(uint pid) {
        var res = new List<uint>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p;
            uint t = GetWindowThreadProcessId(h, out p);
            if (p == pid && !res.Contains(t)) res.Add(t);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static long StyleOf(IntPtr h) {
        try {
            return IntPtr.Size == 8 ? GetWindowLongPtrW(h, -16).ToInt64()
                                    : GetWindowLongW(h, -16).ToInt64();
        } catch { return 0; }
    }

    public static List<long> Descendants(long topLevel) {
        var res = new List<long>();
        EnumChildWindows(new IntPtr(topLevel), delegate(IntPtr h, IntPtr l) {
            res.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return res;
    }

    // Focus a real VCL control inside a window.
    //
    // This is the difference between a keystroke that works and one that
    // vanishes. SuperMemo's element window embeds Internet Explorer
    // ("Shell Embedding" > "Shell DocObject View" > "Internet Explorer_Server"),
    // and when the TElWind form is activated from a background process the
    // focus lands on that embedded host - measured, all of SetForegroundWindow,
    // BringWindowToTop, SwitchToThisWindow and a frame-then-element double
    // activation end up there. Keys delivered to it are swallowed by IE and
    // never reach the application's shortcut dispatcher: with the focus on
    // Shell DocObject View, Ctrl+F does nothing, while focusing a TBitBtn makes
    // the very same Ctrl+F open SuperMemo's Find dialog.
    //
    // So we put the focus where SuperMemo itself would: on one of its own
    // controls (a class starting with T, WS_TABSTOP, visible). "Next repetition"
    // is preferred when present because that is where SuperMemo leaves the focus
    // after a repetition - i.e. exactly the state a human clips from.
    public static long FocusVclControl(long topLevel) {
        long best = 0;
        foreach (long h in Descendants(topLevel)) {
            IntPtr p = new IntPtr(h);
            if (!IsWindowVisible(p)) continue;
            if ((StyleOf(p) & 0x10000) == 0) continue;            // WS_TABSTOP
            string c = ClassName(p);
            if (!c.StartsWith("T")) continue;                     // VCL controls only
            if (c.Contains("ScrollingStyleHook")) continue;        // style hook, not a control
            string t = Title(p);
            if (t.IndexOf("Next repetition", StringComparison.Ordinal) >= 0) {
                if (FocusChild(p)) return h;
            }
            if (best == 0 && FocusChild(p)) { best = h; }
        }
        return best;
    }

    // SetFocus on a window of another thread: only possible while our input
    // queue is attached to that thread's queue.
    public static bool FocusChild(IntPtr child) {
        uint p;
        uint t = GetWindowThreadProcessId(child, out p);
        uint me = GetCurrentThreadId();
        bool joined = (t != 0 && t != me) && AttachThreadInput(me, t, true);
        try { return SetFocus(child) != IntPtr.Zero; }
        finally { if (joined) AttachThreadInput(me, t, false); }
    }

    // First top-level window of a process with this window class, or 0.
    public static long FindTopLevelByClass(uint pid, string cls) {
        foreach (long h in TopLevelWindowsOf(pid)) {
            if (ClassName(new IntPtr(h)) == cls) return h;
        }
        return 0;
    }

    // Ask a window to close itself (WM_CLOSE). Used by the self-test to dismiss
    // the dialog it opened, without touching the keyboard again.
    public static void CloseWindow(long h) {
        if (h != 0) PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}

// Raw Win32 clipboard access.
//
// The CF_HTML stream *must* be handled as bytes. Reading it through
// System.Windows.Forms decodes the stream as text using the system ANSI code
// page: the note's UTF-8 Chinese comes back as mojibake, and (far worse)
// writing that string back re-encodes it as ANSI, corrupting every non-ASCII
// character and every byte offset in the header. ClipboardFormat returns the
// bytes exactly as Chrome wrote them, and Write puts bytes back verbatim.
//
// Note on ownership: after SetClipboardData succeeds the system owns the
// HGLOBAL, so it must NOT be freed by us. Only blocks that failed to be handed
// over are freed.
public class CLIP {
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint RegisterClipboardFormatW(string lpszFormat);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern UIntPtr GlobalSize(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalFree(IntPtr hMem);

    // How many times the clipboard content changed since boot. Used to tell
    // "we wrote it" apart from "something else grabbed the clipboard".
    public static uint Sequence() { return GetClipboardSequenceNumber(); }

    // Raw bytes of a registered clipboard format such as "HTML Format".
    // Returns null when the format is not on the clipboard.
    public static byte[] ReadFormat(string formatName) {
        uint fmt = RegisterClipboardFormatW(formatName);
        if (fmt == 0) return null;
        if (!OpenClipboard(IntPtr.Zero)) return null;
        try {
            IntPtr h = GetClipboardData(fmt);
            if (h == IntPtr.Zero) return null;
            UIntPtr size = GlobalSize(h);
            long n = (long)size;
            if (n <= 0) return null;
            IntPtr p = GlobalLock(h);
            if (p == IntPtr.Zero) return null;
            try {
                byte[] buf = new byte[n];
                Marshal.Copy(p, buf, 0, (int)n);
                return buf;
            } finally {
                GlobalUnlock(h);
            }
        } finally {
            CloseClipboard();
        }
    }

    // CF_UNICODETEXT as a .NET string (no lossy conversion involved).
    public static string ReadText() {
        if (!OpenClipboard(IntPtr.Zero)) return null;
        try {
            IntPtr h = GetClipboardData(CF_UNICODETEXT);
            if (h == IntPtr.Zero) return null;
            IntPtr p = GlobalLock(h);
            if (p == IntPtr.Zero) return null;
            try {
                return Marshal.PtrToStringUni(p);
            } finally {
                GlobalUnlock(h);
            }
        } finally {
            CloseClipboard();
        }
    }

    // Replace the clipboard with exactly these two formats. Everything else
    // that was on it disappears - deliberate: the old content is what carried
    // the wrong SourceURL, and SuperMemo only ever reads CF_HTML or text.
    public static bool Write(string formatName, byte[] htmlBytes, string text) {
        uint fmt = RegisterClipboardFormatW(formatName);
        if (fmt == 0) return false;
        if (!OpenClipboard(IntPtr.Zero)) return false;
        try {
            if (!EmptyClipboard()) return false;

            // CF_HTML first: if the text block fails we still have the note.
            if (htmlBytes != null && htmlBytes.Length > 0) {
                // One NUL terminator, like Chrome's own writer.
                IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)(htmlBytes.Length + 1));
                if (h == IntPtr.Zero) return false;
                IntPtr p = GlobalLock(h);
                if (p == IntPtr.Zero) { GlobalFree(h); return false; }
                Marshal.Copy(htmlBytes, 0, p, htmlBytes.Length);
                Marshal.WriteByte(p, htmlBytes.Length, 0);
                GlobalUnlock(h);
                if (SetClipboardData(fmt, h) == IntPtr.Zero) { GlobalFree(h); return false; }
            }

            if (text != null && text.Length > 0) {
                byte[] tb = Encoding.Unicode.GetBytes(text + "\0");
                IntPtr h2 = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)tb.Length);
                if (h2 != IntPtr.Zero) {
                    IntPtr p2 = GlobalLock(h2);
                    if (p2 == IntPtr.Zero) { GlobalFree(h2); }
                    else {
                        Marshal.Copy(tb, 0, p2, tb.Length);
                        GlobalUnlock(h2);
                        if (SetClipboardData(CF_UNICODETEXT, h2) == IntPtr.Zero) GlobalFree(h2);
                    }
                }
            }
            return true;
        } finally {
            CloseClipboard();
        }
    }
}

