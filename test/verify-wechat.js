// Regression check for article mode (Readability) on a saved WeChat article:
//   node test/verify-wechat.js <saved-page.html>
"use strict";

const fs = require("fs");
const { extract } = require("./harness");

const pageHtml = fs.readFileSync(process.argv[2], "utf8");
const result = extract(pageHtml, "https://mp.weixin.qq.com/s/test", "article");

if (!result || !result.ok) {
  console.log("EXTRACT FAILED:", result && result.error);
  process.exit(1);
}

console.log("TITLE:", result.title);
const pCount = (result.html.match(/<p[>\s]/g) || []).length;
const imgCount = (result.html.match(/<img[>\s]/g) || []).length;
console.log("HTML <p> count:", pCount, "| <img> count:", imgCount);
console.log("---TEXT HEAD (600 chars)---");
console.log(result.text.slice(0, 600));
console.log("---HTML SNIPPET---");
console.log(result.html.slice(0, 800));
