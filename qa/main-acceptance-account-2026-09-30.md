# 2026-09-30 主线账号与 backend 收尾验收

## 身份与结论

- AgentKib：`ce16c00`，独立工作树 `main-acceptance-20260930`；本报告验收期间未修改账号实现。
- Backend：`b07ec13cb6f45edc945358d6c33ee08db914b58d`，测试前后 tracked 工作区干净。
- Node `22.23.2`、pnpm `10.8.1`；PostgreSQL 使用一次性 Docker `postgres:17-alpine`，镜像摘要 `postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`。
- 实测账号 HTTP/PKCE/设备归属/退出与 PostgreSQL 持久化通过；真实 Rust Runtime + Web 八位码配对及撤销通过。这些是隔离集成测试，不是手机、公网 DNS/TLS/FRP、系统钥匙串或生产账号上线验收。
- Runtime 二进制 SHA-256：`395bc01a3ae23b4b714742a35338e7612eaa5d6b7ab9126994b146252b7163b0`。

## 私有备份与远端

本机备份目录为 `~/Documents/AgentKib-archives/2026-09-30/backend/`，目录权限 `0700`，文件 `0600`。`repository.bundle` 包含全部三个提交；`workspace-private.tar.gz` 包含 111 个源码及资料文件，其中 49 个为 ignored 本地资料，包括 handoff、IDE 配置、旧截图及浏览器验收记录。依赖目录、构建产物与缓存排除；这些旧资料仅作为备份，不计为本轮验收。

- Bundle SHA-256：`963bfee15fc0bd5fdded3175526f33fc2ba60b01d2d27d93d87b4232468c7466`。
- 源码/资料包 SHA-256：`86c8948cd5e6f188513b77d7586ce06c9b5e6fd5a98e2b3ab826feedd0711736`。
- `git bundle verify` 通过，从 bundle 克隆成功；解包后全部 111 个文件逐一匹配 `files.json` 的 SHA-256，README 与 ignored handoff 同源文件比对通过；未提交补丁为空。
- 检查三个提交的全部 74 个唯一 blob，未发现真实凭据。候选匹配均为合成测试凭据、变量引用、界面文案、回环地址、文档示例或 Compose 私网地址。检查覆盖已提交历史，不能代替任意编码秘密的数学保证；ignored 私有资料没有推送。
- 推送前再次确认 `starroyhq/agentkib-backend` 为 private、没有 refs、没有 Actions workflow 或 webhook。添加 HTTPS origin，执行 `git push -u origin main`；推送后远端 main 与本地均为上述完整 SHA。没有改写历史或强推。
- 恢复方式：先核对本地 `SHA256SUMS.json`，将 bundle 克隆到新的空目录，再将源码包解压到另一个空目录核对文件；需要恢复 ignored 资料时从后者按需复制，不覆盖现有工作区。

## 本轮实际命令与结果

在 backend 根目录执行，使用上述 Node/pnpm：

| 命令 | 结果 | 本机日志 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 成功，无依赖版本变更 | `install.log` |
| `pnpm test` | 45 通过、12 按需跳过、0 失败 | `test.log` |
| `AGENTKIB_DESKTOP_SOURCE=<验收工作树>/apps/desktop/electron/main/account/service.ts pnpm test:db` | 55 通过、2 跳过、0 失败 | `test-db-desktop.log` |
| `pnpm test:account-web` | 9 通过、0 失败 | `test-account-web.log` |
| `pnpm build:account-web` | 成功 | `build-account-web.log` |

`test:db` 使用随机回环端口和临时数据库密码，运行后容器自动移除；未连接用户或生产数据库。跳过项为需要额外 FRP 二进制与 Compose 开关的测试。PKCE 集成实际加载本轮 AgentKib 的 `DesktopAccountService`，覆盖浏览器授权回调、旧设备认领、幂等新设备登记、账号令牌隔离、退出与 PostgreSQL 持久化。普通账号测试覆盖设备撤销与权限边界。

pnpm 的锁定安装仍自动添加了没有依赖的 account-web 空 importer；仅撤掉该生成块恢复原锁文件，未改变依赖。构建输出属于 ignored 产物。

在 AgentKib 验收工作树执行：

```sh
AGENTKIB_ACCOUNT_TEST_BACKEND=/Users/user/Documents/data/agentkib-backend \
AGENTKIB_ACCOUNT_TEST_RUNTIME=/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib/target/debug/agentkib-runtime \
pnpm --filter @agentkib/desktop exec vitest run electron/main/account/remote-runtime.integration.test.ts
```

结果 **1 通过、0 跳过、0 失败**，日志 `account-runtime.log`。实际执行真实 Runtime、WebAccessService 与账号 HTTP handlers：账号登录和设备认领后，未配对访问依然被拒绝；生成的八位码配对后才能读取合成历史随机标记；退出账号暂停 relay，保留设备归属与既有本地配对；撤销配对后历史访问再次被拒绝。该用例使用内存 backend store，持久化由前述独立 PostgreSQL 用例覆盖。

以上日志、推送证据、扫描分类和恢复验证均在本机备份目录；`SHA256SUMS.json` 可复核。未部署账号功能、未操作生产配置、未更改用户安装或凭据，真实手机及系统钥匙串仍未验收。
