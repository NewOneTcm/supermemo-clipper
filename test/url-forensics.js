// URL forensics (dev tool, never shipped).
//
// Goal: find out how a *relative* URL — the only thing that can make IE turn a
// note URL into `res://…` — can still survive content/common.js, no matter how
// exotic the carrier is.
//
// Method: feed a deliberately hostile page through the REAL extractors, then
// audit the output by parsing it and inspecting every attribute of every
// element. An attribute counts as a leak when its value is URL-ish but not
// absolute+safe. That is a stronger check than grepping for "res://": the
// leak may be `/cdn/x.png`, and a raw grep would only flag it in the note if
// something had already absolutised it wrongly.
//
//   node test/url-forensics.js
"use strict";

const { extract } = require("./harness");

const SAFE_SCHEME = /^(https?|ftp|mailto):/i;
const SAFE_IMG = /^https?:\/\//i;
const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

// Attribute names that can carry a URL in some browser/engine.
const URL_ATTRS = new Set([
  "src", "href", "srcset", "lowsrc", "dynsrc", "background", "poster", "data",
  "action", "formaction", "cite", "longdesc", "usemap", "manifest", "profile",
  "codebase", "classid", "archive", "ping", "icon", "content", "style"
]);

function isUrlIsh(v) {
  if (!v) return false;
  if (/\s/.test(v) && !/^\s*(https?|ftp|mailto):/i.test(v)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) || /^[/.?#]/.test(v) || /\//.test(v);
}

function auditHtml(label, html) {
  const leaks = [];

  // 1. Raw scheme tokens anywhere (catches url() inside a style attribute,
  //    string literals, and anything a DOM parser would normalise away).
  const schemes = html.match(/\b[a-z][a-z0-9+.-]{1,20}:\/\//gi) || [];
  schemes.forEach((s) => {
    if (!/^(https?|ftp):\/\//i.test(s)) leaks.push(["raw scheme", s]);
  });

  // 2. Every attribute of every element.
  const { JSDOM } = require("jsdom");
  const doc = new JSDOM("<!doctype html><body>" + html).window.document;
  doc.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (URL_ATTRS.has(name)) {
        if (name === "style" || name === "content") {
          const inner = value.match(/url\(\s*['"]?([^'")]+)/i);
          if (inner && !SAFE_SCHEME.test(inner[1])) {
            leaks.push([tag + "[style]", inner[1]]);
          }
          continue;
        }
        if (name === "srcset") {
          leaks.push([tag + "[srcset]", value]); // never should survive
          continue;
        }
        if (isUrlIsh(value)) {
          const ok = tag === "img"
            ? (SAFE_IMG.test(value) || SAFE_DATA_IMG.test(value))
            : SAFE_SCHEME.test(value);
          if (!ok) leaks.push([tag + "[" + name + "]", value]);
        }
      } else if (isUrlIsh(value) && !/^(http|ftp|mailto)/i.test(value)) {
        // Non-URL attribute that happens to hold a path — attribute stripping
        // should already have removed these.
        leaks.push([tag + "[" + name + "]", value]);
      }
    }
  });

  const uniq = [...new Map(leaks.map((l) => [l.join("|"), l])).values()];
  console.log("\n[" + label + "]");
  if (!uniq.length) {
    console.log("  ✅ 没有发现任何非绝对 URL 残留");
    return 0;
  }
  console.log("  ❌ 发现 " + uniq.length + " 处可疑残留：");
  uniq.slice(0, 30).forEach(([where, val]) => {
    console.log("     " + where + " = " + (val.length > 120 ? val.slice(0, 120) + "…" : val));
  });
  return uniq.length;
}

// ---------------------------------------------------------------- hostile page

const NASTY = `<!doctype html>
<html><head>
  <base href="/base/">
  <link rel="stylesheet" href="/x.css">
  <meta http-equiv="refresh" content="0;url=/refresh.html">
  <style>@import url("/imp.css"); .a{background:url(/bg.png)}</style>
</head>
<body background="/body-bg.png">
  <h2>ChatGPT 模拟页</h2>
  <img src="/cdn/logo.png" alt="rel img">
  <img src="https://chatgpt.com/cdn/ok.png" alt="abs img">
  <img srcset="/a.png 1x, /b.png 2x" alt="srcset only">
  <img src="/a.png" srcset="/b.png 2x" alt="src+srcset">
  <img lowsrc="/l.png" dynsrc="/d.avi" alt="legacy imgs">
  <img data-src="/lazy.png" alt="lazy">
  <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg data">
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="gif data">
  <img src="res://ieframe.dll/dnserrordiagoff.htm" alt="res">
  <img src="blob:https://chatgpt.com/1234" alt="blob">
  <img src="about:blank" alt="about">
  <img src="javascript:alert(1)" alt="js">
  <img src="C:\\Users\\x.png" alt="win path">
  <img src="//cdn.example.com/proto-rel.png" alt="proto-relative">
  <img src="" alt="empty">
  <img src="?onlyquery=1" alt="query only">
  <img src="#" alt="hash only">
  <picture><source srcset="/p.webp"><img src="/p.jpg" alt="picture"></picture>
  <table background="/t.gif"><tr><td background="/td.gif"><img src="/cell.png" alt="cell"></td></tr></table>
  <div style="background-image:url(/inline-bg.png)">styled div</div>
  <section data-bg="/sec.png">section wrapper</section>
  <form action="/post"><input type="image" src="/btn.png"><button formaction="/b">go</button></form>
  <video poster="/poster.jpg"><source src="/v.mp4"><track src="/t.vtt"></video>
  <audio src="/a.mp3"></audio>
  <embed src="/e.swf"><object data="/o.png"></object><applet code="/app.class"></applet>
  <iframe src="/frame.html"></iframe>
  <svg><image href="/svg-img.png"></image><use href="/svg-use.svg#i"></use></svg>
  <map><area href="/area.png"></map>
  <blockquote cite="/cite.html">quoted</blockquote>
  <del cite="/del.html">deleted</del><ins cite="/ins.html">inserted</ins>
  <q cite="/q.html">inline quote</q>
  <template><img src="/template.png" alt="in template"></template>
  <noscript><img src="/noscript.png" alt="in noscript"></noscript>
  <marquee behavior="alternate"><img src="/marquee.png" alt="marquee"></marquee>
  <a href="/c/abc">relative link</a>
  <a href="#cite-1">anchor link</a>
  <a href="?model=gpt">query link</a>
  <a href="res://ieframe.dll/dnserrordiagoff.htm">res link</a>
  <a href="javascript:void(0)">js link</a>
  <a href="tel:+8613800000000">tel link</a>
  <a href="mailto:a@b.com">mail link</a>
  <a href="https://chatgpt.com/c/xyz">abs link</a>
  <a href="//cdn.example.com/x">proto-rel link</a>
  <a xlink:href="/xlink.png">xlink</a>
  <p data-url="/data-attr.png" title="/title.png">attributes that must vanish</p>
  <span style="background:url(/span-bg.png)">span with style</span>
  <!--[if IE]><img src="/cond.png" alt="conditional"><![endif]-->
  <p>普通段落，带一个裸地址 https://example.com/ok 和一个半截路径 /half/path。</p>
</body></html>`;

console.log("==== 敌意页面：全页模式 ====");
const full = extract(NASTY, "https://chatgpt.com/c/abc", "full");
if (!full.ok) {
  console.log("  提取失败: " + full.error);
} else {
  console.log("  meta = " + JSON.stringify(full.meta));
  auditHtml("全页输出 HTML", full.html);
  auditHtml("全页输出纯文本", full.text);
}

console.log("\n==== 敌意页面：正文模式 ====");
const art = extract(NASTY, "https://chatgpt.com/c/abc", "article");
if (!art.ok) {
  console.log("  提取失败: " + art.error);
} else {
  console.log("  meta = " + JSON.stringify(art.meta || null));
  auditHtml("正文输出 HTML", art.html);
}
