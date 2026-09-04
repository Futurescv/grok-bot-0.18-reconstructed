import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Who a caller is, and which tokens their box uses.
 *
 * The client sends nothing but `authorization: Bearer <key>` (EnsureSandBox has
 * an empty request body), so the key is the whole identity. `scope` is
 * deliberately `sha256(key)`: that is exactly what the desktop's own
 * `accountCacheScope()` computes for a non-JWT credential, so the box the broker
 * hands out lines up with the descriptor cache and secret slot the client keys by.
 *
 * Both per-box tokens are derived from one master secret, so the broker never
 * has to store them: any replica can recompute them, and rotating the master
 * secret invalidates every box at once (the box's own gateway then rejects the
 * stale token, which the client treats as a permanent refusal and re-ensures).
 */
export const SCOPE_LENGTH = 64;

export function keyScope(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function derive(masterSecret: string, purpose: string, scope: string): string {
  return createHmac("sha256", masterSecret).update(`${purpose}:${scope}`).digest("base64url");
}

export function networkTokenFor(masterSecret: string, scope: string): string {
  return derive(masterSecret, "network", scope);
}

export function gatewayTokenFor(masterSecret: string, scope: string): string {
  return derive(masterSecret, "gateway", scope);
}

/** Pod names must be DNS labels, and one box per scope is the whole model. */
export function podNameFor(scope: string): string {
  return `box-${scope.slice(0, 12)}`;
}

/**
 * A label *value* is capped at 63 bytes and a full sha256 hex digest is 64, so
 * the selector carries a truncated form while the full scope travels in an
 * annotation. 128 bits is far more than enough to keep boxes apart.
 */
export function scopeLabel(scope: string): string {
  return scope.slice(0, 32);
}

export function sameToken(provided: string | undefined, expected: string): boolean {
  if (provided == null) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Recovers the scope a network token belongs to.
 *
 * The broker keeps no token table: it re-derives each live scope's token and
 * compares. Callers pass the scopes they know about (from the pod informer), so
 * an unknown token simply resolves to nothing and the request is refused.
 */
export function scopeForNetworkToken(masterSecret: string, token: string, knownScopes: Iterable<string>): string | undefined {
  for (const scope of knownScopes) {
    if (sameToken(token, networkTokenFor(masterSecret, scope))) return scope;
  }
  return undefined;
}
