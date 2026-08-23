// Action popup: clicking the toolbar button opens this document with real
// focus + user activation, which makes clipboard writes legal on Chrome 151+
// (page-context and offscreen writes both get rejected as "not focused").
//
// v2: after copying, the native host activates SuperMemo, creates a new
// element (Alt+N) and pastes (Ctrl+V). Note the popup usually closes itself
// the moment focus jumps to SuperMemo, so success status is mostly seen via
// SuperMemo receiving the paste; error/status paths stay readable here.
"use strict";

const statusEl = document.getElementById("status");
const NATIVE_HOST = "com.supermemo.paster.v2";

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:|^file:/.test(tab.url || "")) {
      setStatus("此页面类型不支持提取", "err");
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/Readability.js", "content/extract.js"]
    });
    const data = results && results[0] && results[0].result;
    if (!data || !data.ok) {
      setStatus((data && data.error) || "提取失败", "err");
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

    if (resp && resp.ok) {
      setStatus("已新建条目并粘贴到 SuperMemo", "ok");
      setTimeout(() => window.close(), 1200);
    } else if (resp && resp.code === "not_running") {
      setStatus("SuperMemo 未运行，内容已在剪贴板，打开后手动 Ctrl+V", "warn");
      // Keep the popup open so the hint stays readable.
    } else if (resp && resp.code === "activate_failed") {
      setStatus("已复制，但无法激活 SuperMemo 窗口，请手动 Alt+N 后 Ctrl+V", "warn");
    } else if (resp && resp.error) {
      setStatus("已复制，自动粘贴失败：" + resp.error, "warn");
    } else {
      setStatus("已复制。native host 未注册，请先运行 native\\install.ps1；此后可自动粘贴", "warn");
    }
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
