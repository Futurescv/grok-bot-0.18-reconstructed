import { BROKER_KEY_SUBMIT_CHANNEL as SUBMIT_CHANNEL } from "../../shared/broker-key-channel.js";

/**
 * Where the user types their API key.
 *
 * A main-process window, not a renderer page: the shipped renderer is a
 * checksum-pinned upstream bundle, and its "Sign in" button already calls
 * login() — so broker mode reuses that button and answers it with this window
 * instead of a Cursor OAuth browser hand-off. Nothing in the renderer changes.
 */
export interface BrokerKeyWindowElectron {
  readonly BrowserWindow: new (options: Record<string, unknown>) => BrokerKeyWindowHandle;
  readonly ipcMain: {
    handleOnce(channel: string, listener: (event: unknown, value: unknown) => void): void;
    removeHandler(channel: string): void;
  };
}

export interface BrokerKeyWindowHandle {
  loadURL(url: string): Promise<unknown>;
  show(): void;
  close(): void;
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): void;
}

export { BROKER_KEY_SUBMIT_CHANNEL } from "../../shared/broker-key-channel.js";

export function brokerKeyWindowHtml(options: { readonly backendLabel: string; readonly channel: string }): string {
  // Inline, so nothing has to be added to the packaged Resources tree, and the
  // form cannot load anything from the network.
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Connect Grok Bot</title>
<style>
  :root { color-scheme: light dark }
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 22px 24px; background: Canvas; color: CanvasText }
  h1 { font-size: 15px; margin: 0 0 6px }
  p { margin: 0 0 16px; opacity: .7 }
  input { box-sizing: border-box; width: 100%; font: inherit; font-family: ui-monospace, monospace; padding: 8px 10px; border-radius: 7px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px }
  button { font: inherit; padding: 7px 14px; border-radius: 7px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); background: ButtonFace; color: ButtonText }
  button.primary { background: AccentColor; color: AccentColorText; border-color: transparent }
  button[disabled] { opacity: .5 }
</style></head><body>
<h1>Connect to your computer</h1>
<p>Paste the API key you were given. It is stored encrypted on this Mac and sent only to ${options.backendLabel}.</p>
<input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="gbk_…" autofocus>
<div class="row"><button id="cancel">Cancel</button><button id="save" class="primary" disabled>Connect</button></div>
<script>
  const field = document.getElementById("key");
  const save = document.getElementById("save");
  const submit = (value) => window.sandBrokerKey.submit(value);
  field.addEventListener("input", () => { save.disabled = field.value.trim().length === 0; });
  field.addEventListener("keydown", (event) => { if (event.key === "Enter" && field.value.trim().length > 0) submit(field.value.trim()); });
  save.addEventListener("click", () => submit(field.value.trim()));
  document.getElementById("cancel").addEventListener("click", () => submit(null));
</script></body></html>`;
}

export function createBrokerKeyPrompt(deps: {
  readonly electron: BrokerKeyWindowElectron;
  readonly preloadPath: string;
  readonly backendUrl: string;
  readonly channel?: string;
  readonly reportFailure?: (stage: string, error: unknown) => void;
}): () => Promise<string | undefined> {
  const channel = deps.channel ?? SUBMIT_CHANNEL;
  let open: Promise<string | undefined> | undefined;

  return async () => {
    // One window at a time: a second "Sign in" click should focus the first, not
    // open a rival prompt that could store a different key.
    if (open !== undefined) return await open;
    const attempt = new Promise<string | undefined>((resolve) => {
      let settled = false;
      const settle = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        try { deps.electron.ipcMain.removeHandler(channel); } catch (error) { deps.reportFailure?.("remove-handler", error); }
        resolve(value);
      };
      let label: string;
      try { label = new URL(deps.backendUrl).host; } catch { label = deps.backendUrl; }
      const window = new deps.electron.BrowserWindow({
        width: 460,
        height: 260,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: "Connect Grok Bot",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: deps.preloadPath },
      });
      deps.electron.ipcMain.handleOnce(channel, (_event, value) => {
        settle(typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
        if (!window.isDestroyed()) window.close();
      });
      window.on("closed", () => settle(undefined));
      const html = brokerKeyWindowHtml({ backendLabel: label, channel });
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .then(() => { if (!window.isDestroyed()) window.show(); })
        .catch((error: unknown) => { deps.reportFailure?.("load", error); settle(undefined); });
    }).finally(() => { open = undefined; });
    open = attempt;
    return await attempt;
  };
}
