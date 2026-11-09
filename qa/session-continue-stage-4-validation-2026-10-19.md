# 会话无感续接：第 4 阶段收尾验证

日期：2026-10-19。基线：`683b0a427`（第 3 阶段 Claude 界面）。本阶段经用户确认后本地提交，不推送。

## 范围与结果

- 按实施说明第 4 阶段更新 `docs/development/ui-terminology.md`，用直接续接、运行位置、外部占用选择和只读原因替换早期手动执行交接约定。
- 核对桌面会话页、工作区 Claude 面板、Web、首页、目录、连接终端和会话详情的简体中文、繁体中文、英文、日文。简体文案以实施说明 1.5 为准，繁体实体统一“對話”、日文统一“会話”、英文实体统一 session。
- 只修本轮续接相关的用户可见文案及确认无调用的废弃词条；内部原因码、旧回执结算、锁、指纹、版本、平台、权限等安全检查保持原样。
- 用户本轮明确要求 Codex follower 暂不删除，相关实现保留；不改跨 Agent 继续、交接文件、在工作区续接和 `handoff.*`，也不改变协议或持久化格式。
- 保留用户已有 `.agents/`、`prototypes/`、两份本机依据文档与忽略目录中的设计文件。

## 核对发现

- 术语表仍把“执行管理”“交给 AgentKib”“待交接”列为现行约定，已更新为 D10/D11 的运行状态、选择条、终端与队列文案，并区分同 Agent 续接和跨 Agent 继续。
- 两端目录的繁体来源/搜索反馈仍混用“會話”“工作階段”，日文仍有“セッション”，英文来源反馈称 conversation；仅对会话实体改为规范词，保留用户标题、原文和真实技术字段。
- 部分安全拦截与错误说明仍要求先交接或手动恢复执行。修正说明和下一步，保留未确认结果必须先核对、权限/协议/主机连接等限制，不承诺自动重发。
- Claude 操作面板的队列标题未对齐四语“待发队列”，队列恢复说明仍暗示旧手动恢复步骤；改为核对上次操作结果后恢复队列，原有禁用条件保持。桌面和 Web 的未确认结果提示同步指向已保存请求核对，继续禁止重复提交和自动重发。
- 繁体通用只读标签“僅可檢視”统一为本表与共享组件使用的“僅可查看”。
- 删除确认无调用的 `webLayoutCopy` 执行管理/待交接/待恢复词条、`codexCopy` 旧恢复确认词条和 `managedText` 旧交接条目；相关旧入口缺席断言改用独立字面量，未删除用例。
- `managed-control-copy.ts` 仅修正实际调用的 access/protocol 四语说明。其他旧交接措辞由没有生产调用的 `claudeHandoffBlockReason`/`canConfirmClaudeHandoff` 兼容 helper 及其测试引用，本阶段保留；内部诊断码、负向样本、跨 Agent 文案和仍有效的原客户端审批上下文也保持原值。

## 验证

- `pnpm typecheck`：通过（后端、桌面、Web，含 Web 路由生成）。
- `pnpm lint`：通过，0 错误、275 条警告，与第 3 阶段数量一致；不宣称零警告。
- `pnpm format:check`：通过，962 个匹配文件。
- `git diff --check`：通过；验证完成时暂存区为空。
- 对比基线：四语各 123 个跨 Agent 键值保持不变，13 个 follower/跨 Agent 实现文件未变；本阶段无后端控制实现改动。
- 桌面会话、工作区与跨 Agent 对话框回归组合：43 个文件、745 条用例全部通过；日志 `/tmp/agentkib-stage4-desktop-final.log`。
- `pnpm test:web` 最终复跑：61 个文件、1242 条用例全部通过；日志 `/tmp/agentkib-stage4-web-final.log`。
- 完整 Web 初跑 60 个文件通过，`session-stability.test.tsx` 两条旧文案等待断言失败（1240 通过、2 失败）；日志 `/tmp/agentkib-stage4-web-initial.log`。断言分别改为全局控制暂停提示与持久化请求未知提示的完整新字面量，保留原请求只发送一次、草稿、隐私及匹配回执要求，针对该文件 24/24 复验通过。

新增两端 `session-continuation-terminology.test.tsx` 各 17 条，使用实际 Reader、Composer、Actions 和 CodexTools，独立于被测字典的规范字面量验证四语渲染；覆盖语言切换保留草稿、占用选择、只读原因、通知、队列标题、安全禁用及桌面/Web 终端入口差异。最初每端 3 条失败，准确复现 Claude 队列简中、繁中和英文标题偏差，修正后各 17/17 通过。目录来源/空搜索先复现繁体和日文 4 条失败，再修文案；copy 回归先复现 9 条失败，再修改四语错误指引。

本阶段没有重新启动浏览器做视觉验收；沿用第 3 阶段已记录的四语窄屏检查，本阶段补实际组件渲染回归。第 1/2 阶段的全仓库 `pnpm test` 有已记录的 Skills 文件系统超时；本阶段未重跑完整仓库套件，不声称全仓库测试通过。没有为通过测试延长超时、删用例或降低安全断言。

工具链沿用第 3 阶段：仓库声明的 pnpm 12.10.1 自动切换报 `ENOEXEC`，实际用本机 pnpm 10.8.1，设置 `npm_config_manage_package_manager_versions=false`；根脚本使用 `/tmp/agentkib-pnpm-session-continue.npmrc`（`manage-package-manager-versions=false`），Vitest 设置 `VITEST_MAX_WORKERS=1`，未改仓库依赖或包管理器配置。

最终检查命令（测试范围与全仓库套件明确区分）：

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:web
pnpm --filter @agentkib/desktop exec vitest run \
  src/features/sessions \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  src/features/workspace/SessionHandoffDialog.test.tsx
```

## 真实 CLI 与实机待验收

本阶段没有新增真实 CLI／真实模型手动验收。技术前提实测沿用第 1 阶段：Claude Code 2.1.302 普通无参数会话可被发现；Codex 最低安全版本采用实测的 0.147.0，真实 app-server 写锁、持锁只读和退出释放均有协议级实测。阶段 2/3 的合成 CLI、受控时钟、组件与 Chromium 检查不等同于下列完整产品验收。

| 技术前提文档验收项 | 已有证据 | 仍需真实环境完成 |
| --- | --- | --- |
| 1 Claude 关闭终端后直接继续、自动结束 | 自动续接、默认计时、回收后重启占用检查已有自动化 | 从 AgentKib 发送并收到真实模型回复；实际空闲 10 分钟退出；终端 `claude --resume` 正常续接且记录无交错 |
| 2 普通 Claude 终端占用、分支 | 普通无参数会话发现已实测；占用选择、分支和草稿/附件迁移已有自动化 | 真实终端保持打开；通过桌面/Web 选择分支并完成模型往返，确认原记录不受影响；真实连接插件的终端发送与审批 |
| 3 Claude 运行中被外部打开 | 停止进程与冲突原因的后端/界面回归 | 真实模型运行时在终端打开同一会话，确认 AgentKib 及时停止且历史无交错 |
| 4 Codex 空闲续接及约 1 分钟释放 | 真实 app-server 启动/写锁/释放原语已测；生命周期自动化 | AgentKib 界面真实模型往返；约 1 分钟释放和离开时等待当前轮次结束释放；交互式 `codex resume` 可继续 |
| 5 Codex Desktop/CLI 占用、分支与退出恢复 | 实际 Desktop 持锁只读、两个真实 app-server 拒绝已测；选择条轮询和草稿回归 | Desktop/交互 CLI 保持打开；真实产品分支往返；完全退出后选择条自动消失，原草稿恢复 |
| 6 AgentKib 持锁时拒绝另一个 Codex | 两个真实 app-server 互斥及退出后 resume 成功已测 | AgentKib 正在真实模型轮次时交互 CLI 被拒绝，释放后能打开，确认记录无交错 |
| 7 不支持的平台/版本及替代入口 | 旧 Codex 版本边界已实测；平台、版本原因及复制命令有自动化 | Windows 实机 Claude 只读与替代入口；低版 Codex 的完整界面验收；Windows/Linux Codex 实际续接 |
| 8 手机/Web 与桌面一致 | 第 3 阶段四语、窄屏 Chromium 与交互验证；本阶段补渲染回归 | 真手机连接主机并完成真实 CLI 的状态、选择条和草稿流程，确认连接终端设置只在 macOS 桌面出现 |

## 实施说明与当前交付的差异

- 本轮按用户明确要求保留 Codex follower，文档原计划的删除工作暂不执行。
- Web 继续沿用用户已确认的复制续接命令与主机操作说明，不增加原先不存在的跨 Agent 入口。
- 用户离开时沿用已确认的“等当前轮次完成后释放”，不立即中断回复。
- 合成自动化与真实产品验收分开记录，当前不宣称技术前提文档 8 条完整验收均通过。

## 文件清单

本阶段修改/新增 33 个文件，仅含文案、废弃显示键、测试与文档。

### 术语与 QA

现行四语术语、安全与能力边界、验证证据及真实环境待验清单。

- `docs/development/ui-terminology.md`
- `qa/session-continue-stage-4-validation-2026-10-19.md`

### 桌面文案与回归

同步目录、错误指引、队列及未确认结果说明，保留安全门控并补实际渲染回归。

- `apps/desktop/src/features/sessions/conversation/features/catalog/catalog-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/catalog/session-details-dialog.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-tools.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-control-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-agent-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/web-layout-copy.ts`
- `apps/desktop/src/features/sessions/session-continuation-terminology.test.tsx`
- `apps/desktop/src/locales/en-US.json`
- `apps/desktop/src/locales/ja-JP.json`
- `apps/desktop/src/locales/zh-CN.json`
- `apps/desktop/src/locales/zh-TW.json`

### Web 文案与回归

与桌面同步四语文案、移除无引用词条，验证既有 Web 能力边界。

- `apps/web/src/features/catalog/session-catalog.test.tsx`
- `apps/web/src/features/catalog/session-details-dialog.test.tsx`
- `apps/web/src/features/conversation/features/catalog/catalog-copy.ts`
- `apps/web/src/features/conversation/features/sessions/codex-copy.ts`
- `apps/web/src/features/conversation/features/sessions/codex-tools.tsx`
- `apps/web/src/features/conversation/features/sessions/managed-control-copy.ts`
- `apps/web/src/features/conversation/features/sessions/managed-copy.ts`
- `apps/web/src/features/conversation/features/sessions/session-agent-copy.ts`
- `apps/web/src/features/conversation/features/sessions/session-composer.test.tsx`
- `apps/web/src/features/conversation/features/sessions/web-layout-copy.ts`
- `apps/web/src/features/conversation/i18n/index.ts`
- `apps/web/src/features/sessions/codex-copy.test.ts`
- `apps/web/src/features/sessions/codex-features.test.tsx`
- `apps/web/src/features/sessions/session-continuation-terminology.test.tsx`
- `apps/web/src/features/sessions/session-handoff-entry.test.tsx`
- `apps/web/src/features/sessions/session-stability.test.tsx`
