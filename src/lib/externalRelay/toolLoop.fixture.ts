import fs from "node:fs";
import path from "node:path";
import { requestSchema, type ExternalRelayTool, type ToolCallResult } from "./protocol";
export const x1Dir = path.join(import.meta.dir, "fixtures/relay_v1");
export const x1Claim = (role: string) => JSON.parse(fs.readFileSync(path.join(x1Dir, `claimed_tools_${role}.json`), "utf8")).request;
export const x1Request = (role: string) => requestSchema.parse(x1Claim(role));
export const x1Results: Record<string, ToolCallResult> = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_results.json"), "utf8"));
export const x1Errors: Record<string, { status: number; body: unknown }> = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_errors.json"), "utf8"));
export const x1Bodies = JSON.parse(fs.readFileSync(path.join(x1Dir, "tool_call_bodies.json"), "utf8"));
// I10 rendering of the public OpenAPI at Celestia amendment revision 03de6455.
export const ownerIndex: ExternalRelayTool[] = JSON.parse(fs.readFileSync(path.join(x1Dir, "owner-tools-index.json"), "utf8"));
export function ownerRequest(name = "owner_x4") {
  const request = x1Request("actions_admin");
  request.request_id = name;
  request.input.requester = x1Request("owner").input.requester;
  request.input.tools = [...request.input.tools!, ...ownerIndex].sort((a, b) => a.name.localeCompare(b.name));
  request.input.request_text = "List my grids, create two requested grids, attach their chats, and deactivate the named clone when I confirm.";
  return request;
}
