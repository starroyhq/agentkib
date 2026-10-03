# 内置 Web 自部署

Web 是 AgentKib 桌面应用的一部分，不是官方云服务。安装包包含网页、字体和本机服务；普通用户无需安装 Node 或下载源码构建，也不需要官方账号。项目继续使用根目录 MIT 许可。

本文描述内置同源模式，适用于本机或自行管理网络的开发使用。邀请内测的手机访问主要流程见 [一键开通托管连接](REMOTE-CODEX-WEB.md)，不要求按本文自行部署。另有[托管 Web 与局域网直连](WEB-HOSTED-LAN.md)：网页独立托管到 `remote.agentkib.com`，通过单独、默认关闭的局域网 HTTP 监听器连接桌面，不使用本节 cookie 或扩大原监听范围。

历史读取、跨 Agent 原生导入与 Web 托管控制分别判断能力。桌面新增的 OpenCode/Hermes/OpenClaw 实验导入不赋予它们 Web 控制能力，也不修改远程授权。具体来源、目标版本和验收状态见[会话互通矩阵](SESSION-INTEROPERABILITY.md)；Claude 托管控制与 Codex 实验能力仍遵循各自已有门限。

## 开启与本机使用

1. 安装对应版本的 AgentKib，打开设置 → 远程连接 → Web 访问。
2. 打开启用开关，保留端口 `1421`，点击保存设置。成功后显示运行中。
3. 在本机浏览器打开 `http://127.0.0.1:1421`。服务只监听 loopback，不监听局域网网卡。
4. 在桌面生成八位一次性授权码，在浏览器输入代码和便于识别的浏览器名称。
5. 验证成功即取得完整远控权限，无需桌面再次确认或逐项勾选。授权码五分钟有效，成功使用一次即失效。

新授权码包含全部已登记及以后新增工作区的历史、任务控制、审批、文件和产物访问，以及主机已支持的高级操作。不要向不信任的设备提供授权码。已有旧 Web 浏览器保留原权限；获得完整权限需撤销后重新输入新码。原生局域网与明文 HTTP 局域网流程仍单独管理。

关闭窗口遵循现有托盘设置；退出桌面应用会停止 Web 服务。不能只在 VPS 部署网页来控制另一台未运行 AgentKib 的电脑。

## 配置远程 HTTPS

使用本文的自管理模式时，用户自行提供域名、证书、反向代理或隧道，不依赖托管服务。本公开仓库不提供托管后端部署实现；独立托管连接的使用边界见 [AgentKib Remote](REMOTE-RELAY.md)。模型调用自身可能需要联网，与网页自部署无关，不代表离线推理。

先在 Web 设置填写外部地址，例如 `https://agent.example.com`（仅 origin，不带路径），保存。必须使用该地址访问；服务严格核验 Host 和 Origin，不接受任意转发头作为信任依据。

下面的 Caddy 配置应运行在 **AgentKib 所在电脑**，或通过你已配置的隧道让上游指向该电脑的 loopback 服务。域名需指向代理并满足证书签发要求。

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:1421 {
        header_up Host agent.example.com
        flush_interval -1
    }
}
```

已自行管理证书的 Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name agent.example.com;
    ssl_certificate /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:1421;
        proxy_set_header Host agent.example.com;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

不要为此服务添加跨域允许头、CDN 内容缓存或记录请求正文。`/api/web/v1/stream` 使用 SSE，需要禁用代理缓冲。本地 HTTP 与远程 HTTPS 的浏览器凭据分离；远程 cookie 带 Secure，本地授权不自动成为远程授权。

## 控制限制

新授权码授予完整远控权限，但操作是否可用仍取决于原生主机能力和当前任务状态。旧版逐项授权的浏览器继续受原有主机控制开关、各自权限和工作区范围限制，不自动升级。

- 历史读取不是 Agent 当前状态；只有权威实时快照确认空闲后才允许发送。
- 对经过验证的 macOS Claude Code 安装，首次发送会启动 AgentKib 托管的 `claude --resume=<UUID>`。这是续接已索引的会话，不是接管已有终端；查看历史不会启动 CLI。完整边界见 [Claude Code 托管续接](CLAUDE-WEB.md)。
- 对已核验的 Antigravity ACP 1.1.1，会话发送、原生审批与精确轮次停止由 AgentKib 托管；未知服务版本保持只读。Desktop/CLI 会话互操作边界见 [Antigravity 接入边界](ANTIGRAVITY.md)。
- Codex 控制只跟随经过验证的 macOS 官方 owner 会话，当前正式开发构建仍保持验收门槛关闭。找不到 owner 时需在官方客户端打开会话；AgentKib 不会自行恢复、分叉或接管。完整边界见 [Codex 原会话实验桥接](CODEX-BRIDGE.md)。
- 未验证的版本、其他平台、只读历史来源以及未知交互契约保持只读。
- 完整远控允许处理原生审批，不会自动同意执行。命令/变更不完整、不支持的审批决定或额外权限需求须在官方客户端处理。
- 请求已接收不等于执行完成。断线、超时和应用重启不会自动重发。结果不明确时先回官方客户端核验，不反复点击发送。
- 活动轮次可在运行或等待审批时请求停止。停止必须由原生协议确认；超时或连接中断会显示失败，不会把结果推断为已停止。

## 撤销、禁用与备份

在桌面 Web 设置撤销浏览器，现有事件流会关闭，后续请求拒绝。浏览器界面收到明确失效通知后清空内存内容。离线设备无法即时收到通知，不能把撤销当作远程擦除已经被用户保存的资料。

关闭启用开关并保存会停止服务，授权记录仍保留，便于下次开启。需要永久取消访问时先逐一撤销。

配置与凭据摘要保存在 Electron 用户数据目录的 `web/web-access.json`。macOS 正式版通常为 `~/Library/Application Support/ai.agentkib/electron/web/`，开发版为 `ai.agentkib.dev`。Windows/Linux 跟随 Electron 的用户数据目录。备份应在退出应用后进行，包含此目录和原有 AgentKib 数据；文件虽不含明文凭据，仍属于敏感授权资料。浏览器 cookie 不在服务端备份中，换浏览器需重新配对。

升级时安装与源码版本对应的发行包；网页与 runtime 一起升级，不要混用其他版本的静态网页。回滚前备份配置。当前版本号来自 `apps/desktop/package.json` 与 `apps/web/package.json`，构建源码应对应同一 Git commit/tag；未提交开发构建不能冒充正式发布版本。

## 故障诊断

| 现象               | 检查                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端口占用           | 桌面显示绑定错误；选择未占用的 1024–65535 端口，更新代理上游                                                                                                                                                              |
| 403 Host / Origin  | 外部地址是否精确匹配协议、域名、端口；代理是否保留配置的 Host                                                                                                                                                             |
| 配对过期或受限     | 八位码五分钟有效，错误达到上限后由桌面生成新码；核对系统时间                                                                                                                                                              |
| 没有历史           | 检查会话索引是否启用、工作区是否登记；浏览器授权不绕过索引设置                                                                                                                                                            |
| 实时连接断开       | 检查 SSE 缓冲、代理超时、桌面运行状态；重连先重新同步                                                                                                                                                                     |
| 控制禁用           | 检查官方版本、owner 状态与轮次 ID；旧版授权还需检查原有浏览器权限和主机实验开关                                                                                                                                           |
| 上次控制结果未确认 | 当前桌面主机运行期间锁定该会话控制；刷新、重连、runtime 自动重启、重新配对或重开 Web 服务不会解除。先在官方客户端核对真实结果，不重复提交。退出并重启桌面应用会更换运行标识，旧请求不能恢复或重放；重启不代表旧操作未执行 |
| 修改网络地址后失效 | 用新地址重新配对，不复制 cookie/token 到 URL 或 localStorage                                                                                                                                                              |

## 开发与构建

仓库使用 pnpm workspace：`apps/desktop`、`apps/web`、`packages/web-client`、`packages/session-ui`。

```sh
pnpm install --frozen-lockfile
pnpm build:web
pnpm dev
# 在桌面设置开启 Web 服务后，可使用独立前端开发服务器：
# 前端监听 127.0.0.1:1423，1422 留给托管网页局域网服务
pnpm dev:web
pnpm test:web
pnpm typecheck
pnpm build
pnpm dist:electron
```

独立开发页面通过本地 Vite 代理连接桌面服务，代理的 Origin 重写仅用于开发，不应照搬到生产安全策略。正式安装包从 `resources/web` 提供静态资源，不依赖 Vite。`pnpm dist:electron` 生成安装包，不自动发布；构建需要 Node、pnpm 和当前平台的打包工具。
