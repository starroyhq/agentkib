# v15 C 批：远程连接设置

基线为最新 `main` 的 `54b30806b202b727dd589301f3a4b1b82d4c0147`；独立分支 `codex/v15-c-remote-connections`。设计依据为本机只读交接文档的共同约束、C 批及第 6 步预览、7-2 操作规范。未修改或复制设计文件；B3 和 D 不在本轮范围。

## 验收清单

| 范围 | 自动化与交互 | 截图/目视 |
| --- | --- | --- |
| 手机首次四步与唯一主要操作 | 未登录、登录中、就绪、授权码、账号异常 | 首次设置，四语 |
| 已开启管理 | 连接进度/失败/暂停、浏览器档位、确认撤销、连接新手机 | 合成已开启、暂停确认 |
| 其他电脑 | 一个空状态、显式共享、发现不启用共享、身份变化与撤销保护 | 空状态，四语 |
| 统一高级设置 | 复选框保存、共享网卡、局域网端口、只提交变化项、失败保留草稿 | 展开的高级设置，四语 |
| 原有入口与状态 | 设置搜索揭示隐藏目标并聚焦、切标签保留草稿、局域网警告常驻 | 键盘和切标签探索 |
| 四语术语 | 实际翻译、键与插值、桌面/Web 连接指引同步 | 三个主要页面无溢出 |
| 安全边界 | 原协议/权限/有效期、旧版授权、自建服务、明文确认、发送前校验不变 | 合成验收不证明真实授权 |

验收只使用独立 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、运行数据、Electron profile 与 AGENTKIB_HOME，阻断个人配置、Keychain 和非测试外网。全部账号、会话、设备和网络地址均为合成值，不登录真实账号、不调用模型。截图前检查个人信息；公开测试码没有可接受它的服务。探针、状态与清理方法见 `probes/v15-c-README.md`。

## 与设计的差异及保留能力

- 连接服务和 frpc 路径单独“应用连接设置”：直接用普通 configure 保存会绕过原 remote-enable 的账号归属、提供方切换清理、邀请码和重新登记流程。因此按 C 批允许的技术例外保留原安全流程，界面说明它不随普通保存应用；更换服务仍需确认，自定义程序仍校验 SHA-256。
- 网卡即使只有一块也需显式选择并保存，避免误把不可信接口作为默认暴露入口；不自动启动监听。已有地址失效或两服务地址不同，保留原连接并要求明确选择。手机局域网与电脑只读共享共用选择，端口、凭据和权限仍独立。
- 手机局域网 configure 会撤销该服务的浏览器授权，统一保存只提交实际变化项；仅改电脑名称或本机 Web 不空提交局域网。部分失败显示分项结果并保留剩余草稿。
- 账号协议仅提供用户名，不假定为邮箱。设备配额、两步验证、归属处理、退出和重试保留在“管理账号”。自建服务、已有未归属邀请码、手动 HTTPS 访问、旧官方服务迁移、旧授权和诊断入口保留。
- 完成态使用已有浏览器、已有登记地址或保存过的暂停配置恢复；本页观察到完成后不因撤销最后一个浏览器回退。默认配置不含 relay，仍从首次引导开始；本页第一次开启时，连接就绪后继续显示第 3 步，授权浏览器后才完成。未新增持久化字段，也不将这些界面证据用于授权。
- C 批首次说明中的“公网访问需要账号”按同批术语验收改为“使用官方远程连接服务需要账号”，准确区分局域网和现有自建服务路径。
- 电脑名称由统一“保存设置”应用；共享开关立即生效，只使用已保存的名称和接口，不顺带应用草稿。空状态的“共享这台电脑”先展示设置，不立即开启监听。

## 验证结果

所有命令使用临时 userconfig 的 `manage-package-manager-versions=false`，及上述六个合成目录；没有修改包管理器版本、依赖或锁文件。桌面全量以两个 worker 运行，保留全部超时和安全断言。

| 命令 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | 通过：backend、desktop、Web；路由生成器有既有 circular dependency 提示 |
| `pnpm lint` | 通过：0 error、275 条既有 warning；本轮实现的独立 lint 检查无新增 warning |
| `pnpm format:check` | 通过，1016 个文件 |
| `pnpm test:web` | 69 文件、1488 测试通过 |
| `pnpm --filter @agentkib/desktop test --maxWorkers=2` | 最终 399 文件通过、1 文件跳过；7870 测试通过、3 跳过；无失败、无超时 |
| `pnpm --filter @agentkib/desktop build:electron` | 通过；最终界面补丁后另跑 `build:web` 通过；保留既有大 chunk 提示 |
| `pnpm build:web:hosted` | 通过 |
| `pnpm exec oxfmt --check apps/desktop/test/remote-settings-name.test.ts` | 通过，新增的后端测试文件单独覆盖 |
| `node --test qa/probes/v15-c-fixtures.test.cjs` | 11 测试通过 |
| `node --check qa/probes/v15-c-bootstrap.cjs`、`node --check qa/probes/v15-c-sandbox.mjs` | 通过 |
| `git diff --check` | 通过 |

最终全量包含：手机旧测试 50、新引导与管理 18、电脑 26、共享网络 17、真实父层整合 8、真实后端名称 3，以及原有账号/LAN/安全测试。全量后只扩充术语回归对第六份新字典 `remote-settings-copy` 的键与插值检查，单独 14 测试通过，测试文件格式检查通过；未再改变生产代码。

三个跳过项沿用环境门禁：真实 Claude Web 集成、原生 TLS、真实 Claude 终端桥接；本轮没有配置真实 CLI 或设备验收。Windows/Linux 原生界面、本轮以外主题、真实账号/服务登记/配对与端口可达性未覆盖。界面截图覆盖 macOS Electron 的 VTRON 浅色主题；Web 仅改连接文案，四语实际 DOM、输入格式和连接回归由现有测试覆盖，没有新增管理页。

测试后已成功重建 `backend:build`（含 Claude 插件构建）与 `cursor:stage`，避免测试夹具残留在构建目录。没有修改真实 Codex/Claude 配置或系统技能。

## 独立检查与回归修复

以下问题先用回归复现，再修复，未削弱原安全断言。最终设计与规范/安全两路独立复核均无剩余明确 finding。

| 边界 | 修复与证据 |
| --- | --- |
| 从未共享过的电脑仅保存名称 | 关闭状态传入非空惰性地址以满足原参数校验；真实 RemoteAgent 证明不监听、不持久化占位地址、不改变已有地址，3 测试通过 |
| 最后一个附近电脑消失 | 编辑后保持配对区域挂载；地址/配对码与焦点保留，发现操作不启动共享 |
| 撤销最后浏览器、暂停后重开应用 | 完成态只增不退，重开可用现有暂停配置恢复；首次开启仍保留连接手机步骤，不增加协议字段 |
| 组合保存排队时修改草稿 | 本机与网络保存全程禁用网络控件；仅清除本次提交的草稿，不清掉更新的网卡/端口/名称输入 |
| 网卡失效或冲突后关闭共享 | 关闭使用权威的当前监听地址；开启仍只使用已保存且有效的共用网卡。空地址导致关闭失败的红测已复现，修后电脑 26 测试通过 |
| 首次登记失败后更正邀请码 | 未完成且尚未就绪时继续保留邀请码输入；已完成管理态的普通暂停/恢复不额外显示邀请码 |
| 暂停后本机 Web 仍运行 | 手机入口和弹窗独立要求 relay ready；暂停/离线隐藏失效授权码与二维码并禁止生成。高级手动 HTTPS 配对仍按原判断，未削弱校验 |
| 英日按钮遗留位数 | 改为 `Generate access code`、`認証コードを生成`；四语真实父层打开对话框，逐项断言默认完整控制、准确按钮及零自动生成请求 |
| LAN 弹窗重复标题/说明 | 外层保留无障碍标题/描述，内部只显示一份可见标题和说明，原 LAN 功能仍保留 |

视觉探针另补初始配置不含 relay、重载可读 runtime status 的回归；runtime retry、登录、配置、模型、桥接、外部应用仍禁止。只读 runtime status 透传原处理器，没有改生产 IPC。

## 四语与术语搜索

已修改英文/日文的工程化旧表达：生成动作去位数（包括 `Generate 8-digit access code`/`8 桁の認証コードを生成`）、one-time/一次性描述；界面操作中的 desktop/デスクトップ、host/ホスト改为 computer/コンピューター或“电脑上的 AgentKib”；public access 改为 remote access；原 native discovery 的 desktop 表述改为 nearby computers；控制功能统一 remote control/リモート操作。新增四步引导、管理/确认、共享接口、单一保存说明均提供四语。

保留 `frpc`、`SHA-256`、`HTTPS`、`IPv4`、`KiB/s`、连接诊断、公网可达性探测等技术含义；网络权限详情里的目标 Host/主机仍是技术名词。命令、内部键、用户内容及跨 Agent 文案不改。桌面/Web 12 个同名连接提示四语逐项相等；六份局部字典检查键与插值一致。

复核命令：

```sh
rg -n '远控|遠控|公网访问|公網存取|公網訪問|八位|一次性|桌面' \
  apps/desktop/src/features/remote/*copy.ts \
  apps/web/src/features/connection/*copy.ts \
  apps/web/src/features/connection/hosted-home.tsx
rg -n '主机|主機' apps/web/src/features/connection/*.ts \
  apps/web/src/features/connection/*.tsx apps/web/src/features/conversation/i18n/index.ts \
  -g '!*.test.*'
git diff --name-only -- apps/desktop/electron packages .github designs
```

第一组搜索无生产文案命中；第二组的 shell 扩展范围也包含测试，只命中拒绝旧词的回归正则，生产文案无命中。技术 Host 在连接目录以外的权限详情中保留。字典补充检查：仅 zh-CN/zh-TW 的 `remote.*` 范围无旧词；全局其余领域不在本批范围。四语各 123 个 `handoff.*` 值与基线逐项相等。最后一条无输出：后端生产代码、协议、CI、设计文件未改。

## 视觉与交互验收

通过真实 Electron CDP/Playwright 操作设置入口、手机/电脑标签、高级折叠、LAN 对话框、合成已开启状态、暂停确认和新手机授权码。四语分别使用固定语言的独立沙盒，不依赖被探针禁止的偏好修改。原生窗口为 1360 × 860 CSS px，PNG 为 2720 × 1720；等待状态加载与有限动画完成后截图。各页 document scrollWidth 均等于 viewport，无横向滚动；长高级内容能滚到唯一“保存设置”。

四语均保存以下本机截图（PNG 按仓库现有规则忽略，未作为源码提交）：

| 语言 | 首次设置 | 电脑空状态 | 高级设置上半/下半 |
| --- | --- | --- | --- |
| zh-CN | `screenshots/v15-c-remote/zh-CN/phone-first.png` | `screenshots/v15-c-remote/zh-CN/computers-empty.png` | `screenshots/v15-c-remote/zh-CN/advanced-top.png` / `advanced-bottom.png` |
| zh-TW | `screenshots/v15-c-remote/zh-TW/phone-first.png` | `screenshots/v15-c-remote/zh-TW/computers-empty.png` | `screenshots/v15-c-remote/zh-TW/advanced-top.png` / `advanced-bottom.png` |
| en-US | `screenshots/v15-c-remote/en-US/phone-first.png` | `screenshots/v15-c-remote/en-US/computers-empty.png` | `screenshots/v15-c-remote/en-US/advanced-top.png` / `advanced-bottom.png` |
| ja-JP | `screenshots/v15-c-remote/ja-JP/phone-first.png` | `screenshots/v15-c-remote/ja-JP/computers-empty.png` | `screenshots/v15-c-remote/ja-JP/advanced-top.png` / `advanced-bottom.png` |

zh-CN 另有 `lan-dialog.png`、`phone-enabled.png`、`pause-confirm.png`、`phone-code.png`。逐张目视无文案裁切或遮挡，图片只含示例账号、设备、接口。首次手机页面仅一个主要按钮，电脑空状态的两个操作均为次要按钮；高级设置只有一个普通保存。暂停确认初始聚焦“取消”；取消保留状态；确认只改变合成状态，暂停后仍有 0 浏览器管理且“连接新手机”禁用。二维码与分组授权码仅为公开测试夹具，没有接受它的服务。

开启中/失败/账号异常/旧授权/部分失败/邀请码更正/打开弹窗后失去连接/切标签保留草稿/设置搜索揭示目标由自动化覆盖。没有用真实账号或跨设备网络做端到端连接验收，也未将夹具成功当作权限或真实服务验收。

四个沙盒均经所有权与 PID/启动身份核对后 cleanup；Electron/CDP 和其 loopback 后端进程已停止，目录已删除。截图保留在当前工作树；个人目录、Keychain、非测试外网未放行。

## PR #145 后续独立复核

初次交付后另做不依赖实现过程的代码复核，发现并继续修复保存竞态、接口同步、恢复操作与授权范围告知的边界问题。逐项证据、回归、最终验证及复审结果见 [PR #145 独立复核记录](v15-c-pr145-review-2026-10-22.md)；上方为首次交付时的验证记录。
