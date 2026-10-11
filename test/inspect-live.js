// Live-page inspector (development tool, never shipped with the extension).
//
// Loads a URL in the system Chrome, lets the page finish rendering, then runs
// the *real* content scripts (content/common.js + content/extract-full.js) in
// that page and reports what they would copy.
//
// Why this exists: some sites build their DOM at runtime, so the HTML you get
// from curl has nothing to do with what the clipper actually sees. When a note
// misbehaves on such a page (e.g. Windows popping its "open this 'res' link?"
// dialog), this is how you tell "the page never contained it" apart from
// "our sanitizer let it through".
//
//   node test/inspect-live.js "https://example.com/page#anchor"
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(__dirname, "saved");

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("找不到 Chrome/Edge，请手动指定 executablePath");
}

// Every URL-bearing attribute still present, plus any scheme-looking text.
function audit(label, html) {
  const urls = new Set();
  const re = /\b(?:href|src)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);

  console.log("\n[" + label + "]");
  console.log("  length        : " + html.length);
  console.log("  res:// count  : " + (html.match(/res:\/\//gi) || []).length);
  console.log("  scheme-ish    : " +
    JSON.stringify(html.match(/\b[a-z][a-z0-9+.-]{1,12}:\/\//gi) || []));
  console.log("  href/src 残留 : " + urls.size + " 个，前 15 个：");
  [...urls].slice(0, 15).forEach((u) => {
    console.log("      " + (u.length > 110 ? u.slice(0, 110) + "…" : u));
  });

  const hit = html.search(/res:/i);
  if (hit >= 0) {
    console.log("  res: 首次出现上下文：");
    console.log("      …" + html.slice(Math.max(0, hit - 150), hit + 200).replace(/\s+/g, " ") + "…");
    console.log("  另：res: 总数 = " + (html.match(/res:/gi) || []).length +
      "（含 Fractures: 这类误报）");
  } else {
    console.log("  res: 未出现");
  }
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error("用法: node test/inspect-live.js <url>");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: findBrowser(),
    headless: true
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 }
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("console", (m) => {
      if (m.type() === "error") console.log("  [console.error] " + m.text().slice(0, 200));
    });
    page.on("requestfailed", (r) => {
      console.log("  [request failed] " + r.url().slice(0, 140) + " — " + (r.failure() || {}).errorText);
    });

    console.log("打开: " + url);
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    // Let client-side rendering settle. Many doc sites fetch their body from
    // markdown at runtime, so a fixed sleep is not enough — poll for a
    // container that actually fills up.
    await page.waitForTimeout(2500);
    for (let i = 0; i < 12; i++) {
      const n = await page.evaluate(() => {
        const list = document.getElementById("list") ||
                     document.querySelector("main, #app, #content, article");
        return list ? list.children.length : 0;
      });
      if (i === 0 || n > 0) console.log("  渲染进度: 主容器子节点 = " + n);
      if (n > 0) break;
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(800);

    const rendered = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, "rendered.html"), rendered, "utf8");
    console.log("渲染后 DOM 已存: test/saved/rendered.html");
    console.log("标题: " + await page.title());

    // Sanity: is the target anchor actually in the rendered DOM?
    const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
    if (hash) {
      const found = await page.evaluate((h) =>
        !!document.getElementById(h), hash);
      console.log("锚点 #" + hash + " 在渲染后 DOM 中: " + found);
    }

    audit("渲染后的完整 DOM", rendered);

    // Run the real extractors, exactly as the popup does.
    for (const mode of ["full", "article"]) {
      const files = mode === "full"
        ? ["content/common.js", "content/extract-full.js"]
        : ["lib/Readability.js", "content/common.js", "content/extract.js"];

      await page.evaluate(() => {
        delete window.__smClip;
        delete window.__smResult;
      });
      for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, f), "utf8");
        const isLast = f === files[files.length - 1];
        const wrapped = isLast
          ? "window.__smResult = " + src.replace(/;\s*$/, "")
          : src;
        await page.addScriptTag({ content: wrapped });
      }

      const res = await page.evaluate(() => window.__smResult || null);
      if (!res) {
        console.log("\n[" + mode + " 模式] 无返回");
        continue;
      }
      if (!res.ok) {
        console.log("\n[" + mode + " 模式] 失败: " + res.error);
        continue;
      }
      console.log("\n[" + mode + " 模式] ok, meta=" + JSON.stringify(res.meta || null));
      const outFile = path.join(OUT_DIR, "out-" + mode + ".html");
      fs.writeFileSync(outFile, res.html, "utf8");
      console.log("  输出已存: test/saved/out-" + mode + ".html");
      audit(mode + " 模式输出 HTML", res.html);
      audit(mode + " 模式输出纯文本", res.text);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("失败: " + (e && e.message || e));
  process.exit(1);
});
