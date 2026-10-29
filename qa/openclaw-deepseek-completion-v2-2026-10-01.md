# OpenClaw 2026.9.6 / DeepSeek 补验

本轮使用新隔离 Grok→OpenClaw 公共导入，完成一次真实模型请求和两次禁网原生 TUI 恢复。严格原始结果为 `false`：原决策中的 `with namespace` 被模型表述为 `, namespace`。原结果及执行错误文件均保留；独立整句审计通过，未修改 runner 的答案判定，也未重试模型。

证据根：`/Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2`。

## 固定环境与公共导入

- OpenClaw `2026.9.6`，Node `v26.9.0`；Node SHA256 `91ed66b8cd139609427a3e9d93518dd3b0d5407c737fc9a265bfd991ec623d8a`。
- `public-case` 经生产 `prepareHandoff → planHandoff(ChangeSet) → continueHandoff`，完成重复调用及运行时重启回执检查。新原生 ID：`9c18ade7-4410-47b7-ac43-78473ec76366`。
- 模型 `deepseek-v4-pro`。隔离配置 `reasoning:true`、原生 `--thinking medium`；实际协议严格为 `thinking:{type:"enabled"}`、`reasoning_effort:"high"`、`max_completion_tokens:4096`。
- 原生在线子进程只可访问本次 loopback relay；官方历史读取和两次 TUI 均全 OS 禁网。真实密钥只在 relay 内存中，未复制凭据文件或更改全局配置。
- 使用已有 CA，SHA256 `c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7`，保持证书及主机名校验。

## 一次真实请求

`live-01`：admitted=1、dispatchAttempts=1、HTTP `[200]`、blocked=0、CLI exit=0；唯一新用户消息和唯一 `stop` 完成的 assistant，无工具调用。

实际完整答案：

```text
AKIB-e4adcb839f074b05a7
append-only SQLite WAL, namespace cobalt-lake
```

原始 SSE、CLI payload、原生 SQLite 正文逐字相等。上游 usage 为 input=2275、output=109，其中 reasoning=83。来源、原导入事件前缀不变，同 ID 在 6 个合成会话中只出现一次。

- 严格原结果：`live-01/result.json`，SHA256 `d2cb72d34598efacb2133bfc9e67f3979147ea09a18783e3fc641d9d25d78b54`，仍为 `false`。
- 独立审计：`live-01/acceptance-audit.json`，SHA256 `0914027daabaee848264bca1971b1f42ee1d921b412e17210f0379c7505b8e28`，为 `true`。
- 独立审计只接受完整固定两句的 `with namespace` 或 `, namespace` 表述，要求 marker 唯一、全部决策词准确；不接受散词匹配、缺词、否定或额外内容。旧缺失 namespace/storage 的失败不提升。

## 两次禁网恢复及元数据

`live-01/offline-restarts/result.json` 为 `true`。两次独立 TUI 均完整显示 5 条消息的正文、角色和顺序，零输入、零模型请求。当前数据库与恢复后快照一致，原配置字节恢复，全部 15 个本轮原生进程组已外部 `ps` 确认消失。

元数据逐字段验证，不忽略整表：精确 TUI 会话指针；配置健康签名及时间；唯一 `config.observe/read` 记录及所属 PID/argv/stat/hash；官方迁移版本与两个配置指纹；首次 canonical receipt 的 `dev:ino/birthtimeNs`；agent registry 的实际文件尺寸和窗口内时间。其他表、schema 和历史字段全部不变。

## 验证与保留的失败

- 请求合同：22 个负例通过，顶层 7 个字段及 `stream_options.include_usage` 精确限定。
- 元数据：2 份实际快照正例、28 个字段漂移负例通过。
- TUI：20 个 UTF-8 正例、15 个正文/角色负例通过。
- `mock-01` 因 reasoning 模式新增历史 assistant 的空 `reasoning_content` 被旧合同拒绝，0 次真实派发；原失败保留。此后仅允许该精确位置的空字段。
- `mock-02/offline-restarts` 的初版元数据合同拒绝首次派生缓存/registry 变化，原 `false` 保留。按固定官方实现建立逐字段合同后，`mock-03` 和其两次禁网恢复通过。
- 真实请求前经过另一代理审查；最终在线 runner SHA256：`acce08e3c29d1306b4d635bd15e72440156e61079c243ffbc951f9ed1d7be65f`。
- 原始运行在销毁 relay 前扫描真实密钥和随机 loopback token；独立审计另以内存真密钥扫描 83 个当前证据/原生文件。随机 token 已销毁，不声称重新获取或重扫它。

执行命令：

```sh
python3 qa/probes/openclaw-public-prepare.py
python3 qa/probes/deepseek-openclaw-native-once.py --selftest
python3 qa/probes/openclaw_metadata_contract_selftest.py
python3 qa/probes/openclaw-postreply-offline-selftest.py
SSL_CERT_FILE=/Users/user/Library/Python/3.11/lib/python/site-packages/certifi/cacert.pem python3 qa/probes/deepseek-openclaw-native-once.py /Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2/public-case /Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2/live-01
python3 qa/probes/openclaw-postreply-offline.py /Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2/live-01 /Users/user/Documents/AgentKib-archives/2026-10-01/provider-retest/OpenClaw/completion-v2/live-01/offline-restarts
```

上述目录与单次 token 已消耗；命令仅作执行记录，不可重新执行真实请求。本轮无生产代码修改、依赖变更、提交或推送。
