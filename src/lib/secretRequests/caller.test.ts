import { expect, test } from "bun:test";
import { authorizeSecretCaller, type SecretCallerWorld } from "./caller";

function fixture() {
  type Conversation = NonNullable<ReturnType<SecretCallerWorld["conversation"]>>;
  const conversations = new Map<string, Conversation>();
  const stageRecords = new Map<string, ReturnType<SecretCallerWorld["stages"]>>();
  const add = (id: string, data: Partial<Conversation> = {}) => {
    conversations.set(id, { project: "project", role: null, title: id, engine: "codex", model: null, ...data });
  };
  const stage = (id: string, source: string | null, project = "project") => {
    add(id);
    stageRecords.set(id, [{ pipelineId: "pipeline", stageId: "build", taskId: "task", source, project }]);
  };
  const world: SecretCallerWorld = {
    conversation: id => conversations.get(id) ?? null,
    stages: id => stageRecords.get(id) ?? [],
    seat: project => project === "project" ? "seat" : null,
    canonical: project => project === "legacy" ? "project" : project,
  };
  add("seat");
  return { add, stage, world };
}

test("admits a seat, MCP launches, and a live stage with a server-attributed source", () => {
  const { add, stage, world } = fixture();
  add("child", { launcher: "seat", role: "builder", project: "legacy" });
  add("grandchild", { launcher: "child" });
  stage("stage", "seat");
  stage("child-stage", "grandchild");
  expect(authorizeSecretCaller("seat", world)).toMatchObject({ project: "project", requester: { role: "orchestrator" } });
  expect(authorizeSecretCaller("child", world).requester).toMatchObject({
    role: "builder", title: "child", seat: { title: "seat" },
  });
  expect(authorizeSecretCaller("grandchild", world).requester.seat.conversationId).toBe("seat");
  expect(authorizeSecretCaller("stage", world).requester.stage).toEqual({ pipelineId: "pipeline", stageId: "build", taskId: "task" });
  expect(authorizeSecretCaller("child-stage", world).requester.role).toBe("stage");
});

test("refuses caller-claimed ancestry, a rotated seat, unsupported origins and foreign projects", () => {
  const { add, stage, world } = fixture();
  add("manual");
  add("claimed", { ...{ parentConversationId: "seat" } });
  add("foreign", { launcher: "seat", project: "other" });
  add("old-seat");
  add("old-child", { launcher: "old-seat" });
  add("relay", { role: "owner-relay", launcher: "seat" });
  // ensureForkedConversation copies parentConversationId into the launch
  // profile of the seat's parallel self. It leaves launcher absent.
  add("parallel-self", { ...{ parentConversationId: "seat" } });
  stage("no-source", null);
  stage("foreign-stage", "seat", "other");
  for (const id of ["manual", "claimed", "foreign", "old-child", "relay", "parallel-self", "no-source", "foreign-stage", "remote-only"]) {
    expect(() => authorizeSecretCaller(id, world)).toThrow("Ask this project's orchestrator");
  }
});

test("walks at most four links, refuses cycles and checks the project at every hop", () => {
  const { add, world } = fixture();
  add("one", { launcher: "seat" });
  add("two", { launcher: "one" });
  add("three", { launcher: "two" });
  add("four", { launcher: "three" });
  add("five", { launcher: "four" });
  add("cycle-a", { launcher: "cycle-b" });
  add("cycle-b", { launcher: "cycle-a" });
  add("foreign-hop", { launcher: "seat", project: "other" });
  add("returned", { launcher: "foreign-hop" });

  expect(authorizeSecretCaller("four", world).requester.seat.conversationId).toBe("seat");
  for (const id of ["five", "cycle-a", "returned"]) {
    expect(() => authorizeSecretCaller(id, world)).toThrow("Ask this project's orchestrator");
  }
});
