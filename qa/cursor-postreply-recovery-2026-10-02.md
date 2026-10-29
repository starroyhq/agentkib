# Cursor 回复后恢复收尾验收

2026-10-02（Asia/Shanghai），继续既有隔离工作树和已消费操作。HEAD 为 `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，dirty 状态保留。没有新增生产代码修改、依赖、数据库迁移或授权协议变更，没有提交、推送、发布、替换安装或复制凭据。

## 结论与范围

修复后的 Claude 合成历史 → Cursor IDE `3.22.12` 新 B，用原操作完成回复后产品打开、七条可见历史、再次作为来源及 Runtime 重启恢复。新 A 同 UUID 打开和重启恢复亦通过，仍无模型发送。本轮新增模型发送为 **0**，导入为 **0**；B 真实回复来自 10 月 1 日已记录的唯一一次 Ask / Grok 4.7 High Fast GUI 发送，不能据此证明厂商内部上游请求次数。

两次正常完整 Cursor 退出/重启记录来自 [10 月 1 日原生 QA](cursor-native-acceptance-2026-10-01.md)。本轮在第二次重启后的两个原窗口补齐产品入口验收，并额外正常重启 Runtime 一次。不能把额外 Runtime 重启称作第三次完整 Cursor 重启。

| 检查                                        | 结果                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A 原操作 / UUID、五条正文、13 个 blob       | stage053、stage062 严格全文及原字节回读通过                                                  |
| B 回复后原操作打开                          | stage055、stage057、stage060 公共 `sessions.launchHandoff` 通过                              |
| B 七条完整可见历史                          | 普通 IDE 实际截图与 AX 核对通过；思考保持折叠                                                |
| B 原历史、source / plan / attempt、唯一身份 | 独立只读审计通过，原 13 个 blob 仍精确                                                       |
| B 新问答                                    | 唯一新增 user 全文与发送意图相等；assistant 准确引用完整标记及决策，无新增问答或 UI 工具步骤 |
| B 再次作为来源                              | stage056 五目标公共预览均保留七条正文、角色及顺序；不是五次原生导入                          |
| Runtime 正常重启后恢复                      | stage058 重启、A/B 原 binding 显式连接、stage060 / stage062 打开通过                         |
| 正常退出                                    | stage063 stop、serve exit0，control socket 和自有 Runtime PID 均消失                         |

Cursor IDE → Claude 的既有一次原生文件导入及两次禁网 TUI 恢复结果保留，**没有反向真实模型回复**。新 A 不提升真实回复等级；CLI、Agents Window、其他来源、富内容、长历史、命名 profile、Windows/Linux 实机及真实手机均不由本轮代表文本例外推。不能宣称“全 Agent 已互通”。

## 冻结身份

- 工作树：`/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`。
- Cursor 官方签名副本：`/Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app`；固定 `3.22.12`，主二进制 SHA256 `7c85e27a23b7dbe8fbfc738a8876550b10cd57173df7cf7d060de69bb216a075`。
- 生产 `cursor_ide.rs` SHA256 `ebe5b34cca53e321923252bbf1bd82a512d06316f03bc4ffabfd48078c73b56c`。
- 实际 debug Runtime SHA256 `5d18e7fc36a4e0a6eb3766e28b4ca27e8914dfd7febf4bc6ee2d80bd04c46abc`，与 10 月 1 日已验证二进制精确一致。
- 原 manifest SHA256 `bf80ee0c28edddc121367e639a8229280f50f72bc33d29ef1ca2e45f05f99407`；没有重写 manifest、计划或旧回执。
- QA harness SHA256 `25bacea881a7a3834f690d11042c1272781f33ed96bd88cf083d4186731e98d3`；回复后只读探针 SHA256 `c24a54bcfcda9a76a164984c19ed9de29c225dc8adf032148496e49e3a80bedf`。
- A operation `55fedfe0-b010-4c27-8f91-79addf62f01a` / native UUID `783272bb-80cf-4c5b-8560-60599dca6402`。
- B operation `687ba192-eba5-4ef5-9aa5-56e06737c6e1` / native UUID `47ee1557-d797-4ba1-a9e7-d03bf4f5ce72`。
- 证据继续保存在 `/Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout/cursor-contextfix-v2/`，新增文件使用 `date1002`，不覆盖旧失败。

## 实际执行

```sh
python3 qa/probes/cursor-bridge-native-acceptance.py --evidence /Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout/cursor-contextfix-v2 serve --runtime-update target/debug/agentkib-runtime
```

通过同一 harness 的 `send --json` 顺序执行如下动作。挑战仅在本机安全输入使用，不进入日志、命令行或截图。

| stage     | 动作                                                            |
| --------- | --------------------------------------------------------------- |
| 052 / 053 | A 原 binding 挑战连接 / `reopen` 严格初始回读                   |
| 054 / 055 | B 原 binding 挑战连接 / `reopen-existing`                       |
| 056       | B `source-preview`，五个目标公共预览                            |
| 057       | 关闭空草稿的 B 历史视图后，再打开原 UUID；无模型发送            |
| 058       | 正常重启 Runtime，握手 PID `91653` / protocol15 / version0.13.0 |
| 059 / 060 | B 显式重新连接 / 打开原 UUID                                    |
| 061 / 062 | A 显式重新连接 / 严格初始回读及原 UUID 打开                     |
| 063       | 正常 stop，serve exit0                                          |

`reopen-existing` 明确返回 `full_readback_performed=false`，不能单独作为全文验收。回复后全文、图、回执和实际 GUI 由下述独立证据补足；原 `reopen` / `readback` 的初始严格比较未削弱。

实际 GUI 首图中 sticky 用户卡片遮住了首条助手的部分正文；滚动工具的方向与实际画面相反，调整滚动位置后七条完整历史均可见，不把后台 AX 当作前景截图通过。在定位中误打开了一条原用户消息的编辑界面，立即 Escape 退出，没有修改或发送；后续原 blob、消息前缀和唯一新 turn 审计仍通过。没有通过再发送模型刷新画面。

## 独立证据与限制

- 恢复前 hardened 图审计：`live-b/independent-date1002-before-recovery-hardened-audit.json`，SHA `01f9c1d8b390b9e7e665d9494b82a661c359a37a4e87fa36948213052ccbc209`。
- 恢复前 20 项输入/回执保护：`live-b/independent-date1002-before-recovery-receipts-audit.json`，SHA `2751d56345ac056f8eefefd67d4f308ec6849345861cd241f97211572dde594d`。
- 回复后原操作打开的图审计：`live-b/independent-date1002-after-reopen-hardened-audit.json`，SHA `62c3b3445a2f42a2f7aced10ed124a13691b19b12a657ffbd0e648c65e84b204`。
- 五目标预览/回执独立审计：`live-b/independent-date1002-stage056-preview-receipts-audit.json`，SHA `a62ded82e6ecb5dc752df24ed79ce7c40c1e7a2fe432c45f88b5c4db9ac696ba`。
- Runtime 重启后图审计：`live-b/independent-date1002-after-runtime-restart-hardened-audit.json`，SHA `ca1f3de95ad593872a4b44fc40462938070c98e0c8bfaaffb103d28c57329646`。
- 正常退出后的最终图审计：`live-b/independent-date1002-final-stopped-graph-audit.json`，SHA `956e1eb5a682de21e985d1997f70e9cd44b5f24533acd22b43ab50887db18b5d`。
- 最终回执/恢复/停止独立审计：`live-b/independent-date1002-final-recovery-receipts-audit.json`，SHA `0dc1270006a93c4a5e10c42bed1277630b0b59ec5b7259478624aed90df6bcf8`；重算 29 个保护输入、两个 ID/标题各唯一，control socket 不存在、PID91653 已退出。
- root 实际操作汇总：`date1002-recovery-outcome.json`，SHA `bd843d7459caeb22acab2f51b6ba6ce5cd891da598d72927adee6ce922ba9624`；分别记录本轮 GUI、公开 RPC、停止与独立审计证据，不将汇总替代原始日志。
- 完整 B 可见历史：`gui-date1002-b-full-visible.png`，SHA `a7854372bc5cd31f267c0ab926f5221c48646c1c773e5f554f775e066a3b6683`。
- Runtime 重启后 B 全文截图：`gui-date1002-b-runtime-restarted.png`，SHA `e9732aa0293a2d7d59f095686938529582aa82931d3312ca82cd39f5a1a3c999`。
- Runtime 重启后 A 全文截图：`gui-date1002-a-runtime-restarted.png`，SHA `49a824a17f8a7d9fb59d6d391814237adb27af2868ce9b3787b2e9d8693620d2`。

独立子代理分别复核实际公开预览的七条 timeline 正文/角色/顺序、来源保护、操作回执及原生图，不使用生产转换器自证。五预览准确保留 `reasoning-excluded:1` 和 `source-content-truncated:1`：只省略本次新增思考及 user ancillary context，七条用户/助手正文没有截断，没有延迟历史窗口。

三个新增 model context 引用仅检查存在、长度与计数，不读取正文或重算内容哈希；新 model JSON 全文不在独立探针验收范围。新问答正文和零工具结论依据原生 UI graph、GUI 及发送意图，厂商内部请求和计费 token 不可观察。OS SecretStorage 跨完整客户端进程的持久性未验证，本隔离 profile 使用 `--use-inmemory-secretstorage` 并显式恢复原 binding。

生产和二进制本轮无变化，复用 10 月 1 日精确身份对应的 Rust 45 suites / 1042 passed / 0 failed / 9 ignored，fmt、workspace all-targets Clippy `-D warnings` 和 debug build 通过记录；没有把这些命令说成 10 月 2 日重跑。新增 QA / README / 兼容矩阵使用项目 `oxfmt --check` 验证。旧首次模型失败、stage048 生产恢复拒绝及旧严格审计 false 全部原样保留。
