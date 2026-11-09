> Historical migration assessment. Its Rust comparison, outstanding gates, and platform requirements describe the pre-migration state and are retained only as history. The current migration status and remaining real-Agent acceptance are tracked in `list.md`.

# Runtime 后端对照实验

## 當前狀態

此文件記錄的是遷移開始前的評估，不代表目前產品狀態。Rust runtime、Cargo workspace 與 Rust 封裝入口已移除；桌面正式執行路徑使用 TypeScript backend。第 8 批已完成，第 9 批 macOS arm64 封裝與啟動 smoke 已驗證。依使用者指示，驗收只涵蓋 macOS，不要求 Windows／Linux build。第 3／7 批仍欠缺本機可用的第二 Agent 原生 session 與真實 Claude CLI 的互通驗收，見 `list.md`。

## 比较对象

| 方案 | commit / 状态 | 说明 |
| --- | --- | --- |
| `origin/main` 原始 Rust | `f77a080`，已采样 | 原始串行启动基线 |
| 优化 Rust | `codex/optimize-rust-runtime-startup`，已采样 | 窗口先创建，请求等待 readiness；握手先于 MCP Hub |
| TS Worker | `a48f449`，已采样 | `typescript-backend-spike`；相对当前 main 落后 19 个提交，版本仍为 0.5.0 |

下方的比較數據與門檻是當時 `typescript-backend-spike` 的狀態，不能用來描述目前遷移結果。

## 可复现实验

在待测分支完成 Release 构建后运行：

```bash
pnpm build
pnpm benchmark:runtime -- --backend rust --label rust-optimized --clean-runs 5 --reuse-runs 10
node apps/desktop/scripts/benchmark-runtime.mjs \
  --backend typescript \
  --desktop /path/to/typescript-backend-spike/apps/desktop \
  --label typescript-backend-spike \
  --clean-runs 5 \
  --reuse-runs 10
```

每次启动使用隔离的 Electron profile、Runtime 数据目录、Codex 目录和 Claude 目录，不读取真实用户数据。复用 profile 组在同组运行之间保留缓存；干净 profile 组每次重新创建目录。

启动时间线包含 Electron main、app ready、后端 spawn/handshake、BrowserWindow 创建/显示、Renderer 首次提交、`runtimeInfo` 和首页查询完成。核心负载使用确定性临时夹具：401 个工作区文件、5,000 行 Claude 会话、101 个 SQLite 工作区；会话事件读取统一限制为 500 条，以满足两组共同的公开参数约束。

## 性能结果

采样环境为同一台 Apple M2 Max、Release 构建。每组包含 5 次干净 profile 和 10 次复用 profile；内存在启动条件满足后额外等待 1 秒再采集。“首次可交互”以主窗口完成 Renderer 首次提交并实际显示为准。最终两组数据均在严格模式下重新采样：所有必需首页查询必须成功，任一查询失败都会让该次基准非零退出，不能产出成功时间线。

### 启动与内存

| 指标 | 优化 Rust | TS Worker | TS 相对 Rust |
| --- | ---: | ---: | ---: |
| 干净 profile 首次可交互 p50 | 283.11 ms | 466.66 ms | 慢 64.8% |
| 干净 profile 首次可交互 p95 | 327.84 ms | 543.69 ms | 慢 65.8% |
| 复用 profile 首次可交互 p50 | 231.84 ms | 471.56 ms | 慢 103.4% |
| 复用 profile 首次可交互 p95 | 294.47 ms | 475.92 ms | 慢 61.6% |
| 干净 profile 合计 RSS p50 | 572,432 KiB | 604,256 KiB | 多 5.6% |
| 复用 profile 合计 RSS p50 | 569,968 KiB | 601,168 KiB | 多 5.5% |
| 后端握手 p50（干净） | 215.06 ms | 105.89 ms | 快 50.8% |
| 首页数据完成 p50（干净） | 465.62 ms | 360.76 ms | 快 22.5% |

TS Worker 的握手确实更快，但该分支仍执行 `await runtimeHost.start()` 和 `runtimeInfo` 后才创建窗口；因此后端优势没有转化为首屏优势。即便忽略窗口 `ready-to-show` 延迟，只比较 Renderer 首次提交，TS 的 318.94 ms 仍慢于优化 Rust 的 283.10 ms。

TS 分支比当前 main 落后 19 个提交，Renderer 和页面重量不完全相同，所以启动数值只作为方向性证据；但 TS 在较旧 UI 上仍明显更慢，结论不会因此反转。

### 确定性负载

| 指标 p50 | 优化 Rust | TS Worker | TS 相对 Rust |
| --- | ---: | ---: | ---: |
| 工作区扫描 | 0.16 ms | 1.32 ms | 慢约 8.3 倍 |
| 会话索引 | 1.54 ms | 1.82 ms | 慢 18.2% |
| 500 条会话事件解析 | 12.52 ms | 9.22 ms | 快 26.4% |
| SQLite 工作区列表 | 1.89 ms | 1.33 ms | 快 29.6% |
| SQLite 活动列表 | 0.75 ms | 0.17 ms | 快 77.3% |

TS 在文本解析和 Node `node:sqlite` 小查询上有优势；Rust 在文件扫描和会话索引上明显更快。按照“任一关键负载不得恶化超过 10%”的预设规则，TS 不能通过性能门槛。

工作负载中的 TS RSS 为独立 Node bridge + Worker 合计 162,160 KiB，Rust 子进程为 23,664 KiB。由于 TS 实际部署会复用 Electron main 的 Node 进程，这两个隔离后端数字不直接作为裁决依据；上表采用完整 Electron 进程树 RSS，TS 在该指标上多约 5.5%，仍在 10% 限制内。

原始结果：

- `qa/runtime-benchmark-rust-origin-main.json`
- `qa/runtime-benchmark-rust-optimized.json`
- `qa/runtime-benchmark-rust-optimized-parity.json`
- `qa/runtime-benchmark-typescript-backend-spike.json`

## 功能与工程门槛

| 门槛 | 优化 Rust | TS Worker | 结论 |
| --- | --- | --- | --- |
| 当前 Runtime 方法覆盖 | 107/107 | 107/107，另有 4 个旧/内部方法 | 通过静态覆盖 |
| 崩溃恢复 | 明确状态机、请求排队、有限重启、手动重试 | Worker `error` 后直接发出 `crash-loop` 并停止 | TS 未通过 |
| 当前 main 功能基线 | 当前 `f77a080` | 落后 19 个提交，缺少 0.6.0、诊断闭环、v8 UI/导航等 | TS 未通过 |
| 数据兼容 | 现有 Rust schema | 声称保持 schema 10，但 Rust↔TS 差分和回读门槛未签字 | 待验证 |
| 路径兼容 | canonical path 测试通过 | `/var` 与 `/private/var` 同一工作区无法匹配 Claude 会话 | TS 未通过 |
| TypeScript-only 构建 | 不适用 | main/preload/worker 构建通过 | 通过 |
| 默认测试去 Rust | 不适用 | 當時 desktop `test` 仍先執行 `runtime:build:dev` | 歷史狀態；目前見 `list.md` |
| Windows/Linux 安装运行 | 现有 CI 基线 | 當時分支文件尚待 release host smoke | 非目前使用者要求的驗收範圍 |

路径问题由相同基准夹具直接复现：存储层把 macOS `/var/...` canonicalize 为 `/private/var/...`，会话索引只用 `path.resolve` 比较来源路径，最终同一工作区返回零会话。修正夹具为 canonical path 后才能继续测纯性能，这一调整没有掩盖兼容缺口，缺口本身仍计为硬门槛失败。

构建还对 `@iarna/toml` 的 direct `eval` 发出两次安全/压缩警告。它不是已证实漏洞，但在替换前应更换解析路径或给出明确的打包安全评估。

## 架构差异

| 维度 | 优化 Rust | 当前 TS spike |
| --- | --- | --- |
| 进程模型 | Electron main + 独立 Rust Runtime | Electron main + Worker thread |
| 通讯 | stdin/stdout JSON-RPC | `MessageChannel` |
| 启动策略 | 主窗口与 Runtime 并行 | Worker handshake、`runtimeInfo` 后创建窗口 |
| 崩溃隔离 | 子进程可独立重启 | Worker 失败后主机停止，无重建路径 |
| 打包 | Rust 可执行文件 + Electron | 约 1.18 MB worker bundle + 新增 Node 生产依赖 |
| 服务器/容器方向 | Runtime 已是 headless 进程边界，可替换 transport | 当前 registry 只接 Worker transport，部署服务端仍需新建 transport/生命周期层 |

如果 AgentKib 后续真的转向云端 Agent 管理，独立 Runtime 边界不是包袱，反而更接近可部署 daemon。TS 也能做服务器，但当前 spike 的主要优势是 Electron 内部开发一致性，不是已完成的服务端复用能力。

## TS 再次参赛的最小条件

1. 基于当前 `main` 重放实现，不直接合并落后 19 个提交的分支。
2. 复用同样的非阻塞窗口启动顺序，而不是用串行启动抵消 Worker 优势。
3. 补齐 `starting/ready/restarting/failed/stopping` 状态机、有限重启、请求等待和手动重试。
4. 修复 canonical path 会话匹配，并加入 `/var`、symlink、大小写和网络盘夹具。
5. 完成 Rust↔TS 数据库回读、方法输出、错误语义和高价值 fixture 差分测试。
6. 讓預設開發、CI 和 macOS 安裝包不依賴 Cargo。（已由後續遷移完成；Windows/Linux build 不在目前驗收範圍。）
7. 处理 TOML direct `eval` 构建警告后，用同一基准重新采样。

在这些条件完成前，建议保留 Rust Runtime，把 TS 分支中更快的会话解析和 SQLite 查询实现作为定向优化线索，而不是整体替换后端。
