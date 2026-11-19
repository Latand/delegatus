/** Saved routine prompt. Unassigned scheduled runs finish without effects. */
export const CLAUDE_CLOUD_TASK_PROMPT = `Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn.

Never push, and open and comment on nothing on GitHub. Send no
notifications. Other follow-ups name a head to work on; follow them exactly and end
your work with the final message the assignment describes.`;

/** Recognition of the previously shipped routine; new tasks use the current prompt. */
export const CLAUDE_CLOUD_TASK_PROMPT_LEGACY_SHA256 = "471da70c9ae02578c365710bffb9ff5e81923389e72ca5ad97cb1d258e632808";
