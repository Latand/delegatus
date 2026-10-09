#!/usr/bin/env bun-container

import path from "node:path";

import { appDirIn } from "../bin/appDir.mjs";
import {
  readRuntimeHostStartupState,
  probeRuntimeHostSuccessor,
  runtimeHostGenerationFromEnvironment,
} from "../src/runtime-host/runtimeHostStartup";

function runtimeHostSocket(environment: NodeJS.ProcessEnv): string {
  const configured = environment.LLV_RUNTIME_HOST_SOCKET?.trim();
  if (configured) return configured;
  const config = environment.XDG_CONFIG_HOME
    || path.join(environment.HOME || "/home/user", ".config");
  return path.join(appDirIn(config), "state", "runtime-host.sock");
}

export async function checkRuntimeHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const generation = runtimeHostGenerationFromEnvironment(environment);
  try {
    await probeRuntimeHostSuccessor(runtimeHostSocket(environment), generation, { timeoutMs: 3_000 });
  } catch (error) {
    const directory = path.join(path.dirname(runtimeHostSocket(environment)), "runtime-host-startup");
    const target = environment.LLV_RUNTIME_HOST_STARTUP_TARGET
      || path.join(directory, `${generation.container}.json`);
    const startup = readRuntimeHostStartupState(directory, target);
    const progress = startup.journal;
    throw new Error(`runtime-host ${startup.state}${progress ? `: journal ${progress.subphase} ${progress.done}/${progress.total}, committed batches ${progress.committedBatches}` : ""}`, { cause: error });
  }
}

if (import.meta.main) {
  try {
    await checkRuntimeHost();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "runtime-host health probe failed");
    process.exit(1);
  }
}
