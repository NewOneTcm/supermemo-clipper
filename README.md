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
- **激活可靠性**：`SetForegroundWindow`（user32）兜底 WScript.Shell 的 `AppActivate`，失败自动重试一次，降低前台锁导致的失败。
- **状态可读**：popup 明确区分四种结果——已新建并粘贴 / SuperMemo 未运行（剪贴板已备好）/ 无法激活窗口 / native host 未注册。

## 工作原理

1. 点「提取」后向当前页面注入内容脚本：
   - **正文模式**：先注入 [Mozilla Readability.js](https://github.com/mozilla/readability)（Firefox 阅读模式同款引擎）识别并抽取正文，自动去掉广告、侧栏、导航、弹窗等。
   - **全页模式**：跳过 Readability。先判定是否为对话页（是则只取消息块），否则取整个 `<body>`；再删掉脚本样式、导航页头页脚、表单控件、弹窗和 `aria-hidden` 节点。
2. 对结果做二次清洗：只保留白名单标签（段落、标题、列表、表格、引用、图片、链接等），剥掉所有 style/class/事件属性，并把 `div`/`section` 这类容器拍平成真正的 `<p>`（不会产生非法的 `<p><p>` 嵌套），顺带清掉空容器。**URL 也会过一遍协议白名单**：只放行 `http(s)` / `ftp` / `mailto` / `#锚点` / 内联 `data:image`，其余协议（`res:`、`javascript:`、`blob:`、`ms-*` 等）一律清掉；相对路径会用页面地址补成绝对路径（SuperMemo 的笔记没有自己的文档，相对路径解析不了）。
3. 组装成 `<h1>标题</h1> + 来源链接 + <hr> + 正文` 的干净 HTML，同时生成纯文本版本，以 `text/html` + `text/plain` 两种格式写入剪贴板。
4. 通过 native messaging 调起 `native\paste.ps1`：查进程 -> 校验剪贴板非空 -> 激活 SuperMemo 窗口 -> 发 `Ctrl+N`（SuperMemo 的 `Edit : Add to category : Article`：新建元素并粘贴剪贴板）。popup 里会顺带回显这次抓了多少（如「12 条消息 · 8432 字」），方便判断是否抓全。

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
  manifest.json            扩展清单 (MV3)，v2.2.2
  background.js            MV3 service worker（占位，逻辑全在 popup）
  popup/popup.html|.js     模式选择 + 提取 + 复制 + 调 native host + 状态回显
  content/common.js        共享清洗与组装（白名单、去脚本样式、容器拍平、URL 协议白名单、空容器清理）
  content/extract.js       正文模式：Readability 抽取
  content/extract-full.js  全页模式：整个 body 导出
  lib/Readability.js       Mozilla 正文识别引擎
  native/                  自动粘贴 host（一次性注册）
    com.supermemo.paster.v2.json   host 清单（install.ps1 会写入扩展 ID）
    host.bat               Chrome 调起的入口
    paste.ps1              进程检测 -> 剪贴板校验 -> 激活窗口 -> Ctrl+N
    install.ps1            注册到注册表（Chrome/Edge）
  test/                    开发自测（不随扩展发布）
    harness.js             jsdom 跑真实内容脚本的测试脚手架
    verify-all.js          提取回归：ChatGPT 两种模式 + 微信两种模式
    verify-popup.js        popup 逻辑：模式选择、站点记忆、自动回退
    verify-wechat.js       拿保存下来的真实微信页面跑正文模式
    verify-img.js          检查微信图片 tp=webp 是否已剥离
  icons/                   扩展图标
```

自测（需要 `jsdom`，本仓库直接复用上级目录 `D:\develop\node_modules`）：

```powershell
$env:NODE_PATH="D:\develop\node_modules"
node test\verify-all.js                       # 提取回归，退出码 0 表示全过
node test\verify-popup.js                     # popup 交互逻辑
node test\verify-wechat.js saved-page.html    # 用真实页面验证正文模式
node test\verify-img.js saved-page.html       # 用真实页面验证 tp=webp 已剥离
```

## 已知边界

- `chrome://`、扩展商店、PDF 查看器等页面浏览器不允许注入脚本，会提示不支持。
- 正文在画布/播放器里的站点（视频字幕页、部分小说站）Readability 可能识别失败——会自动回退到全页模式。
- 全页模式只能读到「DOM 里已经渲染出来的内容」。对话页会在提取前自动滚到顶部，循环等待懒加载的历史进入 DOM（上限 4 秒）；若对话极长、4 秒内没加载完，仍可能缺早期消息——可以先手动往上滚一遍再点提取。
- 对话识别只认三种标记（`[data-message-author-role]`、`[data-testid^="conversation-turn"]`、`user-query`/`model-response`）。站点改版换了标记就会退化为整页导出（内容不会丢，只是会带上侧边栏等界面文字）。
- 全页模式会尽量按结构剔除界面元素（导航、页头页脚、表单、弹窗、`aria-hidden` 节点），但不保证百分百干净——内容页请优先用正文模式。
- 图片保留的是原站链接引用，不是把图片文件存进 SuperMemo；原图挂了 SuperMemo 里也会裂图。
- 自动粘贴靠模拟 `Ctrl+N`（SuperMemo 的 `Edit : Add to category : Article`：新建元素 + 读剪贴板粘贴，一步完成）。它依赖焦点落在 SuperMemo 主窗口——若 SuperMemo 正弹着对话框，这一下可能落到对话框上。但内容始终在剪贴板里，不会丢，手动在 SuperMemo 里按 Ctrl+N 即可。
- **为什么不用 `Alt+N`**：那是 `Edit : Add to category : Note`，只会新建一个**空白**元素、根本不读剪贴板；插件还得再补一次 `Ctrl+V`。而这一次粘贴常常在新元素的 HTML 编辑器拿到焦点之前就发出去了，落到知识树（Contents）窗口上——在那里 `Ctrl+V` 的语义是「Paste element（粘贴元素）」，只接受 SuperMemo 自己 `Copy element` 存的元素数据，剪贴板里是外部 HTML 就会直接报错。改用 `Ctrl+N` 是一步到位，把这个焦点竞态整个消掉了。
- 新建的条目挂在 SuperMemo 的「当前 concept group / 当前元素」下，想换归属分支请先在 SuperMemo 里切过去再点扩展。
- 若 popup 提示「剪贴板里没有内容」，说明写剪贴板时被其他程序占用了——重试一次即可。
- **粘贴后弹出 Windows 的「获取打开此'xxx'链接的应用」**：SuperMemo 的 HTML 组件是 Internet Explorer 内核（`mshtml.dll` + `ieframe.dll` + `urlmon.dll`），IE 遇到自己不认识的协议（尤其 `res://` 这个 IE 内部资源协议）会把它交给 Windows 的 ShellExecute 去找处理器，找不到就弹这个框。所以 v2.2.2 起，清洗阶段会清掉所有非白名单协议的链接——`res://`、`javascript:`、`blob:`、`ms-*` 都进不了笔记。
- 如果清理后**仍然**弹框，那说明触发源不在插件生成的 HTML 里（可能是别的后台程序在调 ShellExecute）。自查方法：弹框时打开任务管理器 →「详细信息」→ 右键列标题勾上「命令行」，看是哪一行在跑；或者在 SuperMemo 里 `Ctrl+F9` 打开当前笔记的 HTML 源码，搜 `res://`。

## 升级记录

- **v2.2.2**：清洗阶段新增 URL 协议白名单 + 相对路径补全。修「粘贴后弹出 Windows『获取打开此'res'链接的应用』」——SuperMemo 的 IE 内核会把 `res://` 这类不认识的协议丢给 ShellExecute。原先只挡了 `javascript:` 和 `data:`，其余协议原样保留，`<img src="res://…">` 就足以触发弹框。
- **v2.2.1**：修自动粘贴报错。原流程 `Alt+N` + `Ctrl+V` 是错的——`Alt+N` 是「Add a note」，只建空白元素、不读剪贴板，补发的那次 `Ctrl+V` 常落到知识树窗口上被当成「粘贴元素」而报错。改为直接发 `Ctrl+N`（「Add a new article」：新建 + 粘贴一步完成），并新增剪贴板非空预检。
- **v2.2.0**：popup 打开后**不再自动提取**（选模式 → 点提取）；全页模式增加对话页识别与历史补加载。
- **v2.1.0**：引入 `storage` 权限（记住每站模式）。

**每次更新后都去 `chrome://extensions` 点一下本扩展的「重新加载」**，并且刷新一下已在打开的页面（内容脚本是点击时注入的，但权限变更必须重载扩展才生效）。
