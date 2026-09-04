import { startBroker } from "./main.js";

void startBroker().catch((error: unknown) => {
  process.stderr.write(`broker: failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
