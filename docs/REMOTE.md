# Native desktop connections / 原生桌面连接

## 中文

本文仅描述桌面「连接其他电脑」的原生局域网协议，与 [手机访问](REMOTE-CODEX-WEB.md) 及 [浏览器 LAN 直连](WEB-HOSTED-LAN.md) 分开配置和配对。

AgentKib 可以连接另一台 AgentKib，也可以允许其他设备查看本机历史。本阶段只读：不发送消息、不审批或停止 Agent，不提供远程桌面、Shell、公网 Relay 或 Web 客户端。

1. 打开“设置 → 远程连接 → 高级设置”，选择并保存私有 IPv4 接口，再在“其他电脑 → 共享这台电脑”开启“允许其他电脑查看（只读）”。共享开关立即生效，默认关闭；连接其他电脑不要求开启自己的共享。电脑名称在统一“保存设置”后生效。
2. 主机生成一次性配对码。控制端从「更多 → 远程连接」发现主机，或输入主机显示的 IPv4 地址和端口。
3. 输入 8 位配对码后，两端核对同一组校验数字。主机确认设备和授权范围后批准；数字不一致时拒绝。
4. 控制端在「会话」中按主机、工作区查看已索引的历史。目录定期更新，正文按选择和分页读取；远程记录没有本地续接操作。

### 授权与隐私

- 授权允许查看**全部已登记工作区以及以后新增工作区**的会话历史，可能包含代码、路径和敏感信息。仅批准可信设备。授权单向生效，不自动开放反向访问。
- 配对码 5 分钟过期，错误累计 5 次失效；重新生成、成功提交、拒绝和超时使相应配对凭据失效。成功提交后仍须主机批准，数字校验绑定双方证书及本次连接。
- 后续连接使用持久设备证书固定；证书变化需要重新配对。私钥与授权在各自 Stable/Dev 数据目录的受限文件中保存，配对码仅存内存。
- 关闭共享会停止监听、广播和入站连接，但保留授权；「撤销」禁止对应设备继续访问。关闭主机的会话索引会停止历史共享，不会由远程请求自动开启或扫描。
- 控制端的远程目录和已读正文只留在进程内存。临时掉线保留缓存并标记最后获取时间；确认撤销、停止共享、关闭索引或移除连接后清除。

### 网络与限制

首版仅支持局域网私有 IPv4，监听选定网卡，不绑定所有网卡，不设置端口映射或更改防火墙。mDNS 不可用时可尝试手动地址；访客网络隔离、防火墙及系统局域网权限可能阻止连接。应用不会为排障自动关闭这些安全措施。

当前历史沿用已有 Codex / Claude Code 会话读取能力，不声称所有 Agent 都有可读取历史。网络只开放白名单配对和只读目录/分页接口，不转发任意桌面 RPC 或接受文件路径。目录与历史读取受体积、分页和并发上限约束。

## English

This guide covers native desktop-to-desktop connections. [Phone access](REMOTE-CODEX-WEB.md) and [browser LAN access](WEB-HOSTED-LAN.md) use separate configuration and pairing.

AgentKib can connect to another desktop and accept incoming devices independently. This stage shares read-only history: no message sending, Agent approvals/stopping, remote desktop, shell, public relay or web client.

1. Open **Settings → Remote connections → Advanced settings**, select and save a private IPv4 interface, then enable **Allow other computers to view (read-only)** under **Other computers → Share this computer**. Sharing takes effect immediately and is off by default; outgoing connections do not require it. Save computer name changes with the shared **Save settings** action.
2. Generate a one-time code. On the controller, use **More → Remote connections** to discover the host or enter its displayed IPv4 address and port.
3. Enter the eight-digit code and compare the verification numbers on both devices. The host explicitly approves the device and scope; reject mismatching numbers.
4. Browse indexed history in **Sessions**, grouped by host and workspace. Directories refresh periodically; transcript pages load on selection. Remote records cannot use local workspace continuation.

### Authorization and privacy

Authorization covers **all registered workspaces, including future additions**. History may contain code, paths and sensitive data. Approve only trusted devices. Grants are one-way, not reciprocal.

Codes expire after five minutes or five failed attempts. Regeneration, successful submission, rejection and timeout invalidate the corresponding pairing credentials. Submission still requires host approval. Verification binds both certificates and the current connection; subsequent connections pin the persistent device certificate. Identity changes require pairing again.

Private keys and grants live in restricted files inside the current Stable/Dev data directory. Codes remain in memory. Disabling sharing stops listening, advertising and incoming connections but retains grants. Revocation blocks that device. Disabling host session indexing stops history sharing; remote reads never enable indexing or trigger a scan.

Remote directories and loaded transcripts remain in controller process memory only. Temporary network loss retains visibly stale history; confirmed revocation, sharing/index shutdown or connection removal clears it.

### Network and limits

Only private LAN IPv4 is supported. AgentKib listens on the selected interface, does not bind every interface, configure port forwarding or change firewall rules. Try a manual address if mDNS is unavailable. Guest-network isolation, firewall rules and OS local-network permissions may prevent connection; the app never disables these protections automatically.

History currently uses the existing Codex / Claude Code readers, not universal Agent support. Network operations are allowlisted pairing and read-only catalog/pagination capabilities, not arbitrary desktop RPC forwarding or file-path input. Size, pagination and concurrency limits apply.

## Validation boundary / 验证边界

Automated TLS and isolated dual-Runtime tests do not replace real cross-device acceptance. Validate discovery, certificate approval, revocation, firewall prompts and OS permissions on the intended machines. Windows file ACL enforcement also requires Windows verification.

自动 TLS 与隔离双 Runtime 测试不能代替真实跨设备验收。请在目标机器验证发现、证书确认、撤销、防火墙提示和系统权限；Windows 文件 ACL 实际生效也需要 Windows 验证。

## Phone and computer list feedback

Phone access-code guidance states the complete authorization scope in one paragraph: all current and future workspaces, no further confirmation on the computer, read-only history/files, full-control task actions/approvals/uploads, and sharing only with your own devices. Access levels and revocation remain in the authorized browsers list

An empty authorized-browsers list or nearby-computers list displays an explicit hint without an empty bordered row. Loading, failed reads and active discovery are not reported as an empty result. This changes presentation only; relay readiness, pairing, grant scope and security checks are unchanged
