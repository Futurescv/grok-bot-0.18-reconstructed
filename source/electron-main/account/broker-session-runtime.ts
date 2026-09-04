import { homedir } from "node:os";

import { readPackagedBackendConfig } from "../../shared/node/cursor-token.js";
import { brokerKeyPaths, createBrokerKeyStore, type BrokerKeyStore } from "./broker-key-store.js";
import type { ApiKeySessionSources } from "./api-key-session.js";

/**
 * What broker mode needs to activate: the backend this build was packaged with,
 * and the key the user has stored. Shared by the auth and access adapters so both
 * agree on whether the session is a broker session.
 */
export interface BrokerSessionRuntime extends ApiKeySessionSources {
  readonly store: BrokerKeyStore;
  readonly backendUrl: string | undefined;
}

export function createBrokerSessionRuntime(deps: {
  readonly userDataDir: string;
  readonly safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plaintext: string): Buffer;
    decryptString(stored: Buffer): string;
  };
  readonly homeDir?: string;
  readonly reportFailure?: (stage: string, error: unknown) => void;
}): BrokerSessionRuntime {
  const paths = brokerKeyPaths(deps.userDataDir, deps.homeDir ?? homedir());
  const store = createBrokerKeyStore({
    filePath: paths.filePath,
    bootstrapFilePath: paths.bootstrapFilePath,
    codec: {
      isAvailable: () => deps.safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => deps.safeStorage.encryptString(plaintext).toString("base64"),
      decrypt: (stored) => deps.safeStorage.decryptString(Buffer.from(stored, "base64")),
    },
    ...(deps.reportFailure === undefined ? {} : { reportFailure: deps.reportFailure }),
  });
  const backendUrl = readPackagedBackendConfig()?.backendUrl;
  return {
    store,
    backendUrl,
    brokerBackendUrl: () => backendUrl,
    // Read per call: the key can appear while the app is running (bootstrap file
    // or the key window), and a stale capture would keep the gate shut.
    brokerApiKey: () => store.read(),
  };
}
