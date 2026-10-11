# SuperMemo Clipper v2

浏览器扩展（Chrome / Edge，Manifest V3）：点一下工具栏图标，选好模式再点「提取」，它就会清理当前网页的广告和无关格式，保留**标题 + 网址 + 正文**，然后**自动切到 SuperMemo、发一次 `Ctrl+N`——新建条目并从剪贴板粘贴，一步完成**。

popup 打开时**不会**碰页面，只有你点了「提取」才动手——避免选错模式时在 SuperMemo 里留下一堆半成品条目。

支持两种提取模式，**按站点记忆**：文章页走 Readability 正文识别，ChatGPT 这类多轮对话走全页导出。

v2 与 v1（`supermemo-clipper`）完全独立：独立的扩展目录、独立的 native host 名（`com.supermemo.paster.v2`），两个版本可以同时装着互不影响。

## 两种提取模式

点图标打开 popup —— **此时不会提取任何东西**。选好模式，再点「提取…并粘贴到 SuperMemo」按钮，才开始：

| | 正文模式（默认） | 全页模式 |
|---|---|---|
| 引擎 | Mozilla Readability | 直接读 DOM |
| 适合 | 公众号、博客、新闻等单篇正文页 | ChatGPT / 论坛 / 仪表盘等多块内容页 |
| 抓取范围 | Readability 认定的那一个正文节点 | 对话页只取消息块；其他页面取整个 `<body>` |
| 清洗 | 白名单标签 + 去广告侧栏 | 同样白名单，另去掉导航/页头页脚/表单/弹窗/`aria-hidden` 节点 |

模式选择**按 hostname 记忆**（存在 `chrome.storage.local`），下次访问同一站点会自动沿用：ChatGPT 保持全页、公众号保持正文，不用每次重选。切换模式本身不会触发提取，只是改记忆。

**为什么要有全页模式**：Readability 是「单篇文章提取器」——它给每个段落打分，只保留得分最高的那一个节点。在 ChatGPT 页面上，那条得分最高的是**最长的那个回答**，于是其余回答全被丢掉，表现出来就是「只抓到了第一个回答」。全页模式不做这种取舍。

**全页模式怎么保证抓全对话**：
1. **先定位对话页**：页面上若存在 ≥2 个 `[data-message-author-role]`（ChatGPT）、`[data-testid^="conversation-turn"]` 或 `user-query`/`model-response`（Gemini）元素，就认定是对话页，**只取这些消息块**——既拿到全部轮次，又天然避开侧边栏和输入框。
2. **再补历史消息**：对话页早期消息可能是懒加载的。提取前会先把滚动容器滚到顶部、循环等待直到消息数量不再增长（上限 4 秒），让全部历史进入 DOM 再读。非对话页跳过这一步。
3. 找不到消息块就退化为整页导出，和普通网页一视同仁。

**自动兜底**：正文模式若识别失败（返回「无法识别正文」，常见于画布/播放器类站点），会自动改用全页模式重试一次，并把该站点记成全页模式。

## 与 v1 的区别

- **自动新建条目**：v1 只发 Ctrl+V（会粘贴进当前元素）；v2 发 Ctrl+N（SuperMemo 的「Add a new article」），由 SuperMemo 自己新建元素并读剪贴板完成粘贴——和手动剪藏网页是同一个动作。
- **进程级检测**：先查 `sm*.exe` 进程，SuperMemo 没开直接报「未运行」，不再靠窗口标题瞎猜。
- **激活可靠性**：`SendKeys` 只认「当前前台窗口」，而宿主是被 Chrome 在后台拉起来的——Windows 的前台锁会拒绝它，`SetForegroundWindow` 被降级成**任务栏闪一下**，按键就落到了 Chrome 手里（症状：SuperMemo 闪一下，什么都没粘上）。v2 用 `AttachThreadInput` 接管输入队列真正抢到前台，**抢到之后还要用 `GetForegroundWindow` 验证确实握在手里才发键**，抢不到就明说抢不到、不再假装粘贴成功。
- **状态可读**：popup 明确区分各种结果——已新建并粘贴（并回显**「收件窗口」**，即发键瞬间前台是谁）/ SuperMemo 未运行（剪贴板已备好）/ 没能切到前台（并报出当前前台是谁）/ 剪贴板为空 / native host 未注册。
- **一键诊断**：popup 右下角「诊断」按钮，不发按键、不新建条目，直接告诉你剪贴板里有什么、SuperMemo 起了几个窗口、**能不能从 Chrome 手里接管前台**，以及宿主上一次真正执行时记录到的实况。

## 工作原理

1. 点「提取」后向当前页面注入内容脚本：
   - **正文模式**：先注入 [Mozilla Readability.js](https://github.com/mozilla/readability)（Firefox 阅读模式同款引擎）识别并抽取正文，自动去掉广告、侧栏、导航、弹窗等。
   - **全页模式**：跳过 Readability。先判定是否为对话页（是则只取消息块），否则取整个 `<body>`；再删掉脚本样式、导航页头页脚、表单控件、弹窗和 `aria-hidden` 节点。
2. 对结果做二次清洗：只保留白名单标签（段落、标题、列表、表格、引用、图片、链接等），剥掉所有 style/class/事件属性，并把 `div`/`section` 这类容器拍平成真正的 `<p>`（不会产生非法的 `<p><p>` 嵌套），顺带清掉空容器。**每一条 URL 都必须既安全又是绝对地址**：协议白名单只放行 `http(s)` / `ftp` / `mailto` / 内联 `data:image`，其余（`res:`、`javascript:`、`blob:`、`ms-*` 等）一律清掉（图片整张丢弃，链接只去掉 `href`、保留文字）；剩下的一律用页面地址补成绝对地址，**连 `#锚点` 也补**——笔记里只要有一条相对地址，SuperMemo 就会弹窗（原因见下面「已知边界」）。
3. 组装成 `<h1>标题</h1> + 来源链接 + <hr> + 正文` 的干净 HTML，同时生成纯文本版本，以 `text/html` + `text/plain` 两种格式写入剪贴板。
4. 通过 native messaging 调起 `native\paste.ps1`，并把**当前页地址**一起送过去：查进程 -> 校验剪贴板非空 -> **抢 SuperMemo 的前台并验证确实抢到了**（抢不到就如实报错，不假装粘贴）-> **把剪贴板 CF_HTML 的 `SourceURL` 从扩展 popup 地址改写成网页地址**（`native/cfhtml.ps1`，字节级改写 + 回读校验，失败就跳过）-> 发 `Ctrl+N`（SuperMemo 的 `Edit : Add a new article`：新建元素并粘贴剪贴板）-> 记录发键瞬间与发键之后前台窗口是谁、SuperMemo 窗口数有没有变化、来源地址改写前后的值。popup 会顺带回显这次抓了多少（如「12 条消息 · 8432 字 · 图 2 · 链 23」），方便判断是否抓全；若有链接因为 URL 不可用被丢弃，会再带上「丢弃 N 个无效链接」；改写过来源地址会显示「来源地址已修正」；右下角还显示扩展版本号，方便确认 Chrome 到底在跑哪一份代码。

## 自动粘贴没生效怎么办

先点 popup 右下角的**「诊断」**（不发按键、不新建条目），它会直接给出三件事：

- **剪贴板**：多少字、带不带 `HTML Format` 格式。若字数为 0，说明写剪贴板那一步就没成功。
- **SuperMemo**：进程名/pid、有几个可见顶层窗口。若显示「没有运行」，那是进程没起来。
- **剪贴板来源地址（SourceURL）**：现在是什么、粘贴前会被改成什么。这一行指向 `chrome-extension://…/popup/popup.html` 时，就是弹 `res://` 对话框的根因（见「已知边界」）。
- **能不能从 Chrome 手里接管前台**：显示「不可以」时，这句话就是粘贴失败的原因本身（`SendKeys` 的按键没人接收）。
- 最后还附上**宿主上一次真正执行时记录的实况**（发键瞬间/之后的前台窗口、窗口数变化、来源地址改写结果、结果），存在 `%TEMP%\supermemo-clipper-last.json`，从 popup 关掉也不影响。

如果诊断说「可以接管前台」但你仍然什么都没粘上，把诊断面板的最后一段连同 SuperMemo 的窗口标题一并发出来即可定位。

**为什么需要这个按钮**：popup 在 SuperMemo 抢到焦点的那一刻就会被 Chrome 自动关掉，所以运行结果根本来不及显示。真正可靠的凭证写在宿主那侧，靠这个按钮取回。

## 配置方法（完整流程）

### 1. 获取代码

```powershell
git clone https://github.com/NewOneTcm/supermemo-clipper.git
cd supermemo-clipper
```

也可以直接点 GitHub 页面的 Code -> Download ZIP 解压。

### 2. 加载扩展

1. 打开 Chrome/Edge，地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择刚克隆/解压的文件夹
4. 把扩展固定到工具栏（拼图图标 -> 图钉）

### 3. 注册 native host（一次性，自动粘贴必需）

1. 在 `chrome://extensions` 页面复制本扩展的 **ID**（一串字母）
2. PowerShell 运行（路径换成你实际的克隆位置）：
   ```powershell
   cd <仓库目录>\native
   .\install.ps1 -ExtensionId 你的扩展ID
   ```
   脚本会自动做三件事：把扩展 ID 写入 `allowed_origins`、把 `path` 改成本机实际的 `host.bat` 绝对路径（克隆到任何目录都能用）、写入 Chrome 和 Edge 的注册表项。
3. 重启浏览器。

> 注意：之后如果**移动了仓库文件夹**，需要重跑一次 install.ps1，让注册表里的路径指向新位置。

不注册也能用：popup 会提示「native host 未注册」，内容照常进剪贴板，手动切到 SuperMemo 粘贴即可。

### 4. 日常使用

- 打开文章页 -> 点扩展图标 -> 完事。SuperMemo 里已经出现一个排版干净的新条目。
- SuperMemo 未运行时点击：内容在剪贴板里，打开 SuperMemo 后按 **Ctrl+N** 即可（这就是 SuperMemo 的「从剪贴板添加文章」），不会丢。
- 之后照常增量阅读：Alt+X 摘录、Alt+Z 挖空。

## 文件结构

```
supermemo-clipper-v2/
  manifest.json            扩展清单 (MV3)，v2.3.0
  background.js            MV3 service worker（占位，逻辑全在 popup）
  popup/popup.html|.js     模式选择 + 提取 + 复制 + 调 native host（带 pageUrl）+ 状态回显（含来源地址修正、收件窗口、版本号）+ 诊断面板
  content/common.js        共享清洗与组装（白名单、去脚本样式、去注释、容器拍平、URL 协议白名单 + 全部绝对化、空容器清理、成稿兜底 URL 网）
  content/extract.js       正文模式：Readability 抽取
  content/extract-full.js  全页模式：整个 body 导出
  lib/Readability.js       Mozilla 正文识别引擎
  native/                  自动粘贴 host（一次性注册）
    com.supermemo.paster.v2.json   host 清单（install.ps1 会写入扩展 ID）
    host.bat               Chrome 调起的入口
    paste.ps1              进程检测 -> 剪贴板校验 -> 抢前台并验证 -> 改写剪贴板来源地址 -> Ctrl+N -> 记录实况
    cfhtml.ps1             CF_HTML 字节级手术：把 SourceURL 从扩展 popup 改成网页地址（见下）
    fghelper.cs            前台接管 + 原始剪贴板读写（P/Invoke，会被预编译缓存，见下）
    install.ps1            注册到注册表（Chrome/Edge）
    dump-clipboard.ps1     取证工具：把当前剪贴板里的 CF_HTML 逐项打出来（排查 res:// 用）
  test/                    开发自测（不随扩展发布）
    harness.js             jsdom 跑真实内容脚本的测试脚手架
    verify-all.js          提取回归：ChatGPT 双模式 + 微信双模式 + URL 卫生 + 相对地址复现页 + 条件注释 + 兜底 URL 网
    verify-popup.js        popup 逻辑：模式选择、站点记忆、自动回退、状态回显、native 消息契约、诊断面板
    verify-wechat.js       拿保存下来的真实微信页面跑正文模式
    verify-img.js          检查微信图片 tp=webp 是否已剥离
    inspect-live.js        用系统 Chrome 打开线上页面，跑真实内容脚本并报告残留 URL
    host-probe.js          按真实 native messaging 协议直接跑宿主（默认只诊断，不落按键）
    url-forensics.js       敌意页面扫描：把几十种 URL 载体喂进真实提取器，逐属性审计输出里有没有非绝对 URL
    cfhtml-roundtrip.ps1   对真实剪贴板做 SourceURL 改写往返测试：断言笔记字节完全不变
  icons/                   扩展图标
```

宿主的速度：`fghelper.cs` 在第一次运行时会被编译到 `%LOCALAPPDATA%\SuperMemoClipper\fghelper-<源文件哈希>.dll`，之后每次只加载现成程序集。这台机器实测——PowerShell 自身启动 ~1.4s，现场编译那段 C# 还要 +1.8s，加载现成 dll 只要 +0.25s。缓存按**源文件哈希**命名，改了 `fghelper.cs` 会自动失效重建。

自测（需要 `jsdom`，本仓库直接复用上级目录 `D:\develop\node_modules`）：

```powershell
$env:NODE_PATH="D:\develop\node_modules"
node test\verify-all.js                       # 提取回归，退出码 0 表示全过
node test\verify-popup.js                     # popup 交互逻辑（含 native 各返回分支与诊断面板）
node test\url-forensics.js                    # 敌意页面：逐属性审计输出里有没有非绝对 URL
node test\host-probe.js                       # 按真实协议跑宿主，默认 diagnose：不发按键、不建条目
node test\host-probe.js new_and_paste "https://example.com/p" "2.3.0"   # 真发一次 Ctrl+N（会建条目，谨慎）
node test\verify-wechat.js saved-page.html    # 用真实页面验证正文模式
node test\verify-img.js saved-page.html       # 用真实页面验证 tp=webp 已剥离
node test\inspect-live.js "https://…"         # 线上页面体检（需系统装有 Chrome/Edge）
powershell -ExecutionPolicy Bypass -File test\cfhtml-roundtrip.ps1   # 对真实剪贴板做 SourceURL 往返测试
powershell -ExecutionPolicy Bypass -File native\dump-clipboard.ps1  # 看剪贴板里到底有什么（含 SourceURL）
```

`cfhtml-roundtrip.ps1` 会先把当前剪贴板备份到 `%TEMP%\supermemo-clipper-clipboard-backup.bin`，再改写它的 SourceURL，然后逐字节比对笔记内容；只要笔记有一个字节变了就自动还原并报失败。改 `cfhtml.ps1` 之后跑一遍它，是改动这个「会动用户剪贴板」的代码的唯一保险。

`host-probe.js` 用和 Chrome 完全相同的格式（4 字节小端长度头 + UTF-8 JSON）跟宿主对话，所以能在不开浏览器的情况下验证「进程检测 / 剪贴板预检 / 能否抢前台 / 发键之后世界变成什么样」，是排查自动粘贴问题时最省事的一层。

`inspect-live.js` 专治「本地 curl 拿到的 HTML 和插件看到的根本不是一回事」：它用系统 Chrome 打开页面、等前端渲染完，再把 `content/common.js` + `content/extract-full.js` 真正注入进去跑一遍，然后把渲染后的 DOM 和提取结果存到 `test/saved/`，并列出所有残留的 `href`/`src`。排查「笔记在 SuperMemo 里出问题」时，先看它报的 URL 列表里有没有相对地址即可定性。

## 已知边界

- `chrome://`、扩展商店、PDF 查看器等页面浏览器不允许注入脚本，会提示不支持。
- 正文在画布/播放器里的站点（视频字幕页、部分小说站）Readability 可能识别失败——会自动回退到全页模式。
- 全页模式只能读到「DOM 里已经渲染出来的内容」。对话页会在提取前自动滚到顶部，循环等待懒加载的历史进入 DOM（上限 4 秒）；若对话极长、4 秒内没加载完，仍可能缺早期消息——可以先手动往上滚一遍再点提取。
- 对话识别只认三种标记（`[data-message-author-role]`、`[data-testid^="conversation-turn"]`、`user-query`/`model-response`）。站点改版换了标记就会退化为整页导出（内容不会丢，只是会带上侧边栏等界面文字）。
- 全页模式会尽量按结构剔除界面元素（导航、页头页脚、表单、弹窗、`aria-hidden` 节点），但不保证百分百干净——内容页请优先用正文模式。
- 图片保留的是原站链接引用，不是把图片文件存进 SuperMemo；原图挂了 SuperMemo 里也会裂图。
- 自动粘贴靠模拟 `Ctrl+N`（SuperMemo 的 `Edit : Add a new article`：新建元素 + 读剪贴板粘贴，一步完成），而 `SendKeys` 只认**当前前台窗口**。宿主由 Chrome 在后台拉起，Windows 的前台锁会拒绝它，`SetForegroundWindow` 于是被降级成任务栏闪一下——症状就是**「SuperMemo 只是闪了一下，什么都没粘上」**。v2.2.4 起用 `AttachThreadInput` 真正接管输入队列，并且**验证确实拿到前台之后才发键**；验证失败会明确报「没能把 SuperMemo 切到前台（当前前台是 X…）」，而不是假装成功。无论哪种失败，内容始终在剪贴板里不会丢，手动在 SuperMemo 里按 Ctrl+N 即可。
- 自动粘贴从点按钮到粘上大约 2 秒（PowerShell 自身启动就占 ~1.4s，这是宿主用 .NET 模拟按键的固有开销）。想要更快，得把宿主换成编译好的小程序（点击到粘贴可压到 ~0.3s），那是一次独立改动。
- **为什么不用 `Alt+N`**：那是 `Edit : Add a category : Note`，只会新建一个**空白**元素、根本不读剪贴板；插件还得再补一次 `Ctrl+V`。而这一次粘贴常常在新元素的 HTML 编辑器拿到焦点之前就发出去了，落到知识树（Contents）窗口上——在那里 `Ctrl+V` 的语义是「Paste element（粘贴元素）」，只接受 SuperMemo 自己 `Copy element` 存的元素数据，剪贴板里是外部 HTML 就会直接报错。改用 `Ctrl+N` 是一步到位，把这个焦点竞态整个消掉了。
- 新建的条目挂在 SuperMemo 的「当前 concept group / 当前元素」下，想换归属分支请先在 SuperMemo 里切过去再点扩展。
- 若 popup 提示「剪贴板里没有内容」，说明写剪贴板时被其他程序占用了——重试一次即可。
- **粘贴后弹出 Windows 的「获取打开此'res'链接的应用」**：机制只有一个——SuperMemo 的 HTML 组件是 Internet Explorer 内核（`mshtml.dll` + `ieframe.dll` + `urlmon.dll`），**IE 会把任何「不是绝对地址」的 URL 拿去跟当前文档的基址（base URL）拼**；拼出来的东西如果它自己处理不了，就交给 Windows 的 ShellExecute，系统里没有能打开它的程序，于是弹框。`res://` 是 IE 的内部资源协议，「文档没有可用基址」时它的兜底基址就是 `res://<模块路径>/`（微软自己的文档里写着这个行为：在 IE 里给图设一个相对 `src`，读回来就是 `res://…`）。所以要么让笔记里**没有相对地址**，要么让**基址是对的**。
  1. **笔记里直接带了 `res://` 这类协议**——v2.2.2 起被协议白名单全部清掉（`res://`、`javascript:`、`blob:`、`ms-*`）。
  2. **笔记里带了相对地址**——v2.2.3 起清洗阶段**不留任何相对地址**，连 `#锚点` 也补成绝对地址。SuperMemo 集合里至今还留着这类痕迹：老笔记里能看到 `<A href="chrome-extension://phjnj…/popup/popup.html#LinkTarget_1038">`——那正是 IE 拿「基址」把相对锚点拼出来的结果。
  3. **基址本身是坏的（v2.3.0 修的，也是最容易被漏掉的一层）**——剪贴板里的 CF_HTML 有一行 `SourceURL:`，它就是 IE 解析这份笔记时的文档基址。Chrome 写入时用的是**执行复制动作的那个文档**的地址，而本扩展是在 popup 里写剪贴板的，于是那行变成了 `chrome-extension://<扩展ID>/popup/popup.html`。IE 拿这个 scheme 当基址根本用不了，就退回自己的 `res://` 基址——**笔记里明明全是 `https://`，照样弹框**。手动 `Ctrl+C` 从来不弹，是因为网页复制的 `SourceURL` 就是网页地址。v2.3.0 起宿主在发 `Ctrl+N` 之前把这一行改写成真实网页地址（`native/cfhtml.ps1` 做字节级改写并回读校验，笔记正文一个字节都不动），自动路径从此和手动路径完全一致；顺带把 SuperMemo 条目的来源引用也修对了（以前那行是扩展的地址）。
- 弹框时怎么定性（30 秒）：`powershell -ExecutionPolicy Bypass -File native\dump-clipboard.ps1` 会把剪贴板里的 CF_HTML 头部、`SourceURL`、片段里每一个 `href`/`src` 和所有 `scheme://` 打出来。① 片段里出现非绝对 URL → 清洗有漏洞；② 片段全干净但 `SourceURL` 指向 `chrome-extension://…/popup/popup.html` → 就是上面第 3 条（把扩展和宿主都更新到 v2.3.0，并确认 popup 上显示的版本号一致）；③ 两者都干净还弹框 → 触发源不在这份笔记里（Windows 上反复弹这个框，最常见的是某个后台程序或计划任务在调 ShellExecute），可以在 SuperMemo 的 HTML 组件里右键 → View source 或按 F9 搜 `res:` 来确认，再开任务管理器 →「详细信息」→ 右键列标题勾「命令行」看是谁在跑。
- **扩展和宿主必须成对更新**：v2.3.0 的修正在宿主（`native/cfhtml.ps1`）里，`%TEMP%\supermemo-clipper-last.json` 和「诊断」面板都会报 `clipboard_rewrite` 与改写前后的 `SourceURL`，据此可确认宿主这一层是否真的生效。
- v2.2.2 之前剪藏的笔记里可能还留着相对地址或 `res://`（已被 IE 拼成奇怪地址写进笔记），打开时照样弹框——把那条笔记删掉、重新剪藏一次即可。

## 升级记录

- **v2.3.0**：修「笔记内容全干净、粘贴时却仍然弹『获取打开此'res'链接的应用』」。根因不在笔记里，而在**剪贴板的基址**：CF_HTML 的 `SourceURL` 就是 IE 解析这份笔记的文档基址，而 Chrome 写的是「执行复制的那个文档」的地址——本扩展在 popup 里写剪贴板，于是那行成了 `chrome-extension://<扩展ID>/popup/popup.html`。IE 拿这个 scheme 当不了基址，就退回自己的 `res://` 基址，于是任何要被解析的 URL 都可能变成 `res://…`，Windows 接手弹框。手动 `Ctrl+C` 不弹框的原因也在这里：网页复制的 `SourceURL` 就是网页地址。
  现在 popup 把当前页地址随 native 消息一起送出，宿主在发 `Ctrl+N` 之前用 `native/cfhtml.ps1` 对剪贴板做**字节级**改写（只改 `SourceURL`，重算 `StartHTML/EndHTML/StartFragment/EndFragment` 四个字节偏移，写完回读校验：源地址对、笔记字节数不变，才继续发键；任何可疑就跳过并照旧发键，绝不让修复本身弄坏一次粘贴）。附带修好的是 SuperMemo 条目的来源引用——以前存进去的是扩展 popup 的地址。
  同一版还补了另外两处漏洞：**① IE 条件注释**——`<!--[if IE]><img src="/x.png"><![endif]-->` 对 Chrome 是注释（任何 DOM 清洗器都看不见里面），对 IE 却是真标记，藏在里面的相对地址能一路漏到 SuperMemo 弹框，现在所有 HTML 注释一律删除；**② 成稿兜底网**——`build()` 在组装完的 HTML 上再做一次 `href`/`src` 审计，不是绝对+白名单协议就删掉属性，并把条数记进 `meta.urls.scrubbed`（popup 会并进「丢弃」里显示）。同时新增 `test/url-forensics.js`（敌意页面逐属性审计）、`test/cfhtml-roundtrip.ps1`（真实剪贴板往返测试）、`native/dump-clipboard.ps1`（剪贴板取证）三个工具，以及 popup 的「来源地址已修正」回显与诊断面板里的 SourceURL 一节。
- **v2.2.4**：修「**SuperMemo 只闪一下、什么都没粘上**」。根因是前台锁：宿主被 Chrome 后台拉起，`SetForegroundWindow` 往往被拒绝（只换来任务栏一闪），而 `SendKeys` 只认前台窗口，于是 `Ctrl+N` 落到了 Chrome 手里。现在用 `AttachThreadInput` 接管输入队列真正抢前台，**并用 `GetForegroundWindow` 验证拿到手才发键**（Chrome 会在 popup 关闭的瞬间把焦点抢回去，所以是循环重试而不是一次性调用；验证按**进程 id**做，SuperMemo 开着的那一堆顶层窗口任意一个在前台都算成功）。抢不到就报「没能把 SuperMemo 切到前台」并说明当前前台是谁，不再假装粘贴成功。
  同时新增**「诊断」按钮**与宿主侧的运行记录（`%TEMP%\supermemo-clipper-last.json`）：popup 会被 SuperMemo 抢焦点后自动关闭，运行结果来不及显示，所以真正可靠的凭证留在宿主那侧，点一下就能取回——包括发键瞬间的前台窗口、SuperMemo 窗口数变化、剪贴板格式。popup 也会回显「收件窗口」。
  另外把 P/Invoke 层抽到 `native/fghelper.cs` 并**预编译缓存**（宿主体积从 ~4.4s 降到 ~2.5s），修复 `install.ps1` 写出的 host 清单带 BOM 的问题，并新增 `test/host-probe.js`——按真实协议直接跑宿主，不依赖浏览器。
- **v2.2.3**：把所有 URL 绝对化做到不留死角——`#锚点` 也补成绝对地址（此前 `href="#xxx"` 会原样保留，它是最后一类残留的相对地址）。同时修一个统计 bug：TreeWalker 会走进已被判定整块删除的子树（如 `<aside>` 侧栏），导致里面的图片/链接被计入 `meta.urls`，popup 显示的数量和笔记实际内容对不上——现在这些注定要删的节点不再计入。popup 新增版本号显示和 URL 统计回显（`图 N · 链 N · 丢弃 N`）；`test/inspect-live.js` 新增线上页面体检工具；`verify-all.js` 新增 URL 卫生与「相对图片 + `#锚点`」复现页，并对所有用例断言「输出中无相对 URL」。
- **v2.2.2**：清洗阶段新增 URL 协议白名单 + 相对路径补全。修「粘贴后弹出 Windows『获取打开此'res'链接的应用』」——SuperMemo 的 IE 内核会把 `res://` 这类不认识的协议丢给 ShellExecute。原先只挡了 `javascript:` 和 `data:`，其余协议原样保留，`<img src="res://…">` 就足以触发弹框。
- **v2.2.1**：修自动粘贴报错。原流程 `Alt+N` + `Ctrl+V` 是错的——`Alt+N` 是「Add a note」，只建空白元素、不读剪贴板，补发的那次 `Ctrl+V` 常落到知识树窗口上被当成「粘贴元素」而报错。改为直接发 `Ctrl+N`（「Add a new article」：新建 + 粘贴一步完成），并新增剪贴板非空预检。
- **v2.2.0**：popup 打开后**不再自动提取**（选模式 → 点提取）；全页模式增加对话页识别与历史补加载。
- **v2.1.0**：引入 `storage` 权限（记住每站模式）。

**每次更新后都去 `chrome://extensions` 点一下本扩展的「重新加载」**，并且刷新一下已在打开的页面（内容脚本是点击时注入的，但权限变更必须重载扩展才生效）。
