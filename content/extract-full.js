// Whole-page mode: runs after content/common.js (Readability is not needed).
//
// Built for pages Readability cannot handle — chat transcripts (ChatGPT,
// Claude, Gemini), forums, dashboards, anything where the "article" is spread
// across many sibling blocks instead of one container.
//
// Two paths:
//   1. Chat page recognised -> collect the message blocks directly. These live
//      in a scroll container mixed with sidebars, headers and a composer, so
//      reading only the blocks gives the full conversation with no page noise.
//   2. Anything else -> the entire <body>, with page chrome stripped by
//      common.js (scripts, styles, nav/header/footer, form controls, dialogs,
//      aria-hidden nodes).
(function () {
  "use strict";

  var api = window.__smClip;
  if (!api) return { ok: false, error: "清洗模块未加载（content/common.js）" };
  if (!document.body) return { ok: false, error: "页面没有 body" };

  // Ordered most-specific first. [data-message-author-role] is the tightest
  // (it wraps exactly one message body); conversation-turn adds the surrounding
  // <article>; the custom elements cover Gemini.
  var MESSAGE_SELECTORS = [
    "[data-message-author-role]",
    '[data-testid^="conversation-turn"]',
    "user-query, model-response"
  ];

  function chatBlocks() {
    for (var i = 0; i < MESSAGE_SELECTORS.length; i++) {
      var found = document.querySelectorAll(MESSAGE_SELECTORS[i]);
      // A single match is just page furniture. A conversation has at least a
      // question and an answer.
      if (found.length >= 2) return Array.prototype.slice.call(found);
    }
    return null;
  }

  try {
    var title = document.title || "";
    var url = location.href;
    var blocks = chatBlocks();
    var holder;

    if (blocks) {
      // Detach-clone each turn into one container so sanitize sees a single
      // flat list instead of the surrounding layout.
      holder = document.createElement("div");
      blocks.forEach(function (el) {
        holder.appendChild(el.cloneNode(true));
      });
    } else {
      // Clone before reading innerHTML so nothing we do can touch the page.
      holder = document.body.cloneNode(true);
    }

    var bodyHtml = api.sanitize(holder.innerHTML, {
      dropChrome: true,
      baseUrl: url
    });
    var out = api.build(bodyHtml, title, url);
    out.meta = {
      scope: blocks ? "chat" : "page",
      blocks: blocks ? blocks.length : 0,
      chars: out.text.length
    };
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})();
