import { answerWorkReads } from "./selfUpdate/workReads";

/* The synchronous registry reads of one Update-dialog observation off the
   Viewer's thread (#2594): answers one JSON line on stdout. */

process.stdout.write(`${JSON.stringify(answerWorkReads())}\n`);
