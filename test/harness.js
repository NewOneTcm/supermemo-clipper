// Local verification harness (dev only, not shipped with the extension).
// Loads a saved page HTML into jsdom, runs the real content scripts for the
// requested mode, and returns the payload the popup would have clipboarded.
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

const FILES = {
  article: ["lib/Readability.js", "content/common.js", "content/extract.js"],
  full: ["content/common.js", "content/extract-full.js"]
};

function extract(pageHtml, url, mode) {
  mode = mode || "article";
  const dom = new JSDOM(pageHtml, {
    url: url || "https://example.com/",
    runScripts: "outside-only"
  });
  const { window } = dom;

  // WeChat ships #js_content with visibility:hidden and flips it visible via
  // JS; jsdom runs no page scripts, so Readability would skip the real body.
  // Simulate the rendered state.
  const jc = window.document.getElementById("js_content");
  if (jc) jc.style.visibility = "visible";

  const entry = FILES[mode][FILES[mode].length - 1];
  const deps = FILES[mode].slice(0, -1);

  deps.forEach((rel) => {
    window.eval(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  });

  // Wrap the entry script so its IIFE return value can be captured — the real
  // injection path reads that same completion value off executeScript.
  const src = fs.readFileSync(path.join(ROOT, entry), "utf8");
  return window.eval("var __r = " + src.replace(/;\s*$/, "") + "; __r");
}

module.exports = { extract, FILES };
