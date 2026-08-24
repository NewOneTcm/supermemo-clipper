// Local verification harness (dev only, not shipped with the extension):
// loads a saved WeChat article HTML into jsdom, runs Readability + the real
// content/extract.js, and prints the sanitized output for inspection.
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const pageHtml = fs.readFileSync(process.argv[2], "utf8");
const dom = new JSDOM(pageHtml, {
  url: "https://mp.weixin.qq.com/s/test",
  runScripts: "outside-only"
});
const { window } = dom;

// WeChat ships #js_content with visibility:hidden and flips it visible via
// JS; jsdom runs no page scripts, so Readability would skip the real body.
// Simulate the rendered state.
const jc = window.document.getElementById("js_content");
if (jc) jc.style.visibility = "visible";

// extract.js touches these globals on the page context.
window.eval(fs.readFileSync(path.join(__dirname, "../lib/Readability.js"), "utf8"));
const src = fs.readFileSync(path.join(__dirname, "../content/extract.js"), "utf8");

// Wrap so the IIFE return value can be captured.
const result = window.eval("var __r = " + src.replace(/;\s*$/, "") + "; __r");

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
