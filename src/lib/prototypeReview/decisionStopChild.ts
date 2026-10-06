/*
 * Test fixture, run as its own process: the Viewer saving a decision and
 * stopping before the message reaches the send path. The decision is durable
 * when `recover` is entered and nothing was admitted yet, which is the moment
 * this process ends.
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

const response = await reviewPOST(new NextRequest(`http://localhost/api/tasks/${taskId}/prototypes`,{ method: "POST", headers: { host: "localhost", "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ reviewId, chosen: [1,2], comment }) }),taskId,{ ...prototypeWorld, orchestrator: () => seat },{ ...prototypeDelivery, recover: async () => process.exit(0) });
console.error(`the stop fixture answered ${response.status} before any delivery: ${await response.text()}`);
process.exit(3);
