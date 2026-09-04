import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The user's broker API key, at rest.
 *
 * Deliberately not `SandUserSecretsStore`: that store keys secrets by signed-in
 * account and refuses to write without one, which is exactly the situation while
 * the user is entering the key that will sign them in. This is the same
 * safeStorage-blob-in-a-0600-file shape the gateway descriptor cache uses, with
 * the codec injected so it is testable without Electron.
 */
export const BROKER_KEY_FILENAME = "broker-key.json";
export const BROKER_KEY_BOOTSTRAP_FILENAME = "broker-key";
export const BROKER_KEY_VERSION = 1;

export interface BrokerKeyCodec {
  isAvailable(): boolean;
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
}

export interface BrokerKeyStore {
  read(): string | undefined;
  write(apiKey: string): void;
  clear(): void;
}

interface StoredKey { readonly version?: number; readonly key?: string; readonly encrypted?: boolean }

export function createBrokerKeyStore(options: {
  readonly filePath: string;
  readonly codec: BrokerKeyCodec;
  /**
   * A plaintext file an operator can drop in before first launch (beta
   * onboarding). Adopted once, then persisted through the codec and deleted.
   */
  readonly bootstrapFilePath?: string;
  readonly reportFailure?: (stage: string, error: unknown) => void;
}): BrokerKeyStore {
  const report = (stage: string, error: unknown): void => options.reportFailure?.(stage, error);

  const persist = (apiKey: string): void => {
    const usable = options.codec.isAvailable();
    const payload: StoredKey = { version: BROKER_KEY_VERSION, key: usable ? options.codec.encrypt(apiKey) : apiKey, encrypted: usable };
    mkdirSync(dirname(options.filePath), { recursive: true });
    const temporary = `${options.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(temporary, options.filePath);
    // rename preserves the temp file's mode, but be explicit for an existing file.
    try { chmodSync(options.filePath, 0o600); } catch (error) { report("chmod", error); }
  };

  const adoptBootstrap = (): string | undefined => {
    const bootstrap = options.bootstrapFilePath;
    if (bootstrap == null || !existsSync(bootstrap)) return undefined;
    try {
      const apiKey = readFileSync(bootstrap, "utf8").trim();
      if (apiKey.length === 0) return undefined;
      persist(apiKey);
      // Do not leave a second plaintext copy lying around once it is stored.
      try { unlinkSync(bootstrap); } catch (error) { report("bootstrap-cleanup", error); }
      return apiKey;
    } catch (error) {
      report("bootstrap-read", error);
      return undefined;
    }
  };

  return {
    read() {
      let raw: string;
      try { raw = readFileSync(options.filePath, "utf8"); }
      catch { return adoptBootstrap(); }
      let parsed: StoredKey;
      try { parsed = JSON.parse(raw) as StoredKey; } catch (error) { report("parse", error); return undefined; }
      const stored = parsed.key;
      if (typeof stored !== "string" || stored.length === 0) return undefined;
      if (parsed.encrypted !== true) return stored;
      if (!options.codec.isAvailable()) { report("decrypt", new Error("encrypted storage is unavailable")); return undefined; }
      try { return options.codec.decrypt(stored); } catch (error) { report("decrypt", error); return undefined; }
    },
    write(apiKey) { persist(apiKey.trim()); },
    clear() { try { unlinkSync(options.filePath); } catch (error) { report("clear", error); } },
  };
}

export function brokerKeyPaths(userDataDir: string, homeDir: string): { readonly filePath: string; readonly bootstrapFilePath: string } {
  return { filePath: join(userDataDir, BROKER_KEY_FILENAME), bootstrapFilePath: join(homeDir, ".grokbot", BROKER_KEY_BOOTSTRAP_FILENAME) };
}
