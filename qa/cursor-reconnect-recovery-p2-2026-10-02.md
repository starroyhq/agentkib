# Cursor 重连撤销与重复正文恢复 P2 修复 QA（2026-10-02）

## 源码与边界

- 工作树：`/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`。
- 分支：`codex/main-acceptance-20260930`；HEAD：`f706abaffac9950d616121f4dc86ef830a41aa09`。验证对象为 dirty 源码，不能只用 HEAD 代表本轮代码。
- 保留上一轮登记隔离、空工作区连接入口及其未提交修改；原 QA 与原始证据不改写，见 [上一轮 QA](cursor-connection-p2-2026-10-02.md)。本次代码增量只涉及 `cursor_bridge.rs`、其集成测试与 `cursor_ide.rs`，另更新使用说明和本记录。
- macOS 本机自动化；`rustc 1.92.0 (ded5c06cf 2025-12-08)`、`cargo 1.92.0`。固定 Cursor `3.22.12` 的格式合约保持不变，未提升其他版本、产品表面或平台能力。
- 本机证据目录：`~/Documents/AgentKib-archives/2026-10-02/cursor-reconnect-recovery-p2/`。目录权限 0700，文件 0600；保存源码 SHA256、命令结果、日志 SHA256 与测试 Runtime 二进制身份，不保存挑战或凭据值。

## 复现与修复

### 断开后旧重连挑战重新授权

修复前，扩充真实 Runtime RPC / Unix socket 集成用例，生成待用重连码后断开，再持旧码握手。定向测试失败于 `A pre-revocation ticket was accepted`：期望 EOF，实际收到 360 bytes。未保留响应中的凭据或票据。

断开现在在原有 registry → state 锁顺序下删除该 binding 的全部待用挑战，且不依赖窗口在线。仍撤销原凭据、关闭自有 socket，保留明确重新连接所需的冻结身份。其他 binding 的挑战不受影响。

扩充回归验证：两份在线时生成的待用码均拒绝；离线后新生成的码在再次断开后也拒绝；旧凭据拒绝；另一工作区待用码成功；明确生成新码后恢复原 binding、原 operation 与同一原生 UUID，不再导入，原历史保持准确，目标身份数量仍为 1。

### 新增轮次复用旧正文哈希

修复前，新正例 `recovery_allows_new_turns_to_reuse_historical_prompt_blobs` 稳定失败，错误为 `Cursor IDE recovered model history differs from preview`。原实现统计整条当前历史内已审核哈希，新增正文相同的轮次会增加计数。此前一次误加 `--exact` 的命令运行 0 项，不计入复现或通过证据。

恢复现在逐项核对已审核模型历史的连续前缀；其后的旧哈希或已核实 assistant 编码变体，每次复用须按顺序匹配一个实际新增 UI 轮次的角色与准确正文。仍验证全部已审核原 blob 存在且字节相等。额外私有上下文引用不读取正文；未知引用插入历史前缀仍拒绝；首次导入 `exact=true` 的严格校验不变。

新增 3 个测试覆盖：新增 user/assistant 重复正文、历史和新轮次连续相同角色、Unicode、新正文与重复正文混合、固定 assistant 编码变体；以及历史引用插入、未知替换、缺失、重排、尾部超额/乱序、角色错配、原 blob 删除/损坏。旧 mutation 2/3（没有新增 UI 轮次却多出模型引用）仍拒绝。正例同时断言校验不会修改数据库；首次导入严格分支仍拒绝续聊后的历史。

## 实际检查

| 命令                                                                                                                                      | 结果                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test -p agentkib-runtime --test cursor_bridge disconnect_revokes_old_credential_then_ticket_recovers_original_operation`（修复前） | 0 passed / 1 failed；旧码被接受，触发原缺陷                                                                                    |
| `cargo test -p agentkib-conversations recovery_allows_new_turns_to_reuse_historical_prompt_blobs -- --nocapture`（子代理，修复前）        | 0 passed / 1 failed；重复正文触发原缺陷                                                                                        |
| `cargo test -p agentkib-runtime --test cursor_bridge`                                                                                     | 11 passed / 0 failed；其后又补充离线发码再撤销的断言，由下方全包验证覆盖                                                       |
| `cargo test -p agentkib-runtime -p agentkib-conversations`                                                                                | Runtime 243 passed / 1 ignored；conversations 206 passed / 8 ignored；合计 449 passed / 0 failed / 9 ignored；`rust-tests.log` |
| `cargo clippy -p agentkib-runtime -p agentkib-conversations --all-targets -- -D warnings`                                                 | exit 0；`clippy.log`                                                                                                           |
| `cargo fmt --all -- --check`                                                                                                              | exit 0；`rust-format.log`                                                                                                      |
| `pnpm exec oxfmt --check docs/SESSION-INTEROPERABILITY.md qa/cursor-reconnect-recovery-p2-2026-10-02.md`                                  | exit 0                                                                                                                         |
| `git diff --check`                                                                                                                        | exit 0                                                                                                                         |

修复前两次失败的原始输出仅保留在本聊天工具记录中，未另存日志；本机证据清单保存其失败摘要，不冒充完整原始日志。

本次未修改前端代码。两个上一轮 UI 文件的 SHA256 与原证据清单一致，沿用上一轮已通过的 frontend format、lint、typecheck 和全套桌面/Web 测试结果；不将它们描述为本次重新执行。

独立子代理只读复核 accept / begin / disconnect 的实际 RPC 调用与锁路径，以及恢复前缀、消费式尾部匹配、原始 blob 和新旧负例，未发现确定缺陷。没有动态强制制造握手与撤销的锁交错。恢复路径仍仅校验新增已知旧引用与新增 UI 的对应，不核对所有新 UI/model 的双向对应，此为原有 `exact=false` 校验范围。

本轮没有真实 Cursor GUI、模型回复、手机或 Windows/Linux 实机补验，也未重做安装包验收；自动化不替代这些结论。没有提交、推送、发布、修改安装或用户凭据。
