import { createCursorAuthWiring, type AuthServicePort } from "../account/cursor-auth-wiring.js";
import { resolveApiKeySessionConfig, SandApiKeySessionAuthService } from "../account/api-key-session.js";
import { createBrokerSessionRuntime } from "../account/broker-session-runtime.js";
import { createBrokerKeyPrompt, type BrokerKeyWindowElectron } from "../account/broker-key-window.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionAccountService, ProductionServiceContext } from "../main-production-services.js";
import { requireFunction, requireObject } from "./provider-guards.js";

// Electron's ipcMain/BrowserWindow are not on the narrow native-bindings port, and
// this adapter only ever runs inside Electron; the lazy require mirrors
// telemetry-report-sinks.ts.
function requireElectronRuntime(): unknown {
  const load = (() => { try { return eval("require") as NodeRequire; } catch { return undefined; } })();
  if (load == null) throw new Error("Electron runtime is unavailable for the broker key window.");
  return load("electron");
}

type CursorAuthWiringDeps = Parameters<typeof createCursorAuthWiring>[0];

export interface ProductionAccountOAuthPorts {
  readonly resolveWiringDeps?: (context: ProductionServiceContext) => CursorAuthWiringDeps;
}

function accountRuntimeOf(context: ProductionServiceContext): ReturnType<CursorAuthWiringDeps["getAccountRuntime"]> {
  try {
    const runtime = context.requireCoordinator().getAccountRuntime?.();
    if (runtime != null && typeof (runtime as { observe?: unknown }).observe === "function" && typeof (runtime as { whenIdle?: unknown }).whenIdle === "function") {
      return runtime as ReturnType<CursorAuthWiringDeps["getAccountRuntime"]>;
    }
  } catch {
    // Account construction precedes coordinator construction. The auth wiring
    // must deliver directly until the coordinator exposes its settled runtime.
  }
  return null;
}

function defaultWiringDeps(context: ProductionServiceContext): CursorAuthWiringDeps {
  requireFunction(context.native?.shell?.openExternal, "electron.shell.openExternal");
  requireFunction(context.settings?.settingsStore?.getLocalToolPermission, "account settings.getLocalToolPermission");
  requireFunction(context.settings?.settingsStore?.setLocalToolPermissionCeiling, "account settings.setLocalToolPermissionCeiling");
  requireFunction(context.requireMainEdge, "account main-edge");
  requireFunction(context.coordinatorLegs?.legs?.setHostSettings, "account coordinator.setHostSettings");
  // Self-hosted mode: the login gate accepts either an operator-run box's gateway
  // token or, for builds packaged against a self-hosted broker, the user's own API
  // key (see api-key-session.ts). Cursor account auth is untouched otherwise.
  const broker = createBrokerSessionRuntime({
    userDataDir: context.native.app.getPath("userData"),
    safeStorage: context.native.safeStorage,
  });
  const apiKeySession = resolveApiKeySessionConfig(context.env, broker);
  // Broker mode answers the renderer's existing "Sign in" button with a native key
  // window, so the checksum-pinned renderer needs no change to collect a key.
  const brokerKeyPrompt = apiKeySession?.mode !== "broker" || broker.backendUrl == null ? undefined : createBrokerKeyPrompt({
    electron: requireElectronRuntime() as unknown as BrokerKeyWindowElectron,
    preloadPath: context.resources.preloadPath,
    backendUrl: broker.backendUrl,
  });
  return {
    openExternal: async (url) => { await context.native.shell.openExternal(url); },
    ...(apiKeySession == null ? {} : {
      createAuthService: () => new SandApiKeySessionAuthService(apiKeySession, brokerKeyPrompt == null ? {} : {
        promptForApiKey: brokerKeyPrompt,
        storeApiKey: (apiKey) => broker.store.write(apiKey),
        clearApiKey: () => broker.store.clear(),
      }),
    }),
    getAccountRuntime: () => accountRuntimeOf(context),
    emitAuthStatus: (status) => context.requireMainEdge().emit("cursor-auth-changed", status),
    sentryEnabled: context.env.SAND_DISABLE_SENTRY !== "1",
    settingsStore: context.settings.settingsStore,
    syncHostSettingsToBox: async (settings) => {
      const setHostSettings = context.coordinatorLegs.legs.setHostSettings;
      if (typeof setHostSettings !== "function") throw new Error("Electron production account requires coordinator host-settings synchronization.");
      await setHostSettings(settings);
    },
  };
}

function validateAuthService(service: AuthServicePort): AuthServicePort {
  requireObject(service, "accountOAuth.service");
  for (const method of ["subscribe", "getStatus", "getValidAccessToken", "revokeForAccountRefusal", "login", "cancelLogin", "logout", "updateDisplayName"] as const) {
    requireFunction(service[method], `accountOAuth.service.${method}`);
  }
  return service;
}

/** Artifact anchor: main.cjs:505993, `var cursorAuthWiring = createCursorAuthWiring({`. */
export function createProductionAccountOAuthAdapter(
  ports: ProductionAccountOAuthPorts,
): ElectronProductionAdapterBindings["accountOAuth"] {
  return {
    async create(context): Promise<ProductionAccountService> {
      const wiring = createCursorAuthWiring((ports?.resolveWiringDeps ?? defaultWiringDeps)(context));
      const service = validateAuthService(await wiring.ensureCursorAuthService());
      const subscriptions = new Set<() => void>();
      let disposed = false;
      return {
        getStatus: () => service.getStatus(),
        currentAuthStatusFreshness: wiring.currentAuthStatusFreshness,
        deliverCursorAuthStatus(status) {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          wiring.deliverCursorAuthStatus(service, status);
        },
        async getAuthService() {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          return service;
        },
        async revokeForAccountRefusal() {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          return await service.revokeForAccountRefusal();
        },
        subscribe(listener) {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          const unsubscribe = service.subscribe(() => listener());
          subscriptions.add(unsubscribe);
          return () => { if (subscriptions.delete(unsubscribe)) unsubscribe(); };
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          const failures: unknown[] = [];
          for (const unsubscribe of [...subscriptions].reverse()) {
            subscriptions.delete(unsubscribe);
            try { unsubscribe(); } catch (error) { failures.push(error); }
          }
          try { wiring.dispose(); } catch (error) { failures.push(error); }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Electron production account cleanup failed.");
        },
      };
    },
  };
}

/**
 * Exact desktop account composition: native browser callback, secure-store
 * defaults, generated profile clients, main-edge status, coordinator account
 * runtime, and host-settings synchronization remain real owner seams.
 */
export function createElectronProductionAccountOAuthBinding(): ElectronProductionAdapterBindings["accountOAuth"] {
  return createProductionAccountOAuthAdapter({});
}
