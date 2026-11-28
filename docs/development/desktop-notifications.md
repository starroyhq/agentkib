# 桌面通知前端接入清单

- 在设置左侧加一级「通知」，把原「设置 → 会话」里的通知项移到这里。顶部依次放「允许电脑通知」「推送到手机」两个总开关。只显示一组「审批」「提问」「本轮完成」「本轮失败」「Worker 的结果」。保留手机专用的「仅离开电脑时推送」以及共用的「安静时段」和「时间范围」。
- 调用 `window.agentkibDesktop.notifications.status()` 读取 `{ desktopEnabled, policy, permission }`。`policy.enabled` 只控制手机，`desktopEnabled` 是本机保存的开启意向。已配对设备仍通过 `/push/policy` 读写共用策略。桌面即使未登录或远程关闭也可保存。沿用已有分类和推送默认值。`Worker 的结果` 和电脑总开关默认关闭。
- 每行即时提交 `notifications.update(patch)`。电脑总开关单独提交 `{ desktopEnabled: true | false }`。手机总开关写 `{ enabled: ... }`。「仅离开电脑时推送」写 `{ onlyAway: ... }`。分类写 `{ categories: { approval: ... } }` 等单项。Worker 写 `{ workerResults: ... }`。安静时段写 `{ quietHours: null }` 或 `{ quietHours: { start, end } }`。使用电脑本地时间和 `HH:mm`，允许跨午夜，起止不能相同。
- `authorized` 和支持 Electron 通知的 `unknown` 显示已保存的开关值。在 macOS 的 `not-determined` 状态打开开关时，先写入开启意向，再调用 `requestPermission()`。`denied` 强制显示关闭，提供「打开系统设置」，调用 `openSettings()`。窗口重新聚焦时读一次状态，系统放行后恢复已保存的开启意向。`unsupported` 置灰，行尾「不支持」。
- 手机未配对或远程关闭时，按设计置灰手机专用行。共用分类和安静时段继续可编辑。共用项保留存储值。失败时回显上次值，行尾「保存失败」。不加说明文字，也不加「保存」「刷新」按钮。
- 验收切换两端总开关互不影响，从手机修改共用分类即在电脑状态中生效。在主窗口、菜单栏浮窗和手机上各完成一次审批或阅读，确认对应系统卡片消退。同一会话在前台时没有新卡片，切到另一个页面后可收到。点击卡片只打开会话。

macOS 在打包应用中读系统授权和按标识撤回。Windows 与 Linux 由 Electron 投递，支持时只能查询通知服务是否可用，权限细分状态为 `unknown`。历史卡片撤回依赖通知服务和运行中的通知对象。静音由应用指定，横幅、锁屏和专注模式遵从系统设置。
