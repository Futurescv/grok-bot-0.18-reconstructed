export const GATEWAY_API_PREFIX = "/api";
export const GATEWAY_EVENTS_PATH = "/events";
export const GATEWAY_HEALTH_PATH = "/health";
export const GATEWAY_AUTH_SCHEME = "Bearer";
// Equivalent to the Authorization bearer, for callers that reach the gateway
// through a proxy which consumes Authorization for its own authentication (the
// Kubernetes apiserver's service/pod proxy deletes the header before
// forwarding, but passes unknown headers through untouched).
export const GATEWAY_TOKEN_HEADER = "x-sand-gateway-token";
export const GATEWAY_SLIM_AVATARS_HEADER = "x-sand-slim-avatars";
export const GATEWAY_MINT_DEDUPE_HEADER = "x-sand-mint-dedupe";
export const GATEWAY_TRACEPARENT_HEADER = "traceparent";
export const GATEWAY_AVATARS_PATH = "/avatars";
export const GATEWAY_NETWORK_TOKEN_HEADER = "x-anyrun-network-token";
