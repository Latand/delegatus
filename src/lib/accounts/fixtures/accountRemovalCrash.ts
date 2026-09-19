/* Child process for the account-removal crash tests (#1857). It runs the
   production removal and kills itself with SIGKILL at one named checkpoint,
   the way a Viewer that dies mid-removal stops: no finally block, no rollback.
   Exit code 3 means the checkpoint was never reached. */
const [engine, accountId, checkpoint] = process.argv.slice(2);
if (!engine || !accountId || !checkpoint) throw new Error("usage: accountRemovalCrash <engine> <account> <checkpoint>");

const removal = await import("../removal");
removal.setAccountRemovalCheckpointForTests((reached) => {
  if (reached === checkpoint) process.kill(process.pid, "SIGKILL");
});
if (engine === "claude") (await import("../claude")).removeManagedClaudeAccount(accountId);
else (await import("../codex")).removeManagedCodexAccount(accountId);
process.exit(3);

export {};
