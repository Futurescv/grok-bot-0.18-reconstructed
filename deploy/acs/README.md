# Deploying the box runtime to Alibaba Cloud ACS

Only **half** of this repository is deployable to a cluster.

| Half | Where it runs |
| --- | --- |
| Electron client (`source/electron-main`, `source/electron-preload`, renderer) | macOS arm64 desktop. Not deployable. |
| Box runtime (`source/host` + `source/box-exec-daemon`) | A container. This is what goes to ACS. |

The client stays on the developer's machine and reaches the in-cluster box over
the host gateway. No code changes are needed for this: `EnvDescriptorHostConnector`
(`source/electron-main/box/box-host-connector.ts:140`) reads `SAND_HOST_GATEWAY_URL`
and `SAND_HOST_GATEWAY_TOKEN`, and `createRemoteHostConnector` prefers it over the
Cursor broker (`:150`).

## Target cluster

Verified against the ACS cluster reachable via `~/Documents/auth/acs-internal/k8s.yaml`
(`10.229.6.119:6443`, cn-hongkong, v1.36.2-aliyun.1).

```sh
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
export KUBECONFIG=~/Documents/auth/acs-internal/k8s.yaml NO_PROXY='*'
```

Cluster facts that shaped this manifest, all measured rather than assumed:

- **Nodes are amd64**, matching the box image's single-arch `linux/amd64` build.
- **`public.ecr.aws` is directly pullable from the cluster** — 1.40 GB cold pull in
  60 s. The image does *not* need mirroring into `*.cr.aliyuncs.com`.
- **`registry.npmjs.org` is reachable** (200) from pods, so agent CLIs can be
  installed at image-build or runtime.
- **`api-gateway.glm.ai` does not resolve** from this cluster (`ENOTFOUND`). The
  local machine's `ANTHROPIC_BASE_URL` points there, so it cannot be reused as-is.
- **`open.bigmodel.cn` is reachable** (200), and a real `/v1/messages` call from a
  Pod returns GLM output. That is what inference runs on — see below.

## Stage 1 — prove the chain with the stock host

The image ships its own entrypoint (`/usr/local/bin/start-sand-box`) and a stock
`host-main.cjs` (27.7 MB) at `/home/box/sand-host/`. Running it unmodified
validates scheduling, boot, gateway and auth before any local build is involved.

```sh
kubectl -n grok-bot create secret generic grok-bot-box-gateway \
  --from-literal=token="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
kubectl apply -f deploy/acs/box.yaml
kubectl -n grok-bot rollout status deploy/grok-bot-box
```

Point the client at it:

```sh
kubectl -n grok-bot port-forward svc/grok-bot-box 11340:1340 &
export SAND_HOST_GATEWAY_URL=http://127.0.0.1:11340
export SAND_HOST_GATEWAY_TOKEN=$(kubectl -n grok-bot get secret grok-bot-box-gateway \
  -o jsonpath='{.data.token}' | base64 -d)
```

Measured results: `/events` returns 401 with no token, 401 with a wrong token, and
200 with the right one — both in-cluster and through the port-forward.

### `/health` is deliberately unauthenticated

`gateway-server.ts:48` answers `/health` and returns *before* the auth gate at
`:51`. Anything in the cluster that can reach the Pod IP can read `pid`, `isBusy`
and `activeAgentId`. Everything else needs the bearer token (timing-safe compared).
Binding off loopback makes the host require auth on its own
(`gateway-config.ts:49`), so the token is the only gate — do not put this behind an
ALB on the strength of that token alone.

## Stage 2 — the reconstructed runtime (done)

Stage 1 ran *upstream's* host. Stage 2 overlays this repository's build onto it:

| Artifact | Mounted over |
| --- | --- |
| `src/app/dist/host/host-main.cjs` | `/home/box/sand-host/host-main.cjs` |
| `src/app/dist/box-exec-daemon/main.cjs` | `/home/box/box-exec-daemon/main.cjs` |

plus `SAND_USE_EXISTING_BOX_EXEC_DAEMON=1`, mirroring what
`local-docker-host-connector.ts:192-198` does with bind mounts. `subPath` mounts
so the rest of `/home/box/sand-host` (workers, `node_modules`, `extensions`)
still comes from the image.

Build it, then seed it:

```sh
nvm use 26.5.0                 # engines.node is >=26.5.0 <27
npm ci
npm run bootstrap              # needs the pinned DMG; see below
npm run build                  # -> dist/host/host-main.cjs
node scripts/build-box-exec-daemon.mjs \
  "$PWD/src/app/dist/box-exec-daemon/main.cjs"
./deploy/acs/seed-runtime.sh
```

`npm run build` does **not** build the box exec daemon — `build-box-exec-daemon.mjs`
is a standalone script that no npm script invokes, and its default output goes to
`.build/`, not `dist/`. Passing the `dist/` path explicitly is required.

Its `target: "node22"` is correct, not a lucky guess: the box's *system* Node is
v20.19.2, but the host is launched by `/exec-daemon/node`, which is v22.14.0.

Portability is proven rather than assumed: the local Docker path already builds
these on macOS and runs them in a `linux/amd64` container, with native
dependencies (tree-sitter) supplied by the image at `/home/box/deps` via
`NODE_PATH`.

### Verified live

```
                       local build        in the running box
host-main.cjs          b0e529081dd0f7fe   b0e529081dd0f7fe   (25012458 B)
box-exec-daemon        f02590ca6f98b46b   f02590ca6f98b46b   ( 2490267 B)

live process : /exec-daemon/node /home/box/sand-host/host-main.cjs
`// src/` banners in the bundle : 677     (stock upstream has none)

/events  no-token 401 · bad-token 401 · with-token 200   (in-cluster and via port-forward)
claude -p -> result='stage2-verified' subtype=success models=['glm-5.3']
```

### The pinned DMG

`npm run bootstrap` needs Grok Bot 0.18.0 as a build input, because the renderer
cannot be built from this repository at all — see "Why the GUI is not here" below.

**The upstream URL is dead**: `downloads.cursor.com/.../Grok_Bot_0.18.0.dmg`
returns S3 `AccessDenied` (403) for both HEAD and ranged GET. The archived LFS
copy is the only remaining source:

```sh
brew install git-lfs && git lfs install && git lfs pull
shasum -a 256 research-archives/original/0.18.0/macos-arm64/Grok_Bot_0.18.0.dmg
# a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb
```

That hash is both the `dmgSha256` in `scripts/lib/config.mjs:47` and the LFS
pointer's own oid, so the archive is self-verifying.

### Why a PVC and not a derived image

A ~27 MB image carrying just the artifacts, consumed by an initContainer, would
be cleaner: immutable, no RWO disk, nothing to re-seed. It is not viable from
this build machine. Measured, in order:

- `docker build` cannot reach `docker.io` — `auth.docker.io` resolves to a
  hijacked address (`162.125.18.129`) and times out.
- Rehosting the base as `public.ecr.aws/docker/library/busybox` fails too:
  Docker gets `EOF` on the manifest HEAD.
- `FROM scratch` removes the pull entirely and builds fine, but **pushing** to
  ACR fails with `TLS handshake timeout`, with the proxy on and off, and after
  adding ACR to Docker's proxy exclusions.
- `crane` fails identically. So does `aliyun oss`.
- Yet `curl` to the same ACR endpoint succeeds 6/6 (TLS in 0.13-1.35 s).

So Go-based clients cannot reach Aliyun's public *data* endpoints from this
machine, while `curl` can — most likely process-based routing in the local proxy.
`kubectl` keeps working because it talks to an internal IP (`10.229.6.119`), not
a public Aliyun endpoint. `aliyun cr GetAuthorizationToken` also works, which is
how ACR credentials were minted before discovering the registry itself was
unreachable.

That leaves `kubectl cp` as the only reliable Mac-to-cluster channel, hence the
PVC. If you are on a machine where `docker push` to ACR works, the image
approach is strictly better — the seeding step and the RWO constraint both go away.

`seed-runtime.sh` re-verifies SHA-256 on both files after copying, because
`kubectl cp` is a tar stream that can fail in ways that still exit 0.

## Inference credentials

The router lives in the host (`source/host/extensions/inference/`), so it runs
*inside* the box. Local Docker mode bind-mounts `~/.codex` and `~/.claude`
read-only (`local-docker-host-connector.ts:157-163`); in a shared cluster that
would mean uploading login state, so this deployment injects env instead — the
same zero-login-state pattern glm-tag uses.

Inference goes to **BigModel over its Anthropic-compatible surface**, which lets
the existing Claude Code provider work unchanged:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` |
| `ANTHROPIC_API_KEY` | Secret `grok-bot-inference`, key `bigmodel-key` |
| `ANTHROPIC_MODEL` | `glm-5.3` |
| `CLAUDE_CODE_PATH` | `/opt/agent-cli/bin/claude` (from the initContainer) |

```sh
kubectl -n grok-bot create secret generic grok-bot-inference \
  --from-literal=bigmodel-key="$(sed -n 's/^secret[[:space:]]*=[[:space:]]*//p' \
    ~/Documents/auth/acs-internal/bigmodel.key)"
```

`ANTHROPIC_API_KEY` rather than `ANTHROPIC_AUTH_TOKEN`: it maps to the `x-api-key`
header this endpoint was verified against, and it is also the variable
`getLocalInferenceCliStatus` checks (`inference-router-local.ts:54`), so the
settings badge agrees with reality.

Verified end-to-end on a freshly rolled-out Pod, nothing hand-patched:

```
result           = 'rollout-verified'
subtype          = 'success'
is_error         = False
models used      = ['glm-5.3']
```

Two things worth knowing:

- The correct path is `/api/anthropic`. `/api/paas/v4/anthropic` returns 404 —
  `/paas/v4` is the OpenAI-compatible surface, a different protocol.
- `claude` writes `[claude-code:unrecognized_model] {"model":"glm-5.3",...}` to
  **stderr** on every run. It is benign (its session-title helper does not know
  the model name), but it is not JSON — do not fold stderr into stdout when
  parsing `--output-format json`.

The box image has no agent CLI of its own, so an initContainer installs a pinned
`@anthropic-ai/claude-code` into a shared `emptyDir`. Pinning is deliberate: an
agent CLI that changed its control protocol underneath the provider would fail
with no signal from this manifest.

zcode CLI is **not** a drop-in replacement for the `claude` binary here. This
project drives Claude Code through `@anthropic-ai/claude-agent-sdk`
(`provider-session.ts:214`), which speaks Claude Code's control protocol; zcode's
headless contract differs on nearly every axis (`--prompt` not `-p`, pretty-printed
`--json` rather than NDJSON, no streaming events, no `--mcp-config`, no `--model`).
Using zcode as the kernel means writing a new provider. Going through BigModel's
Anthropic-compatible endpoint reaches the same GLM models without that work.

## Teardown

```sh
kubectl delete -f deploy/acs/box.yaml
kubectl -n grok-bot delete secret grok-bot-box-gateway
```

## The client: sign-in wall, and the API-key session that replaces it

Pointing the app at this box needs no code change at the protocol layer —
`EnvDescriptorHostConnector` takes `SAND_HOST_GATEWAY_URL` and is preferred over
the Cursor broker (`box-host-connector.ts:140,150`). On its own that was
misleading: the packaged app opened on a "Sign in" wall and never called
`connect()`, which is why a Pod-side `ss -tn` showed zero connections to 1340 no
matter what the env said.

That gate now has a second door, in reconstructed code only (the upstream
minified renderer stays byte-pinned):
`source/electron-main/account/api-key-session.ts`. When `SAND_HOST_GATEWAY_URL`
and `SAND_HOST_GATEWAY_TOKEN` are both set and `SAND_AUTH_MODE` is not `cursor`,
the app authenticates by probing the box's own `/events` with that token and the
identity becomes "Self-hosted (API key)". A wrong token, or an unreachable
gateway, renders the reason on the cover screen instead of a blank wall. The
token never doubles as a Cursor backend credential — `getValidAccessToken()`
returns a local sentinel.

One more change was needed to boot: the packaged coordinator binding rejects a
connector without `issueLocalExecDaemonCredential`, so the env-descriptor
connector grew a stub that reports "no credential" instead of aborting the whole
boot before a window opens.

### Client-side runtime: three processes

Verified working end to end — a real conversation, and the box desktop rendering
in the app's screen panel.

```sh
# 1. Gateway (many short requests). NOT kubectl port-forward: its tunnel rots
#    under this traffic (measured 0/20 API calls through it; 20/20 through this).
SAND_HOST_GATEWAY_TOKEN=<token> node deploy/acs/gateway-proxy.mjs

# 2. noVNC (one long socket per viewer). This one IS port-forward, because the
#    apiserver proxy drops the query string on WebSocket upgrades and
#    websockify's TokenFile plugin then rejects the connection with
#    "Token not present".
PORTS="6080:6080 6081:6081" HEALTH_URL=none LOG=/tmp/novnc-pf.log \
  bash deploy/acs/port-forward.sh

# 3. The app, with the env it needs.
bash deploy/acs/run-app.sh            # add --remote-debugging-port=9222 to drive it
```

The agent's screen resolves because of a detail worth knowing: without a
`vncProxy` descriptor (which only the Cursor broker supplies), the host hands the
client its own loopback URL — `http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3D2`.
Nothing rewrites it, so something has to answer on that exact port here. The
panel stays blank until `ensureForeverBox` has run for the agent; `state:
"absent"` with `vncUrl: null` is what an un-ensured agent reports.

### Where inference actually runs

Not in the box. `node-agent-coordinator/inference-router.ts` intercepts
`sendPrompt` in the **desktop** coordinator for every non-Cursor provider, keeps
its own transcript at `~/.grokbot/inference-router-transcript.json`, and spawns
the claude CLI on the client machine — with the box's tools handed back to it
over an MCP bridge. The box is the computer; the model follows the coordinator.
So `~/.grokbot/settings.json` (client), not the box's settings, decides the
provider, and `CLAUDE_CODE_PATH` has to point at a CLI on the client.

Setting `inferenceProvider` in the *box* instead routes turns through the host's
own agent machinery, where the claude path gets no tool definitions — the turn
runs, spawns a CLI in the Pod, and produces no reply, because a Grok Bot agent
speaks by calling `SendMessage`.

### Launch notes

- Executing `Contents/MacOS/Grok Bot` directly works and is the only way to
  capture stdout/stderr; `run-app.sh` does that. (An earlier note here claimed it
  blocks in `_handleAEOpenEvent` — that was a symptom of launching with a broken
  proxy env, not of bypassing `open`.)
- **Clear the proxy env.** With `HTTPS_PROXY` et al. set, boot took 137 s (every
  Cursor backend call waited out the broken proxy) and routed turns never
  produced a reply. Cleared: 7 s boot, ~1.4 s replies.
- `open` does not forward env, so going that route needs `launchctl setenv`
  (session-global; `launchctl unsetenv` afterwards).
- Do not use "does a renderer helper process exist" as a proxy for "the window is
  open". `pgrep -f type=renderer` matches every other Electron app on the
  machine. Count page targets on the CDP endpoint, or look at the window.


## Why the GUI is not here, and what the box's desktop is

Two different surfaces get confused with each other:

| | What it is | Where it runs |
| --- | --- | --- |
| Grok Bot's own UI | Chat window, Settings → Router | Electron, on the developer's Mac |
| The box's Linux desktop | The *computer the agent drives* | Already in this Pod |

**Grok Bot's UI is not in this repository as source.** The shipped app contained
no frontend source and no source maps, so the reconstruction keeps upstream's
minified renderer and splices the Router page in by exact string replacement
(`scripts/lib/router-renderer-patch.mjs`). The injected React is hand-written in
the host bundle's own minified dialect — reusing its aliases (`a.jsx`,
`de.useState`, `ie`/`re`/`se`) and its CSS atom classes — so it can be spliced in
at all. `replaceExactlyOnce` plus a "exactly one candidate chunk" check make it
fail loudly if upstream's anchors move.

`frontend/` (308 files) is a readable partial reconstruction and design
workspace. It is **not** shipped: neither `build.mjs` nor `package-macos.mjs`
references it.

This is why the DMG is a hard build input rather than a convenience.

**The box's desktop, by contrast, is real and running:** Xvfb + xfwm4 + plank +
picom + x11vnc + websockify on `DISPLAY=:1`, 1280x800, with noVNC served on 6080
and a token-gated websockify on 6081.

x11vnc runs `-nopw -shared -forever`. `-shared` is the useful part: a human can
attach *alongside* the agent rather than displacing it — watch it work, then take
the mouse.

**6080 is unauthenticated.** This is confirmed, not inferred:

```
6081: websockify --token-plugin TokenFile --token-source /tmp/sand-novnc-tokens.d 0.0.0.0:6081
6080: websockify 0.0.0.0:6080 localhost:5900          <- no --token-plugin
                              `-- x11vnc -nopw
```

The token-gated listener serves the *fork* sessions; the primary display on 6080
has no gate at all, and a websocket upgrade to `/websockify` returns 101 without
any credential. Anything that can reach the port gets an interactive root desktop.

The Service publishes 6080 as **ClusterIP, never an Ingress**. That is only
acceptable because the cluster is internal — and note it is *shared* with other
workloads, so "internal" is not "only me". Narrow it with a NetworkPolicy if that
matters.

```sh
kubectl -n grok-bot port-forward svc/grok-bot-box 16080:6080
# then open http://127.0.0.1:16080/vnc.html
```

Verified through the Service: `/vnc.html` 200, `/websockify` upgrade 101.

There is no Linux build of the Electron client to run *inside* that desktop:
only macOS arm64 and Windows x64 installers exist, packaging is macOS-only
(`package-macos.mjs`, `hdiutil`, ad-hoc signing), and the native modules are
built for darwin-arm64. The `/home/box/deps` tree is the Linux build for the
*host* service, not for an Electron renderer.
