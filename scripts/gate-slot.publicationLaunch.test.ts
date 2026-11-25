import { LAUNCH_RECORD_FIFO_MODES, registerFifoPublicationCases } from "./gate-slot.fifoPublication.fixture";

// A publication from an older lane checkout, admitted in FIFO order only by
// the launch record the Viewer stamps. These modes run in their own file so
// the queue's other FIFO modes keep their per-file budget.
registerFifoPublicationCases(LAUNCH_RECORD_FIFO_MODES);
