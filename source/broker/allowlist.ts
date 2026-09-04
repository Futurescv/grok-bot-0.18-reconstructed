import { getConfigMapData, type KubeClient } from "./kube.js";
import { keyScope } from "./identity.js";

/**
 * Which API keys may provision a box.
 *
 * The ConfigMap stores `sha256(key) → display name`, never the key itself: the
 * plaintext exists only in the user's app, so a leaked cluster read cannot be
 * replayed as a credential. Revoking one user is deleting one entry.
 *
 * Polled rather than watched — the set changes when a human edits it, and a watch
 * would add reconnect handling for no benefit at this size.
 */
export const API_KEYS_CONFIGMAP = "grok-bot-api-keys";
export const ALLOWLIST_REFRESH_MS = 30_000;

export interface Allowlist {
  /** Undefined when the key is not allowed; otherwise the display name (possibly ""). */
  lookup(apiKey: string): string | undefined;
  scopes(): readonly string[];
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

function displayName(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed != null && typeof (parsed as { name?: unknown }).name === "string") return (parsed as { name: string }).name;
  } catch { /* a bare string is a display name */ }
  return value;
}

export function createAllowlist(kube: KubeClient, options?: {
  readonly configMapName?: string;
  readonly refreshMs?: number;
  /**
   * Plaintext keys accepted in addition to the ConfigMap. Intended for running the
   * broker on a laptop before any ConfigMap exists; set it in the Deployment and
   * you have hard-coded credentials, so don't.
   */
  readonly extraKeys?: readonly string[];
  readonly onError?: (error: unknown) => void;
}): Allowlist {
  const configMapName = options?.configMapName ?? API_KEYS_CONFIGMAP;
  const refreshMs = options?.refreshMs ?? ALLOWLIST_REFRESH_MS;
  const extra = new Map((options?.extraKeys ?? []).filter(key => key.trim().length > 0).map(key => [keyScope(key.trim()), "dev key"]));
  let fromCluster = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    const data = await getConfigMapData(kube, configMapName);
    fromCluster = new Map(Object.entries(data ?? {}).map(([scope, value]) => [scope.trim().toLowerCase(), displayName(value)]));
  };

  return {
    lookup(apiKey) {
      const scope = keyScope(apiKey);
      return fromCluster.get(scope) ?? extra.get(scope);
    },
    scopes() { return [...new Set([...fromCluster.keys(), ...extra.keys()])]; },
    refresh,
    start() {
      if (timer !== undefined) return;
      const tick = (): void => { void refresh().catch(error => options?.onError?.(error)); };
      tick();
      timer = setInterval(tick, refreshMs);
      timer.unref();
    },
    stop() { if (timer !== undefined) clearInterval(timer); timer = undefined; },
  };
}
