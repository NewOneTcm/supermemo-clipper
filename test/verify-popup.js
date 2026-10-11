// Popup logic checks with chrome.* mocked out. The extraction scripts are
// covered by verify-all.js; this file covers the wiring around them:
//   - opening the popup must NOT extract anything
//   - clicking 提取 runs the remembered mode
//   - switching modes only remembers the choice, it does not extract
//   - automatic fallback to whole-page mode when article mode finds nothing
//
//   node test/verify-popup.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const popupHtml = fs.readFileSync(path.join(ROOT, "popup/popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(ROOT, "popup/popup.js"), "utf8");

let failures = 0;
function check(label, condition, detail) {
  console.log((condition ? "  PASS  " : "  FAIL  ") + label + (detail ? "  -> " + detail : ""));
  if (!condition) failures += 1;
}

const OK = { ok: true, html: "<p>x</p>", text: "x", meta: { scope: "page", blocks: 0, chars: 1 } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(opts) {
  const dom = new JSDOM(popupHtml, {
    url: "chrome-extension://test/popup/popup.html",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const calls = [];
  const funcCalls = [];
  const nativeMsgs = [];
  const store = { siteModes: opts.siteModes };

  window.close = () => {};
  window.document.execCommand = () => true;
  window.chrome = {
    tabs: { query: async () => [{ id: 1, url: opts.url }] },
    scripting: {
      executeScript: async (injection) => {
        if (injection.func) {
          funcCalls.push(injection.func.name);
          return [{ result: null }];
        }
        calls.push(injection.files.slice());
        const entry = injection.files[injection.files.length - 1];
        return [{ result: opts.results[entry] }];
      }
    },
    runtime: {
      sendNativeMessage: async (_host, msg) => {
        nativeMsgs.push(msg);
        if (msg && msg.action === "diagnose") {
          return opts.diagnose === undefined ? { ok: true, code: "diagnose" } : opts.diagnose;
        }
        return opts.native === undefined ? { ok: true } : opts.native;
      },
      getManifest: () => ({ version: "9.9.9-test" })
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => { Object.assign(store, obj); }
      }
    }
  };

  window.eval(popupJs);
  await tick(60);
  return {
    window,
    dom,
    calls,
    funcCalls,
    nativeMsgs,
    store,
    status: () => window.document.getElementById("status").textContent,
    ver: () => window.document.getElementById("ver").textContent,
    label: () => window.document.getElementById("run").textContent,
    diagText: () => window.document.getElementById("diag").textContent,
    diagVisible: () =>
      window.document.getElementById("diag").style.display !== "none",
    pick: async (value) => {
      const input = window.document.querySelector('input[value="' + value + '"]');
      input.checked = true;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick(60);
    },
    run: async () => {
      window.document.getElementById("run").click();
      await tick(120);
    },
    diagnose: async () => {
      window.document.getElementById("diagBtn").click();
      await tick(120);
    }
  };
}

(async () => {
  console.log("\n[ popup / 打开时不应提取 ]");
  {
    const r = await boot({
      url: "https://mp.weixin.qq.com/s/x",
      results: { "content/extract.js": OK }
    });
    check("打开 popup 不注入任何脚本", r.calls.length === 0, JSON.stringify(r.calls));
    check("按钮文案 = 提取正文并粘贴到 SuperMemo",
      r.label() === "提取正文并粘贴到 SuperMemo", r.label());
    check("状态是等待操作，不是「正在提取」",
      !/正在提取/.test(r.status()), r.status());
    // Version badge: the quickest way to tell whether Chrome is running the
    // files on disk or a stale copy from before "重新加载".
    check("popup 显示扩展版本号", /v9\.9\.9-test/.test(r.ver()), r.ver());

    await r.run();
    check("点按钮后才注入", r.calls.length === 1, JSON.stringify(r.calls));
    check("走正文模式（含 Readability）",
      r.calls[0].join("|") === "lib/Readability.js|content/common.js|content/extract.js",
      r.calls[0] && r.calls[0].join(" -> "));
  }

  console.log("\n[ popup / 切换模式不应触发提取 ]");
  {
    const r = await boot({
      url: "https://chatgpt.com/c/68f0a1b2",
      results: { "content/extract-full.js": OK }
    });
    check("chatgpt.com 未记录过，默认正文模式",
      r.window.document.querySelector('input[value="article"]').checked);

    await r.pick("full");
    check("切换模式没有注入任何脚本", r.calls.length === 0, JSON.stringify(r.calls));
    check("按钮文案跟着变成整页",
      r.label() === "提取整页并粘贴到 SuperMemo", r.label());
    check("该站点已记住 full",
      r.store.siteModes && r.store.siteModes["chatgpt.com"] === "full",
      JSON.stringify(r.store.siteModes));

    await r.run();
    check("点按钮后只注入一次", r.calls.length === 1, JSON.stringify(r.calls));
    check("全页模式不加载 Readability",
      r.calls[0].join("|") === "content/common.js|content/extract-full.js",
      r.calls[0] && r.calls[0].join(" -> "));
    check("全页模式先尝试预热滚动（loadChatHistory）",
      r.funcCalls.includes("loadChatHistory"), JSON.stringify(r.funcCalls));
    check("状态里带【全页】标记", /【全页】/.test(r.status()), r.status());
    check("状态里带字数统计", /字）/.test(r.status()), r.status());
  }

  console.log("\n[ popup / 站点记忆生效 ]");
  {
    const r = await boot({
      url: "https://chatgpt.com/c/68f0a1b2",
      siteModes: { "chatgpt.com": "full" },
      results: { "content/extract-full.js": OK }
    });
    check("radio 预选「全页模式」",
      r.window.document.querySelector('input[value="full"]').checked);
    check("按钮文案是整页", r.label() === "提取整页并粘贴到 SuperMemo", r.label());
    await r.run();
    check("点按钮后直接走全页模式", r.calls.length === 1 && r.calls[0].length === 2,
      JSON.stringify(r.calls));
  }

  console.log("\n[ popup / 正文失败自动回退 ]");
  {
    const r = await boot({
      url: "https://example.com/post",
      results: {
        "content/extract.js": { ok: false, error: "无法识别正文（当前页面可能不是文章页）" },
        "content/extract-full.js": OK
      }
    });
    await r.run();
    check("先试正文、再试全页", r.calls.length === 2, JSON.stringify(r.calls));
    check("第二次是全文模式",
      r.calls[1] && r.calls[1].join("|") === "content/common.js|content/extract-full.js",
      r.calls[1] && r.calls[1].join(" -> "));
    check("回退后记住该站点为全页",
      r.store.siteModes && r.store.siteModes["example.com"] === "full",
      JSON.stringify(r.store.siteModes));
    check("状态里说明了自动回退", /自动改用全页模式/.test(r.status()), r.status());
  }

  console.log("\n[ popup / 两种模式都失败 ]");
  {
    const r = await boot({
      url: "https://example.com/blank",
      results: {
        "content/extract.js": { ok: false, error: "无法识别正文" },
        "content/extract-full.js": { ok: false, error: "页面没有 body" }
      }
    });
    await r.run();
    check("报错而不是静默", /页面没有 body/.test(r.status()), r.status());
  }

  console.log("\n[ popup / 不支持的页面 ]");
  {
    const r = await boot({ url: "chrome://extensions", results: {} });
    check("不注入脚本", r.calls.length === 0, JSON.stringify(r.calls));
    check("提示不支持", /不支持/.test(r.status()), r.status());
    check("提取按钮被禁用", r.window.document.getElementById("run").disabled);
  }

  console.log("\n[ popup / native host 各返回分支 ]");
  {
    // The clipboard guard added in v2.2.1 exists so SuperMemo's own failure
    // ("Error adding new text topic. Cannot open clipboard") never has to be
    // the first thing the user sees. v2.3.1 changed what the host reports on
    // success: not "which window was in front" (SuperMemo's app frame could be
    // in front with the keystroke still being swallowed) but "which window owned
    // the keyboard", which is the class the user sees as 键盘：....
    const cases = [
      ["成功", { ok: true }, /已新建条目并粘贴到 SuperMemo/],
      ["成功（带键盘所在窗口）", { ok: true, focus: "TBitBtn", target: "TElWind" },
        /键盘：TBitBtn/],
      ["成功（没检测到新窗口时给提示）", { ok: true, focus: "TBitBtn", newWindow: false },
        /未检测到新窗口/],
      ["未运行", { ok: false, code: "not_running" }, /打开后按 Ctrl\+N 即可/],
      ["无法激活", { ok: false, code: "activate_failed", fg: "ChatGPT - Google Chrome",
        focusClass: "Shell DocObject View" },
        /没能把键盘交给 SuperMemo（前台：「ChatGPT - Goog/],
      ["无法激活时点名吃掉按键的窗口类",
        { ok: false, code: "activate_failed", fg: "X", focusClass: "Shell DocObject View" },
        /键盘：「Shell DocObject View」/],
      ["剪贴板为空", { ok: false, code: "clipboard_empty" }, /剪贴板里没有内容/],
      ["host 未注册", null, /native host 未注册/]
    ];
    for (const [name, native, want] of cases) {
      const r = await boot({
        url: "https://mp.weixin.qq.com/s/x",
        results: { "content/extract.js": OK },
        native
      });
      await r.run();
      check(name + " -> " + want.source, want.test(r.status()), r.status());
    }

    const fail = await boot({
      url: "https://mp.weixin.qq.com/s/x",
      results: { "content/extract.js": OK },
      native: { ok: false, code: "activate_failed", fg: "ChatGPT - Google Chrome" }
    });
    await fail.run();
    check("激活失败时把诊断面板亮出来",
      fail.diagVisible(), fail.diagText());
  }

  console.log("\n[ popup / 诊断按钮 ]");
  {
    const diagPayload = {
      ok: true,
      code: "diagnose",
      clipboardFormats: ["HTML Format", "UnicodeText"],
      clipboardTextLen: 3657,
      clipboardHasHtml: true,
      clipboardProbeError: null,
      smProcess: "sm20",
      smPid: 12724,
      windowCount: 9,
      windows: ["MYBRAIN (SuperMemo 20: d:\\supermemo\\systems\\)"],
      foregroundTaken: true,
      foregroundTitle: "反共识观点：第6辑 处世. 观点1.  反对盲目跟风投资",
      focusClass: "TBitBtn",
      targetClass: "TElWind",
      attempts: 1,
      previousRun: {
        ts: "2026-10-11 16:20:01",
        result: "sent",
        foreground_attempts: 3,
        foreground_title: "ChatGPT - Google Chrome",
        foreground_after: "MYBRAIN (SuperMemo 20: d:\\supermemo\\systems\\)",
        focus_before_key: "TBitBtn",
        focus_hands: 1,
        sm_windows_before: 8,
        sm_windows_after: 9,
        clipboard_text_len: 3657,
        clipboard_has_html: true
      },
      log: "C:\\Users\\Newone\\AppData\\Local\\Temp\\supermemo-clipper-last.json"
    };
    const r = await boot({
      url: "https://mp.weixin.qq.com/s/x",
      results: { "content/extract.js": OK },
      diagnose: diagPayload
    });
    await r.diagnose();
    check("诊断请求带 action=diagnose",
      r.nativeMsgs.length === 1 && r.nativeMsgs[0].action === "diagnose",
      JSON.stringify(r.nativeMsgs));
    check("诊断不注入脚本、不提取", r.calls.length === 0, JSON.stringify(r.calls));
    check("诊断不新建条目（状态里明说）",
      /没有新建条目/.test(r.status()), r.status());

    const t = r.diagText();
    check("显示剪贴板字数与格式", /3657 字 \+ HTML/.test(t) && /HTML Format/.test(t), t);
    check("显示 SuperMemo 进程与窗口数",
      /sm20 \(pid 12724\)/.test(t) && /可见顶层窗口 9 个/.test(t), t);
    check("显示键盘能否交给 SuperMemo",
      /键盘能否交给 SuperMemo：可以（第 1 次尝试成功）/.test(t), t);
    check("显示激活的窗口类与拿到键盘的窗口类",
      /激活的窗口类：TElWind/.test(t) && /拿到键盘的窗口类：TBitBtn/.test(t), t);
    check("回显上次运行发键时键盘在哪",
      /发键时键盘在：TBitBtn/.test(t), t);
    check("回显上次运行把焦点交出去几次",
      /把焦点交给 SuperMemo 控件：1 次/.test(t), t);
    check("回显上次运行的真实前台窗口",
      /发键时前台：ChatGPT - Google Chrome/.test(t), t);
    check("回显发键后的前台窗口",
      /发键后前台：MYBRAIN/.test(t), t);
    check("回显 SuperMemo 窗口数变化", /SuperMemo 窗口数：8 → 9/.test(t), t);
    check("给出日志文件路径", /supermemo-clipper-last\.json/.test(t), t);

    // The case that motivates the button: the host cannot take the foreground.
    const bad = await boot({
      url: "https://mp.weixin.qq.com/s/x",
      results: { "content/extract.js": OK },
      diagnose: {
        ok: true, code: "diagnose", clipboardTextLen: 0, clipboardHasHtml: false,
        smProcess: "sm20", smPid: 1, windowCount: 2,
        foregroundTaken: false, foregroundTitle: "ChatGPT - Google Chrome",
        attempts: 27, previousRun: null, log: "C:\\Temp\\x.json"
      }
    });
    await bad.diagnose();
    check("抢不到键盘时明确指出来",
      /不可以 ← 这就是「点了没反应」的原因/.test(bad.diagText()), bad.diagText());
    check("没有上次记录时也说得清楚",
      /还没有记录/.test(bad.diagText()), bad.diagText());

    // host not registered at all
    const none = await boot({
      url: "https://mp.weixin.qq.com/s/x",
      results: { "content/extract.js": OK },
      diagnose: null
    });
    await none.diagnose();
    check("host 无响应时给安装指引",
      /install\.ps1/.test(none.diagText()), none.diagText());
    check("host 无响应时状态是失败",
      /诊断失败/.test(none.status()), none.status());
  }

  console.log("\n[ popup / 状态栏回显抓取量与 URL 统计 ]");
  {
    const r = await boot({
      url: "https://example.com/book/",
      results: {
        "content/extract-full.js": {
          ok: true, html: "<p>x</p>", text: "x",
          meta: {
            scope: "page", blocks: 0, chars: 1234,
            urls: { img: 2, imgDropped: 0, link: 23, linkDropped: 1 }
          }
        }
      }
    });
    await r.pick("full");
    await r.run();
    const s = r.status();
    check("回显字数", /1234 字/.test(s), s);
    check("回显图片与链接数", /图 2 · 链 23/.test(s), s);
    check("有丢弃时回显丢弃数", /丢弃 1 个无效链接/.test(s), s);
  }

  console.log("\n[ popup / 剪贴板来源地址：页面 URL 必须随消息发给宿主 ]");
  {
    // SuperMemo pastes into an IE component whose base URL comes from the
    // clipboard's CF_HTML SourceURL. Chrome stamps that with the POPUP's
    // chrome-extension URL, which IE cannot use, so it falls back to its
    // internal res:// base and Windows pops the "open this 'res' link?"
    // dialog. Only the popup knows which page the note came from, so the page
    // URL must travel with every native call.
    const r = await boot({
      url: "https://chatgpt.com/c/68f0a1b2-test",
      results: { "content/extract-full.js": OK }
    });
    await r.pick("full");
    await r.run();
    const pasteMsg = r.nativeMsgs.find((m) => m.action === "new_and_paste");
    check("提取时发的是 new_and_paste", !!pasteMsg, JSON.stringify(r.nativeMsgs));
    check("消息里带 pageUrl（当前页地址）",
      pasteMsg && pasteMsg.pageUrl === "https://chatgpt.com/c/68f0a1b2-test",
      pasteMsg && pasteMsg.pageUrl);
    check("消息里带扩展版本号（宿主日志可查是哪一版干的）",
      pasteMsg && pasteMsg.version === "9.9.9-test", pasteMsg && pasteMsg.version);
  }

  console.log("\n[ popup / 来源地址修正的回显 ]");
  {
    const fixed = await boot({
      url: "https://chatgpt.com/c/x",
      results: { "content/extract-full.js": OK },
      native: { ok: true, fg: "SuperMemo - 集合", sourceStatus: "fixed" }
    });
    await fixed.pick("full");
    await fixed.run();
    check("修好时状态里明确写出来（这次修复的可见部分）",
      /来源地址已修正/.test(fixed.status()), fixed.status());

    const notFixed = await boot({
      url: "https://chatgpt.com/c/x",
      results: { "content/extract-full.js": OK },
      native: { ok: true, fg: "SuperMemo" }
    });
    await notFixed.pick("full");
    await notFixed.run();
    check("没改（例如没装宿主）时不谎报已修正",
      !/来源地址已修正/.test(notFixed.status()), notFixed.status());
  }

  console.log("\n[ popup / 诊断里要看得到剪贴板来源地址 ]");
  {
    const r = await boot({
      url: "https://chatgpt.com/c/x",
      results: { "content/extract-full.js": OK },
      diagnose: {
        ok: true, code: "diagnose",
        clipboardTextLen: 10, clipboardHasHtml: true,
        clipboardFormats: ["HTML Format", "UnicodeText"],
        clipSourceUrl: "chrome-extension://abc/popup/popup.html",
        clipSourceWouldBe: "https://chatgpt.com/c/x",
        clipSourceStatus: "would-fix",
        smProcess: "sm20", smPid: 1, windowCount: 2,
        foregroundTaken: true, attempts: 1, log: "C:\\Temp\\x.json"
      }
    });
    await r.diagnose();
    const d = r.diagText();
    check("诊断里显示当前 SourceURL", /chrome-extension:\/\/abc\/popup\/popup\.html/.test(d), d);
    check("诊断里说明会被改写成网页地址", /会被改写成上面的网页地址/.test(d), d);
    const diagMsg = r.nativeMsgs.find((m) => m.action === "diagnose");
    check("诊断消息也带 pageUrl", diagMsg && diagMsg.pageUrl === "https://chatgpt.com/c/x",
      JSON.stringify(diagMsg));
  }

  console.log("\n[ popup / loadChatHistory 注入函数 ]");
  {
    const match = popupJs.match(/\nasync function loadChatHistory\(\) \{[\s\S]*?\n\}/);
    check("能从 popup.js 提取到自包含函数源码", !!match);
    if (match) {
      // Must run inside the jsdom VM context: a function returned by
      // window.eval() and called from Node loses `document` from its scope.
      const invoke = async (dom) => {
        const ctx = dom.getInternalVMContext();
        vm.runInContext(match[0].trim(), ctx);
        return await vm.runInContext("loadChatHistory()", ctx);
      };

      const plain = new JSDOM("<body><p>普通文章正文</p></body>", {
        url: "https://example.com/",
        runScripts: "outside-only"
      });
      const plainResult = await invoke(plain);
      check("非对话页直接返回 null（跳过预热）", plainResult === null, JSON.stringify(plainResult));

      const chatHtml = `<body><div role="log">
        <article data-testid="conversation-turn-1"><div data-message-author-role="user"><div class="markdown"><p>问题一</p></div></div></article>
        <article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>回答一</p></div></div></article>
        <article data-testid="conversation-turn-3"><div data-message-author-role="user"><div class="markdown"><p>问题二</p></div></div></article>
        <article data-testid="conversation-turn-4"><div data-message-author-role="assistant"><div class="markdown"><p>回答二</p></div></div></article>
      </div></body>`;
      const chat = new JSDOM(chatHtml, {
        url: "https://chatgpt.com/c/1",
        runScripts: "outside-only"
      });
      const chatResult = await invoke(chat);
      check("对话页返回消息条数（不重复计数）",
        chatResult && chatResult.blocks === 4, JSON.stringify(chatResult));
    }
  }

  console.log("\n" + (failures ? failures + " check(s) FAILED" : "all checks passed"));
  process.exit(failures ? 1 : 0);
})();
