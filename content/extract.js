// Article mode: runs after lib/Readability.js and content/common.js.
// Clones the document, extracts the main article with Readability, then hands
// the HTML to common.js for sanitizing and payload assembly.
//
// Caveat: Readability is a *single-article* extractor — it scores every
// paragraph, picks the highest-scoring node (topCandidates[0]) and returns
// that one subtree. On multi-message pages (ChatGPT and friends) only the
// first/longest reply survives. Use content/extract-full.js for those.
(function () {
  "use strict";

  var api = window.__smClip;
  if (!api) return { ok: false, error: "清洗模块未加载（content/common.js）" };
  if (typeof Readability !== "function") {
    return { ok: false, error: "Readability 未加载" };
  }

  try {
    var article = new Readability(document.cloneNode(true)).parse();
    if (!article || !article.content) {
      return { ok: false, error: "无法识别正文（当前页面可能不是文章页）" };
    }

    var title = article.title || document.title || "";
    var url = location.href;
    // baseUrl lets common.js promote relative src/href to absolute ones — the
    // note has no document of its own to resolve them against, and a relative
    // URL in an IE-rendered note comes out as a res:// URL (Windows error
    // dialog), so nothing relative may survive.
    var stats = { img: 0, imgDropped: 0, link: 0, linkDropped: 0 };
    var bodyHtml = api.sanitize(article.content, { baseUrl: url, stats: stats });
    // The same stats object goes into build() so its final URL net can report
    // anything it had to delete (stats.scrubbed). Expected to stay 0.
    var out = api.build(bodyHtml, title, url, stats);
    out.meta = { scope: "article", chars: out.text.length, urls: stats };
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})();
