import { createPod, deletePod, getPod, isPodReady, listPods, podIsWedged, type KubeClient, type Pod } from "./kube.js";
import { gatewayTokenFor, podNameFor, scopeLabel } from "./identity.js";

/**
 * One box per scope, created on demand and adopted if it already exists.
 *
 * Bare Pods, not Deployments: a box is always a single replica, and a controller
 * would fight the idle reaper (delete the pod, the ReplicaSet brings it back).
 * Crash recovery does not need a controller either — the client re-runs
 * EnsureSandBox on every connect cycle, which recreates a missing pod.
 */
export const BOX_LABEL_APP = "grok-bot-box";
export const BOX_LABEL_SCOPE = "grok-bot.dev/scope";
export const BOX_LABEL_MANAGED_BY = "grok-bot.dev/managed-by";
export const BOX_MANAGED_BY = "broker";
export const BOX_ANNOTATION_CREATED_AT = "grok-bot.dev/created-at";
// The label is truncated to fit Kubernetes' 63-byte cap; this carries the exact
// scope, which is what the per-box tokens are derived from.
export const BOX_ANNOTATION_SCOPE = "grok-bot.dev/scope-full";
export const BOX_SELECTOR = `${BOX_LABEL_MANAGED_BY}=${BOX_MANAGED_BY}`;

export interface BoxTemplateConfig {
  readonly image: string;
  /**
   * Inference settings handed to every box, so a user needs no model key of their
   * own. Set by the operator, which matters for more than convenience: inference
   * now runs *inside the box*, so the endpoint has to be reachable from the
   * cluster — a key that works from a laptop can point at a host the cluster
   * cannot resolve. A key entered in Settings → Router still overrides these,
   * because box-secrets are applied over the container environment.
   */
  readonly inferenceEnv: Readonly<Record<string, string>>;
  /** In-cluster URL the initContainer fetches the reconstructed runtime from. */
  readonly runtimeBaseUrl: string;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly nodeSelector?: Record<string, string>;
  readonly tolerations?: readonly unknown[];
}

export interface ProvisionerConfig extends BoxTemplateConfig {
  readonly masterSecret: string;
  /**
   * How long EnsureSandBox may wait for a fresh box to answer before returning
   * anyway. Must stay well under the ALB's ~60s response cap (it 504s past that).
   * With a warm ECI image cache a box is ready in ~20s, so a bounded wait makes
   * the client's first connection succeed instead of failing once and retrying.
   */
  readonly ensureWaitMs: number;
  readonly readyTimeoutMs: number;
  readonly pollMs: number;
  readonly maxLiveBoxes: number;
  readonly now: () => number;
}

export class BoxQuotaExceededError extends Error {
  constructor(readonly liveCount: number, readonly limit: number) { super(`the broker is already running ${liveCount} of ${limit} boxes`); this.name = "BoxQuotaExceededError"; }
}
export class BoxNotReadyError extends Error {
  constructor(message: string) { super(message); this.name = "BoxNotReadyError"; }
}

/**
 * The runtime the box must run is our own build, not the image's. The image has
 * the rest of `/home/box/sand-host` (extensions, workers, node_modules), so the
 * two files are placed with subPath mounts from an emptyDir that an initContainer
 * fills — no shared ReadWriteOnce disk, which would pin every box to one node and
 * rule out serverless overflow.
 */
export function boxPodManifest(scope: string, config: BoxTemplateConfig & { readonly gatewayToken: string; readonly createdAt: string }): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podNameFor(scope),
      labels: { app: BOX_LABEL_APP, [BOX_LABEL_SCOPE]: scopeLabel(scope), [BOX_LABEL_MANAGED_BY]: BOX_MANAGED_BY },
      annotations: {
        [BOX_ANNOTATION_CREATED_AT]: config.createdAt,
        [BOX_ANNOTATION_SCOPE]: scope,
        // Boot from the pre-pulled ECI image cache when one matches
        // (deploy/acs/image-cache.yaml). Without it a cold serverless start spends
        // 2m20s pulling 1.4 GB before the box exists, which is what made the
        // client's first connection after provisioning always fail.
        "k8s.aliyun.com/eci-image-cache": "true",
      },
    },
    spec: {
      restartPolicy: "Always",
      ...(config.nodeSelector === undefined ? {} : { nodeSelector: config.nodeSelector }),
      ...(config.tolerations === undefined ? {} : { tolerations: config.tolerations }),
      initContainers: [
        {
          name: "fetch-runtime",
          image: config.image,
          imagePullPolicy: "IfNotPresent",
          // Trust nothing: the manifest carries sha256 for both files and the
          // container refuses to start the box if either mismatches.
          command: ["bash", "-euo", "pipefail", "-c", [
            `curl -fsS "${config.runtimeBaseUrl}/manifest.json" -o /runtime/manifest.json`,
            `curl -fsS "${config.runtimeBaseUrl}/host-main.cjs" -o /runtime/host-main.cjs`,
            `curl -fsS "${config.runtimeBaseUrl}/box-exec-daemon.cjs" -o /runtime/box-exec-daemon.cjs`,
            `python3 - <<'PY'\nimport hashlib, json, sys\nmanifest = json.load(open("/runtime/manifest.json"))\nfor name, want in manifest["sha256"].items():\n    got = hashlib.sha256(open("/runtime/" + name, "rb").read()).hexdigest()\n    if got != want:\n        sys.exit(f"{name}: expected {want}, got {got}")\nprint("runtime verified", json.dumps(manifest["sha256"]))\nPY`,
          ].join("\n")],
          volumeMounts: [{ name: "runtime", mountPath: "/runtime" }],
          resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
        },
      ],
      containers: [
        {
          name: "box",
          image: config.image,
          imagePullPolicy: "IfNotPresent",
          env: [
            { name: "SAND_SUPERVISOR_ENABLED", value: "1" },
            { name: "SAND_BOX_AUTO_UPDATE", value: "0" },
            { name: "SAND_TREE_SITTER_NODE_DEPS", value: "/home/box/deps" },
            { name: "NODE_PATH", value: "/home/box/deps" },
            { name: "SAND_USE_EXISTING_BOX_EXEC_DAEMON", value: "1" },
            // Off loopback the host requires auth on its own, so this token is the
            // only thing gating the gateway behind the router.
            { name: "SAND_GATEWAY_BIND_HOST", value: "0.0.0.0" },
            { name: "SAND_HOST_PORT", value: "1340" },
            { name: "SAND_GATEWAY_TOKEN", value: config.gatewayToken },
            // The box runs its own agent loop (24 tools: shell, files, computer
            // use, search) and picks its inference provider per turn from its
            // settings, falling back to this. The desktop must stay on "cursor" so
            // the coordinator forwards sendPrompt here instead of answering it
            // itself with a chat-only routed path that has no tools.
            { name: "SAND_INFERENCE_PROVIDER", value: "anthropic" },
            ...Object.entries(config.inferenceEnv).map(([name, value]) => ({ name, value })),
            // A self-hosted box has no upstream upgrade channel, and the default
            // one is Anysphere's public S3 bucket: left alone the box reports
            // "host update available" forever (its version can never match), the
            // client offers an update that wipes the box, and a forced update
            // would download upstream's host bundle over the reconstructed one.
            // Pointing this at the broker, which 404s the version file, makes
            // fetchLatestHostBundleVersion() return undefined -> the field is
            // omitted -> no prompt, and no channel to swap our runtime out.
            { name: "SAND_HOST_BUNDLE_S3_BASE_URL", value: `${config.runtimeBaseUrl}/host-bundle` },
          ],
          ports: [
            { name: "gateway", containerPort: 1340 },
            { name: "novnc", containerPort: 6080 },
            { name: "novnc-fork", containerPort: 6081 },
          ],
          readinessProbe: { tcpSocket: { port: 1340 }, initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 36 },
          resources: {
            requests: { cpu: config.cpuRequest, memory: config.memoryRequest },
            limits: { cpu: config.cpuLimit, memory: config.memoryLimit },
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            { name: "sand-data", mountPath: "/home/box/sand-data" },
            { name: "dshm", mountPath: "/dev/shm" },
            { name: "runtime", mountPath: "/home/box/sand-host/host-main.cjs", subPath: "host-main.cjs", readOnly: true },
            { name: "runtime", mountPath: "/home/box/box-exec-daemon/main.cjs", subPath: "box-exec-daemon.cjs", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "workspace", emptyDir: {} },
        { name: "sand-data", emptyDir: {} },
        { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "2Gi" } },
        { name: "runtime", emptyDir: {} },
      ],
    },
  };
}

export interface ProvisionedBox { readonly scope: string; readonly podName: string; readonly podIP: string }

export function createProvisioner(kube: KubeClient, config: ProvisionerConfig) {
  const inFlight = new Map<string, Promise<ProvisionedBox>>();

  /**
   * Waits a bounded moment for a box to become ready, then gives up quietly: the
   * router answers 503 until it is up and the client retries, so this only ever
   * turns a guaranteed first-attempt failure into a success when it can.
   */
  const waitBriefly = async (podName: string): Promise<string> => {
    const deadline = config.now() + config.ensureWaitMs;
    while (config.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, config.pollMs));
      const pod = await getPod(kube, podName);
      if (podIsWedged(pod) !== undefined) return "";
      const ip = pod?.status?.podIP ?? "";
      if (isPodReady(pod) && ip.length > 0) return ip;
    }
    return "";
  };

  /**
   * Creates or adopts the box and returns as soon as the Pod object exists —
   * deliberately without waiting for readiness. Two reasons: the ALB in front of
   * the broker cuts a single response at 60s, and the client is built for this
   * shape anyway (the router answers 503 while a box boots, which its reconnect
   * backoff treats as transient). A cold serverless start is minutes; nothing
   * should hold an HTTP request open that long.
   */
  const provision = async (scope: string): Promise<ProvisionedBox> => {
    const podName = podNameFor(scope);
    let pod = await getPod(kube, podName);

    if (pod != null && pod.metadata?.deletionTimestamp == null) {
      const wedged = podIsWedged(pod);
      // A pod that can never come up is worth reporting rather than adopting.
      if (wedged === undefined) {
        const ip = pod.status?.podIP ?? "";
        return { scope, podName, podIP: isPodReady(pod) && ip.length > 0 ? ip : await waitBriefly(podName) };
      }
      await deletePod(kube, podName);
      pod = undefined;
    }

    if (pod?.metadata?.deletionTimestamp != null) {
      // Terminating: give the name a moment to free up before reusing it.
      const deadline = config.now() + 30_000;
      while (config.now() < deadline && (await getPod(kube, podName)) != null) await new Promise(resolve => setTimeout(resolve, config.pollMs));
    }

    const live = (await listPods(kube, BOX_SELECTOR)).filter(candidate => candidate.metadata?.deletionTimestamp == null);
    if (live.length >= config.maxLiveBoxes) throw new BoxQuotaExceededError(live.length, config.maxLiveBoxes);

    await createPod(kube, boxPodManifest(scope, {
      ...config,
      gatewayToken: gatewayTokenFor(config.masterSecret, scope),
      createdAt: new Date(config.now()).toISOString(),
    }));
    return { scope, podName, podIP: await waitBriefly(podName) };
  };

  return {
    /** Concurrent callers for one scope share a single provisioning attempt. */
    async ensure(scope: string): Promise<ProvisionedBox> {
      const existing = inFlight.get(scope);
      if (existing !== undefined) return await existing;
      const attempt = provision(scope).finally(() => { if (inFlight.get(scope) === attempt) inFlight.delete(scope); });
      inFlight.set(scope, attempt);
      return await attempt;
    },
    async destroy(scope: string): Promise<void> {
      await deletePod(kube, podNameFor(scope));
    },
    async live(): Promise<readonly Pod[]> {
      return (await listPods(kube, BOX_SELECTOR)).filter(pod => pod.metadata?.deletionTimestamp == null);
    },
  };
}
