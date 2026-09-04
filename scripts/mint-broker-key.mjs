// Mints a broker API key and prints both halves: the key itself (hand it to the
// user, it exists nowhere else) and the ConfigMap entry to record server-side.
//
//   node scripts/mint-broker-key.mjs "alice"
//   kubectl -n grok-bot patch configmap grok-bot-api-keys --type merge -p '<the JSON below>'
import { createHash, randomBytes } from "node:crypto";

const name = process.argv[2] ?? "";
const key = `gbk_${randomBytes(32).toString("base64url")}`;
const scope = createHash("sha256").update(key).digest("hex");

process.stdout.write(`key (give this to the user, it is not stored anywhere):\n  ${key}\n\n`);
process.stdout.write(`configmap patch:\n  ${JSON.stringify({ data: { [scope]: JSON.stringify({ name, createdAt: new Date().toISOString() }) } })}\n\n`);
process.stdout.write(`revoke later with:\n  kubectl -n grok-bot patch configmap grok-bot-api-keys --type json -p '[{"op":"remove","path":"/data/${scope}"}]'\n`);
