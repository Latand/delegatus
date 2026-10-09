import { createContext } from "react";

import type { FileEntry } from "@/lib/types";

/**
 * The board's agent window, for a surface the board draws that is not a card:
 * the orchestrator seat's head opens the seat's conversation there, like any
 * agent (#2612). `from` is the control pressed, which takes the keyboard back
 * when the window closes. Null outside a board.
 */
export const AgentWindowOpener = createContext<((file: FileEntry, from: HTMLElement | null) => void) | null>(null);
