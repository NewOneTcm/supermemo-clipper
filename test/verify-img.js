// One-off check: run article mode on a saved WeChat page and list the final
// img srcs to confirm the tp=webp (WebP) params are gone.
//   node test/verify-img.js <saved-page.html>
"use strict";

const fs = require("fs");
const { extract } = require("./harness");

const r = extract(
  fs.readFileSync(process.argv[2], "utf8"),
  "https://mp.weixin.qq.com/s/test",
  "article"
);

console.log("ok:", r.ok);
const imgs = [];
const re = /<img[^>]*src="([^"]+)"/g;
let m;
while ((m = re.exec(r.html))) imgs.push(m[1]);
console.log("img count:", imgs.length);
imgs.slice(0, 8).forEach((s) => console.log(s));
console.log("any tp=webp left:", imgs.some((s) => /tp=webp/.test(s)));
