#!/usr/bin/env bun
/* Print the app dir under the config root, the way every Delegatus process
   resolves it (`bin/appDir.mjs`): `~/.config/delegatus` for a new install, the
   `agent-log-viewer` spelling for an existing one. Compose cannot ask the
   filesystem, so its defaults read the exported value instead:

     export DELEGATUS_CONFIG_DIR="$(bun scripts/app-config-dir.mjs)"

   It reads nothing but the two directory names and writes nothing. */

import { homedir } from "node:os";
import { join } from "node:path";

import { appDirIn } from "../bin/appDir.mjs";

const root = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config");
process.stdout.write(`${appDirIn(root)}\n`);
