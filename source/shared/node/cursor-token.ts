import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const DEFAULT_CURSOR_BACKEND_URL = "https://api2.cursor.sh";
export const PROD_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEV_AUTH_CLIENT_ID = "OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE";
export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface JwtPayload { readonly email?: string; readonly exp?: number; readonly sub?: string; readonly [key: string]: unknown; }

export function parseJwtPayload(token: string): JwtPayload | null {
  const [, payload] = token.split(".");
  if (payload == null || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.email !== undefined && typeof record.email !== "string") return null;
    if (record.exp !== undefined && typeof record.exp !== "number") return null;
    if (record.sub !== undefined && typeof record.sub !== "string") return null;
    return record as JwtPayload;
  } catch { return null; }
}

export function accountCacheScope(accessToken: string): string {
  return createHash("sha256").update(parseJwtPayload(accessToken)?.sub ?? accessToken).digest("hex");
}

export function isTokenExpiringSoon(token: string, now = Date.now()): boolean {
  const payload = parseJwtPayload(token);
  return payload?.exp == null || payload.exp * 1_000 - now < TOKEN_REFRESH_LEEWAY_MS;
}

export function getAccessTokenExpiryMs(token: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return exp == null || !Number.isFinite(exp) ? null : exp * 1_000;
}

/**
 * A backend baked into the app bundle at packaging time, for builds that ship
 * pointed at a self-hosted broker instead of Cursor's backend.
 *
 * Read from Resources rather than an env var because the user only ever types a
 * key: env would put the burden back on whoever installs it. Not a user-editable
 * setting either — a settable backend URL is somewhere to phish an API key to,
 * and this file needs admin rights to change and shows up in a bundle diff.
 */
export const PACKAGED_BACKEND_FILENAME = "sand-backend.json";
export interface PackagedBackendConfig { readonly backendUrl: string; readonly authMode?: string }

let packagedBackend: PackagedBackendConfig | null | undefined;

export function readPackagedBackendConfig(deps?: {
  readonly resourcesPath?: string;
  readonly readFile?: (path: string) => string;
}): PackagedBackendConfig | null {
  if (deps === undefined && packagedBackend !== undefined) return packagedBackend;
  const resourcesPath = deps?.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  const resolve = (): PackagedBackendConfig | null => {
    if (resourcesPath == null || resourcesPath.length === 0) return null;
    let raw: string;
    try { raw = (deps?.readFile ?? ((path: string) => readFileSync(path, "utf8")))(`${resourcesPath}/${PACKAGED_BACKEND_FILENAME}`); }
    catch { return null; }
    try {
      const parsed = JSON.parse(raw) as { backendUrl?: unknown; authMode?: unknown };
      if (typeof parsed.backendUrl !== "string" || parsed.backendUrl.length === 0) return null;
      new URL(parsed.backendUrl);
      return { backendUrl: parsed.backendUrl, ...(typeof parsed.authMode === "string" ? { authMode: parsed.authMode } : {}) };
    } catch { return null; }
  };
  const resolved = resolve();
  if (deps === undefined) packagedBackend = resolved;
  return resolved;
}

export function getConfiguredBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Env still wins, so a dev can point a packaged build anywhere.
  const configured = env.SAND_BACKEND_URL ?? env.CURSOR_API_BASE_URL ?? readPackagedBackendConfig()?.backendUrl ?? DEFAULT_CURSOR_BACKEND_URL;
  return new URL(configured).toString();
}

export function getAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_AUTH_CLIENT_ID;
  if (configured != null && configured.length > 0) return configured;
  const hostname = new URL(backendUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build") || hostname === "dev-staging.cursor.sh" ? DEV_AUTH_CLIENT_ID : PROD_AUTH_CLIENT_ID;
}

export function isDevAuthBackend(backendUrl: string): boolean { return getAuthClientId(backendUrl) !== PROD_AUTH_CLIENT_ID; }
export function shouldRefreshAccessToken(backendUrl: string, accessToken: string): boolean { return isTokenExpiringSoon(accessToken) || isDevAuthBackend(backendUrl); }
