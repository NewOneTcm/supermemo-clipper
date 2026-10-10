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
      sendNativeMessage: async () =>
        (opts.native === undefined ? { ok: true } : opts.native)
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
    store,
    status: () => window.document.getElementById("status").textContent,
    label: () => window.document.getElementById("run").textContent,
    pick: async (value) => {
      const input = window.document.querySelector('input[value="' + value + '"]');
      input.checked = true;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick(60);
    },
    run: async () => {
      window.document.getElementById("run").click();
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
    // the first thing the user sees.
    const cases = [
      ["成功", { ok: true }, /已新建条目并粘贴到 SuperMemo/],
      ["未运行", { ok: false, code: "not_running" }, /打开后按 Ctrl\+N 即可/],
      ["无法激活", { ok: false, code: "activate_failed" }, /手动按 Ctrl\+N/],
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
