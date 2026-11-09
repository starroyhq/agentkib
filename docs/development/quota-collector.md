# 额度与本机费用采集器

桌面额度和费用采用两条独立路径。额度只读 dashboard 的配额、多账号 ID、窗口标签和未知值；本机费用只扫描原生 Codex / Claude Code 日志。费用是日志用量乘以公开 API 标价的 USD 估算，与额度页面当前登录账号、订阅账单和实际扣款无关。

## 固定源码与补丁

`apps/desktop/scripts/quota-collector/lock.json` 固定源码 archive 校验值、完整 commit、依赖锁文件校验值、补丁版本、补丁与修改文件校验值、构建工具链和 Linux SDK / SQLite 校验值。

| 平台              | 上游                | commit                                     | 构建工具链                                                                             |
| ----------------- | ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| macOS arm64 / x64 | CodexBar 0.83.0     | `348e2fa8d36ae8e452739ca07a79e83ab9d25e98` | Xcode 27.1 (`27A9275`)，Apple Swift 6.4 (`swiftlang-6.4.0.34.1`)                       |
| Linux arm64 / x64 | CodexBar 0.83.0     | 同上                                       | Swift 6.3.3，`swift-6.3.3-RELEASE_static-linux-0.1.0`，musl 1.2.5，固定 SQLite 3530400 |
| Windows x64       | Win-CodexBar 0.70.0 | `f0b45ed422513eaf3e58ef0e321e1b02424547be` | Rust 1.92.0，MSVC，`Cargo.lock`                                                        |
| Windows ARM64     | 不支持额度采集      | —                                          | 不打包、不调用 x64 替代品                                                              |

Linux 的资源名继续沿用 `*-unknown-linux-gnu`，实际 CLI 使用上游静态 musl 构建方式；不因此提高到 glibc 2.39。macOS CLI 延续上游 macOS 14 最低要求，不改变 AgentKib 主程序的最低系统版本。

两个补丁均保持默认调用行为，新增以下选项：

```sh
dashboard --no-local-costs --provider codex --identity full --timeout 25
cost --provider codex --format json --days 30 --provider-native-only --agentkib-native-only
```

Swift 可另带 `--json-only`，Windows 不带。`dashboard --no-local-costs` 不调用独立费用采集函数；`--provider` 在采集前过滤，继续使用原 dashboard 投影和多账号逻辑。

`--agentkib-native-only` 只接受 Codex 或 Claude 单一 Provider，使用机器本地自然日，排除 Pi / OMP、OpenCodex / OpenCode、额外自定义与 WSL 导入目录、Claude Desktop / swap 历史和 Windows 自定义价格。结果每个 Provider 带有 `agentkibNativeOnly: true`，后端验证此标记。上游已有的 `--provider-native-only` 和所有未指定新增选项的行为保持原样。

`AGENTKIB_COST_CACHE` 由电脑后端指定为当前日志根、配置、时区范围的独立目录；刷新沿用上游增量缓存，不传 `--refresh`。范围标记或新选项不受支持时保留缓存并报告更新采集器，不退回混合采集。

## 构建与资源校验

从仓库根目录运行：

```sh
node apps/desktop/scripts/prepare-quota-sidecar.mjs
node apps/desktop/scripts/stage-electron-quota.mjs
node --test apps/desktop/scripts/quota-collector/build.node-test.mjs
node apps/desktop/scripts/quota-collector/verify.mjs
node apps/desktop/scripts/quota-collector/verify.mjs --source-tests
```

`prepare` 从固定来源解压、校验锁文件、应用并校验补丁，再复用上游 CLI 构建方式。`AGENTKIB_QUOTA_TARGET` 指定目标，macOS arm64 可以交叉构建 macOS x64；Linux 和 Windows 在对应原生架构 / 平台运行。Linux 需要 clang、llvm-ar、unzip、curl，脚本校验并安装固定静态 SDK、编译固定 SQLite。macOS 不添加上游未采用的静态 Swift 链接参数。

资源清单在 `apps/desktop/resources/quota/manifests/<target>.json`，记录实际文件 SHA-256、上游版本、完整 commit、补丁及工具链。缺少清单、内容不符、旧官方未打补丁二进制均明确失败，不静默打包。二进制和资源 bundle 仍属于本地构建产物；许可证和源码补丁纳入版本管理。固定构建输入及命令并不承诺不同操作系统 / 链接器生成的二进制逐字节一致。

可用 `AGENTKIB_QUOTA_BUILD_CACHE` 调整构建缓存目录，或通过 `AGENTKIB_QUOTA_SOURCE_ARCHIVE` 提供离线源码 archive（仍验证锁定 SHA-256）。不接受用任意外部二进制替代已锁定的 patched CLI。`--rebuild` 强制按源码重新构建，不影响费用日志缓存。

CI 的 `Patched quota collector acceptance` 工作流构建全部受支持目标。macOS 使用公开 `xcode-27` arm64 runner 上固定的 Xcode 27.1，同时构建两个架构；Electron 原有 macOS 15 打包 runner 只接收经清单校验的 artifact，不依赖其旧 Swift。发布流程先通过该工作流，再打包签名。Windows ARM64 继续明确不支持采集。

## 隔离验收与限制

`verify.mjs` 创建临时 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、配置与费用缓存；只写合成会话，不继承 provider 凭据，使用不可达代理阻止定价网络调用。核对 Codex 110 Token、Claude 135 Token、真实每日结果、范围标记，以及额外 swap 历史不被统计；结束后删除临时目录。可用 `AGENTKIB_QUOTA_FIXTURE_OUTPUT` 保留合成 JSON，供后端解析回归使用。

`--source-tests` 在 macOS 运行实际 dashboard producer、原稳定多账号与未知窗口测试，检查禁用费用后调用次数为零及默认行为保留；Windows 运行对应 Rust producer / dashboard 投影测试。Swift 上游测试依赖 `DEBUG` 测试 hook，应使用 debug 测试配置，不能以 release 编译的测试失败归咎于生产采集器。Linux 运行真实隔离 CLI，公共 Swift producer 的源码测试在 macOS 执行。

费用进程最多 5 分钟；单次 Codex 增量扫描有自身文件 / 字节限制，历史可能分多轮补齐。被取消或强杀并不保证上游已保存本轮检查点。未知费用、未定价模型和未覆盖日期保留未知；不能将缺少日期补成 0 或把占位额度当成真实百分比。

本轮已在本机构建 macOS arm64 和 x64，分别原生与通过 Rosetta 完成资源检查、真实隔离费用命令，并核对两份资源清单。共享 Swift producer / 投影的 32 项源码测试通过。Linux 和 Windows x64 的原生执行需在对应 CI / 工具链完成后才能认定通过；Windows 上游当前不能直接在 macOS 编译（Muse 使用 Windows 文件 API），不能把该失败改写成通过或用模拟输出替代原生验收。
