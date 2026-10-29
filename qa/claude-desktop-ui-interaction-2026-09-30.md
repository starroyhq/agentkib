# Claude 真实 Electron 审批与问题点击验收

2026-09-30，本次为新增桌面 renderer 集成覆盖，不重跑此前失败模型用例。

## 结果

**通过**：真实 Electron 新建空会话、点击发送、批准 Write、回答 AskUserQuestion、读取最终回复，全程使用原生 CUA 操作。辅助脚本只准备隔离目录/登记工作区和只读核验，未代替 UI 发送、审批或回答。

- CLI `2.1.285`，实际模型 `deepseek-v4-pro`。
- 最终 debug Runtime SHA256：`66fa91d437dd36f4532017a3a3bb32303002b7f1f02a6edcfb8469c738c24895`。
- 源码 revision `057da8b81a3f3c9536a568287175af8e50c12176`，dirty 工作树 `/Users/user/.codex/worktrees/all-agent-continuation/agentkib`。
- 1 次 UI 发送、1 次 CLI 启动、1 个原生 user turn、1 个原生会话，0 个原生 API error。
- Write 和 AskUserQuestion 各一次，每项 tool_use 都有匹配的成功 tool_result。
- 合成文件精确包含 `00ea3334-f386-4e64-9248-c660638b35df`；最终新回复包含该 marker 与 `cobalt-lake`，界面空闲、两项工具 completed。
- CLI 用量：input_tokens=20527、cache_read_input_tokens=39680、output_tokens=317、cache_creation_input_tokens=0。不推算实际账单。
- 原 settings SHA 前后相同。通过 CUA `Cmd+Q` 正常退出隔离 Electron，进程 exit 0。

## 真实操作记录

1. 打开构建好的隔离 Electron，选择合成 workspace → 继续工作 → Claude Code → 新建 Claude 任务。空会话显示 CLI 版本和空闲，尚未启动模型。
2. 在实际消息输入框填入单轮合成任务，点击发送一次。模型先请求 Write。
3. 通过 AX 内容核对 `file_path` 只指向本次隔离工作区、content 精确匹配预定 UUID，点击「允许」。界面随后显示 Write completed。
4. 原生 AskUserQuestion 到达，表单出现两个选项。为覆盖刚修复的单选互斥，先输入 `temporary-other` 自定义答案，再点 `cobalt-lake`；界面自定义输入清空、选择仅一项、「提交回答」启用。点击提交一次。
5. 等待界面显示空闲、AskUserQuestion completed，最终回复正确。没有脚本控制替代、失败重试或再次模型发送。

截图均来自原生 `cua.getScreenshot`，未裁剪、合成或用页面脚本伪造：

- [Write 审批](claude-desktop-ui-interaction-2026-09-30/write-approval.png)：当时长路径内容使面板出现横向滚动，截图未完整呈现允许按钮；实际审批内容与按钮均由 AX 读取，CUA 按钮点击及 Write completed 后态确认操作成功。
- [问题选择及清空自定义输入](claude-desktop-ui-interaction-2026-09-30/question-selected.png)。
- [最终回复及工具完成](claude-desktop-ui-interaction-2026-09-30/completed-reply.png)。
- [原生日志与文件只读核验](claude-desktop-ui-interaction-2026-09-30/results.json)。

## 隔离与命令

目录 `/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30` 保留。独立 `CLAUDE_CONFIG_DIR`、Runtime 数据、Electron profile 与随机 MCP 端口；未改 HOME/CODEX_HOME，未复制凭据、更新安装或覆盖用户应用。

隔离 wrapper 引用原 settings 路径，显式 Pro、`--safe-mode --setting-sources local --strict-mcp-config --permission-mode default --max-budget-usd 0.50`。仅隔离工作区 `.claude/settings.local.json` 设置 ask Write/Edit/Bash，可靠触发本次工具审批；此为测试约束，不是生产权限变更。wrapper 拒绝第二次模型 CLI 启动。测试应用初次自动发现本机已有工作区，这是应用既有启动行为；没有打开或向模型发送其他工作区内容。

```sh
export PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH
node qa/probes/claude-desktop-interaction-ui-2026-09-30.mjs prepare
# 从 apps/desktop 启动，PATH 首项为该隔离根的 bin：
AGENTKIB_DEV=1 \
AGENTKIB_RUNTIME_PATH=/Users/user/.codex/worktrees/all-agent-continuation/agentkib/target/debug/agentkib-runtime \
AGENTKIB_BENCHMARK_DATA_DIR=/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30/runtime-data \
AGENTKIB_BENCHMARK_USER_DATA=/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30/electron-profile \
CLAUDE_CONFIG_DIR=/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30/claude-config \
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
# 以下为退出后的只读核验，无模型调用：
node --check qa/probes/claude-desktop-interaction-ui-2026-09-30.mjs
node qa/probes/claude-desktop-interaction-ui-2026-09-30.mjs verify
```

辅助脚本格式化、语法检查、只读核验均通过。原生数据与 electron.log 留在隔离根；核验日志 `/tmp/claude-desktop-ui-interaction-verification.log`。

Web 的真实 HTTP 双端旧表单失效与同 UUID 续接已有独立证据；本增量只补真实桌面操作，不重复宣称 Web 浏览器点击或真实手机验收。真实手机仍未取得设备，未验收。
