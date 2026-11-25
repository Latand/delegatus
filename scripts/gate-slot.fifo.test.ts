import { QUEUE_FIFO_MODES, registerFifoPublicationCases } from "./gate-slot.fifoPublication.fixture";

// FIFO admission of two publications whose preparers and hooks carry their
// own launch proof.
registerFifoPublicationCases(QUEUE_FIFO_MODES);
