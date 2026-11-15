import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "./seats";

/* A second process on the same state directory, for the seat store's tests:
   it reads or writes through the public seat API with its own connections. */
const [action, project, conversationId] = process.argv.slice(2);
if (!action || !project) throw new Error("seat store child arguments are required");

if (action === "read") {
  process.stdout.write(`${JSON.stringify(orchestratorSeatFor(project))}\n`);
} else if (action === "designate") {
  if (!conversationId) throw new Error("designate needs a conversation");
  const clientRequestId = `child-${conversationId}`;
  beginOrchestratorSeatIntent({ project, mandate: `mandate from the child for ${conversationId}`, clientRequestId, mode: "existing", conversationId });
  const completed = completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
  process.stdout.write(`${JSON.stringify(completed.kind)}\n`);
} else {
  throw new Error(`unknown seat store child action: ${action}`);
}
