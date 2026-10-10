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
// After copying, the native host activates SuperMemo and sends Ctrl+N, which
// is SuperMemo's "Add a new article": it creates the element AND pastes the
// clipboard itself, in one step — exactly what you do when clipping by hand.
// (The host used to send Alt+N + Ctrl+V; Alt+N is "Add a note", which makes a
// blank element and ignores the clipboard, and the follow-up Ctrl+V often
// landed on the Contents window where it means "Paste element" and rejected
// the HTML — that was the error.) The popup usually closes itself the moment
// focus jumps to SuperMemo, so success is mostly seen via SuperMemo receiving
// the paste; error/status paths stay readable here.
"use strict";

const statusEl = document.getElementById("status");
const runBtn = document.getElementById("run");
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

function lockUI(locked) {
  busy = locked;
  modeInputs.forEach((i) => { i.disabled = locked; });
  runBtn.disabled = locked;
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

    // Native host path: auto new-element + paste inside SuperMemo.
    let resp = null;
    try {
      resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "new_and_paste" });
    } catch (_) {
      resp = null; // host not registered / browser disconnected
    }

    const meta = data.meta || {};
    const size = meta.chars
      ? "（" + (meta.blocks ? meta.blocks + " 条消息 · " : "") + meta.chars + " 字）"
      : "";
    const head = notice + (mode === "full" ? "【全页】" : "【正文】");

    if (resp && resp.ok) {
      setStatus(head + "已新建条目并粘贴到 SuperMemo" + size, "ok");
      setTimeout(() => window.close(), 1400);
    } else if (resp && resp.code === "not_running") {
      setStatus(head + "SuperMemo 未运行，内容已在剪贴板" + size + "，打开后按 Ctrl+N 即可", "warn");
      // Keep the popup open so the hint stays readable.
    } else if (resp && resp.code === "activate_failed") {
      setStatus(head + "已复制" + size + "，但无法激活 SuperMemo 窗口，请在 SuperMemo 里手动按 Ctrl+N", "warn");
    } else if (resp && resp.code === "clipboard_empty") {
      setStatus(head + "提取成功" + size + "，但剪贴板里没有内容（可能被其他程序占用），请重试", "warn");
    } else if (resp && resp.error) {
      setStatus(head + "已复制" + size + "，自动粘贴失败：" + resp.error, "warn");
    } else {
      setStatus(head + "已复制" + size + "。native host 未注册，请先运行 native\\install.ps1；此后可自动粘贴", "warn");
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
  } catch (e) {
    setStatus("失败：" + String(e && e.message || e), "err");
  }
})();

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
