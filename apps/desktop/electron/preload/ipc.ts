import { ipcRenderer as electron } from "electron";
import { isRuntimeQueueFullReply } from "../ipc-admission";

const invoke: typeof electron.invoke = async (channel, ...parameters) => {
  const reply: unknown = await electron.invoke(channel, ...parameters);
  if (isRuntimeQueueFullReply(reply)) {
    const admission = reply.__agentkibRuntimeAdmission;
    throw Object.assign(new Error(admission.code), admission);
  }
  return reply;
};

export const ipcRenderer = {
  invoke,
  on: electron.on.bind(electron),
  removeListener: electron.removeListener.bind(electron),
  send: electron.send.bind(electron),
};
