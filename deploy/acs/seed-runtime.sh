#!/usr/bin/env bash
# Seed runtime artifacts into the grok-bot-runtime PVC.
#
# The PVC is ReadWriteOnce, so the box must be scaled down while the seeder
# holds the disk. Run this after every packaging build.
#
# SEED_RUNTIME picks which host bundle the box runs:
#   reconstructed (default) -- our clean-source build of source/host, produced by
#                              `npm run package`. Only this one carries the
#                              inference-provider router (claude-code/codex/...).
#   upstream                -- the extracted original bundle shipped in src/app.
#                              Keep it as the rollback target: it has no router,
#                              so agent turns can only talk to Cursor inference.
set -euo pipefail

NS=grok-bot
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED_RUNTIME="${SEED_RUNTIME:-reconstructed}"
case "$SEED_RUNTIME" in
  reconstructed) DIST="$ROOT/.build/fidelity/app/dist"; BUILD_HINT="npm run package" ;;
  upstream) DIST="$ROOT/src/app/dist"; BUILD_HINT="node scripts/bootstrap-runtime.mjs (extracted upstream tree)" ;;
  *) echo "SEED_RUNTIME must be 'reconstructed' or 'upstream', got '$SEED_RUNTIME'" >&2; exit 1 ;;
esac
HOST="$DIST/host/host-main.cjs"
EXEC="$DIST/box-exec-daemon/main.cjs"
BROKER="${BROKER_BUNDLE:-$ROOT/.build/broker/broker.cjs}"

echo "seeding $SEED_RUNTIME runtime from $DIST"
[ -f "$HOST" ] || { echo "missing $HOST -- run: $BUILD_HINT" >&2; exit 1; }
[ -f "$EXEC" ] || { echo "missing $EXEC -- run: $BUILD_HINT" >&2; exit 1; }

kubectl -n "$NS" scale deploy/grok-bot-box --replicas=0
kubectl -n "$NS" wait --for=delete pod -l app=grok-bot-box --timeout=120s || true

kubectl -n "$NS" delete pod runtime-seeder --ignore-not-found --wait=true
kubectl -n "$NS" apply -f - <<'POD'
apiVersion: v1
kind: Pod
metadata: { name: runtime-seeder, namespace: grok-bot }
spec:
  restartPolicy: Never
  containers:
    - name: seeder
      image: public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest
      imagePullPolicy: IfNotPresent
      command: ["sleep", "1800"]
      volumeMounts: [{ name: runtime, mountPath: /seed }]
      resources: { requests: { cpu: 200m, memory: 512Mi }, limits: { cpu: "2", memory: 2Gi } }
  volumes:
    - name: runtime
      persistentVolumeClaim: { claimName: grok-bot-runtime }
POD
kubectl -n "$NS" wait --for=condition=Ready pod/runtime-seeder --timeout=300s

kubectl -n "$NS" exec runtime-seeder -- mkdir -p /seed/sand-host /seed/box-exec-daemon /seed/broker /seed/runtime-payload
# Keep the outgoing bundles next to the new ones: if the box refuses to serve
# the gateway after a swap, `cp /seed/<path>.prev /seed/<path>` from a seeder is
# the fastest way back, without needing a matching local build.
kubectl -n "$NS" exec runtime-seeder -- sh -c \
  'for f in sand-host/host-main.cjs box-exec-daemon/main.cjs; do if [ -f "/seed/$f" ]; then cp -f "/seed/$f" "/seed/$f.prev"; fi; done'
kubectl -n "$NS" cp "$HOST" runtime-seeder:/seed/sand-host/host-main.cjs
kubectl -n "$NS" cp "$EXEC" runtime-seeder:/seed/box-exec-daemon/main.cjs

# The broker: its own bundle, plus the same two runtime files under the names it
# serves them as. Per-user boxes fetch them over HTTP from the broker while they
# start, which is what keeps them off this ReadWriteOnce disk (it would pin every
# box to one node and rule out serverless overflow).
if [ -f "$BROKER" ]; then
  kubectl -n "$NS" cp "$BROKER" runtime-seeder:/seed/broker/broker.cjs
  kubectl -n "$NS" cp "$HOST" runtime-seeder:/seed/runtime-payload/host-main.cjs
  kubectl -n "$NS" cp "$EXEC" runtime-seeder:/seed/runtime-payload/box-exec-daemon.cjs
  BROKER_PAIRS="broker/broker.cjs:$BROKER runtime-payload/host-main.cjs:$HOST runtime-payload/box-exec-daemon.cjs:$EXEC"
else
  echo "no broker bundle at $BROKER -- skipping (run: node scripts/build-broker.mjs)" >&2
  BROKER_PAIRS=""
fi

# Trust nothing: kubectl cp is a tar stream and fails in ways that still exit 0.
for pair in "sand-host/host-main.cjs:$HOST" "box-exec-daemon/main.cjs:$EXEC" $BROKER_PAIRS; do
  remote_path="/seed/${pair%%:*}"
  local_path="${pair#*:}"
  want="$(shasum -a 256 "$local_path" | cut -d' ' -f1)"
  got="$(kubectl -n "$NS" exec runtime-seeder -- sha256sum "$remote_path" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "checksum mismatch for $remote_path: $want != $got" >&2; exit 1; }
  echo "verified $remote_path"
done

kubectl -n "$NS" delete pod runtime-seeder --wait=true

# The broker holds this same disk read-only, and a read-only mount does not see
# writes made through another mount of the block device — it would keep serving
# the previous bundle to every new box until it remounts. Restarting it is the
# only way, and forgetting costs an afternoon of debugging a fix that is already
# on disk.
if kubectl -n "$NS" get deploy/grok-bot-broker >/dev/null 2>&1; then
  kubectl -n "$NS" rollout restart deploy/grok-bot-broker
  kubectl -n "$NS" rollout status deploy/grok-bot-broker --timeout=240s
fi

kubectl -n "$NS" scale deploy/grok-bot-box --replicas=1
kubectl -n "$NS" rollout status deploy/grok-bot-box --timeout=420s
