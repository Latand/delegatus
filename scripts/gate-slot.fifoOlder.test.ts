import { OLDER_LAUNCHER_FIFO_MODES, registerFifoPublicationCases } from "./gate-slot.fifoPublication.fixture";

// FIFO admission of two publications through older hooks, helpers and the
// main-era dispatcher, recognised at the cutover.
registerFifoPublicationCases(OLDER_LAUNCHER_FIFO_MODES);
