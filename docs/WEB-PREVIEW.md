# 网页预览

会话右侧「文件与产物」面板的「网页预览」标签显示这台电脑上正在运行的网页，例如会话里启动的开发服务器。电脑端直接嵌入页面；远程浏览器经主机的预览源代理。

## 选择页面

- 列出会话最近 200 条记录和正在输出的回复里出现的本机地址：`localhost`、`127.0.0.1`、`0.0.0.0`、`[::1]` 加端口。最新的在前，每个端口只列一次。终端颜色码先去掉再识别（Vite 会给端口单独上色）；工具输出里被打码的查询参数整段丢掉。
- 也可以输入端口（`5173`）或本机地址（`localhost:5173/app`、`https://127.0.0.1:8443/`）。其他主机一律不接受。
- 点了才加载，不自动打开。页面一律用 `localhost` 访问，HTTPS 地址保持 HTTPS。

识别与解析在 `@agentkib/web-client` 的 `localPreviewTargets`、`parseLocalPreviewTarget`，两端共用。

## 电脑端

会话和开发服务器在同一台电脑上，页面直接放进 iframe，热更新照常。

- iframe 的 sandbox 为 `allow-scripts allow-same-origin allow-forms allow-modals`：页面保留自己的 `localhost` 源，碰不到 AgentKib；不能导航窗口、打开新窗口或下载。`target=_blank` 链接不会打开，可用「在浏览器中打开」。
- 渲染进程 CSP 的 `frame-src` 允许 `http(s)://localhost:*`。页面跳到其他网站时被拦截。
- Django、Rails 等默认发送 `X-Frame-Options`。主窗口直接嵌入的 `localhost` 页面会去掉它和 CSP 的 `frame-ancestors`；这个页面里再嵌的框架、其他窗口和 `127.0.0.1` 上 AgentKib 自己的服务不受影响（`apps/desktop/electron/main/live-preview-frames.ts`）。
- 「重新加载」回到最初打开的地址。

## 远程浏览器

只给完整控制的浏览器（`device.accessMode=full` 且有 `advancedControl`）。局域网 HTTP 连接没有完整控制，不提供。

### 票据

`POST /api/web/v1/live-preview-tickets`，请求体 `{port, path?, secure?}`，返回 `{url, expiresAt}`。

- 先检查权限再探测端口，只读浏览器不能借此扫描本机端口。
- 拒绝 AgentKib 自己的端口（Web 服务与两个预览服务，`live_preview_port_reserved`）和浏览器禁用的端口（Fetch 标准的 bad port 列表，`live_preview_port_blocked`）；端口没有在监听时返回 409 `live_preview_unreachable`。
- 票据 24 字节随机，绑定设备、端口和签发时的预览源。闲置 30 分钟或签发满 4 小时失效，`expiresAt` 是按闲置计算的初值。预览源改变（开关中继）、撤销设备、退出登录、权限改为只读时立即作废，进行中的响应一并断开；每个请求都重新检查设备权限。每台设备最多 8 张，超出时丢弃最旧的。
- 面板里每次打开和「重新加载」都申请新票据。

### 页面怎样到达浏览器

1. 面板的 iframe 打开 `<预览源>/live/<票据>/<路径>`，sandbox 与电脑端相同。
2. 第一次打开时主机返回引导页。引导页安装作用于整个预览源的 Service Worker `/live-sw.js`，再打开同一地址；浏览器绕过 Worker 时显示说明，不会反复刷新。
3. Worker 把页面重定向到它自己的根路径 `/<路径>`，之后把这个页面的每个请求改写为 `/live/<票据>/...`，加上 `X-AgentKib-Live: 1`。前端路由和 `/@vite/client` 这类根相对地址因此照常工作。
4. 主机只代理带这个标记的请求，连到 `localhost:<端口>`（固定解析为 127.0.0.1 与 ::1，不经系统解析）。HTTPS 开发服务器不校验证书：回环端口上的证书证明不了什么。

代理对请求和响应的改写（`apps/desktop/electron/main/web/live-preview.ts`）：

- 上游看到的是它自己的源：`Host`、`Origin`、`Referer` 改为 `http(s)://localhost:<端口>`，`Sec-Fetch-Mode`、`Sec-Fetch-Dest` 还原成页面原本的请求类型。
- 不转发 AgentKib 的会话 Cookie（`ak_web_local`、`ak_web_secure`）。本机模式下预览源和 AgentKib 都在 127.0.0.1，浏览器会把它发给每个端口。
- 页面的 Cookie 去掉 `Domain`；经中继时改为 `SameSite=None; Secure; Partitioned`，才能在第三方 iframe 里使用；页面不能设置 AgentKib 的 Cookie 名。
- 去掉 `X-Frame-Options`、HSTS、`Clear-Site-Data`、`Service-Worker-Allowed`；`frame-ancestors` 换成 `'self'` 加 AgentKib 的源；`Location` 指回同一端口时留在票据内；`Referrer-Policy` 固定为 `same-origin`。

Worker 不处理其他源、产物票据 `/p/` 和它自己。顶层页面需要来自预览本身的证据（由之前的预览页打开，或同源 Referer），否则原样交给主机拒绝，那个页面的图标请求也一样；所以别的网站链接或提交到预览源，到不了开发服务器。iframe 里的 Worker 按顶层站点分区，只和 AgentKib 的页面共用。几个预览按客户端分开记录，Worker 重启后仍记得。

## 限制

- 不代理 WebSocket，远程浏览器收不到热更新；改动后点「重新加载」。同一台电脑上的浏览器有时能直连开发服务器的 WebSocket。
- 所有远程预览共用一个预览源：不同开发服务器的 localStorage 和 Cookie 互相可见，页面也不能注册自己的 Service Worker。
- 需要 Service Worker：中继（HTTPS）和本机 127.0.0.1 可用。浏览器不允许时引导页提示在新标签页打开。
- 本机模式下页面脚本能写 127.0.0.1 的 Cookie；AgentKib 的会话 Cookie 是 HttpOnly，不能被覆盖。
- 电脑端和远程浏览器（Chrome）都在真实运行的 AgentKib 里核对过；Safari、Firefox 未测。记录见 [会话管理与网页预览 QA](../qa/session-management-2026-10-28.md)。
