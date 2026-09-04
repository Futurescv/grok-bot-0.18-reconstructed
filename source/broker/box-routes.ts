/**
 * Maps a client URL onto one leg of one box.
 *
 * Shape: `/box/<networkToken>/<leg>/<rest>`, where the prefix is stripped before
 * the request reaches the pod. A path prefix (rather than a per-box hostname) is
 * what the client's own URL construction forces: `buildSandBoxNoVncUrl` embeds
 * `path=websockify?...` *relative* to the viewer page, and noVNC loads its assets
 * relatively too, so page, assets and the WebSocket all have to live under one
 * host and one prefix. Stripping the prefix is what keeps `?token=N` and
 * `?network_token=…` intact on the way to websockify.
 */
export const BOX_PATH_PREFIX = "/box";

export const BOX_LEGS = {
  /** The in-box Sand gateway: POST /api/*, GET /events (SSE), /health, /avatars/*. */
  gw: 1340,
  /** Primary noVNC display. */
  vnc: 6080,
  /** Token-gated websockify serving the per-agent fork displays. */
  fork: 6081,
} as const;

export type BoxLeg = keyof typeof BOX_LEGS;

export type BoxRoute = { readonly token: string; readonly leg: BoxLeg; readonly port: number; readonly path: string };
export type BoxRouteRefusal = { readonly refusal: "not-a-box-path" | "malformed" | "unknown-leg" | "traversal" };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isLeg(value: string): value is BoxLeg {
  return Object.hasOwn(BOX_LEGS, value);
}

/**
 * Traversal is refused rather than normalised: the upstreams are a static file
 * server and a command gateway, so a request that tries to climb out of its own
 * prefix is a probe, not a typo.
 */
function hasTraversal(value: string): boolean {
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return true; }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.split(/[/\\]/).includes("..");
}

export function resolveBoxRoute(url: string): BoxRoute | BoxRouteRefusal {
  const queryAt = url.search(/[?#]/);
  const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
  const suffix = queryAt < 0 ? "" : url.slice(queryAt);
  if (!pathname.startsWith(`${BOX_PATH_PREFIX}/`)) return { refusal: "not-a-box-path" };
  if (hasTraversal(pathname)) return { refusal: "traversal" };

  const segments = pathname.slice(BOX_PATH_PREFIX.length + 1).split("/");
  const token = segments[0] ?? "";
  const leg = segments[1] ?? "";
  if (token.length === 0 || !BASE64URL.test(token)) return { refusal: "malformed" };
  if (leg.length === 0) return { refusal: "unknown-leg" };
  if (!isLeg(leg)) return { refusal: "unknown-leg" };

  const rest = segments.slice(2).join("/");
  return { token, leg, port: BOX_LEGS[leg], path: `/${rest}${suffix}` };
}

export function isBoxRouteRefusal(value: BoxRoute | BoxRouteRefusal): value is BoxRouteRefusal {
  return Object.hasOwn(value, "refusal");
}

/** The public URLs handed to the client in EnsureSandBoxResponse. */
export function boxLegBaseUrl(publicBaseUrl: string, networkToken: string, leg: BoxLeg): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${BOX_PATH_PREFIX}/${networkToken}/${leg}`;
}
