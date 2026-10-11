// Action popup: clicking the toolbar button opens this document with real
// focus + user activation, which makes clipboard writes legal on Chrome 151+
// (page-context and offscreen writes both get rejected as "not focused").
//
// Flow: opening the popup extracts NOTHING. The user picks a mode, then clicks
// 提取. The mode choice is remembered per hostname, so ChatGPT stays on "full"
// and mp.weixin.qq.com stays on "article" without any fiddling.
//
//   article — Readability picks the single main article node (blog, news,
//             WeChat). Fails or truncates on multi-message pages.
//   full    — whole <body>, or just the message blocks on a chat page.
//
// After copying, the native host brings SuperMemo to the foreground and sends
// Ctrl+N, which is SuperMemo's "Add a new article": it creates the element AND
// pastes the clipboard itself, in one step — exactly what you do when clipping
// by hand. (The host used to send Alt+N + Ctrl+V; Alt+N is "Add a note", which
// makes a blank element and ignores the clipboard, and the follow-up Ctrl+V
// often landed on the Contents window where it means "Paste element" and
// rejected the HTML — that was the error.)
//
// The host has to *fight* for the foreground to do this, because SendKeys goes
// to whatever window owns it. That is why a run can end with SuperMemo merely
// flashing instead of pasting, and why the host now verifies the foreground
// before sending, reports which window received the key, and writes what
// happened to %TEMP%\supermemo-clipper-last.json for the 诊断 button to show.
//
// The page URL travels with the native message for one reason: Chrome stamps
// the clipboard with the URL of the document that copied it, and here that
// document is this popup (chrome-extension://.../popup/popup.html). SuperMemo
// pastes into an IE (mshtml) component, IE cannot use a chrome-extension URL as
// the note's base URL, so it falls back to its internal res:// base — which is
// what makes Windows pop "How do you want to open this 'res' link?". The host
// rewrites that SourceURL to the real page before pressing Ctrl+N, so the
// automatic path looks exactly like a manual Ctrl+C.
"use strict";

const statusEl = document.getElementById("status");
const runBtn = document.getElementById("run");
const verEl = document.getElementById("ver");
const diagEl = document.getElementById("diag");
const diagBtn = document.getElementById("diagBtn");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));
const NATIVE_HOST = "com.supermemo.paster.v2";
const DEFAULT_MODE = "article";

// Readability is only needed by article mode; full mode skips it entirely.
const FILES = {
  article: ["lib/Readability.js", "content/common.js", "content/extract.js"],
  full: ["content/common.js", "content/extract-full.js"]
};

const RUN_LABEL = {
  article: "提取正文并粘贴到 SuperMemo",
  full: "提取整页并粘贴到 SuperMemo"
};

let tab = null;
let host = "";
let busy = false;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

// Version badge source. It answers the one question that keeps coming up when a
// fix "does not work": is the extension that is actually running the fixed
// code? chrome://extensions shows the same number — if it is older, the
// extension has not been reloaded and nothing on disk matters. It also travels
// to the native host so its log says which build produced a paste.
function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version || "";
  } catch (_) {
    return "";
  }
}

function lockUI(locked) {
  busy = locked;
  modeInputs.forEach((i) => { i.disabled = locked; });
  runBtn.disabled = locked;
  diagBtn.disabled = locked;
}

function shortTitle(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "（无标题窗口）";
  const max = n || 18;
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function currentMode() {
  const checked = modeInputs.find((i) => i.checked);
  return checked ? checked.value : DEFAULT_MODE;
}

function syncRunLabel() {
  runBtn.textContent = RUN_LABEL[currentMode()];
}

function hostOf(url) {
  try {
    return new URL(url).hostname || "local-file";
  } catch (_) {
    return "unknown";
  }
}

async function loadModeFor(h) {
  try {
    const { siteModes = {} } = await chrome.storage.local.get("siteModes");
    return siteModes[h] || DEFAULT_MODE;
  } catch (_) {
    return DEFAULT_MODE;
  }
}

async function saveModeFor(h, mode) {
  try {
    const { siteModes = {} } = await chrome.storage.local.get("siteModes");
    if (siteModes[h] === mode) return;
    siteModes[h] = mode;
    await chrome.storage.local.set({ siteModes });
  } catch (_) { /* private mode / storage unavailable: not worth failing over */ }
}

async function extractWith(mode) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: FILES[mode]
  });
  return results && results[0] && results[0].result;
}

async function run(mode) {
  if (busy) return;
  lockUI(true);
  setStatus(mode === "full" ? "正在提取整页…" : "正在提取正文…");

  let notice = "";
  try {
    let data = null;

    if (mode === "full") {
      // Chat transcripts lazily mount older turns. Nudge the scroller so the
      // conversation is fully in the DOM before reading it. No-op elsewhere.
      try {
        const warm = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: loadChatHistory
        });
        const w = warm && warm[0] && warm[0].result;
        if (w && w.blocks) setStatus("正在读取 " + w.blocks + " 条消息…");
      } catch (_) { /* best effort, extraction works without it */ }
    }

    data = await extractWith(mode);

    // Safety net: article mode found nothing usable, so the page is probably
    // not a single-article layout. Retry as a whole page instead of failing.
    if ((!data || !data.ok) && mode === "article") {
      const fallback = await extractWith("full");
      if (fallback && fallback.ok) {
        data = fallback;
        mode = "full";
        notice = "正文识别失败，已自动改用全页模式；";
        modeInputs.forEach((i) => { i.checked = i.value === "full"; });
        await saveModeFor(host, "full");
        syncRunLabel();
      } else if (fallback && fallback.error) {
        // Both modes failed. Report the whole-page error — it is the more
        // fundamental one ("no body" beats "couldn't guess the article").
        data = { ok: false, error: fallback.error };
      }
    }

    if (!data || !data.ok) {
      setStatus(notice + ((data && data.error) || "提取失败"), "err");
      return;
    }

    await copyToClipboard(data.html, data.text);

    // Native host path: rewrite the clipboard's source URL, auto new-element +
    // paste inside SuperMemo. The page URL must go with the message — it is the
    // base URL SuperMemo's IE component needs, and only the page itself knows
    // it.
    let resp = null;
    try {
      resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        action: "new_and_paste",
        pageUrl: (data.url || tab.url || ""),
        version: extensionVersion()
      });
    } catch (_) {
      resp = null; // host not registered / browser disconnected
    }

    const meta = data.meta || {};
    // What the note ended up containing. Handy when something looks wrong in
    // SuperMemo: the counts say whether the page had little content or whether
    // the cleaner threw things away, and "丢弃 N" is exactly the number of
    // images/links dropped because their URL could not be made safe+absolute.
    const u = meta.urls || {};
    const bits = [];
    if (meta.blocks) bits.push(meta.blocks + " 条消息");
    if (meta.chars) bits.push(meta.chars + " 字");
    if (u.img || u.link) bits.push("图 " + (u.img || 0) + " · 链 " + (u.link || 0));
    const dropped = (u.imgDropped || 0) + (u.linkDropped || 0) + (u.scrubbed || 0);
    if (dropped) bits.push("丢弃 " + dropped + " 个无效链接");
    const size = bits.length ? "（" + bits.join(" · ") + "）" : "";
    const head = notice + (mode === "full" ? "【全页】" : "【正文】");

    // The clipboard's SourceURL is what SuperMemo's IE component uses as the
    // note's base URL. "fixed" means it now points at the page instead of at
    // this popup, i.e. the res:// dialog cannot happen for this paste. Say so,
    // because that is the invisible half of the work.
    const srcNote = resp && resp.sourceStatus === "fixed" ? " · 来源地址已修正" : "";

    if (resp && resp.ok) {
      // resp.focus is the window class that owned the KEYBOARD when the key went
      // out — not merely the foreground process. That distinction is the whole
      // bug fixed in v2.3.1: activating SuperMemo's app frame (or letting the
      // focus sit in the element window's embedded IE host) satisfied "the
      // foreground is SuperMemo" while the keystroke was swallowed, so nothing
      // happened at all. resp.focus should therefore read as a SuperMemo control
      // class (TBitBtn / TEdit / TVirtualStringTree ...).
      const kb = resp.focus ? " · 键盘：" + resp.focus : "";
      // No new element window is not proof of failure (SuperMemo can reuse the
      // current element window), so this is a nudge, not an error.
      const noWin = resp.newWindow === false ? "（未检测到新窗口，若没看到新条目请点「诊断」）" : "";
      setStatus(head + "已新建条目并粘贴到 SuperMemo" + size + kb + srcNote + noWin, "ok");
      setTimeout(() => window.close(), 1400);
    } else if (resp && resp.code === "not_running") {
      setStatus(head + "SuperMemo 未运行，内容已在剪贴板" + size + "，打开后按 Ctrl+N 即可", "warn");
      // Keep the popup open so the hint stays readable.
    } else if (resp && resp.code === "activate_failed") {
      // The key would have gone to some other program (or been swallowed), so
      // don't pretend it was pasted. Say exactly what held the keyboard.
      const who = resp.fg ? "（前台：「" + shortTitle(resp.fg, 14) + "」" : "（";
      const kb = resp.focusClass ? "，键盘：「" + resp.focusClass + "」）" : "）";
      setStatus(head + "已复制" + size + "，但没能把键盘交给 SuperMemo" + who + kb +
        "，请在 SuperMemo 里手动按 Ctrl+N", "warn");
      diagEl.style.display = "block";
      diagEl.textContent = "点右下角「诊断」看详细原因。";
    } else if (resp && resp.code === "clipboard_empty") {
      setStatus(head + "提取成功" + size + "，但剪贴板里没有内容（可能被其他程序占用），请重试", "warn");
    } else if (resp && resp.error) {
      setStatus(head + "已复制" + size + "，自动粘贴失败：" + resp.error, "warn");
    } else {
      setStatus(head + "已复制" + size + "。native host 未注册，请先运行 native\\install.ps1；" +
        "此后可自动粘贴（未注册时 SuperMemo 可能弹 res:// 对话框，因为没人为你把剪贴板来源地址改成网页地址）", "warn");
    }
  } catch (e) {
    setStatus("失败：" + String(e && e.message || e), "err");
  } finally {
    lockUI(false);
  }
}

// Injected into the page (must be self-contained — it is serialised, not
// closured). On chat pages, scroll to the top in a loop until the number of
// mounted messages stops growing, so lazily-loaded history is in the DOM.
// Returns { blocks } when it recognised a conversation, null otherwise.
async function loadChatHistory() {
  // Count messages, not matching nodes: on ChatGPT the role attribute sits
  // inside the conversation-turn element, so a comma-joined selector would
  // count every message twice.
  const count = () => {
    const byRole = document.querySelectorAll("[data-message-author-role]").length;
    if (byRole >= 2) return byRole;
    return document.querySelectorAll(
      '[data-testid^="conversation-turn"], user-query, model-response'
    ).length;
  };
  if (count() < 2) return null;

  const isScrollable = (el) => {
    if (!el || el.scrollHeight <= el.clientHeight + 100) return false;
    if (el.clientHeight < 150 || el.clientWidth < 150) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll";
  };

  const findScroller = () => {
    let best = null;
    let bestArea = 0;
    const all = document.querySelectorAll("div, main, section");
    const limit = Math.min(all.length, 4000);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (!isScrollable(el)) continue;
      const area = el.clientHeight * el.clientWidth;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best;
  };

  const scroller = findScroller() ||
    document.scrollingElement ||
    document.documentElement ||
    document.body;
  if (!scroller) return null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const saved = scroller.scrollTop;
  const deadline = Date.now() + 4000;
  let last = -1;

  try {
    while (Date.now() < deadline) {
      scroller.scrollTop = 0;
      await sleep(260);
      const n = count();
      if (n === last) break;   // nothing new mounted: history is complete
      last = n;
    }
  } finally {
    scroller.scrollTop = saved;
    await sleep(120);
  }
  return { blocks: count() };
}

(async () => {
  // Version badge. It answers the one question that keeps coming up when a fix
  // "does not work": is the extension that is actually running the fixed code?
  // chrome://extensions shows the same number — if it is older, the extension
  // has not been reloaded and nothing on disk matters.
  if (verEl) verEl.textContent = "剪藏 v" + (extensionVersion() || "?");

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active;
    if (!tab || !tab.id || !/^https?:|^file:/.test(tab.url || "")) {
      runBtn.disabled = true;
      setStatus("此页面类型不支持提取", "err");
      return;
    }
    if (/\.pdf($|[?#])/i.test(tab.url || "")) {
      runBtn.disabled = true;
      setStatus("PDF 页面浏览器不允许注入脚本，暂不支持直接提取", "err");
      return;
    }

    host = hostOf(tab.url);
    const mode = await loadModeFor(host);
    modeInputs.forEach((i) => { i.checked = i.value === mode; });
    syncRunLabel();
    setStatus(mode === "full"
      ? "当前为该站点记住的「全页模式」，点按钮开始提取。"
      : "当前为默认「正文模式」，点按钮开始提取。");

    modeInputs.forEach((input) => {
      input.addEventListener("change", async () => {
        if (busy) return;
        const next = currentMode();
        syncRunLabel();
        await saveModeFor(host, next);
        setStatus(next === "full"
          ? "已切换为「全页模式」，点按钮开始提取。"
          : "已切换为「正文模式」，点按钮开始提取。");
      });
    });

    runBtn.addEventListener("click", () => run(currentMode()));
    diagBtn.addEventListener("click", runDiagnose);
  } catch (e) {
    setStatus("失败：" + String(e && e.message || e), "err");
  }
})();

// "Why did nothing happen?" answered from the host side. This is the one call
// that does NOT paste: it reports clipboard state, the SuperMemo process, how
// many top-level windows it keeps, whether the host can actually take the
// foreground away from Chrome, and what the host recorded the last time 提取
// was pressed. That record lives in %TEMP%\supermemo-clipper-last.json — it has
// to, because SuperMemo stealing the focus usually closes this popup before any
// result could be shown in it.
async function runDiagnose() {
  if (busy) return;
  lockUI(true);
  diagEl.style.display = "block";
  diagEl.textContent = "正在检查…";
  try {
    let resp = null;
    try {
      resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        action: "diagnose",
        pageUrl: (tab && tab.url) || "",
        version: extensionVersion()
      });
    } catch (_) {
      resp = null;
    }
    if (!resp) {
      diagEl.textContent =
        "native host 没有响应——它还没注册，或注册表里指向的路径不对。\n" +
        "请在仓库里运行：powershell -ExecutionPolicy Bypass -File native\\install.ps1";
      setStatus("诊断失败：native host 无响应", "err");
      return;
    }
    if (resp.code === "not_running") {
      diagEl.textContent = "SuperMemo 没有运行。";
      setStatus("诊断完成：SuperMemo 未运行", "warn");
      return;
    }
    diagEl.textContent = formatDiagnosis(resp);
    setStatus("诊断完成（没有新建条目、没有发出按键）", "ok");
  } catch (e) {
    diagEl.textContent = "诊断失败：" + String((e && e.message) || e);
  } finally {
    lockUI(false);
  }
}

// Window classes that mean "a keystroke sent here will be eaten". SuperMemo
// renders the note inside an embedded Internet Explorer, and after an automatic
// activation the keyboard very easily ends up in that host (or on the app frame)
// instead of on one of SuperMemo's own controls — in which case Ctrl+N does
// nothing at all. This map is what turns that diagnosis into a sentence.
const FOCUS_HINT = {
  "Shell DocObject View": " ← 元素窗口里内嵌的 IE 宿主，按键被它吃掉",
  "Shell Embedding": " ← 内嵌 IE 的宿主窗口，按键被它吃掉",
  "Internet Explorer_Server": " ← 内嵌 IE，按键被它吃掉",
  "TApplication": " ← 应用框架窗口，不派发快捷键",
  "TSMMain": " ← 应用框架窗口，不派发快捷键",
  "": " ← 没拿到键盘"
};

function formatDiagnosis(r) {
  const L = [];
  L.push("==== 本次检查 ====");
  L.push("剪贴板：" + (r.clipboardTextLen || 0) + " 字" +
    (r.clipboardHasHtml ? " + HTML" : "（没有 HTML）"));
  if (r.clipboardFormats && r.clipboardFormats.length) {
    L.push("  格式：" + r.clipboardFormats.join(" / "));
  }
  if (r.clipboardProbeError) L.push("  探测失败：" + r.clipboardProbeError);

  // The clipboard's SourceURL is the note's base URL inside SuperMemo's IE
  // component. When it points at this popup, IE cannot use it and falls back to
  // res://, which is the Windows "open this 'res' link?" dialog.
  const SRC_HINT = {
    "would-fix": "→ 粘贴前会被改写成上面的网页地址",
    "current": "→ 已经是网页地址，正常",
    "skipped": "→ 不改写（原因见下）",
    "verify-failed": "← 改写没通过校验，会按原样粘贴"
  };
  if (r.clipSourceUrl || r.clipSourceStatus) {
    L.push("剪贴板来源地址（SourceURL）：" +
      (r.clipSourceUrl || "（没有）"));
    if (r.clipSourceStatus && SRC_HINT[r.clipSourceStatus]) {
      L.push("  " + SRC_HINT[r.clipSourceStatus]);
    } else if (r.clipSourceStatus) {
      L.push("  状态：" + r.clipSourceStatus);
    }
    if (r.clipSourceDetail) L.push("  说明：" + r.clipSourceDetail);
  }

  L.push("SuperMemo：" + (r.smProcess || "?") + " (pid " + (r.smPid || "?") + ")，" +
    "可见顶层窗口 " + (r.windowCount || 0) + " 个");
  L.push("键盘能否交给 SuperMemo：" +
    (r.foregroundTaken ? "可以（第 " + r.attempts + " 次尝试成功）"
                       : "不可以 ← 这就是「点了没反应」的原因"));
  if (r.foregroundTitle) L.push("  前台窗口：" + shortTitle(r.foregroundTitle, 30));
  if (r.targetClass) L.push("  激活的窗口类：" + r.targetClass);
  if (r.focusClass) L.push("  拿到键盘的窗口类：" + r.focusClass + (FOCUS_HINT[r.focusClass] || ""));

  const p = r.previousRun;
  L.push("");
  L.push("==== 上次点「提取」时宿主记录到的实况 ====");
  if (!p) {
    L.push("（还没有记录。装好新版后点一次「提取」再来看）");
  } else {
    L.push("时间：" + (p.ts || "?"));
    L.push("扩展版本：" + (p.extension_version || "（旧版没上报）"));
    L.push("结果：" + (p.result || "?"));
    if (p.foreground_attempts != null) L.push("抢前台尝试：" + p.foreground_attempts + " 次");
    if (p.foreground_title) L.push("发键时前台：" + shortTitle(p.foreground_title, 30));
    if (p.focus_before_key) L.push("发键时键盘在：" + p.focus_before_key + (FOCUS_HINT[p.focus_before_key] || ""));
    if (p.focus_hands) L.push("把焦点交给 SuperMemo 控件：" + p.focus_hands + " 次");
    if (p.foreground_after) L.push("发键后前台：" + shortTitle(p.foreground_after, 30));
    if (p.sm_windows_before != null) {
      L.push("SuperMemo 窗口数：" + p.sm_windows_before + " → " + p.sm_windows_after);
    }
    L.push("剪贴板：" + (p.clipboard_text_len || 0) + " 字" +
      (p.clipboard_has_html ? " + HTML" : "（没有 HTML）"));
    if (p.clipboard_rewrite) {
      L.push("来源地址改写：" + p.clipboard_rewrite +
        (p.clipboard_source_before ? "（" + shortTitle(p.clipboard_source_before, 44) + "）" : ""));
      if (p.clipboard_rewrite_detail) L.push("  说明：" + p.clipboard_rewrite_detail);
    }
    if (p.page_url) L.push("页面：" + shortTitle(p.page_url, 60));
    if (p.error) L.push("错误：" + p.error);
  }
  if (r.log) { L.push(""); L.push("日志文件：" + r.log); }
  return L.join("\n");
}

async function copyToClipboard(html, text) {
  if (navigator.clipboard && typeof ClipboardItem === "function") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" })
        })
      ]);
      return;
    } catch (_) { /* fall through to execCommand */ }
  }
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.style.position = "fixed";
  holder.style.left = "-9999px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand("copy");
  sel.removeAllRanges();
  holder.remove();
  if (!ok) throw new Error("execCommand copy failed");
}
