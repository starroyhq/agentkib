# 托管 Web / LAN 直连验收

本记录区分代码测试、同机界面检查和真实跨设备验收；后两者不能相互替代。

## 验收清单（实施前定义）

| 能力 | 功能检查 | 可见状态 / 证据 |
| --- | --- | --- |
| 桌面 LAN 设置 | 默认关闭、明确明文确认、仅选定私有 IPv4、保存后监听 | 开关、地址、风险文案、未验收控制禁用、二维码及地址可读 |
| 托管入口 | 地址格式/风险确认/连接/切换后端 | 初始屏、错误与重新连接，不裁切或横向溢出 |
| 配对 | 八位码、确认数字、桌面单独授权 | 未授权无历史、等待/拒绝/结束状态 |
| 授权边界 | 正确 Host/Origin/Bearer/CSRF、限流、独立设备 | 明确授权失效后清空内容 |
| 阅读与实时 | 历史分页、SSE 分片、掉线重新快照 | 长文本、代码块、离线禁用控制 |
| 控制 | 模拟 owner 互斥、幂等、失效审批、未知结果 | 不自动重放，未真实验收能力保持关闭 |
| 发布隔离 | 内置 dist 与 Pages dist-hosted 分离 | 静态资源、安全头、版本兼容提示 |

探索异常路径至少包括非法地址、连接失败后切换地址、网卡消失和撤销中请求返回。

## 当前限制

- 使用现有布局和四语文案，不改原设计稿。
- 当前没有 playwright-interactive 所需的 js_repl，界面检查使用 CUA；不修改工具配置。
- 尚未完成 Cloudflare 账号授权与正式域名部署。
- 尚未完成另一台真实设备的 Chromium LAN 权限、配对和控制验收。
- 不向真实 Codex 并发发请求，不以模拟测试解除正式控制门槛。

## 结果

- `pnpm test`：桌面 83 个文件 / 623 项、Web 2 个文件 / 86 项通过；包含原内置服务及新增 LAN 隔离测试。Node 输出已有 localstorage-file 警告，未导致失败。
- `pnpm typecheck`、`pnpm build:web`、`pnpm build:web:hosted`、`pnpm --filter @agentkib/desktop build` 通过。完整桌面构建包含 release runtime、协议生成、资源暂存、renderer/main/preload；未生成或发布安装包。
- `pnpm format:check`、`git diff --check` 通过。本轮没有 Rust 源码修改。
- CUA 同机连接页：390×844 浅色/深色、768×1024 深色、1440×920 深色查看完成；风险确认与非法公网地址提示可见。快速连续调整视口产生了裁切截图，未作为通过证据；1360×860 未完成稳定截图检查。
- 桌面使用独立临时 userData/runtime 目录启动；CUA 的“更多”菜单操作未能进入设置页，因此不声称桌面完整交互验收通过。桌面设置行为由组件测试覆盖；仍需实际复测。
- 本轮没有真实 LAN 配对、发送、审批或撤销；没有真实手机软键盘、跨设备 Chromium 权限或正式来源下的联网证据。生产控制门槛保持关闭。
- 已停止本轮临时 Electron 与两个开发服务器，未退出用户已安装的 AgentKib。临时数据保留于 `/tmp/agentkib-hosted-lan-ui-mjP2mb` 供排查。

## 交付边界

代码与本地构建通过，不代表部署及端到端验收完成。下一步需要 Cloudflare 账号登录，先发布预览静态资源，再绑定正式域名；随后在另一台同网设备验证配对与读取。仅在正式来源和指定测试会话串行验收成功后，才可评估开启实验控制。

## Cloudflare 部署补充（2026-09-09 15:14 CST）

- 用户授权后通过已登录 Safari 创建独立 Direct Upload Pages 项目 `agentkib-remote`，上传 `apps/web/dist-hosted` 的 12 个静态文件；未添加 Functions 或 API 代理，也未修改现有官网项目。
- Pages 入口 `https://agentkib-remote.pages.dev/` 返回 200，Safari 显示连接页；SPA 测试路径 `/connection-check` 返回相同入口 HTML。
- 新增 CNAME `remote.agentkib.com → agentkib-remote.pages.dev`。初始化时 TLS 暂不可用，随后正式 HTTPS 地址返回 200；未绕过证书验证。
- 正式与 Pages 地址返回 CSP、DENY、no-referrer、no-store 响应头。Cloudflare 默认静态响应还有 `Access-Control-Allow-Origin: *` 与 NEL 头；这不是本机 API 的 CORS 策略，未新增应用日志采集。
- Pages JS SHA-256 与本地相同：`42801da08dff357dcd58a4b3f9dfdf7b97a942d09f819e49cf12daebb96d75ae`。
- 构建元数据为 Web package `0.8.0`、revision `ea7955ac513278cfca3dae1029e6fe07152a359a`、dirty=true：这是当前未提交工作树的试用部署，不是桌面新版本发布。
- 此处解除“账号/域名部署”阻塞，不解除真实跨设备 Chromium 验收阻塞；未配对真实后端或启用实验控制。

## 桌面布局完善（本地，尚未再次部署）

- 连接入口：宽屏左侧说明与三步指引、右侧地址表单；语言/主题独立顶栏；800px 以下回到单栏。保留明文确认和原地址校验，补充错误与输入的 ARIA 关联。
- 配对/等待：宽屏步骤区与表单/数字区并列，标识实际当前步骤；小屏保留原单栏。未改变配对请求、审批或控制行为。
- 会话：宽屏目录自适应 280–336px，扩大阅读边距，状态和后端地址可换行；保留原移动端目录/会话切换规则。工具详情仍使用原弹窗，未新增侧面板。
- `pnpm test:web`：89/89；Web typecheck、内置/hosted 构建、`git diff --check` 通过。
- Safari 本地连接页明暗主题已目视检查；配对与等待步骤由组件测试覆盖。尚未完成此布局的真实手机及已配对会话视觉回归，不声称完整端到端通过。
- 当前线上仍为上一节部署的版本；新布局仅在本地预览和构建产物中。
