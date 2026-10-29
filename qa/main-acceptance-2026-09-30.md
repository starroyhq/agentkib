# 主线收尾与本机验收 — 2026-09-30

## 源码与范围

- AgentKib 基线 `ce16c0024210bb926805f48970f055e983af37b2`（已合并 main）；新工作树 `main-acceptance-20260930/agentkib`，分支 `codex/main-acceptance-20260930`。
- backend 基线 `b07ec13cb6f45edc945358d6c33ee08db914b58d`。
- macOS arm64，Node 22.23.2、pnpm 10.8.1、Cargo 1.92.0；锁定依赖，无新增生产依赖。
- 本轮未部署账号、替换已安装应用、升级用户 Agent、修改凭据或发布。真实手机不可用，不以浏览器或 fixture 结果替代。

## 备份、审计与归档

私有档案：`/Users/user/Documents/AgentKib-archives/2026-09-30/`，根目录权限 0700。`README.md` 说明恢复步骤，`archive-index.json` 记录来源、HEAD、分支及文件数量；包内全部文件均按 SHA256 核验。每份源码从原 HEAD 解包并重新应用 staged/unstaged binary patch 后，逐个已跟踪文件与原工作树核对成功；另外抽样提取并核验实际文件。Git bundle 已验证，归档后新增 Codex snapshot refs 另存独立 bundle。

五个本聊天旧工作树已通过 Codex 可恢复归档：`stability-pr`、`release-v0-12-0`、`antigravity-icon-lobehub`、`claude-managed-commit`、`all-agent-continuation`。归档前复查源码哈希、Git status 和 HEAD 均未变化，未发现 cwd/可执行文件位于旧树的运行进程，也未发现其他活动聊天使用旧路径。最终 Git worktree list 仅保留原主目录、其他任务的 hosted-v013-deploy 和本轮验收树。原主目录及 prototypes 已额外备份，未改动；分支和远端分支保留。

独立子代理逐项审计 199 个生产/工具链文件：136 与 main 完全一致，24 完整内容位于 main 历史，32 项差异经审查被新版替代，7 为生成文件。没有发现遗漏生产功能；完整逐文件哈希和理由保存在 `source-audit/`。12 份互通 QA 与 main 一致；旧文档抽取到的54个临时引用路径当前均不存在（部分为文本后缀片段），不把历史摘要当成本轮原始日志。

发现并恢复一个确定的测试依赖遗漏：`qa/probes/openclaw-sqlite-fixtures.mjs`。main 中 OpenClaw 原生 ignored 测试引用它，之前只存在于旧工作树。脚本调用固定版本官方 writer/readback，不访问凭据或调用模型；独立复核通过。仅用于可信隔离安装和唯一新目录，不宣称提供包签名认证或跨进程原子目录排他。

## backend 远端与账号链路

全部三个提交的74个唯一 blob 已做敏感内容检查，匹配项为测试值、变量和示例；未发现真实凭据。确认现有 `starroyhq/agentkib-backend` 私有、无 refs/workflow/webhook 后，添加 origin 并正常推送 main。远端与本地 SHA 均为 `b07ec13`。私有 Git bundle 恢复克隆及源码包全部111文件（含49份ignored本地资料）校验通过。

临时 PostgreSQL + 新主线 DesktopAccountService 的真实 HTTP/PG 链路、真实 Rust Runtime 与八位码配对/读取/退出/撤销回归均通过，详见 [账号专项记录](main-acceptance-account-2026-09-30.md)。数据库容器清理完成。系统钥匙串、公网 FRP/TLS、手机及生产账号上线不计入通过。

## 本次实际质量检查

日志在私有档案 `main-validation/`，保留首次失败与后续复验，不修改旧 QA 的结论。

| 检查 | 本次结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；AgentKib 锁文件不变 |
| `cargo fmt --all --check` | 通过 |
| `cargo test --workspace` 首次并行运行 | 既有 Antigravity `replay_shares_one_deadline_across_session_list_and_load` 失败：1.5秒总期限内未到达 load 阶段，当时并行编译和安装；见 `rust-tests.log` |
| 同一时限用例精确单项复验 | 1/1 通过，1.50秒；保留原断言，见 `antigravity-timing-focused.log` |
| `cargo test --workspace -- --test-threads=1` | 1006通过、6 ignored；未改断言或生产实现，见 `rust-tests-serial.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 均通过；保留 lint warnings |
| `pnpm test` | 桌面942通过、7个按需入口跳过；Web230通过 |
| `pnpm build` / `pnpm build:web:hosted` | 均通过，保留 React Compiler 对部分 try/finally 不优化的提示 |

曾用不完整测试名称配合 `--exact` 得到0项执行；该命令日志 `antigravity-timing-diagnostic.log` 仅作诊断，不计通过证据。时限用例在全量高并发下的脆弱性保留为测试限制，串行通过不抹去首次失败。

Claude 的新建空会话、同会话锁/状态、审批与问题失效、附件引用、重复请求、取消和重启未知回执由真实 Provider/controller、宿主及 Runtime fixture 回归覆盖。此处无新付费模型调用，原工作树的真实模型证据不冒充本轮新主线二进制实测。

构建完成后的 Runtime SHA256：debug `18f225c179dfc891553a182fd1e922b363ff0a5b4414d809738106236489de16`，release `52a835192374c88bb0ea62d6d2e4d5595b32ef6ea2d942ed17a254af64fe95f5`。账号专项使用更早生成的 dev-app 二进制，SHA 独立记录于专项 QA；不混用二进制身份。

## 原生互通与剩余边界

本轮新建隔离安装与数据，固定 OpenCode 1.18.32、Hermes 0.21.5、OpenClaw 2026.9.6。OpenClaw 安装需要独立 Node26，未替换项目 Node22 或用户 Agent。

逐目标公开 Runtime 预览、确认、导入、回读及恢复结果，以及官方免费模型资格/实际回复，另见 [互通专项记录](main-acceptance-interop-2026-09-30.md)。缺授权、运行条件或失败的方向保持未验收；本轮不新增 Grok/Cursor/Antigravity 目标控制能力。

Claude 合成来源至上述三个目标的公开导入、严格正文/角色回读、重复请求及 Runtime 重启恢复通过；5项固定版本原生回归通过。OpenCode/OpenClaw 原生 TUI 显示历史标记，Hermes 停留 provider setup，界面未验收。验收脚本经独立审查补齐业务失败与身份漂移断言，3项负例自检通过，已有成功 case 再次只读核验通过。

本轮真实模型请求为0：OpenCode 固定版本的外层自动重试无法可靠关闭，不满足单次派发约束；Hermes/OpenClaw 隔离环境没有可用免费授权。因此三方向均不提升为完整原生互通通过。全部来源组合、真实手机、Windows/Linux 实机及生产账号上线仍不计入本轮通过。
