/**
 * 退出前让 renderer 确认（例如询问是否放弃未保存的草稿），同时保证退出不会被卡住。
 *
 * - preload 收到退出请求后立即回执，之后用户思考多久都可以。
 * - renderer 已崩溃或被 Electron 判定为无响应时直接退出，不再等待。
 * - 其余情况（例如页面还没挂载退出守卫）最多等待 timeoutMs 后退出。
 *   这个超时只是兜底，要足够长，避免把"只是暂时忙"的 renderer 当成卡死而丢掉草稿。
 */
export interface QuitGuardWindow {
  /** 窗口存在、未销毁且 renderer 进程未崩溃。 */
  isAlive(): boolean;
  /** Electron 已对该窗口发出 unresponsive 且尚未恢复。 */
  isUnresponsive(): boolean;
  show(): void;
  sendQuitRequest(): void;
}

export interface QuitGuard {
  request(window: QuitGuardWindow | undefined): void;
  /** preload 回执：renderer 已接手，不再需要兜底计时。 */
  acknowledged(): void;
  /** renderer 崩溃或变为无响应：若正在等待回执，立即退出。 */
  rendererUnavailable(): void;
  /** 已获准退出（用户确认或其他路径），取消等待。 */
  approve(): void;
}

export const QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

export function createQuitGuard(options: {
  approveQuit(): void;
  timeoutMs?: number;
  onTimeout?(): void;
}): QuitGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const approve = () => {
    clear();
    options.approveQuit();
  };
  return {
    request(window) {
      if (!window || !window.isAlive() || window.isUnresponsive()) {
        approve();
        return;
      }
      window.show();
      // 已在等待回执时不重复发送，避免叠加多个退出对话框。
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        options.onTimeout?.();
        options.approveQuit();
      }, options.timeoutMs ?? QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS);
      window.sendQuitRequest();
    },
    acknowledged: clear,
    rendererUnavailable() {
      if (timer) approve();
    },
    approve,
  };
}
