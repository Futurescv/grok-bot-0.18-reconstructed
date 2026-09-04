import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { outputApp, outputDir, reconstructedName } from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

// A drag-to-install disk image: open it, drag the app onto the Applications
// alias. Run `npm run package` first — this only wraps what that produced.
//
//   GROK_BOT_BROKER_URL=http://… npm run package && node scripts/package-dmg.mjs
if (process.platform !== "darwin") throw new Error("The disk image can only be built on macOS.");

const appName = path.basename(outputApp);
if (!(await stat(outputApp).catch(() => null))) throw new Error(`no packaged app at ${outputApp} — run npm run package first`);

// Ship the backend the app was packaged against, so a DMG handed to someone is
// never silently a build that talks to Cursor's backend instead of ours.
const backendFile = path.join(outputApp, "Contents", "Resources", "sand-backend.json");
const backend = await readFile(backendFile, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
if (backend == null) {
  process.stdout.write(`warning: ${appName} has no packaged backend; recipients would need SAND_BACKEND_URL or a gateway of their own.\n`);
}

const staging = await mkdtemp(path.join(os.tmpdir(), "grok-bot-dmg-"));
const volumeName = reconstructedName;
const dmgPath = path.join(outputDir, `${reconstructedName.replaceAll(" ", "_")}.dmg`);

try {
  // dereference: false keeps the bundle's internal symlinks (frameworks) intact.
  await cp(outputApp, path.join(staging, appName), { recursive: true, dereference: false, preserveTimestamps: true });
  await symlink("/Applications", path.join(staging, "Applications"));
  await writeFile(path.join(staging, "READ ME FIRST.txt"), `${reconstructedName}

1. Drag "${appName}" onto the Applications folder in this window.

2. The first launch is blocked, because this build carries an ad-hoc signature
   rather than an Apple Developer ID. Clear the download flag once:

       xattr -dr com.apple.quarantine "/Applications/${appName}"

   Then open it normally. (Or: System Settings > Privacy & Security > Open Anyway.)

3. Sign in with the API key you were given. It is stored encrypted on your Mac.
   To use a different key later, sign out — that forgets the stored one.
${backend == null ? "" : `
This build connects to:
    ${backend.backendUrl}
You need to be on the network that can reach it.
`}
Requires an Apple Silicon Mac.
`, "utf8");

  await rm(dmgPath, { force: true });
  await run(SYSTEM_TOOLS.hdiutil, [
    "create",
    "-volname", volumeName,
    "-srcfolder", staging,
    "-fs", "HFS+",
    "-format", "UDZO",
    "-imagekey", "zlib-level=9",
    "-quiet",
    "-ov",
    dmgPath,
  ]);
} finally {
  await rm(staging, { recursive: true, force: true });
}

const bytes = await readFile(dmgPath);
process.stdout.write(`Disk image: ${dmgPath}\n`);
process.stdout.write(`  size:   ${(bytes.byteLength / 1_048_576).toFixed(1)} MiB\n`);
process.stdout.write(`  sha256: ${createHash("sha256").update(bytes).digest("hex")}\n`);
