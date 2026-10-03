import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { RuntimeHost } from "../runtime-host";

export type TrustedIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcRegistrar {
  /** 注册 handler；调用方不是受信 renderer 时在执行任何逻辑之前拒绝。 */
  handle(channel: string, handler: TrustedIpcHandler): void;
  /**
   * 直接转发到 runtime 的 IPC。`params` 负责校验 renderer 传入的参数并构造请求，
   * 省略时发送空对象。
   */
  forward(channel: string, method: string, params?: (...args: unknown[]) => unknown): void;
}

export function createIpcRegistrar(options: {
  assertTrustedRenderer(event: IpcMainInvokeEvent): void;
  runtime(): RuntimeHost;
}): IpcRegistrar {
  const handle: IpcRegistrar["handle"] = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      options.assertTrustedRenderer(event);
      return handler(event, ...args);
    });
  };
  return {
    handle,
    forward(channel, method, params = () => ({})) {
      handle(channel, (_event, ...args) => options.runtime().request(method, params(...args)));
    },
  };
}
