# 内置 Web 自部署

Web 是 AgentKib 桌面应用的一部分，不是官方云服务。安装包包含网页、字体和本机服务；普通用户无需安装 Node、Rust 或下载源码构建，也不需要官方账号。项目继续使用根目录 MIT 许可。

本文描述保留不变的内置同源模式。另有[托管 Web 与局域网直连](WEB-HOSTED-LAN.md)：网页独立托管到 `remote.agentkib.com`，通过单独、默认关闭的局域网 HTTP 监听器连接桌面，不使用本节 cookie 或扩大原监听范围。

## 开启与本机使用

1. 安装对应版本的 AgentKib，打开设置 → 远程连接 → Web 访问。
2. 打开启用开关，保留端口 `1421`，点击保存设置。成功后显示运行中。
3. 在本机浏览器打开 `http://127.0.0.1:1421`。服务只监听 loopback，不监听局域网网卡。
4. 在桌面生成八位配对码，在浏览器输入代码和便于识别的浏览器名称。
5. 对比两端校验数字，在桌面确认授权。默认仅允许读取；发送与审批分别授权，主机实验开关也必须开启。

授权覆盖全部已登记和以后新增的工作区，不提供按工作区隔离。不要授权不信任的浏览器。已有原生局域网设备授权不会自动获得 Web 权限。

关闭窗口遵循现有托盘设置；退出桌面应用会停止 Web 服务。不能只在 VPS 部署网页来控制另一台未运行 AgentKib 的电脑。

## 配置远程 HTTPS

用户自行提供域名、证书、反向代理或隧道。官方协调服务不是必需项，本版也不提供协调、打洞或中继。模型调用自身可能需要联网，与网页自部署无关，不代表离线推理。

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

当前开发构建的发布验收开关保持关闭，**发送和审批不能启用**；主机设置会说明这一状态。控制链路已实现并做隔离测试，但不据此宣称真实 Web 控制已经通过。该门槛不是付费功能或账号限制，源码中公开实现，真实验收通过后才可在对应构建开放。

- 历史读取不是 Agent 当前状态；只有权威实时快照确认空闲后才允许发送。
- 仅支持已验证的 macOS Codex 安装版本和索引可验证映射的原会话。未知版本、其他平台或其他 Agent 保持只读。
- 找不到 owner 时在官方客户端打开该会话，不会自动启动、恢复、分叉或接管。
- 发送与审批独立授权。命令/变更不完整、不支持的审批决定或额外权限需求须在官方客户端处理。
- 请求已接收不等于执行完成。断线、超时和应用重启不会自动重发。结果不明确时先回官方客户端核验，不反复点击发送。
- 首版没有停止、中断、进程终止或撤销执行能力。

## 撤销、禁用与备份

在桌面 Web 设置撤销浏览器，现有事件流会关闭，后续请求拒绝。浏览器界面收到明确失效通知后清空内存内容。离线设备无法即时收到通知，不能把撤销当作远程擦除已经被用户保存的资料。

关闭启用开关并保存会停止服务，授权记录仍保留，便于下次开启。需要永久取消访问时先逐一撤销。

配置与凭据摘要保存在 Electron 用户数据目录的 `web/web-access.json`。macOS 正式版通常为 `~/Library/Application Support/ai.agentkib/electron/web/`，开发版为 `ai.agentkib.dev`。Windows/Linux 跟随 Electron 的用户数据目录。备份应在退出应用后进行，包含此目录和原有 AgentKib 数据；文件虽不含明文凭据，仍属于敏感授权资料。浏览器 cookie 不在服务端备份中，换浏览器需重新配对。

升级时安装与源码版本对应的发行包；网页与 runtime 一起升级，不要混用其他版本的静态网页。回滚前备份配置。当前版本号来自 `apps/desktop/package.json` 与 `apps/web/package.json`，构建源码应对应同一 Git commit/tag；未提交开发构建不能冒充正式发布版本。

## 故障诊断

| 现象 | 检查 |
| --- | --- |
| 端口占用 | 桌面显示绑定错误；选择未占用的 1024–65535 端口，更新代理上游 |
| 403 Host / Origin | 外部地址是否精确匹配协议、域名、端口；代理是否保留配置的 Host |
| 配对过期或受限 | 八位码五分钟有效，错误达到上限后由桌面生成新码；核对系统时间 |
| 没有历史 | 检查会话索引是否启用、工作区是否登记；浏览器授权不绕过索引设置 |
| 实时连接断开 | 检查 SSE 缓冲、代理超时、桌面运行状态；重连先重新同步 |
| 控制禁用 | 检查两个独立浏览器权限、主机实验开关、官方版本、owner状态与轮次 ID |
| 上次控制结果未确认 | 当前桌面主机运行期间锁定该会话控制；刷新、重连、runtime 自动重启、重新配对或重开 Web 服务不会解除。先在官方客户端核对真实结果，不重复提交。退出并重启桌面应用会更换运行标识，旧请求不能恢复或重放；重启不代表旧操作未执行 |
| 修改网络地址后失效 | 用新地址重新配对，不复制 cookie/token 到 URL 或 localStorage |

## 开发与构建

仓库使用 pnpm workspace：`apps/desktop`、`apps/web`、`packages/web-client`、`packages/session-ui`。

```sh
pnpm install --frozen-lockfile
pnpm build:web
pnpm dev:electron
# 在桌面设置开启 Web 服务后，可使用独立前端开发服务器：
# 前端监听 127.0.0.1:1423，1422 留给托管网页局域网服务
pnpm dev:web
pnpm test:web
pnpm typecheck
pnpm build
pnpm dist:electron
```

独立开发页面通过本地 Vite 代理连接桌面服务，代理的 Origin 重写仅用于开发，不应照搬到生产安全策略。正式安装包从 `resources/web` 提供静态资源，不依赖 Vite。`pnpm dist:electron` 生成安装包，不自动发布；首次构建需要项目既有 Rust/Node/平台打包工具链，这些仅开发者需要。
