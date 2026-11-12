/** Saved routine prompt. Unassigned scheduled runs finish without effects. */
export const CLAUDE_CLOUD_TASK_PROMPT = `Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn.

Never push, and open and comment on nothing on GitHub. Send no
notifications. Other follow-ups name a head to work on; follow them exactly and end
your work with the final message the assignment describes.`;
