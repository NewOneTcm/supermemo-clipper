# SuperMemo Clipper v2

浏览器扩展（Chrome / Edge，Manifest V3）：点一下工具栏图标，自动清理当前网页的广告和无关格式，只保留**标题 + 网址 + 正文**，然后**自动切到 SuperMemo、新建条目（Alt+N）并粘贴（Ctrl+V）**，全程无感。

v2 与 v1（`supermemo-clipper`）完全独立：独立的扩展目录、独立的 native host 名（`com.supermemo.paster.v2`），两个版本可以同时装着互不影响。

## 与 v1 的区别

- **自动新建条目**：v1 只发 Ctrl+V（会粘贴进当前元素）；v2 先发 Alt+N 新建元素，等焦点稳定后再 Ctrl+V。
- **进程级检测**：先查 `sm*.exe` 进程，SuperMemo 没开直接报「未运行」，不再靠窗口标题瞎猜。
- **激活可靠性**：`SetForegroundWindow`（user32）兜底 WScript.Shell 的 `AppActivate`，失败自动重试一次，降低前台锁导致的失败。
- **状态可读**：popup 明确区分四种结果——已新建并粘贴 / SuperMemo 未运行（剪贴板已备好）/ 无法激活窗口 / native host 未注册。

## 工作原理

1. 点击图标后向当前页面注入 [Mozilla Readability.js](https://github.com/mozilla/readability)（Firefox 阅读模式同款引擎），识别并抽取正文，自动去掉广告、侧栏、导航、弹窗等。
2. 对抽取结果做二次清洗：只保留白名单标签（段落、标题、列表、表格、引用、图片、链接等），剥掉所有 style/class/事件属性。
3. 组装成 `<h1>标题</h1> + 来源链接 + <hr> + 正文` 的干净 HTML，同时生成纯文本版本，以 `text/html` + `text/plain` 两种格式写入剪贴板。
4. 通过 native messaging 调起 `native\paste.ps1`：查进程 -> 激活 SuperMemo 窗口 -> Alt+N 新建条目 -> Ctrl+V 粘贴。

## 安装

1. 打开 Chrome/Edge，地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹 `supermemo-clipper-v2`
4. 把扩展固定到工具栏（拼图图标 -> 图钉）

## 注册 native host（一次性，自动粘贴必需）

1. 加载扩展后，在 `chrome://extensions` 页面复制扩展的 **ID**（一串字母）
2. PowerShell 运行：
   ```powershell
   cd D:\develop\supermemo-clipper-v2\native
   .\install.ps1 -ExtensionId 你的扩展ID
   ```
3. 重启浏览器。

不注册也能用：popup 会提示「native host 未注册」，内容照常进剪贴板，手动切到 SuperMemo 粘贴即可。

## 日常使用

- 打开文章页 -> 点扩展图标 -> 完事。SuperMemo 里已经出现一个排版干净的新条目。
- SuperMemo 未运行时点击：内容在剪贴板里，打开 SuperMemo 后手动 Ctrl+V 即可，不会丢。
- 之后照常增量阅读：Alt+X 摘录、Alt+Z 挖空。

## 文件结构

```
supermemo-clipper-v2/
  manifest.json            扩展清单 (MV3)，v2.0.0
  background.js            MV3 service worker（占位，逻辑全在 popup）
  popup/popup.html|.js     提取 + 复制 + 调 native host + 状态展示
  content/extract.js       Readability 抽取 + HTML 白名单清洗
  lib/Readability.js       Mozilla 正文识别引擎
  native/                  自动粘贴 host（一次性注册）
    com.supermemo.paster.v2.json   host 清单（install.ps1 会写入扩展 ID）
    host.bat               Chrome 调起的入口
    paste.ps1              进程检测 -> 激活窗口 -> Alt+N -> Ctrl+V
    install.ps1            注册到注册表（Chrome/Edge）
  icons/                   扩展图标
```

## 已知边界

- `chrome://`、扩展商店、PDF 查看器等页面浏览器不允许注入脚本，会提示不支持。
- 正文在画布/播放器里的站点（视频字幕页、部分小说站）Readability 可能识别失败。
- 图片保留的是原站链接引用，不是把图片文件存进 SuperMemo；原图挂了 SuperMemo 里也会裂图。
- SendKeys 模拟按键依赖焦点落点：SuperMemo 若停在非编辑状态（比如弹着对话框），Alt+N/Ctrl+V 可能落到意外的地方——但内容始终在剪贴板里，不会丢。
- Alt+N 新建的元素挂在 SuperMemo 当前节点下，想换归属分支请先切过去再点扩展。
