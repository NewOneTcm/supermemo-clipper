// Regression suite for the clipper's two extraction modes.
//
// [A] ChatGPT transcript — the case that motivated whole-page mode.
//     Readability is a *single-article* extractor: it scores every paragraph,
//     keeps the highest-scoring node only, and returns that one subtree. On a
//     multi-message page that means the first (longest) reply survives and
//     every later turn is silently dropped. Asserts that article mode still
//     reproduces the truncation (baseline) while full mode returns every turn
//     with nav / composer / script / aria-hidden stripped.
// [B] WeChat article — the case article mode was built for. Guards the
//     <section>→<p> paragraph preservation, lazy data-src promotion and the
//     mmbiz tp=webp strip against the v2.1 sanitize refactor.
//
//   node test/verify-all.js
"use strict";

const { extract } = require("./harness");

const URL = "https://chatgpt.com/c/68f0a1b2-test";
const TITLE = "为什么天空是蓝色的";

const answer1 = `
  <p>天空呈现蓝色，是瑞利散射的结果。瑞利散射描述的是，当光线穿过尺度远小于波长的粒子时，短波长的光会被散射得更强烈。空气分子本身的尺度大约只有零点几纳米，远远小于可见光四五百纳米的波长，正好落在这个范围内，所以阳光穿过大气层时，蓝光被到处弹射，红光则大多直穿而过。</p>
  <p>散射强度和波长的四次方成反比，这个关系由瑞利在十九世纪推导出来。蓝光的波长大约是四百五十纳米，红光大约是七百纳米，两者比值的四次方接近六倍，也就是说蓝光被散射掉的强度大约是红光的六倍上下，这个差距足以让天空明显偏蓝。至于为什么不是紫色，一方面紫光在大气上层就被散射掉了，另一方面人眼对蓝色的敏感度远高于紫色，两个因素叠加，我们看到的就是蓝色。</p>
  <p>还有一点容易误解，天空的蓝色并不是某种物质本身的颜色，它是白光被拆开之后的产物。你在任何方向看到的蓝天，其实都是被散射进你眼睛的光。如果你离开大气层进入太空，抬头就是黑的，因为没有粒子把光散射到你的视线方向。这也是为什么月球上的天空即使在白天也是漆黑的。</p>
  <pre><code>const rayleigh = (w) => 1 / Math.pow(w, 4);</code></pre>
  <ul><li>蓝光波长短，散射强</li><li>红光波长长，散射弱</li></ul>
`;

const answer2 = `
  <p>日落时太阳光穿过的大气层比正午厚得多，蓝光在途中几乎被散射干净，剩下的红光和橙光直接进入你的眼睛，所以天空和太阳附近会呈现暖色。这就是第二个回答的内容。</p>
`;

const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${TITLE}</title>
  <style>.markdown { color: #111; }</style>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="dark">
  <nav role="navigation" aria-label="会话列表">
    <p>侧边栏导航 新对话 历史记录 设置</p>
  </nav>
  <div role="log" class="conversation-scroller">
    <article data-testid="conversation-turn-1">
      <div data-message-author-role="user">
        <div class="markdown"><p>为什么天空是蓝色的？请尽量详细地解释一下背后的物理原理。</p></div>
      </div>
    </article>
    <article data-testid="conversation-turn-2">
      <div data-message-author-role="assistant">
        <div class="markdown">${answer1}</div>
      </div>
    </article>
    <article data-testid="conversation-turn-3">
      <div data-message-author-role="user">
        <div class="markdown"><p>那日落为什么是红色的呢？</p></div>
      </div>
    </article>
    <article data-testid="conversation-turn-4">
      <div data-message-author-role="assistant">
        <div class="markdown">${answer2}</div>
      </div>
    </article>
  </div>
  <form class="composer">
    <textarea placeholder="给 ChatGPT 发送消息"></textarea>
    <button type="submit">发送</button>
  </form>
  <div aria-hidden="true" class="sr-only-helper">装饰性节点不应出现</div>
  <script>window.__SECRET_SOURCE__ = "SHOULD_NOT_APPEAR";</script>
</body>
</html>`;

let failures = 0;

function check(label, condition, detail) {
  console.log((condition ? "  PASS  " : "  FAIL  ") + label + (detail ? "  -> " + detail : ""));
  if (!condition) failures += 1;
}

function run(label, pageHtml, url, mode, title, expectations) {
  console.log("\n[ " + label + " ]");
  const r = extract(pageHtml, url, mode);
  if (!r || !r.ok) {
    check("提取成功", false, r && r.error);
    return null;
  }
  check("提取成功", true);
  if (title) check("标题 = " + title, r.title === title, r.title);
  expectations.must.forEach((needle) => {
    check("包含: " + needle, r.text.includes(needle));
  });
  expectations.mustNot.forEach((needle) => {
    check("不含: " + needle, !r.text.includes(needle));
  });
  console.log("  长度: html " + r.html.length + " 字节 / text " + r.text.length + " 字");
  return r;
}

run("ChatGPT / article mode（对照组：Readability 只拿到一部分）", page, URL, "article", TITLE, {
  must: ["零点几纳米", "月球上的天空"],
  mustNot: ["这就是第二个回答的内容", "SHOULD_NOT_APPEAR"]
});

const chatFull = run("ChatGPT / full mode（应识别为对话页，抓全 4 条）", page, URL, "full", TITLE, {
  must: [
    "零点几纳米",
    "月球上的天空",
    "这就是第二个回答的内容",
    "请尽量详细地解释",
    "那日落为什么是红色的呢",
    "瑞利散射",
    TITLE
  ],
  mustNot: [
    "SHOULD_NOT_APPEAR",
    "侧边栏导航",
    "给 ChatGPT 发送消息",
    "装饰性节点"
  ]
});

if (chatFull) {
  // The scroller carries role="log" (the W3C's own chat-history example). When
  // that role was treated as page chrome, the conversation was deleted whole.
  check("识别为对话页 (meta.scope=chat)", chatFull.meta && chatFull.meta.scope === "chat",
    JSON.stringify(chatFull.meta));
  check("抓到全部 4 条消息", chatFull.meta && chatFull.meta.blocks === 4,
    JSON.stringify(chatFull.meta));
}

const WX_URL = "https://mp.weixin.qq.com/s/wx-test-0001";

const wechatPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>十分钟看懂血糖曲线</title>
  <style>.rich_media_content { font-size: 17px; }</style>
</head>
<body>
  <div class="rich_media">
    <h1 class="rich_media_title">十分钟看懂血糖曲线</h1>
    <div id="js_content" class="rich_media_content" style="visibility:hidden">
      <section style="margin-bottom:20px;">
        <p>很多人拿到动态血糖仪的第一反应，是盯着那条曲线发呆，看到尖峰就紧张，看到平缓就放心。其实曲线的形状比单点数值更有信息量，先学会看形状，再去看数字。</p>
      </section>
      <section style="margin-bottom:20px;">
        <p>餐后尖峰的高度和宽度，主要取决于三件事，吃的顺序，碳水的总量，以及餐后有没有活动。同样的米饭，先吃菜和肉再吃饭，尖峰通常会低一些，也来得更晚一些，这是最容易被忽略的一个杠杆。</p>
      </section>
      <section style="margin-bottom:20px;">
        <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc123/640?wx_fmt=jpeg&amp;tp=webp&amp;wxfrom=5&amp;wx_lazy=1" alt="血糖曲线示例">
        <p>上面这张图是同一个人的两顿晚餐，碳水总量接近，但第一顿先吃菜，第二顿直接吃饭，可以看到尖峰的差异相当明显。曲线不会骗人，它只反映你实际做了什么。</p>
      </section>
      <section style="margin-bottom:20px;">
        <p>还有一个常见的误区，是把餐后两小时的数值当成唯一标准。实际上餐后一小时往往是峰值出现的时间点，只看两小时，会漏掉那次被压平的尖峰，也会漏掉那种延迟出现的尖峰，两者对策略的含义完全不同。</p>
      </section>
      <ul><li>先吃菜，再吃肉，最后吃主食</li><li>餐后二十分钟散步</li></ul>
    </div>
    <div class="rich_media_tool"><button>点赞</button><button>在看</button></div>
  </div>
  <script>var wxAnalytics = "SHOULD_NOT_APPEAR_WX";</script>
</body>
</html>`;

const wx = run("WeChat article / article mode", wechatPage, WX_URL, "article", null, {
  must: ["餐后尖峰的高度和宽度", "先吃菜，再吃肉，最后吃主食"],
  mustNot: ["SHOULD_NOT_APPEAR_WX"]
});

if (wx) {
  const imgs = (wx.html.match(/<img[^>]*src="([^"]+)"/g) || []);
  check("lazy 图已从 data-src 提升出 src", imgs.length === 1, imgs[0]);
  check("mmbiz 的 tp=webp 已剥离", imgs.length === 1 && !/tp=webp/.test(imgs[0]), imgs[0]);
  const pCount = (wx.html.match(/<p[>\s]/g) || []).length;
  check("section 已拆成多个 <p>（段落没塌成一块）", pCount >= 4, "p=" + pCount);
  // Readability emits <div><section><p>…</p></section></div>; converting both
  // wrappers used to yield illegal <p><p>…</p></p>. The browser silently
  // un-nests it, so this can only be caught here.
  check("没有嵌套 <p>（非法 HTML）", !/<p[^>]*>\s*<p[\s>]/i.test(wx.html));
  check("没有残留的 section/div 包裹", !/<(section|div)[\s>]/i.test(wx.html));
}

const wxFull = run("WeChat article / full mode", wechatPage, WX_URL, "full", null, {
  must: ["餐后尖峰的高度和宽度", "先吃菜，再吃肉，最后吃主食"],
  mustNot: ["SHOULD_NOT_APPEAR_WX"]
});

if (wxFull) {
  // No message blocks here, so full mode must fall back to the whole page.
  check("非对话页走整页路径 (meta.scope=page)",
    wxFull.meta && wxFull.meta.scope === "page", JSON.stringify(wxFull.meta));
  check("整页路径下 0 条消息块", wxFull.meta && wxFull.meta.blocks === 0,
    JSON.stringify(wxFull.meta));
}

// [C] URL hygiene — the "How do you want to open this 'res' link?" dialog.
//     SuperMemo renders notes in an IE component, which punts schemes it cannot
//     handle to ShellExecute. res:// is the IE-internal resource scheme, so a
//     single <img src="res://…"> in the page is enough to pop a Windows dialog
//     on paste. Relative paths are broken too (a note has no base document).
const URL_PAGE_URL = "https://example.com/posts/url-test";

const urlPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>URL 卫生</title></head>
<body>
  <div class="post">
    <p>这一段正文要足够长，才能让整页模式把它当成真正的段落留下来。继续补一些无害的文字，让这段内容看起来像一篇正常的长文章，而不是页面上可有可无的一行提示。</p>
    <img src="res://ieframe.dll/http_404.htm" alt="IE 内部资源">
    <img src="javascript:alert(1)" alt="脚本">
    <img src="blob:https://example.com/deadbeef" alt="Blob">
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="内联图">
    <img src="/assets/relative.png" alt="相对路径">
    <img alt="没有 src">
    <p><a href="res://ieframe.dll/dnserrordiagoff.htm">诊断链接</a></p>
    <p><a href="javascript:void(0)">脚本链接</a></p>
    <p><a href="/help/index.html">站内链接</a></p>
    <p><a href="https://example.com/ok">正常链接</a></p>
    <p><a href="#top">页内锚点</a></p>
  </div>
</body></html>`;

const hygiene = run("URL 卫生 / full mode", urlPage, URL_PAGE_URL, "full", "URL 卫生", {
  must: ["这一段正文要足够长", "正常链接"],
  mustNot: ["SHOULD_NOT_APPEAR"]
});

if (hygiene) {
  check("res:// 一律清除", !/res:\/\//i.test(hygiene.html));
  check("javascript: 一律清除", !/javascript:/i.test(hygiene.html));
  check("blob: 一律清除", !/blob:/i.test(hygiene.html));
  check("无 src 的 img 被丢弃", !/<img(?![^>]*\bsrc=)/i.test(hygiene.html));
  check("内联 data:image 保留",
    /src="data:image\/png;base64,/i.test(hygiene.html));
  check("相对图片路径补成绝对",
    /src="https:\/\/example\.com\/assets\/relative\.png"/i.test(hygiene.html),
    (hygiene.html.match(/<img[^>]*>/g) || []).join(" "));
  check("相对链接补成绝对",
    /href="https:\/\/example\.com\/help\/index\.html"/i.test(hygiene.html));
  check("绝对链接原样保留",
    /href="https:\/\/example\.com\/ok"/i.test(hygiene.html));
  check("页内锚点保留", /href="#top"/i.test(hygiene.html));
  const imgCount = (hygiene.html.match(/<img[^>]*>/g) || []).length;
  check("只剩 2 张可用图片（内联 + 相对路径）", imgCount === 2, "img=" + imgCount);
}

console.log("\n" + (failures ? failures + " check(s) FAILED" : "all checks passed"));
process.exit(failures ? 1 : 0);
