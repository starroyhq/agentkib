# 托管 Web 与局域网直连

`https://remote.agentkib.com` 只托管网页。Chromium 浏览器直接请求同一局域网电脑上的 AgentKib；Cloudflare 不代理会话、控制请求或实时事件，不提供打洞、中继、账号或计费。

## 使用与安全边界

1. 保持桌面应用运行，在远程连接设置开启独立的托管网页局域网访问；确认明文风险，选择网卡上的私有 IPv4 地址及端口（默认 `1422`）。该设置不修改原 loopback `1421` 服务。
2. 手机或另一台电脑连接同一局域网，打开桌面提供的链接／二维码，或手动输入类似 `http://192.168.1.10:1422` 的实际地址。支持 `10/8`、`172.16/12`、`192.168/16`，不扫描网络，不监听所有网卡。
3. 允许 Chromium 请求的本地网络权限，输入桌面生成的八位配对码，对比两端校验数字，由桌面确认；发送和审批遵守独立授权及原有主机实验门槛。
4. 刷新、关闭网页或切换目标需重新配对。凭据只在内存中，不能放入链接、浏览器存储或日志。桌面可撤销授权。

**局域网段采用明文 HTTP。** 网站 HTTPS 只保护网页加载，不能保护浏览器到电脑的请求。配对、Origin 校验与 CSRF 不能阻止同网段攻击者窃听或篡改会话、凭据和操作。只在可信网络试用，不配置公网端口转发。网页脚本更新也属于信任边界，只部署可信源码。

兼容性以实际 Chromium 跨设备验收为准，不保证所有手机浏览器可用。拒绝权限或浏览器阻断时，不关闭安全保护来规避。电脑浏览器成功、桌面缩放或模拟设备不能替代真实手机验收。

## 独立构建

```sh
pnpm install --frozen-lockfile
pnpm build:web:hosted
```

上传目录是 `apps/web/dist-hosted`，不得上传仓库、用户数据或 `.env`。托管构建使用 Vite `hosted` 模式，含 `_headers`、`_redirects` 和来源 `build-info.json`。`pnpm build:web` 仍生成 `apps/web/dist` 供 Electron 使用，不带托管专用响应头。两套输出独立。

`pnpm dev:web` 监听 `127.0.0.1:1423`，为局域网服务留出 `1422`。开发页代理 `1421`，不是正式域名的跨域验收环境。

## Cloudflare Pages 部署

使用 **Pages Direct Upload**，只上传预构建文件，不创建 Workers、Pages Functions、`_worker.js`、API 代理或分析脚本。需要 Cloudflare 账号及域名配置权限；仓库不包含凭据，不自动安装或登录 Wrangler。

在控制台 Workers & Pages 中创建 Pages Direct Upload 项目，建议名 `agentkib-remote`，上传 `apps/web/dist-hosted` 文件夹，也可压缩目录内的内容上传。已有 Git 集成项目不直接改变部署类型，应使用单独项目。参见 [Direct Upload 官方说明](https://developers.cloudflare.com/pages/get-started/direct-upload/)。

已有 Wrangler 且获账号授权时：

```sh
wrangler whoami
wrangler pages project create agentkib-remote --production-branch main
wrangler pages deploy apps/web/dist-hosted --project-name agentkib-remote --branch preview
```

已有项目跳过 create。先检查预览页面、字体、响应头及控制台错误；`*.pages.dev` 不在桌面可信来源中，预览只验证静态页面，不因此扩大 CORS。随后上传相同产物到生产分支：

```sh
wrangler pages deploy apps/web/dist-hosted --project-name agentkib-remote --branch main
```

在 Pages 项目 Custom domains 添加 `remote.agentkib.com`，按提示完成 DNS 和证书。不要只手动新增 CNAME 而不在 Pages 绑定。参见 [Custom domains 官方说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)。正式域名生效后才验收真实局域网连接。

产物的 [`_headers`](https://developers.cloudflare.com/pages/configuration/headers/) 禁止嵌入、关闭 Referrer、请求不缓存并限制脚本／字体来源；[`_redirects`](https://developers.cloudflare.com/pages/configuration/redirects/) 提供 SPA 回退。不要添加 `upgrade-insecure-requests` 改变 HTTP 连接。`connect-src 'self' http:` 是浏览器连接许可，不是 RFC1918 网络隔离；应用和桌面仍必须执行地址与授权限制。API 不经过 Pages。

默认可信来源固定为 `https://remote.agentkib.com`。其他域名仅能显示页面，不自动取得连接权限；自有域名需同步审查修改桌面可信 Origin、生成链接及前端约束并构建对应版本，不宣称设置支持任意域名。完全不依赖该域名的方式仍是[内置 Web 自部署](WEB-SELF-HOSTING.md)。

## 诊断、升级与验收

| 现象 | 检查 |
| --- | --- |
| 页面打不开 | Pages 部署、域名、DNS、HTTPS 证书，与本地 Agent 无关 |
| 页面打开但连不上 | 应用运行、网卡端口、防火墙、浏览器权限；访客 Wi-Fi／AP 隔离可能阻断 |
| 网卡地址改变 | 旧监听应停止，重新选择地址并生成链接，不自动绑定所有网卡 |
| 来源拒绝 | 使用精确正式 HTTPS 域名；预览域名和原内置 cookie 没有授权 |
| 版本不兼容 | 安装兼容桌面版本并重新配对，不绕过协议检查 |
| 控制禁用 | 检查独立权限、实验门槛、owner／轮次；不重试结果不明的请求 |

禁用局域网服务终止连接；关闭网页不等于撤销。升级前按内置文档备份桌面数据，不上传到 Pages。发布保留对应 Git commit/tag 和 MIT 许可，不将开发构建冒充正式版本。

交付分别记录静态构建、正式域名部署、真实 Chromium 跨设备读取／撤销、指定测试会话串行发送／审批。缺少 Cloudflare 授权或真实设备时列为阻塞，不以模拟测试替代。
