import type { SandAccess } from "./access.js";
import type { SandAuthStatus } from "./cursor-auth.js";
import type { AuthServicePort } from "./cursor-auth-wiring.js";

// A second, real door through the login gate for self-hosted deployments, in two
// shapes:
//
//  - gateway: the client is pointed straight at one operator-run box
//    (SAND_HOST_GATEWAY_URL + SAND_HOST_GATEWAY_TOKEN, the same pair
//    EnvDescriptorHostConnector reads). The credential is the gateway token, and
//    it is verified against that box's token-gated /events endpoint.
//  - broker: the app ships pointed at a self-hosted broker and the credential is
//    the user's own API key, verified against the broker's /broker/verify. The
//    broker then provisions that user's box, so nothing has to be configured on
//    the machine beyond the key itself.
//
// Either way no Cursor account participates, the verdict travels through the same
// SandAuthStatus pipe the Cursor account service uses, and the credential is only
// ever sent to the one origin it belongs to (see getValidAccessToken).

export const API_KEY_AUTH_ID = "api-key-session";
export const API_KEY_SESSION_DISPLAY_NAME = "Self-hosted (API key)";
// Handed to Cursor-backend clients as their bearer. Deliberately not the
// gateway token: those clients talk to the Cursor backend and are correctly
// rejected, and the real key must never be sent anywhere but this gateway.
export const API_KEY_LOCAL_BACKEND_TOKEN = "api-key-local-session";
export const API_KEY_PROBE_TIMEOUT_MS = 5_000;
export const API_KEY_STATUS_TTL_MS = 30_000;

// In API-key mode the entitlement authority is the operator who runs the box,
// so access is granted locally instead of asking the Cursor backend (which
// would 401 and strand the client in "checking access" forever).
export const API_KEY_SESSION_SAND_ACCESS: SandAccess = { state: "granted", reason: "none" };
export const apiKeySessionSandAccess = async (): Promise<SandAccess> => API_KEY_SESSION_SAND_ACCESS;

export type ApiKeySessionConfig =
  | { readonly mode: "gateway"; readonly gatewayUrl: string; readonly gatewayToken: string }
  | { readonly mode: "broker"; readonly backendUrl: string; readonly apiKey: string };

export const BROKER_VERIFY_PATH = "/broker/verify";

export interface ApiKeySessionSources {
  /** The backend this build ships pointed at, if it was packaged with one. */
  readonly brokerBackendUrl?: () => string | undefined;
  /** The user's stored broker API key, if they have entered one. */
  readonly brokerApiKey?: () => string | undefined;
}

function normalizedOrigin(value: string): string | undefined {
  try { return new URL(value).toString(); } catch { return undefined; }
}

export function resolveApiKeySessionConfig(env: NodeJS.ProcessEnv = process.env, sources: ApiKeySessionSources = {}): ApiKeySessionConfig | null {
  if (env.SAND_AUTH_MODE === "cursor") return null;
  // An explicit gateway wins: that is the local/dev deployment, and it is also
  // the only mode where the box is not the broker's to hand out.
  const gatewayUrl = env.SAND_HOST_GATEWAY_URL?.trim();
  const gatewayToken = env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (gatewayUrl != null && gatewayUrl.length > 0 && gatewayToken != null && gatewayToken.length > 0) {
    const normalized = normalizedOrigin(gatewayUrl);
    return normalized === undefined ? null : { mode: "gateway", gatewayUrl: normalized, gatewayToken };
  }
  const backendUrl = sources.brokerBackendUrl?.()?.trim();
  if (backendUrl == null || backendUrl.length === 0) return null;
  const normalized = normalizedOrigin(backendUrl);
  // A build packaged against a broker is in broker mode even before the user has
  // a key: that is precisely when the gate has to ask for one, and returning null
  // here would hand them the Cursor sign-in wall instead.
  return normalized === undefined ? null : { mode: "broker", backendUrl: normalized, apiKey: sources.brokerApiKey?.()?.trim() ?? "" };
}

interface ProbeOutcome {
  readonly kind: "granted" | "rejected" | "unreachable";
  readonly detail?: string;
}

export interface SandApiKeySessionAuthServiceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly probeTimeoutMs?: number;
  readonly statusTtlMs?: number;
  /** Asks the user for a key (broker mode). Resolves undefined if they cancel. */
  readonly promptForApiKey?: () => Promise<string | undefined>;
  /** Persist an accepted key. Called before the key is verified. */
  readonly storeApiKey?: (apiKey: string) => void;
  /** Forget the stored key, so the next sign-in asks for a new one. */
  readonly clearApiKey?: () => void;
}

const LOGGED_OUT_STATUS = { kind: "logged-out" } as const;

export class SandApiKeySessionAuthService implements AuthServicePort {
  private readonly listeners = new Set<(status: SandAuthStatus) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly statusTtlMs: number;
  private probeInFlight: Promise<ProbeOutcome> | undefined;
  private lastOutcome: ProbeOutcome | undefined;
  private lastProbedAtMs = 0;
  private lastEmittedStatus: SandAuthStatus | undefined;
  private signedOut = false;
  private brokerApiKey: string;
  private readonly promptForApiKey: (() => Promise<string | undefined>) | undefined;
  private readonly storeApiKey: ((apiKey: string) => void) | undefined;
  private readonly clearApiKey: (() => void) | undefined;

  constructor(private readonly config: ApiKeySessionConfig, options: SandApiKeySessionAuthServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = options.probeTimeoutMs ?? API_KEY_PROBE_TIMEOUT_MS;
    this.statusTtlMs = options.statusTtlMs ?? API_KEY_STATUS_TTL_MS;
    this.brokerApiKey = config.mode === "broker" ? config.apiKey : "";
    this.promptForApiKey = options.promptForApiKey;
    this.storeApiKey = options.storeApiKey;
    this.clearApiKey = options.clearApiKey;
  }

  private hasCredential(): boolean {
    return this.config.mode === "gateway" || this.brokerApiKey.length > 0;
  }

  subscribe(listener: (status: SandAuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private endpointUrl(): string {
    return this.config.mode === "gateway" ? this.config.gatewayUrl : this.config.backendUrl;
  }

  private credential(): string {
    return this.config.mode === "gateway" ? this.config.gatewayToken : this.brokerApiKey;
  }

  private gatewayLabel(): string {
    const url = this.endpointUrl();
    try { return new URL(url).host; } catch { return url; }
  }

  private statusFor(outcome: ProbeOutcome): SandAuthStatus {
    switch (outcome.kind) {
      case "granted": return { kind: "logged-in", authId: API_KEY_AUTH_ID, displayName: API_KEY_SESSION_DISPLAY_NAME };
      case "rejected": return { kind: "logged-out", errorMessage: this.config.mode === "broker"
        ? `${this.gatewayLabel()} rejected this API key. Check the key, or ask for a new one.`
        : `The gateway at ${this.gatewayLabel()} rejected this API key. Check SAND_HOST_GATEWAY_TOKEN.` };
      default: return { kind: "logged-out", errorMessage: this.config.mode === "broker"
        ? `Cannot reach ${this.gatewayLabel()}${outcome.detail == null ? "" : ` (${outcome.detail})`}. Check your network connection.`
        : `Cannot reach the gateway at ${this.gatewayLabel()}${outcome.detail == null ? "" : ` (${outcome.detail})`}. Check SAND_HOST_GATEWAY_URL and any port-forward.` };
    }
  }

  private emit(status: SandAuthStatus): void {
    this.lastEmittedStatus = status;
    for (const listener of this.listeners) listener(status);
  }

  private sameReportedStatus(previous: SandAuthStatus | undefined, next: SandAuthStatus): boolean {
    if (previous == null || previous.kind !== next.kind) return false;
    if (previous.kind === "logged-out" && next.kind === "logged-out") return previous.errorMessage === next.errorMessage;
    return true;
  }

  private async probeOnce(): Promise<ProbeOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    timer.unref?.();
    try {
      // redirect: "error" keeps the bearer from ever following a redirect to
      // another origin.
      // Gateway mode probes the box's own SSE endpoint; broker mode asks the
      // broker whether the key is allowed at all, which is cheap and does not
      // provision anything.
      const target = this.config.mode === "gateway" ? new URL("/events", this.config.gatewayUrl) : new URL(BROKER_VERIFY_PATH, this.config.backendUrl);
      const response = await this.fetchImpl(target, { headers: { authorization: `Bearer ${this.credential()}` }, redirect: "error", signal: controller.signal });
      // The status line decides the verdict; /events is an SSE stream that
      // never ends, so drop the body instead of reading it.
      const body = response.body;
      if (body != null) void body.cancel().catch(() => {});
      if (response.status === 200) return { kind: "granted" };
      if (response.status === 401 || response.status === 403) return { kind: "rejected", detail: `HTTP ${response.status}` };
      return { kind: "unreachable", detail: `HTTP ${response.status}` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "unreachable", detail: controller.signal.aborted ? "timed out" : reason };
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveOutcome(force: boolean): Promise<ProbeOutcome> {
    if (!force && this.lastOutcome !== undefined && this.now() - this.lastProbedAtMs < this.statusTtlMs) return this.lastOutcome;
    if (this.probeInFlight == null) {
      const inFlight = this.probeOnce().then((outcome) => {
        this.lastOutcome = outcome;
        this.lastProbedAtMs = this.now();
        this.probeInFlight = undefined;
        if (!this.signedOut) {
          const status = this.statusFor(outcome);
          if (!this.sameReportedStatus(this.lastEmittedStatus, status)) this.emit(status);
        }
        return outcome;
      });
      this.probeInFlight = inFlight;
    }
    return await this.probeInFlight;
  }

  private needsKeyStatus(): SandAuthStatus {
    return { kind: "logged-out", errorMessage: `Enter your API key to connect to ${this.gatewayLabel()}.` };
  }

  async getStatus(): Promise<SandAuthStatus> {
    if (this.signedOut) return LOGGED_OUT_STATUS;
    if (!this.hasCredential()) return this.needsKeyStatus();
    return this.statusFor(await this.resolveOutcome(false));
  }

  /**
   * In broker mode the real key IS the backend credential — but only for our own
   * broker. Anything else (including api2.cursor.sh, should a stray env var ever
   * point a backend client there) gets the inert sentinel, so the user's key
   * cannot be sent to a host that did not issue it.
   */
  async getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string> {
    if (this.config.mode !== "broker" || this.brokerApiKey.length === 0) return API_KEY_LOCAL_BACKEND_TOKEN;
    const requested = options?.backendUrl;
    if (requested == null) return this.brokerApiKey;
    let sameOrigin = false;
    try { sameOrigin = new URL(requested).origin === new URL(this.config.backendUrl).origin; } catch { sameOrigin = false; }
    return sameOrigin ? this.brokerApiKey : API_KEY_LOCAL_BACKEND_TOKEN;
  }

  /**
   * In broker mode this is the whole sign-in: ask for a key, store it, verify it.
   * The renderer's existing "Sign in" button already calls login(), so no UI in
   * the checksum-pinned renderer has to change.
   */
  async login(): Promise<SandAuthStatus> {
    this.signedOut = false;
    if (!this.hasCredential()) {
      if (this.promptForApiKey == null) return this.needsKeyStatus();
      const entered = (await this.promptForApiKey())?.trim();
      if (entered == null || entered.length === 0) return this.needsKeyStatus();
      this.brokerApiKey = entered;
      this.storeApiKey?.(entered);
      this.lastOutcome = undefined;
    }
    return this.statusFor(await this.resolveOutcome(true));
  }

  async cancelLogin(): Promise<SandAuthStatus> { return await this.getStatus(); }

  /**
   * In broker mode signing out means forgetting the key: that is the only way a
   * user can replace one, and leaving it stored would make the next sign-in
   * silently reuse a key they meant to change.
   */
  async logout(): Promise<SandAuthStatus> {
    this.signedOut = true;
    if (this.config.mode === "broker" && this.brokerApiKey.length > 0) {
      this.brokerApiKey = "";
      this.lastOutcome = undefined;
      this.clearApiKey?.();
    }
    this.emit(LOGGED_OUT_STATUS);
    return LOGGED_OUT_STATUS;
  }

  async revokeForAccountRefusal() { return { kind: "completed" as const, status: await this.logout() }; }

  async updateDisplayName(_name: string): Promise<SandAuthStatus> { return await this.getStatus(); }
}
