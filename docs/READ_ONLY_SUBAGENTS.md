# 只读子代理

Remote 在主会话输入区上方显示一个子代理胶囊，展开列表后可在 Sheet 中查看子对话。辅助记录继续从普通会话目录隐藏；这些读取接口不授予发送、停止、审批或回答权限。

## 接口

接口均使用现有电脑访问凭据，通过已授权父会话解析子代理。请求参数不能指定原生文件路径，子代理 ID 也不能作为普通可控会话使用。

HTTP 层校验 64 位小写十六进制子代理 ID、分页上限和 cursor 长度，只将已知的无效／过期游标和子内容不可用错误映射为公开状态，不透传原生异常。完成全部异步工作区校验后，再检查一次设备授权与主机 boot，撤销期间的请求不得返回正文。

- `GET /api/web/v1/subagents?sessionId=…`：`{version:1, sessionId, agents, truncated, partial?}`
- `GET /api/web/v1/subagent/events?sessionId=…&subagentId=…&cursor=…&limit=50`：`{version:1, sessionId, subagentId, epoch?, events, next_cursor, warnings}`

`agents` 每项含 `id`、可选 `parentId`、`name`、`agent`、`status`、可选 `updatedAt` 及 `readable`。ID 绑定父会话；同名子代理仍是独立条目。只有 `starting`、`running`、`waiting-input`、`waiting-approval` 计入活跃数量。其他状态为 `completed`、`failed`、`stopped`、`unknown`。

父会话 SSE 的 `live.subagents` 携带同一公开结构，作为可选扩展，不改变现有控制协议和事件 cursor。Worker 的局部观察带 `partial:true`，只更新出现的子项，不能删除未出现的原生历史；完整目录才可以移除旧项。局部发布不推迟完整目录刷新，延迟完整读取返回时叠加期间的新状态，避免列表缺项或完成状态倒退。读取暂时不可用时不能把上次活跃状态继续当成已确认运行。

## 来源和隔离

Codex 根据原生线程父子元数据核验关联，通过既有分页器读取子记录。Claude Code 托管进程维护独立、有界的子代理观察表，使用 Agent 调用、子帧归属和 task 生命周期关联状态；原生子文件可验证时读取原生历史，尚未落盘时可提供内存窗口。普通外部 Claude CLI 无法确认当前存活状态时保留 `unknown`，不根据文件修改时间猜测运行中。

后台派发回执不等于子任务完成，父轮次结束也不使后台子代理自动完成。进程失去关联后不恢复旧的运行中结论。子代理正文不写入父助手正文。

Remote 不额外为每个子代理打开 SSE。列表以父流为主并以静默 HTTP 读取兜底；详情仅在可见时更新选中项。后台、离页、切换电脑和授权失效会释放观察与计时器，迟到响应不得恢复已失效内容。只读详情独立保存阅读位置，不取得主会话控制器的订阅所有权或草稿。

旧主机不支持接口时隐藏入口。子代理存在但没有可验证正文时显示内容不可用，不尝试打开任意文件。

## 回归入口

- `apps/desktop/test/session-subagents.test.ts`：原生父子关联、安全读取、状态和分页
- `apps/desktop/test/claude-subagents.test.ts`：托管生命周期、后台任务、嵌套和正文隔离
- `apps/desktop/test/claude-subagent-read.test.ts`：真实 Owner 与隔离 CLI 的内存页、worker 重启和原生换源
- `apps/desktop/test/subagents-web-read.test.ts`：真实 Codex WebRead 接线、跨轮次和连接代际
- `apps/desktop/test/session-subagent-snapshots.test.ts`：父流发布顺序、局部目录合并和缓存隔离
- `apps/desktop/electron/main/web/subagents.test.ts`：父授权、辅助记录边界、撤销和参数校验
- `apps/desktop/test/claude-web-backend-integration.test.ts`：真实 HTTP → Backend → 原生子历史，使用临时合成记录
- Remote `packages/agentkib_client/test/subagents_test.dart`：协议版本、身份、未知状态和只读请求
- Remote `test/subagents_test.dart`：胶囊、列表、Sheet、阅读及生命周期隔离

自动合成测试与真实 Agent、模拟器、真机验收应分别记录；代码合入不会更新已安装的桌面端或手机 App。

## 本地集成记录（2026-11-02）

`web-read.ts` 恢复修改后已接入真实 Codex runner/follower 的连接与 owner 身份；观察代际不依赖父轮次，失联或 owner 变化后旧活跃结论降为未知。Claude 内存 epoch 与 cursor 绑定父、子及实际 worker 启动代际。父流缓存使用独立 publication generation，子状态不推进父控制 revision 时仍保持顺序。

相关 8 个 Vitest 文件合跑 310 项通过，覆盖原生记录、快照缓存、真实 WebRead、真实 Claude Owner 及既有 Codex 跟随／流合并回归；Backend 和 Desktop TypeScript 检查通过。HTTP 授权及 CLI 集成单独回归，不能与上述数量相加作为唯一测试数。

`service.ts` 已恢复并完成 HTTP 边界收尾。路由专项 14 项通过，覆盖只读授权、公开错误映射、参数验证，以及真实完整配对授权在最后一次工作区异步检查期间撤销；联合现有 service、配对和真实 Backend HTTP 集成回归，共 190 项通过、1 项条件跳过，Desktop 类型检查通过。独立复核未发现新的明确问题。

测试使用隔离 HOME、临时工作区、合成原生记录和离线 CLI，不启动付费模型或读取用户真实对话。未做真实 Agent → 手机端到端验收，未更新已安装程序；本次提交仅包含子代理功能，其他工作保留，不推送。

## 运行时路由修复（2026-11-07）

桌面主进程的运行时路由按操作名把 `web.request` 分给后端，原名单里没有 `subagents` 与 `subagent-events`，两个读取都报“没有后端处理者”，HTTP 返回 500，手机上看不到子代理入口；上面的测试都替换了运行时，没有经过这层路由。二期 2c 已把两者加入只读读取名单并补了路由测试，随后在沙箱中以真实 DeepSeek Harness 和 Android 模拟器完成首次端到端验收（列表、只读子会话），见[二期 2c QA](../qa/dsh-integration-phase2c-2026-11-06.md)。Codex 与 Claude 走同一路由，尚未单独做真实端到端验收。
