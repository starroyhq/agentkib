# C 批远程连接视觉沙盒

这是合成 UI 夹具，不验证真实账号、连接服务、浏览器授权、配对、端口可达性或权限实现。
不导入个人配置，不运行模型。授权码固定为公开测试值 `12345678`，没有接受它的服务。

复用 B 探针的准备、合成会话导入和进程启动/停止；不修改 B 文件。由于 B 的根目录校验，C 的专用目录必须为 `/tmp/agentkib-v15-b-c-名称`。C 另有独立所有权标记，拒绝接管已有非空目录；清理只删除对应 C 根目录。

在构建好的当前 worktree 根目录执行（Node 版本按项目要求）：

```sh
node --test qa/probes/v15-c-fixtures.test.cjs
node qa/probes/v15-c-sandbox.mjs prepare --root /tmp/agentkib-v15-b-c-remote --locale zh-CN --cdp-port 19345
# 使用已授权的项目构建命令生成 desktop main/preload/renderer/backend 后：
node qa/probes/v15-c-sandbox.mjs seed --root /tmp/agentkib-v15-b-c-remote
node qa/probes/v15-c-sandbox.mjs check --root /tmp/agentkib-v15-b-c-remote
node qa/probes/v15-c-sandbox.mjs start --root /tmp/agentkib-v15-b-c-remote
```

通过启动输出的 `http://127.0.0.1:19345` 连接 Electron CDP，进入设置 → 远程连接。
不要使用 B 启动输出里的 `web` 地址：真实 Web 服务保持停用。

必需截图使用初始 `first-time` 状态：手机未登录、其他电脑空状态、高级设置展开。接口只显示合成的 `192.168.1.23`，名称为 Example Wi-Fi；不会返回操作系统的实际接口。

可选状态：

```sh
node qa/probes/v15-c-sandbox.mjs state --root /tmp/agentkib-v15-b-c-remote --state ready
node qa/probes/v15-c-sandbox.mjs state --root /tmp/agentkib-v15-b-c-remote --state code
node qa/probes/v15-c-sandbox.mjs state --root /tmp/agentkib-v15-b-c-remote --state registering
node qa/probes/v15-c-sandbox.mjs state --root /tmp/agentkib-v15-b-c-remote --state offline
node qa/probes/v15-c-sandbox.mjs state --root /tmp/agentkib-v15-b-c-remote --state failed
```

每次切状态后重新加载本地 renderer，使账号订阅与引导同步。`ready` 可点击“暂停”截确认框；确认只把合成状态变为 `paused`。也可点击“连接新手机”后生成公开测试码；只改夹具状态，不调用原授权码方法。`set-access`/`revoke` 只操作唯一合成浏览器；登录、绑定、配置、原生共享/配对、模型和会话控制、外部应用操作均拒绝。未知 IPC 默认拒绝，遇到未覆盖入口时会显示失败，不能据此扩展为真实操作。

账号/Web/native 夹具必须先通过对应原始 `status` 读取；它保留生产 renderer 和 target 校验，再返回固定合成对象。只接受本地 `app://bundle` 顶层 renderer。不会调用原修改方法，也不接受 ticket、token、邀请码等额外输入。展示已登录账号为 `reader@example.invalid`，不创建真实账号或设备授权。

隔离六个目录：`HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`AGENTKIB_BENCHMARK_DATA_DIR`、`AGENTKIB_BENCHMARK_USER_DATA`、`AGENTKIB_HOME`。Seatbelt 拒绝个人数据/凭据路径、Keychain 文件、securityd Mach 服务与非 loopback 网络；实际系统用户的个人目录也受保护，不依赖调用者的 `HOME`。Electron 安全存储方法禁止读写真实凭据，外部导航与应用操作另行拒绝。

限制：复用的生产 backend 初始化需要自己的 loopback MCP 端口，CDP 也使用 loopback；两者是沙盒基础设施。Web/LAN/native 远程监听始终停用，所有“已开启”状态都是展示夹具。启动参数 `--no-sandbox` 用于避免 Chromium 与外层 Seatbelt 冲突，本探针不验证 Chromium renderer 沙盒。截图前检查页面没有实际路径或真实接口；不要保存包含个人信息的日志到仓库。

结束并清理：

```sh
node qa/probes/v15-c-sandbox.mjs stop --root /tmp/agentkib-v15-b-c-remote
node qa/probes/v15-c-sandbox.mjs cleanup --root /tmp/agentkib-v15-b-c-remote
```

也可直接 `cleanup`：它先用 B 的 PID、进程启动时间和完整命令身份核对后停止本探针所属进程组，再删除 C 根目录；不会对其他进程发送信号。
