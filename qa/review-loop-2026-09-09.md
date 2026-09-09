# origin/main 基线审查与修复闭环

## 范围与方法

- 分支：`codex/fix-runtime-pipe-recovery`，初始 HEAD `58912bb`。
- 已 fetch `origin main`，合并基线：`ea7955ac513278cfca3dae1029e6fe07152a359a`。
- 按 review-agent 缺陷优先规则，由三个子代理分区审查完整合并差异；修复后交叉复审，包含未提交修改。
- 范围包括 HTTP/LAN 授权、原生控制、Web 交互/目录、桌面刷新、增量 Insights/Store/Quota、Windows 诊断变更。
- 不运行真实 Agent 控制，不修改官方会话或用户权限，不提交、推送或部署。已有设计稿及临时目录保持原状。

## 已修复发现

1. Claude 空闲实例不回收，八个会话后容量永久耗尽。改按 Worker 数量限制，回收进程但保留身份、revision、去重与未知结果保护。
2. Claude 审批/回答在原生取消帧处理前按旧状态生成响应。改为生命周期队列最终验证，并确认处理结果；不明确回执保持禁用。
3. QuestionForm 普通对象索引读取原型属性导致 `constructor` / `__proto__` 等原生问题 ID 崩溃。使用 own-property 读取。
4. 不支持的问题契约（如 `options:null`）仍渲染表单导致崩溃。结构校验后安全降级。
5. 桌面首次 Web/remote 状态读取失败后不再重试。未知状态按现有可见轮询重试，成功空闲后停止。
6. 离开会话后待处理标识不更新/清除。对本次访问已打开的会话轮转读取权威快照，每四秒最多两项，非当前会话不抢焦点；超时有界、卸载取消，访问结束清空。
7. 真实 Claude 验收只选择唯一 Claude 目录项，可能误发其他会话。根据指定原生 UUID、Agent、隔离数据库盐精确映射，无法验证即失败。
8. 旧缺列 Codex 数据库阻塞正常 JSONL 初次导入。跳过从未导入的不适用 schema；已缓存来源的 schema 丢失或读取错误继续保留旧数据并重试。
9. 回答表单允许必被接口拒绝的长度、重复值和总字节量。对齐题数、值数、单值 4096 字符且 8192 UTF-8 字节、完整 64 KiB JSON 请求限制，四语言说明错误。额外验证单条中文 8190/8192 字节通过、8193 字节拒绝，避免与 Rust 下游长度单位不一致。

修复期间另外纠正了两项回归：Worker join 前重置初始化状态的竞态；clear 后授权仍 approved 导致后台 watcher 永久失活。均补回归测试。

## 验证记录

- Rust 全工作区：706 项通过；包含新增原生队列/容量/回收时序及旧 schema 回归。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- `cargo fmt --all -- --check` 通过。
- 桌面最终全量：662 项通过，1 项真实 Claude 验收按 opt-in 跳过。
- Web：127 项通过；HTTP 单值 UTF-8 边界目标测试通过。
- `pnpm typecheck`、`pnpm format:check`、`git diff --check` 通过；本分支此前不符合格式的七个展示/测试文件作机械格式整理。
- 桌面/内置 Web/托管 Web 构建通过；协议重新生成无差异。
- HTTP/LAN 与 Insights/Store/Quota 交叉复审：No findings。
- 原生 runtime/Claude/Codex 交叉复审：No findings。
- 最终表单与 watcher 独立复审：No findings。原生控制、HTTP/缓存、Web 各范围的最后审查均无未解决可操作发现。

## 覆盖限制

这是当前合并差异的代码审查与隔离回归结论，不是“证明无任何漏洞”。本轮未进行真实跨设备、Safari/手机或 Windows 执行验收，未扩大已验证原生版本的控制能力。后台标识只监测本次浏览器访问中已打开的会话，不对整个目录启动探针。
