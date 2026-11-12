# Codex 托管会话目录读盘复测

macOS arm64、Node 26.13.0，比较桌面 `v0.30.0`（`b29debab9`）与修复后的工作树。独立 Node 进程走真实本地目录投影，使用同一份 39.4 MiB 临时 SQLite，包含 5,000 个合成线程、24 个工作区和 24 个托管归属。样本包含大写 UUID 与无项目集合中的会话。没有连接原生 Agent 或读取生产凭据。

| 指标                            |    v0.30.0 |   修复后 |
| ------------------------------- | ---------: | -------: |
| 首次刷新耗时                    |   384.0 ms |  18.7 ms |
| 首次刷新 CPU                    |   512.0 ms |  22.6 ms |
| 首次刷新打开原生数据库          |      27 次 |     1 次 |
| 连续 8 次刷新耗时               | 2,971.6 ms |  76.4 ms |
| 连续 8 次刷新 CPU               | 3,093.4 ms | 101.9 ms |
| 连续 8 次刷新打开原生数据库     |     216 次 |     0 次 |
| 连续 8 次刷新全表元数据查询     |     208 次 |     0 次 |
| 连续 8 次刷新元数据查询返回行数 |  1,040,000 |      384 |
| 连续 8 次刷新结束时进程 RSS     |  173.9 MiB | 54.1 MiB |
| 连续 8 次刷新结束时进程峰值 RSS |  197.8 MiB | 88.9 MiB |

首次、重复及另一 SQLite 连接更新标题后的目录结果均逐项等价。更新后的目录在两版都读到了新标题，修复版重新查询一次 UUID 索引。两版采样区间的进程归属物理读写均为 0 B，测试使用系统暖缓存。CPU、RSS 和 SQLite 查询数的对比仅覆盖这条目录刷新路径。

另以 Instruments 的 File Activity 分别跟踪两版进程，按临时 `state_5.sqlite` 和其旁文件过滤 `FsSyscall`。整个场景包含 10 次刷新及测试夹具写入和还原标题。`pread` 从 1,354,342 次降到 216 次，返回的逻辑读取字节从 5,544,082,380 B 降到 778,808 B。逻辑读取包含由系统缓存满足的请求。

在仓库根目录复测，当前工作树须已安装项目依赖。仅运行当前工作树可省略 `--baseline-root`。macOS 物理 I/O 计数另需 Python 3。

```sh
benchmark_baseline=$(mktemp -d)
git archive v0.30.0 | tar -xf - -C "$benchmark_baseline"
node apps/desktop/scripts/benchmark-codex-catalog-io.mjs --baseline-root "$benchmark_baseline"
```
