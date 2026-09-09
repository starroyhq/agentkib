# Web 审批与提问验收 · 2026-09-09

## 修复范围

- 独立 questions 快照及 `/answer` 白名单；答案使用发送权限，审批权限不替代回答权限。保持原授权、CSRF、Origin、并发、幂等及失效保护。
- Claude 已验证选择式 AskUserQuestion 的原生答案回传；Codex 接通已知 requestUserInput/follower response 契约。未支持的新式表单不猜测处理。
- 当前会话请求首次自动弹框，收起后保留入口；其他会话仅显示曾观察到的待处理状态，不扫描所有 owner。
- 修复混合待审批/待回答状态，以及回答或审批后快速完成导致的回执残留。
- 目录紧凑箭头、行内路径详情入口；工具状态四语言显示。

## whoami 证据

原会话 2026-09-09 08:58:11.925Z 记录 Bash whoami，08:58:12.495Z 返回成功。对应用户记录 permissionMode 为 default；当前 runner 启动参数为 manual，不能单凭两者命名推断绕过权限。用户级配置没有显式 Bash allow，测试项目未发现本地权限文件。

历史 JSONL 不包含完整 stdio control_request/control_response，未找到该会话的 debug 文件。因此无法追溯确认此次没有弹框究竟是原生直接允许还是 UI 漏接；不得用模型自述替代证据，也未修改权限策略强制弹框。

## 已通过

- Web 112 项测试、类型检查和构建；服务原 52 项通过，追加后回答相关 4 项通过；桌面类型检查。
- Claude runner 12、Codex bridge 46、Web runtime 16 项相关测试；相关两 crate all-targets Clippy、cargo fmt check、git diff check。
- 完整 `pnpm --filter @agentkib/desktop build:electron` 通过，包含协议生成、release runtime、Web/桌面前端及主进程构建；协议无新 wire 版本变化。
- 原 Claude test UUID 的真实 WebAccessService HTTP 验证串行通过：结构化颜色提问选择蓝色并回传、/usr/bin/true 拒绝未执行、允许一次成功。均经过配对及 Web API，不是直接 CLI 伪装 Web。测试时释放旧托管进程，之后恢复开发版 AgentKib。
- Safari 合成服务器 1434：真实浏览器自动弹框、单选+多选提交、收起后重新打开；390×844 响应式表单可见，无横向溢出。合成页不调用真实 runtime。

## 尚未通过／限制

- 真实 HTTP 回传不等于完整真实 Safari 交互验收；本轮未完成真实审批弹框全路径及窄屏深色复验。响应式模式不是实体手机。
- 原 Codex 指定测试会话探针返回 no session owner found；安装版本匹配。用户随后授权新建测试对话，已请求创建“AgentKib Web 结构化提问验收”，等待任务创建完成；未将 Codex 真实问答列为通过，不放宽现有 Codex 控制资格。
- Codex secret/multiSelect 及 Claude text/number/preview 等未验证契约保持禁用。
- 没有修改官方会话文件或用户权限配置；没有 commit、push 或部署。相关检查不代表所有全仓库测试都运行过。
