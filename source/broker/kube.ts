import { readFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import os from "node:os";
import path from "node:path";

/**
 * The four Kubernetes calls the broker needs, over plain HTTPS.
 *
 * Hand-rolled rather than @kubernetes/client-node: the surface is pods (get,
 * list, create, delete) plus one configmap read, and this repo's package.json is
 * a reconstruction artifact where a new runtime dependency has to justify itself.
 *
 * Two dial modes, so the same binary runs on a laptop and in the cluster:
 *  - in-cluster: the ServiceAccount token and CA that kubelet projects. The token
 *    file is re-read per request because kubelet rotates it in place.
 *  - kubeconfig: client-certificate mTLS, read the way deploy/acs/gateway-proxy.mjs
 *    already reads it (regex over the generated file, credentials stay in memory).
 */
export type KubeTls = { readonly ca?: Buffer; readonly cert?: Buffer; readonly key?: Buffer };
export type KubeEndpoint = { readonly host: string; readonly port: number; readonly tls: KubeTls };
export type KubeReply<T> = { readonly status: number; readonly value: T | undefined; readonly raw: string };

export interface KubeClient {
  readonly namespace: string;
  readonly endpoint: KubeEndpoint;
  readonly mode: "in-cluster" | "kubeconfig";
  request<T>(method: string, apiPath: string, body?: unknown): Promise<KubeReply<T>>;
  /** Headers that authenticate the broker itself; recomputed per call for token rotation. */
  authHeaders(): Record<string, string>;
}

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

function readIfPresent(file: string): Buffer | undefined {
  try { return readFileSync(file); } catch { return undefined; }
}

function inClusterClient(env: NodeJS.ProcessEnv): KubeClient | undefined {
  const token = readIfPresent(path.join(SERVICE_ACCOUNT_DIR, "token"));
  const namespace = readIfPresent(path.join(SERVICE_ACCOUNT_DIR, "namespace"));
  if (token === undefined || namespace === undefined) return undefined;
  const ca = readIfPresent(path.join(SERVICE_ACCOUNT_DIR, "ca.crt"));
  const endpoint: KubeEndpoint = {
    host: env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc",
    port: Number(env.KUBERNETES_SERVICE_PORT ?? "443"),
    tls: ca === undefined ? {} : { ca },
  };
  return finishClient({
    namespace: namespace.toString("utf8").trim(),
    endpoint,
    mode: "in-cluster",
    authHeaders: () => {
      // Re-read: kubelet rotates the projected token roughly hourly.
      const current = readIfPresent(path.join(SERVICE_ACCOUNT_DIR, "token")) ?? token;
      return { authorization: `Bearer ${current.toString("utf8").trim()}` };
    },
  });
}

function kubeconfigClient(env: NodeJS.ProcessEnv): KubeClient {
  const file = env.KUBECONFIG ?? path.join(os.homedir(), ".kube/config");
  const raw = readFileSync(file, "utf8");
  const pick = (key: string): string | undefined => new RegExp(`${key}:\\s*(\\S+)`).exec(raw)?.[1];
  const server = pick("server");
  const cert = pick("client-certificate-data");
  const key = pick("client-key-data");
  if (server === undefined || cert === undefined || key === undefined) throw new Error(`${file} lacks a server URL and client certificate`);
  const ca = pick("certificate-authority-data");
  const url = new URL(server);
  return finishClient({
    namespace: env.BOX_NAMESPACE ?? "grok-bot",
    endpoint: {
      host: url.hostname,
      port: url.port.length > 0 ? Number(url.port) : 443,
      tls: { cert: Buffer.from(cert, "base64"), key: Buffer.from(key, "base64"), ...(ca === undefined ? {} : { ca: Buffer.from(ca, "base64") }) },
    },
    mode: "kubeconfig",
    authHeaders: () => ({}),
  });
}

function finishClient(base: Omit<KubeClient, "request">): KubeClient {
  const request = async <T>(method: string, apiPath: string, body?: unknown): Promise<KubeReply<T>> => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const options: RequestOptions = {
      host: base.endpoint.host,
      port: base.endpoint.port,
      method,
      path: apiPath,
      headers: {
        accept: "application/json",
        ...base.authHeaders(),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": payload.byteLength }),
      },
      ...(base.endpoint.tls.ca === undefined ? { rejectUnauthorized: false } : { ca: base.endpoint.tls.ca }),
      ...(base.endpoint.tls.cert === undefined ? {} : { cert: base.endpoint.tls.cert, key: base.endpoint.tls.key }),
    };
    return await new Promise<KubeReply<T>>((resolve, reject) => {
      const call = httpsRequest(options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let value: T | undefined;
          try { value = raw.length === 0 ? undefined : JSON.parse(raw) as T; } catch { value = undefined; }
          resolve({ status: response.statusCode ?? 0, value, raw });
        });
      });
      call.on("error", reject);
      if (payload !== undefined) call.write(payload);
      call.end();
    });
  };
  return { ...base, request };
}

export function createKubeClient(env: NodeJS.ProcessEnv = process.env): KubeClient {
  return inClusterClient(env) ?? kubeconfigClient(env);
}

// --- typed shapes, only the fields the broker reads ---

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
export interface Pod {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string>; readonly annotations?: Record<string, string>; readonly deletionTimestamp?: string };
  readonly status?: {
    readonly phase?: PodPhase;
    readonly podIP?: string;
    readonly conditions?: readonly { readonly type?: string; readonly status?: string; readonly message?: string }[];
    readonly containerStatuses?: readonly { readonly ready?: boolean; readonly state?: Record<string, { readonly reason?: string; readonly message?: string }> }[];
    readonly initContainerStatuses?: readonly { readonly ready?: boolean; readonly state?: Record<string, { readonly reason?: string; readonly message?: string }> }[];
  };
}

const encode = (value: string): string => encodeURIComponent(value);

export function podsPath(namespace: string, suffix = ""): string {
  return `/api/v1/namespaces/${encode(namespace)}/pods${suffix}`;
}

export async function listPods(kube: KubeClient, labelSelector: string): Promise<readonly Pod[]> {
  const reply = await kube.request<{ items?: readonly Pod[] }>("GET", podsPath(kube.namespace, `?labelSelector=${encode(labelSelector)}`));
  if (reply.status !== 200) throw new Error(`listing pods failed (${reply.status}): ${reply.raw.slice(0, 512)}`);
  return reply.value?.items ?? [];
}

export async function getPod(kube: KubeClient, name: string): Promise<Pod | undefined> {
  const reply = await kube.request<Pod>("GET", podsPath(kube.namespace, `/${encode(name)}`));
  if (reply.status === 404) return undefined;
  if (reply.status !== 200) throw new Error(`reading pod ${name} failed (${reply.status}): ${reply.raw.slice(0, 512)}`);
  return reply.value;
}

export async function createPod(kube: KubeClient, pod: unknown): Promise<Pod> {
  const reply = await kube.request<Pod>("POST", podsPath(kube.namespace), pod);
  // 409 means someone (or a racing call) already created it; adopt instead of failing.
  if (reply.status === 409) {
    const existing = await getPod(kube, (pod as { metadata?: { name?: string } }).metadata?.name ?? "");
    if (existing !== undefined) return existing;
  }
  if (reply.status !== 201 && reply.status !== 200) throw new Error(`creating pod failed (${reply.status}): ${reply.raw.slice(0, 512)}`);
  if (reply.value === undefined) throw new Error("creating pod returned no object");
  return reply.value;
}

export async function deletePod(kube: KubeClient, name: string, gracePeriodSeconds = 5): Promise<void> {
  const reply = await kube.request<unknown>("DELETE", podsPath(kube.namespace, `/${encode(name)}?gracePeriodSeconds=${gracePeriodSeconds}`));
  if (reply.status !== 200 && reply.status !== 202 && reply.status !== 404) throw new Error(`deleting pod ${name} failed (${reply.status}): ${reply.raw.slice(0, 512)}`);
}

export async function getConfigMapData(kube: KubeClient, name: string): Promise<Record<string, string> | undefined> {
  const reply = await kube.request<{ data?: Record<string, string> }>("GET", `/api/v1/namespaces/${encode(kube.namespace)}/configmaps/${encode(name)}`);
  if (reply.status === 404) return undefined;
  if (reply.status !== 200) throw new Error(`reading configmap ${name} failed (${reply.status}): ${reply.raw.slice(0, 512)}`);
  return reply.value?.data ?? {};
}

export function isPodReady(pod: Pod | undefined): boolean {
  if (pod?.status?.phase !== "Running" || pod.metadata?.deletionTimestamp != null) return false;
  return pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") === true;
}

/** A pod that will never become ready on its own, so the broker recreates it. */
export function podIsWedged(pod: Pod | undefined): string | undefined {
  if (pod == null) return undefined;
  if (pod.status?.phase === "Failed") return pod.status.conditions?.find((condition) => condition.status !== "True")?.message ?? "pod failed";
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  for (const status of statuses) {
    for (const state of Object.values(status.state ?? {})) {
      const reason = state.reason ?? "";
      if (["ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName"].includes(reason)) return reason;
    }
  }
  return undefined;
}
