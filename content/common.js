// Shared helpers for the clipper's two extraction modes.
// Injected before content/extract.js (Readability article mode) or
// content/extract-full.js (whole-page mode), so both produce an identical
// payload shape for popup/popup.js.
(function () {
  "use strict";

  if (window.__smClip) return;

  var ALLOWED_TAGS = new Set([
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
    "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
    "strong", "em", "b", "i", "u", "s", "sup", "sub", "br", "hr", "img", "a"
  ]);

  // Disallowed but block-level: convert to <p> instead of unwrapping, or
  // paragraph breaks disappear and WeChat's <section>-wrapped article
  // collapses into one blob of text.
  var BLOCK_FALLBACK = new Set([
    "section", "div", "article", "main", "aside", "header", "footer",
    "figure", "figcaption", "nav", "center", "details", "summary", "caption"
  ]);

  // Dropped together with their subtree. sanitize() normally *unwraps*
  // disallowed tags (keeps the inner text), which is correct for <span> but
  // disastrous for <script>/<style> — their source code would land in the
  // note. Readability's output rarely contains these; whole-page mode always
  // does, so this set is what makes full-page mode safe.
  var DROP_TAGS = new Set([
    "script", "style", "noscript", "template", "iframe", "frame", "frameset",
    "object", "embed", "applet", "canvas", "svg", "math", "map", "area",
    "audio", "video", "source", "track",
    "head", "meta", "link", "base", "title", "slot",
    "button", "input", "select", "option", "optgroup", "textarea",
    "form", "fieldset", "legend", "datalist", "output", "dialog"
  ]);

  // Block-level tags, used to decide whether a container being converted to
  // <p> already carries its own paragraph boundary. Readability routinely
  // emits <div><section><p>…</p></section></div>: converting both wrappers
  // blindly produces illegal <p><p>…</p></p>, which the browser then has to
  // silently un-nest. Only wrap when the element has NO block child of its own.
  var BLOCK_TAGS = new Set([
    "p", "div", "section", "article", "main", "aside", "header", "footer",
    "nav", "center", "figure", "figcaption", "details", "summary", "caption",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tr", "td", "th",
    "blockquote", "pre", "hr", "form", "fieldset"
  ]);

  // Page chrome, removed only in whole-page mode (article mode already got
  // rid of it via Readability).
  //
  // Deliberately narrow. role="log" is OUT: the W3C's own chat-history example
  // uses it, so treating it as chrome deletes the entire conversation.
  // role="feed"/"article" stay out for the same reason.
  var CHROME_TAGS = new Set(["header", "footer", "nav", "aside", "menu"]);
  var CHROME_ROLES = new Set([
    "banner", "navigation", "contentinfo", "search", "complementary",
    "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist", "tab",
    "status", "alert"
  ]);

  var GLOBAL_ATTRS = new Set([]);
  var TAG_ATTRS = {
    a: new Set(["href"]),
    img: new Set(["src", "alt"]),
    td: new Set(["colspan", "rowspan"]),
    th: new Set(["colspan", "rowspan"])
  };

  // Container tags that carry no meaning once empty.
  var PRUNE_SELECTOR =
    "p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,table,thead,tbody";

  // URL hygiene. SuperMemo renders the note in an IE component (mshtml +
  // ieframe + urlmon), and that engine hands schemes it cannot handle to
  // ShellExecute — which is what pops Windows' "How do you want to open this
  // 'res' link?" dialog. res:// is the IE-internal resource scheme; ms-*,
  // search-ms:, blob: and friends behave the same way.
  //
  // Relative URLs are just as broken for a different reason: the note has no
  // document of its own, so a path like /assets/x.png resolves against
  // nothing. So every URL is either safe AND absolute, or it goes away.
  var SAFE_IMG_SRC = /^https?:\/\//i;
  var SAFE_IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
  var SAFE_HREF = /^(https?|ftp|mailto):/i;

  function isAllowedUrl(s, kind) {
    if (kind === "img") return SAFE_IMG_SRC.test(s) || SAFE_IMG_DATA.test(s);
    return SAFE_HREF.test(s);
  }

  // Returns "" when the URL cannot be safely handed to SuperMemo.
  function resolveUrl(raw, baseUrl, kind) {
    var s = (raw || "").trim();
    if (!s) return "";
    if (kind === "link" && s.charAt(0) === "#") return s; // in-page anchor

    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      // Has an explicit scheme (res://, javascript:, blob:, ms-...): keep only
      // the ones we vetted.
      return isAllowedUrl(s, kind) ? s : "";
    }
    if (!baseUrl) return "";
    try {
      // Handles //host/x, /x and x alike.
      var abs = new URL(s, baseUrl).href;
      return isAllowedUrl(abs, kind) ? abs : "";
    } catch (_) {
      return "";
    }
  }

  function sanitize(html, opts) {
    opts = opts || {};
    var dropChrome = !!opts.dropChrome;
    var baseUrl = opts.baseUrl || "";
    var doc = new DOMParser().parseFromString(html, "text/html");
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    var toRemove = [], toConvert = [], toDrop = [];
    var node;

    while ((node = walker.nextNode())) {
      var tag = node.tagName.toLowerCase();

      if (DROP_TAGS.has(tag)) {
        toDrop.push(node);
        continue;
      }
      if (dropChrome) {
        var role = (node.getAttribute("role") || "").toLowerCase();
        if (CHROME_TAGS.has(tag) ||
            CHROME_ROLES.has(role) ||
            node.getAttribute("aria-hidden") === "true") {
          toDrop.push(node);
          continue;
        }
      }
      if (!ALLOWED_TAGS.has(tag)) {
        if (BLOCK_FALLBACK.has(tag)) toConvert.push(node);
        else toRemove.push(node);
        continue;
      }

      if (tag === "img") {
        // Lazy-loaded images (e.g. WeChat) carry the real URL elsewhere.
        if (!node.getAttribute("src")) {
          var lazy = node.getAttribute("data-src") ||
                     node.getAttribute("data-original") ||
                     node.getAttribute("data-actualsrc");
          if (lazy) node.setAttribute("src", lazy);
        }
        var src = resolveUrl(node.getAttribute("src") || "", baseUrl, "img");
        if (!src) {
          // No usable source: an <img> with nothing to show is just a broken
          // box (or, with a scheme like res://, a Windows error dialog).
          toDrop.push(node);
          continue;
        }
        node.setAttribute("src", src);
        // WeChat CDN: with tp=webp the server returns WebP, which SuperMemo's
        // IE-based HTML renderer cannot display. Strip the format-override and
        // lazy-load params so a plain JPEG/PNG is served instead.
        if (/^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(src)) {
          try {
            var u = new URL(src);
            u.searchParams.delete("tp");
            u.searchParams.delete("wxfrom");
            u.searchParams.delete("wx_lazy");
            u.hash = "";
            node.setAttribute("src", u.toString());
          } catch (_) { /* keep original src on parse failure */ }
        }
      }

      // Strip every attribute except the whitelisted ones. Must happen after
      // the lazy-src promotion above, or data-src would already be gone.
      var allowed = TAG_ATTRS[tag] || GLOBAL_ATTRS;
      for (var i = node.attributes.length - 1; i >= 0; i--) {
        var attr = node.attributes[i];
        if (!allowed.has(attr.name)) node.removeAttribute(attr.name);
      }
      if (tag === "a") {
        var href = resolveUrl(node.getAttribute("href") || "", baseUrl, "link");
        if (href) node.setAttribute("href", href);
        else node.removeAttribute("href");
      }
    }

    // Drop whole subtrees first: a removed parent takes its queued
    // descendants with it, and the parentNode guards below keep the later
    // passes from touching detached nodes.
    toDrop.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });

    // Block-level wrappers, deepest first. Going backwards matters: each pass
    // hoists block children out, so by the time a parent is handled its
    // children are either already lifted or already <p>. Handling parents
    // first would move children past the TreeWalker's cursor and leave them
    // unprocessed (raw <section> in the output).
    for (var c = toConvert.length - 1; c >= 0; c--) {
      flattenBlockWrapper(toConvert[c], doc);
    }

    // Finally unwrap leftover inline disallowed tags, keeping their content.
    toRemove.forEach(unwrap);

    pruneEmpty(doc);
    return doc.body.innerHTML;
  }

  // Turn a block-level wrapper (div/section/...) into a real paragraph, or
  // drop it, without ever creating <p><p>…</p></p>. Block children carry their
  // own boundary, so they are lifted out first; whatever inline content is
  // left is the actual paragraph and gets wrapped.
  function flattenBlockWrapper(el, doc) {
    var parent = el.parentNode;
    if (!parent) return;

    var hasBlock = false;
    Array.prototype.slice.call(el.childNodes).forEach(function (child) {
      if (child.nodeType === 1 && BLOCK_TAGS.has(child.tagName.toLowerCase())) {
        parent.insertBefore(child, el);
        hasBlock = true;
      }
    });

    var hasInline = !!el.textContent.trim() || !!el.querySelector("img");
    if (!hasInline) {
      el.parentNode.removeChild(el);
      return;
    }
    if (hasBlock) {
      // Pure container: its paragraphs already exist, don't add a phantom one.
      unwrap(el);
      return;
    }

    var p = doc.createElement("p");
    while (el.firstChild) p.appendChild(el.firstChild);
    parent.replaceChild(p, el);
  }

  function unwrap(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function pruneEmpty(doc) {
    var nodes = doc.body.querySelectorAll(PRUNE_SELECTOR);
    // Backwards: removing a parent first would leave its queued children
    // detached, and we would be pruning nodes nobody can see anyway.
    for (var i = nodes.length - 1; i >= 0; i--) {
      var el = nodes[i];
      if (el.querySelector("img")) continue;
      if (el.textContent.trim()) continue;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }

  function build(bodyHtml, title, url) {
    title = title || "";
    url = url || "";
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
  }

  window.__smClip = {
    sanitize: sanitize,
    pruneEmpty: pruneEmpty,
    htmlToText: htmlToText,
    build: build
  };
})();
