// Content script: runs after lib/Readability.js in the target page.
// Clones the document, extracts the article with Readability, sanitizes the
// HTML down to a small whitelist, and returns title / url / html / text.
(function () {
  "use strict";

  if (typeof Readability !== "function") {
    return { ok: false, error: "Readability 未加载" };
  }

  var ALLOWED_TAGS = new Set([
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
    "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
    "strong", "em", "b", "i", "u", "s", "sup", "sub", "br", "hr", "img", "a"
  ]);
  // Disallowed but block-level tags (WeChat wraps every paragraph in
  // <section>): convert to <p> instead of unwrapping, or paragraph breaks
  // disappear and the article collapses into one blob of text.
  var BLOCK_FALLBACK = new Set([
    "section", "div", "article", "main", "aside", "header", "footer",
    "figure", "figcaption", "nav", "center", "details", "summary", "caption"
  ]);
  var GLOBAL_ATTRS = new Set([]);
  var TAG_ATTRS = {
    a: new Set(["href"]),
    img: new Set(["src", "alt"]),
    td: new Set(["colspan", "rowspan"]),
    th: new Set(["colspan", "rowspan"])
  };

  function sanitize(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    var toRemove = [], toConvert = [];
    var node;
    while ((node = walker.nextNode())) {
      var tag = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        if (BLOCK_FALLBACK.has(tag)) toConvert.push(node);
        else toRemove.push(node);
        continue;
      }
      // Lazy-loaded images (e.g. WeChat) carry the real URL in data-src.
      if (tag === "img" && !node.getAttribute("src")) {
        var dataSrc = node.getAttribute("data-src");
        if (dataSrc && /^https?:/i.test(dataSrc)) node.setAttribute("src", dataSrc);
      }
      // Strip every attribute except the whitelisted ones.
      var allowed = TAG_ATTRS[tag] || GLOBAL_ATTRS;
      for (var i = node.attributes.length - 1; i >= 0; i--) {
        var attr = node.attributes[i];
        if (!allowed.has(attr.name)) node.removeAttribute(attr.name);
      }
      if (tag === "a") {
        var href = node.getAttribute("href") || "";
        if (/^\s*javascript:/i.test(href)) node.removeAttribute("href");
      }
      if (tag === "img") {
        var src = node.getAttribute("src") || "";
        if (/^\s*(javascript|data):/i.test(src)) toRemove.push(node);
      }
    }
    // Rewrite block-level tags to <p>, then unwrap inline disallowed tags
    // while keeping their inner text/HTML.
    toConvert.forEach(function (el) {
      var parent = el.parentNode;
      if (!parent) return;
      var p = doc.createElement("p");
      while (el.firstChild) p.appendChild(el.firstChild);
      parent.replaceChild(p, el);
    });
    toRemove.forEach(function (el) {
      var parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    return doc.body.innerHTML;
  }

  function htmlToText(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    // Add breathing room around block elements before reading textContent.
    doc.querySelectorAll("p,div,br,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre,hr")
      .forEach(function (el) { el.append("\n"); });
    return doc.body.textContent
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function refDate() {
    var d = new Date();
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() +
      ", " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  try {
    var article = new Readability(document.cloneNode(true)).parse();
    if (!article || !article.content) {
      return { ok: false, error: "无法识别正文（当前页面可能不是文章页）" };
    }

    var title = article.title || document.title || "";
    var url = location.href;
    var bodyHtml = sanitize(article.content);

    var html =
      "<h1>" + escapeHtml(title) + "</h1>" +
      bodyHtml +
      "<p></p><hr><p></p>" +
      '<span class="Reference">' +
      "#SuperMemo Reference:" +
      "<p></p>" +
      "#Title: " + escapeHtml(title) +
      "</br>" +
      "#Date: Imported on " + refDate() +
      "</br>" +
      "#Source: Web import" +
      "</br>" +
      "#Link: " + escapeHtml(url) +
      "</span>";

    var text =
      title + "\n" + url + "\n\n" + htmlToText(bodyHtml) +
      "\n\n#SuperMemo Reference:\n\n" +
      "#Title: " + title + "\n" +
      "#Date: Imported on " + refDate() + "\n" +
      "#Source: Web import\n" +
      "#Link: " + url;

    return { ok: true, title: title, url: url, html: html, text: text };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }
})();
