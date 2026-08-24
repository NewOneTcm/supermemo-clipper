// One-off check: run extract.js on the saved WeChat page and list final img
// srcs to confirm the tp=webp (WebP) params are gone.
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(fs.readFileSync(process.argv[2], "utf8"), {
  url: "https://mp.weixin.qq.com/s/test",
  runScripts: "outside-only"
});
const w = dom.window;
const jc = w.document.getElementById("js_content");
if (jc) jc.style.visibility = "visible";

w.eval(fs.readFileSync(path.join(__dirname, "../lib/Readability.js"), "utf8"));
const src = fs.readFileSync(path.join(__dirname, "../content/extract.js"), "utf8");
const r = w.eval("var __r = " + src.replace(/;\s*$/, "") + "; __r");
console.log("ok:", r.ok);
const imgs = [];
const re = /<img[^>]*src="([^"]+)"/g;
let m;
while ((m = re.exec(r.html))) imgs.push(m[1]);
console.log("img count:", imgs.length);
imgs.slice(0, 8).forEach((s) => console.log(s));
console.log("any tp=webp left:", imgs.some((s) => /tp=webp/.test(s)));
