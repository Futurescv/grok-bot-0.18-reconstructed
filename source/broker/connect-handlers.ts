import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";

import { GrokBotService } from "../packages/proto/generated/aiserver/v1/grok_bot_connect.js";
import { EnsureSandBoxResponse, GetSandBoxRunStateResponse, RecreateSandBoxResponse, SandBoxMigrationEvent } from "../packages/proto/generated/aiserver/v1/sand_box_pb.js";
import { boxLegBaseUrl } from "./box-routes.js";
import { gatewayTokenFor, keyScope, networkTokenFor } from "./identity.js";
import type { Allowlist } from "./allowlist.js";
import { BoxQuotaExceededError, BoxNotReadyError, type createProvisioner } from "./provisioner.js";

/**
 * Our own implementation of the slice of `aiserver.v1.GrokBotService` the desktop
 * client actually calls, so the app can point `SAND_BACKEND_URL` here instead of
 * Cursor's backend and get a box we provision.
 *
 * The client sends nothing but a bearer token (`EnsureSandBox` has an empty
 * request body), and it reads five fields off the response. Every URL we hand
 * back points at this same process's router, which is what makes the desktop's
 * `vncProxy` rewrite work and removes the need for any port-forwarding on the
 * client.
 */
export const AUTOMATION_FAILURE_HINT_HEADER = "x-automation-failure-hint";
export const SAND_BOX_BLOCKED_HINT = "SAND_BOX_BLOCKED";
export const CLUSTER_NAME = "selfhosted-acs";

export interface BrokerHandlerDeps {
  readonly allowlist: Allowlist;
  readonly provisioner: ReturnType<typeof createProvisioner>;
  readonly masterSecret: string;
  readonly publicBaseUrl: string;
  readonly quotaRetryAfterSeconds: number;
  /** How long a migration watch with nothing to report stays attached. */
  readonly idleWatchMs: number;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export function bearerToken(context: Pick<HandlerContext, "requestHeader">): string | undefined {
  const header = context.requestHeader.get("authorization") ?? undefined;
  if (header == null || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice(7).trim();
  return value.length === 0 ? undefined : value;
}

/** Resolves the caller to a scope, or throws the refusal the client understands. */
export function authenticate(deps: Pick<BrokerHandlerDeps, "allowlist">, context: Pick<HandlerContext, "requestHeader">): { scope: string; displayName: string } {
  const key = bearerToken(context);
  // Unauthenticated is load-bearing: the client maps it to "access denied" and
  // clears its cached gateway descriptor instead of retrying forever.
  if (key == null) throw new ConnectError("missing API key", Code.Unauthenticated);
  const displayName = deps.allowlist.lookup(key);
  if (displayName === undefined) throw new ConnectError("this API key is not allowed to provision a box", Code.Unauthenticated);
  return { scope: keyScope(key), displayName };
}

function quotaRefusal(deps: BrokerHandlerDeps, error: BoxQuotaExceededError): ConnectError {
  // Reuses the client's existing "box blocked" surface, including retry-after.
  const metadata = new Headers({ [AUTOMATION_FAILURE_HINT_HEADER]: SAND_BOX_BLOCKED_HINT, "retry-after": String(deps.quotaRetryAfterSeconds) });
  return new ConnectError(error.message, Code.ResourceExhausted, metadata);
}

export function ensureSandBoxResponse(deps: Pick<BrokerHandlerDeps, "masterSecret" | "publicBaseUrl">, scope: string, podName: string): EnsureSandBoxResponse {
  const networkToken = networkTokenFor(deps.masterSecret, scope);
  return new EnsureSandBoxResponse({
    cluster: CLUSTER_NAME,
    tenantId: scope,
    podId: podName,
    networkToken,
    gatewayUrl: boxLegBaseUrl(deps.publicBaseUrl, networkToken, "gw"),
    gatewayToken: gatewayTokenFor(deps.masterSecret, scope),
    // The client passes vncUrl straight through as vncProxy.primaryUrl, and
    // rewrites the box's own loopback URLs to it. The network_token has to ride
    // in the query so the webview seeds its header before the first asset load.
    vncUrl: `${boxLegBaseUrl(deps.publicBaseUrl, networkToken, "vnc")}/vnc.html?network_token=${networkToken}`,
    forkVncBaseUrl: boxLegBaseUrl(deps.publicBaseUrl, networkToken, "fork"),
    // Deliberately empty: the in-box loopback box supplies these, not the broker.
    execDaemonUrl: "",
    execDaemonAuthToken: "",
    terminalsFolder: "",
    imageUpdateAvailable: false,
  });
}

export function createBrokerHandlers(deps: BrokerHandlerDeps) {
  // The client remembers the operationId that recreateSandBox returned and only
  // treats a migration stream as finished when a terminal event carries the SAME
  // id (box-migration-watcher.ts: answersOwed). Emitting events without it leaves
  // the "Updating Grok Bot's Computer" dialog spinning at 0% forever.
  const lastOperation = new Map<string, string>();
  const ensure = async (context: Pick<HandlerContext, "requestHeader">): Promise<EnsureSandBoxResponse> => {
    const { scope, displayName } = authenticate(deps, context);
    try {
      const box = await deps.provisioner.ensure(scope);
      deps.log(`ensure scope=${scope.slice(0, 12)} name=${displayName} pod=${box.podName}`);
      return ensureSandBoxResponse(deps, scope, box.podName);
    } catch (error) {
      if (error instanceof BoxQuotaExceededError) throw quotaRefusal(deps, error);
      if (error instanceof BoxNotReadyError) throw new ConnectError(error.message, Code.Unavailable);
      // Connect turns anything else into a bare "internal error" on the wire, so
      // the only place the cause can be seen is here.
      deps.log(`ensure failed scope=${scope.slice(0, 12)}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      throw error;
    }
  };

  const recreate = async (context: Pick<HandlerContext, "requestHeader">): Promise<RecreateSandBoxResponse> => {
    const { scope } = authenticate(deps, context);
    const operationId = `broker-${scope.slice(0, 12)}-${deps.now()}`;
    lastOperation.set(scope, operationId);
    await deps.provisioner.destroy(scope);
    await deps.provisioner.ensure(scope);
    deps.log(`recreate scope=${scope.slice(0, 12)} operation=${operationId}`);
    return new RecreateSandBoxResponse({ started: true, reason: "", operationId });
  };

  const service = {
    ensureSandBox: async (_request: unknown, context: HandlerContext) => await ensure(context),
    ensureSandBoxWindow: async (_request: unknown, context: HandlerContext) => await ensure(context),
    recreateSandBox: async (_request: unknown, context: HandlerContext) => await recreate(context),
    forceRecreateSandBox: async (_request: unknown, context: HandlerContext) => await recreate(context),
    getSandBoxRunState: async (_request: unknown, context: HandlerContext) => {
      authenticate(deps, context);
      // 1 = RUNNING in SandBoxRunState; the client only distinguishes running.
      return new GetSandBoxRunStateResponse({ state: 1, imageUpdateAvailable: false });
    },
    watchSandBoxMigration: async function* (_request: unknown, context: HandlerContext) {
      const { scope } = authenticate(deps, context);
      // Emit ONLY for an operation we actually ran. The client watches this stream
      // continuously, and a CREATING event on every attach makes it believe an
      // update is in progress forever — which disables sending and survives a
      // relaunch, because the next attach says the same thing again.
      const operationId = lastOperation.get(scope);
      if (operationId != null) {
        // A broker recreate is synchronous, so by the time anyone watches it is
        // already finished: report the terminal phase and forget the operation.
        lastOperation.delete(scope);
        yield new SandBoxMigrationEvent({ phase: 6, detail: "done", atMs: BigInt(deps.now()), offsetKey: `${operationId}-done`, operationId });
      }
      // Hold the stream briefly instead of ending instantly, so a client that
      // reattaches on stream end does not spin.
      await new Promise(resolve => setTimeout(resolve, deps.idleWatchMs));
    },
  };

  return { service, definition: GrokBotService, ensure, authenticate: (context: Pick<HandlerContext, "requestHeader">) => authenticate(deps, context) };
}
