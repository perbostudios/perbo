import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL, CHANGED, CLOSE_REQUEST, CLOSE_RESPONSE, CLOSE_CANCEL, ChangeSchema } from "../shared/protocol.js";
import type {
  DesktopBridge,
  ReplyMap,
  Request,
  Response,
} from "../shared/protocol.js";

const closeListeners = new Set<() => Promise<void>>();
ipcRenderer.on(CLOSE_REQUEST, (_event, token: string) => {
  // Keep new input outside the interval between the saved-edit acknowledgment and quit.
  if (document.body) document.body.inert = true;
  void Promise.all([...closeListeners].map((listener) => Promise.resolve().then(listener))).then(
    () => ipcRenderer.send(CLOSE_RESPONSE, { token, ok: true, error: null }),
    (error: unknown) => ipcRenderer.send(CLOSE_RESPONSE, { token, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 2000) }),
  );
});
ipcRenderer.on(CLOSE_CANCEL, () => { if (document.body) document.body.inert = false; });
const bridge: DesktopBridge = {
  beforeClose(listener) {
    closeListeners.add(listener);
    return () => { closeListeners.delete(listener); };
  },
  async request<T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> {
    const response = (await ipcRenderer.invoke(CHANNEL, request)) as Response;
    if (!response.ok) throw new Error(response.error);
    return response.value as ReplyMap[T["kind"]];
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const change = ChangeSchema.safeParse(value);
      if (change.success) listener(change.data);
    };
    ipcRenderer.on(CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(CHANGED, handler);
    };
  },
};
contextBridge.exposeInMainWorld("perbo", bridge);
