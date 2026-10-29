# OpenClaw 原生客户端离线故障验收 — 2026-09-30

用户已选择保留未通过，继续离线验收。以下调用均为未修改的固定版 OpenClaw `2026.9.6` CLI → 本机临时 relay → 本机 mock，不使用真实授权，不向 CPA 或任何模型/登录接口请求。**OpenClaw 的真实上下文回复仍未验收**；不提升方向兼容矩阵的真实互通等级。

## 输入与版本

工作树 `/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`，基线 `0440d04`，本轮处于 dirty 状态。只新增 QA 脚本与记录，没有修改第三方 CLI、用户 Agent 安装或产品协议。

从既有公共 RPC 导入用例 `native-interop/openclaw-rpc-v2` 制作独立 SQLite backup 副本；目标 session 为 `d8121789-4e47-4b46-b0ca-c459497c0360`。原始安装固定于 `native-interop/tools/openclaw/node_modules/openclaw`，Node `v26.9.0`。每个故障有新的私有目录，不复用已消费的 token。

正式 custom provider 使用 `api: openai-completions` 和 `apiKey: {source: env, provider: default, id: AGENTKIB_QA_CPA_KEY}`。只有进程环境持有明显的假测试值，关闭插件、工具与 bootstrap。模型名称保持选定的 `relay/claude-opus-5-5`，mock 返回合成错误，没有生成模型内容。

## 原生传输投影

初次 `openclaw-cpa-mock-v1` 被通用精确历史守卫拒绝，模型 mock 请求 **0**。该失败保留，不能算单派发测试通过。

固定版实际合并连续 user 消息，给历史首段及新提示加时间戳，将完整 Runtime 行从 system 部分移动到首个 user。`dist/legacy-Dc3ci2cN.mjs::migrateFinalLayoutKills` 明确删除旧 `envelopeTimestamp/envelopeElapsed/envelopeTimezone` 配置，不能沿用旧开关假装禁用。

新增 `openclaw_mock_projection.py` **仅供此版本、本机合成 fixture 的离线测试**：严格检查三条预期消息、每段原正文和角色、历史时间戳、完整 Runtime 行中的 session/model/host/version，以及新提示时间戳在启动时间范围内。没有忽略正文差异，也没有重写上游请求：仅将准确规范化投影交给原有 token 守卫，转发到 mock 的仍是逐字节原生 wire body。规范化与 wire 原文分别留证。此适配器禁止连接本机 CPA 的 8317 端口，不提供 live 路径；时间戳与 Runtime 规则不能外推其他版本、机器或来源。

纯投影自检有 9 个负例：三段首消息变化、助手正文变化、新提示变化、过早/未来时间、角色变化、额外消息，全部拒绝。

## 故障结果

| 本地用例 | mock 上游派发 | 原生 CLI 退出 | 结果 |
| --- | ---: | ---: | --- |
| `openclaw-cpa-mock-v2` / HTTP 500 | 1 | 1 | 原生重试被拦截，配置恢复与清理通过 |
| `openclaw-cpa-mock-429` | 1 | 1 | 同上；原生完整前缀和只读重启通过 |
| `openclaw-cpa-mock-redirect` / HTTP 307 | 1 | 1 | 不跟随 Location；重启 relay 后重复请求仍 409 |
| `openclaw-cpa-mock-network` | 1 | 1 | 连接中断后不再向 mock 派发；重启重复仍拒绝 |
| `openclaw-cpa-mock-stream` | 1 | 143 | 流中断后检测额外尝试并停止自有 CLI；重启重复仍拒绝 |

所有五例：持久 token 保留，原始来源数据库 SHA 不变，原生 wire 与 mock 收到内容逐字节相等，所有常规文件分块扫描没有假凭据落盘，原隔离配置精确恢复。PID 49482、53255、55028、55043、55093 均已退出，relay 和 mock 均关闭。500 用例在后续增加完整回读断言前执行，不沿用后续断言声称其全项通过。

429、307、连接和流中断用例额外使用官方只读 SQLite accessor 在两个独立 Node 进程中回读：导入原始事件前缀与 `plan.payload` 完全相等，总计仍为 6 个 fixture 会话、导入目标恰好 1 个，重启前后事件完全相同。307/连接/流中断另重建 relay，用相同 wire 请求验证持久 token 拒绝，既无第二次 dispatch 也无额外 mock 请求。这些证明本机失败恢复，不能代替真实模型回复、原生 UI 或所有来源方向验收。

## 命令与证据

```text
python3 qa/probes/openclaw-cpa-relay-mock.py <new-private-case> <archives>/native-interop/openclaw-rpc-v2 <500|429|redirect|network|stream>
python3 qa/probes/openclaw_mock_projection.py <archives>/native-interop/openclaw-cpa-mock-v2
```

证据根 `~/Documents/AgentKib-archives/2026-09-30/native-interop/`。每例包含 contract、原生 stdout/stderr、canonical/wire 请求、relay event、token 与 result；具有完整回读的用例另有 `native-after-restart.json`。汇总清理核对为 `openclaw-cpa-mock-final-audit.json`。

冻结脚本 SHA256：

- `openclaw_mock_projection.py`: `1d75342908ddb12fc38d089fc8c5db8240d1efd3fd91a4517662a6ac78275edf`
- `openclaw-cpa-relay-mock.py`: `3ae4ddddb864bef2c4ae815e47a4be7477480c61b2bcdc3a623cac836aae7e7a`

后续只保留离线证据和未验收项，不通过重新登录、改变身份或继续模型调用追求通过。

独立审查通过离线范围：重新执行 9 个投影负例，核对五例 wire 与派发哈希，扫描 109 个常规文件共约 14.9 MB，假凭据出现次数 0。汇总 audit 补充每例完整 probe/native argv 与 cwd；这些 argv 是按冻结执行器和 case 契约事后重建，启动时未自动录制，已在证据中标明，不冒充原始进程日志。
