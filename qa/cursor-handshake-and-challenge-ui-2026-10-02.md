# Cursor 握手与连接码清理 QA（2026-10-02）

## 源码与证据

- 工作树：`/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`。
- 分支：`codex/main-acceptance-20260930`；HEAD：`f706abaffac9950d616121f4dc86ef830a41aa09`。实际验证对象为 dirty 源码。
- 保留前两轮未提交修改；原 QA 和证据不改写，参见 [登记隔离与首次连接](cursor-connection-p2-2026-10-02.md)、[撤销重连码与重复正文](cursor-reconnect-recovery-p2-2026-10-02.md)。
- 本轮增量：Runtime `cursor_bridge.rs`、其集成测试，桌面 `CursorBridgePanel.tsx` 和组件测试，以及使用说明与本记录。没有新增依赖、RPC 或持久化格式变更。
- macOS 本机；Rust / Cargo 1.92.0，前端 Node v22.23.2、pnpm 10.8.1。Cursor 合约仍限定 3.22.12，未扩展版本或平台门限。
- 原始日志与源码/Runtime 二进制 SHA256：`~/Documents/AgentKib-archives/2026-10-02/cursor-handshake-and-challenge-ui/`。目录 0700，文件 0600；只使用隔离合成数据，不记录真实挑战、凭据或用户正文。

## P2：延迟或分片 hello 被立即关闭

修复前新增真实 Runtime 集成测试 `delayed_hello_can_pair_and_reconnect`：建立 Unix socket 后故意延迟 50ms 再发送合法 hello。定向测试 0 passed / 1 failed，错误为 `BrokenPipe`；原输出保存在 `handshake-before.log`。macOS 接受的 socket 继承监听器非阻塞标记，原 `set_read_timeout` 无法让读取等待数据。

修复在 `accept` 读取 hello 前执行 `set_nonblocking(false)`，继续使用原有 3 秒读写超时。监听器仍保持非阻塞，握手等待不占用 Runtime 主请求循环，也不持有 registry/state 锁。

新增三个用例分别验证：

- 单帧 hello 的首字节延迟 50ms，首次配对与凭据重连成功。
- 首片立即发送、后两片各延迟 50ms，合法三片 hello 可完整解析；首次配对与重连均成功。
- 静默连接及只有 JSON 前缀的残缺帧超时关闭，绑定列表为空；失败不消费有效挑战，后续完整 hello 仍能配对。

延迟/分片过程中，普通 `runtime.info` 请求在每次测试设定的 1 秒内响应；重连沿用同一 binding、产生新 lease，不增加登记或原生会话，Runtime 退出后自有已连接 socket 关闭。

初轮 14 项桥接及 Runtime 全包通过后，将分片测试收紧为立即发送首片，避免与首字节延迟用例重叠；最终再次执行 Runtime 全包，结果见下表。保留初轮日志，不替换最终源码身份。

## P3：断开后仍展示已撤销连接码

实现子代理先补真实组件用例，生产未改时共 8 项测试，2 failed / 6 passed：断开已经成功，但 textarea 仍显示连接码。该失败输出仅保留在子代理工具记录，未另存完整日志；不能以本轮通过日志替代修复前证据。

挑战 state 现在保存实际 connect 请求的 binding ID。断开成功后、开始状态刷新之前，按本次断开请求的 binding 清除对应挑战，立即移除码、有效期提示与复制按钮。失败断开不清除仍有效的码；无 binding 的首次连接码和其他 binding 的码不被误清。

新增 5 个组件用例，只模拟 API 边界：断开成功而后续刷新等待/失败、请求中切换所选 binding、断开失败，以及断开其他 binding 时保留重连码或首配码。使用可控 Promise 与有限计时器推进，断言可见内容、复制状态、调用参数及轮询次数。修复后 8/8 通过。

## 实际命令与结果

前端命令均设置 `PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH`。

| 命令                                                                                                                                                                                                           | 结果                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `cargo test -p agentkib-runtime --test cursor_bridge delayed_hello_can_pair_and_reconnect`（修复前）                                                                                                           | 1 failed，exit 101；`handshake-before.log`                                           |
| `cargo test -p agentkib-runtime --test cursor_bridge`                                                                                                                                                          | 14 passed / 0 failed；`bridge-tests.log`；随后收紧分片用例，由最终全包验证覆盖       |
| `cargo test -p agentkib-runtime`（最终源码）                                                                                                                                                                   | 246 passed / 0 failed / 1 ignored；`runtime-tests.log`                               |
| `cargo clippy -p agentkib-runtime --all-targets -- -D warnings`                                                                                                                                                | exit 0；`clippy.log`                                                                 |
| `cargo fmt --all -- --check`                                                                                                                                                                                   | exit 0；`rust-format.log`                                                            |
| `pnpm --filter @agentkib/desktop exec vitest run src/features/workspace/CursorBridgePanel.test.tsx`（子代理）                                                                                                  | 修复前 2 failed / 6 passed；修复后 8 passed                                          |
| `pnpm --filter @agentkib/desktop exec vitest run src/features/workspace/CursorBridgePanel.test.tsx src/features/workspace/SessionHandoffDialog.test.tsx src/features/workspace/WorkspaceSessionsPage.test.tsx` | 3 suites，45 passed；`frontend-tests.log`                                            |
| `pnpm --filter @agentkib/desktop exec vitest run src/features/workspace/NativeImportRecoveryPanel.test.tsx`                                                                                                    | 1 suite，5 passed；`recovery-tests.log`                                              |
| `pnpm format:check`                                                                                                                                                                                            | exit 0；`frontend-format.log`                                                        |
| `pnpm lint`                                                                                                                                                                                                    | exit 0；既有 warnings 保留，未降低检查；`frontend-lint.log`                          |
| `pnpm typecheck`                                                                                                                                                                                               | 桌面 / Web exit 0；Web 生成路由的既有循环依赖 warning 保留；`frontend-typecheck.log` |
| `git diff --check`                                                                                                                                                                                             | exit 0                                                                               |

真实组件回归合计 50 passed。Vitest 输出中的既有 React Compiler 优化跳过提示保留，未屏蔽诊断。本轮没有重新执行全部 Web 测试、conversations 测试或桌面/hosted 构建，不将此前结果表述为本轮重新执行。

## 独立复核与限制

独立子代理只读复核 Runtime 的 accept / alive / call 模式与锁顺序、退出调用，以及 UI 绑定归属、刷新/失败/选择切换和相邻调用方，未发现本次修复引入的确定缺陷。

保留已有边界：3 秒是读取空闲超时，不是整帧绝对期限；持续慢速分片可能延长串行 accept 的占用。新增测试没有单独验证等待 hello 时退出或强制握手/断开交错，不将静态检查冒充动态验收。

本轮没有真实 Cursor GUI、模型、手机或 Windows/Linux 实机补验，没有安装包验收，也没有提交、推送、发布或修改用户安装与凭据。
