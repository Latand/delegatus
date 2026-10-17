/** Namespaces shared by the producer key builders and the seat channel. */
const bridge = "bridge_d_";
export const seatMessageKeys = {
  bridge,
  decision: "prototype-decision:", telegram: `${bridge}telegram_`, voice: "voice-", spawn: "spawn_notice_",
  tick: "seat-tick:", boardReport: "board_report_", nudge: "seat-autorotate-nudge-", deputy: "deputy_note_", mandate: "orchmandate_",
} as const;
