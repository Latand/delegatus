/*
 * Test fixture, run as its own process: the Viewer saving a decision,
 * answering the operator, and stopping while the background delivery hands
 * the message to the send path. The decision is durable and marked as handed
 * over, the send path never ran, and the answer went out first: this process
 * ends on the send, after it has checked that answer.
 *
 * The task store fixes its file when its module loads and everything else
 * resolves the state directory per call, so the parent test's two directories
 * are given in that order: the tasks' own first, the runtime fixture's after.
 */
export {};

const { PROTOTYPE_STOP_TASKS_STATE: tasksState, PROTOTYPE_STOP_STATE: state, PROTOTYPE_STOP_TASK: taskId, PROTOTYPE_STOP_REVIEW: reviewId,
  PROTOTYPE_STOP_SEAT: seat, PROTOTYPE_STOP_COMMENT: comment } = process.env;
if (!tasksState || !state || !taskId || !reviewId || !seat || comment === undefined) throw new Error("the stop fixture needs its state, task, review, seat and comment");
process.env.LLV_STATE_DIR = tasksState;
await import("@/lib/tasks/store");
process.env.LLV_STATE_DIR = state;
const { NextRequest } = await import("next/server");
const { prototypeDelivery } = await import("./decision");
const { reviewPOST } = await import("./http");
const { prototypeWorld } = await import("./world");
const { soloBrowserSession } = await import("@/lib/agent/operatorSession");

let answered!: () => void;
const checked = new Promise<void>(resolve => { answered = resolve; });
const response = await reviewPOST(new NextRequest(`http://localhost/api/tasks/${taskId}/prototypes`,{ method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "localhost", "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ reviewId, chosen: [1,2], comment }) }),taskId,{ ...prototypeWorld, orchestrator: () => seat },
{ ...prototypeDelivery, send: async () => { await checked; process.exit(0); } });
const body = await response.json() as { rounds: Array<{ id: string; decision?: { delivery: { phase?: string } } }> };
if (response.status !== 200 || body.rounds.find(round => round.id === reviewId)?.decision?.delivery.phase !== "saved") {
  console.error(`the stop fixture's decision was not answered as saved: ${response.status} ${JSON.stringify(body)}`);
  process.exit(4);
}
answered();
await new Promise(resolve => setTimeout(resolve, 20_000));
console.error("the stop fixture's background delivery never reached the send path");
process.exit(3);
