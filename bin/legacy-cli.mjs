#!/usr/bin/env node

/* `agent-log-viewer` is the command's name before the rename to delegatus
   (docs/design/rename-delegatus.md §3.3). Old configs, scripts and memories
   call it, so it keeps working: one line on stderr, then the same CLI with the
   same arguments. */
process.stderr.write("agent-log-viewer is now delegatus; this command keeps working.\n");
await import("./cli.mjs");
