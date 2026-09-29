import { exitWhenViewerOwnershipEnds } from "./viewerWorkerLifecycle";

exitWhenViewerOwnershipEnds({ releasePollMs: 25 });
setInterval(() => undefined, 60_000);
