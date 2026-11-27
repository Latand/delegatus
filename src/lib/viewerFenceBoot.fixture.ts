/* Boots the real instrumentation hook the way `next start` does: a listener
   already holds the process open, and a rejected hook leaves it answering 500.
   The test names every state root and ends the process it started. */
import { register } from "@/instrumentation";

let refused = false;
Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: refused ? 500 : 503 }) });
try {
  await register();
} catch (error) {
  refused = true;
  console.error("Failed to prepare server", error instanceof Error ? error.message : String(error));
}
