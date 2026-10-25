import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
export type CheckExecution = "cloud" | "local";
const laneKey = (lane: string) => `delegatus.lane-${createHash("sha256").update(lane).digest("hex")}.checks`;
const stageKey = (lane: string, stage: string) => `delegatus.stage-${createHash("sha256").update(JSON.stringify([lane, stage])).digest("hex")}.checks`;
async function config(root: string, args: string[], missingCode: number): Promise<string | null> {
  try {
    const result = await exec("git", ["config", "--local", ...args], { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 4096 });
    return result.stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === missingCode) return null;
    throw new Error("Cannot access check execution setting");
  }
}
async function read(root: string, key: string): Promise<CheckExecution | null> {
  const value = await config(root, ["--get", key], 1);
  if (value === null) return null;
  const choice = value.trim();
  if (choice !== "cloud" && choice !== "local") throw new Error("Invalid check execution setting");
  return choice;
}
export async function checkExecutionSettings(root: string, lane?: string, stage?: string) {
  if (stage && !lane) throw new Error("Stage checks require a lane");
  const project = await read(root, "delegatus.checks") ?? "cloud";
  const override = lane ? await read(root, laneKey(lane)) : null;
  const stageOverride = lane && stage ? await read(root, stageKey(lane, stage)) : null;
  return { project, override, ...(stage ? { stageOverride } : {}), effective: stageOverride ?? override ?? project };
}
export async function setCheckExecution(root: string, choice: CheckExecution | null, lane?: string, stage?: string) {
  if (choice !== null && choice !== "cloud" && choice !== "local") throw new Error("Invalid check execution setting");
  if (stage && !lane) throw new Error("Stage checks require a lane");
  const key = lane && stage ? stageKey(lane, stage) : lane ? laneKey(lane) : "delegatus.checks";
  await config(root, choice === null ? ["--unset-all", key] : [key, choice], choice === null ? 5 : -1);
  return checkExecutionSettings(root, lane, stage);
}
