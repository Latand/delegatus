import fs from "node:fs";
import path from "node:path";
import { requestSchema, type ToolCallResult } from "./protocol";
export const x1Dir = path.join(import.meta.dir, "fixtures/relay_v1");
export const x1Claim = (role: string) => JSON.parse(fs.readFileSync(path.join(x1Dir, `claimed_tools_${role}.json`), "utf8")).request;
export const x1Request = (role: string) => requestSchema.parse(x1Claim(role));
export const x1Results: Record<string, ToolCallResult> = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_results.json"), "utf8"));
export const x1Errors: Record<string, { status: number; body: unknown }> = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_errors.json"), "utf8"));
export const x1Bodies = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_bodies.json"), "utf8"));
