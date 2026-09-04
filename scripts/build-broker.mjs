import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The broker runs on the box image's own `/usr/bin/node`, which is v20 — not the
// v22 the exec daemon's bundled runtime provides.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.resolve(process.argv[2] ?? path.join(root, ".build", "broker", "broker.cjs"));
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/broker/cli.ts")],
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile,
  legalComments: "none",
  logLevel: "silent",
  banner: { js: "// Self-hosted Grok Bot broker: provisions one box per API key and proxies its gateway and desktop." },
});
process.stdout.write(`${outfile}\n`);
