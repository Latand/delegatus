import { expect, setSystemTime, test } from "bun:test";
import { prototypePublishSchema, parsePrototypeInput } from "./input";
import { publishPrototype } from "./store";
import { prototypeReviewReplica } from "./model";
import { isPrototypeReplica } from "./replica";
import { createTask } from "@/lib/tasks/commands";
import { loadTasks, saveTasks } from "@/lib/tasks/store";

import { questions } from "./questionnaire.fixture";

test("questions-only publications validate the short questionnaire contract", () => {
  const input = { clientRequestId: "questions", title: "Before work", questions };
  expect(prototypePublishSchema.safeParse(input).success).toBe(true);
  expect(parsePrototypeInput(input)).toEqual(input);
  expect(parsePrototypeInput({ ...input, variants: [] }).variants).toEqual([]);
  /* One decision is one question (docs/design/operator-decision-forms.md §2.1). */
  expect(parsePrototypeInput({ ...input, questions: questions.slice(0, 1) }).questions).toHaveLength(1);
  const invalid = [
    { questions: [] },
    { questions: Array.from({ length: 8 }, (_, i) => ({ ...questions[0], id: `q${i}` })) },
    { questions: questions.map(q => ({ ...q, options: q.options.slice(0, 1) })) },
    { questions: questions.map(q => ({ ...q, options: Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i}`, recommended: i === 0 })) })) },
    { questions: questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, recommended: false })) })) },
    { questions: questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, recommended: true })) })) },
    { questions: [questions[0], questions[0], questions[2]] },
    { questions: questions.map(q => ({ ...q, options: [{ label: "Same", recommended: true }, { label: "Same" }] })) },
    { dir: "/var/tmp/frames" },
    { questions: undefined },
    { questions: undefined, variants: [] },
  ];
  for (const patch of invalid) expect(() => parsePrototypeInput({ ...input, ...patch })).toThrow();
});

test("Unicode code-point form maxima survive publication, reload and the replica reader", async () => {
  const now = "2026-11-01T10:00:00.000Z";
  setSystemTime(new Date(now));
  try {
    const created = createTask([], { project: "form-fixture", text: "Choose the next direction", placement: "unplaced", dueAt: "2026-12-01T10:00:00.000Z", dueTz: "UTC" }, [], { now: () => now, id: () => "form-task" });
    if (!created.ok) throw Error(created.error);
    saveTasks(created.tasks);
    const text = "🧭".repeat(300), label = "🧭".repeat(120);
    const questions = Array.from({ length: 3 }, (_, index) => ({ id: `choice-${index}`, text, options: [{ label, recommended: true }, { label: "Wait" }] }));
    const raw = { clientRequestId: "wide-form", title: "Choose a direction", questions };
    const parsed = parsePrototypeInput(raw);
    const round = await publishPrototype(parsed, created.task.id, { conversationId: "conversation_form" });
    const stored = loadTasks()[0]!;
    expect(stored.prototypeReviews?.[0]?.id).toBe(round.id);
    expect(stored.prototypeReviews?.[0]?.questions).toEqual(questions);
    const replica = prototypeReviewReplica(stored);
    expect(isPrototypeReplica(replica, stored.id, stored.project)).toBe(true);
    expect(replica?.rounds[0]?.questions).toEqual(questions);
    for (const [field, value, max] of [["text", text + "я", 300], ["label", label + "я", 120]] as const) {
      const over = structuredClone(raw);
      if (field === "text") over.questions[0]!.text = value;
      else over.questions[0]!.options[0]!.label = value;
      expect(() => parsePrototypeInput(over)).toThrow(`actual length is ${max + 1}`);
    }
    expect(loadTasks()[0]!.prototypeReviews).toHaveLength(1);
  } finally { setSystemTime(); }
});

test("skippable is for a form without a task: it parses there and is refused beside a taskId", () => {
  const fixed = questions.map(q => q.id === "scope" ? { ...q, skippable: false } : q);
  const form = { clientRequestId: "first-form", title: "What should I do first?", questions: fixed };
  expect(parsePrototypeInput(form).questions?.find(q => q.id === "scope")?.skippable).toBe(false);
  expect(() => parsePrototypeInput({ ...form, taskId: "task-1" })).toThrow("skippable is for a form published without taskId");
  /* Even true: a task round is copied to older installations, which reject a field they do not know. */
  expect(() => parsePrototypeInput({ ...form, taskId: "task-1", questions: questions.map(q => ({ ...q, skippable: true })) })).toThrow("skippable is for a form published without taskId");
  /* A task round with no skippable field is as before. */
  expect(parsePrototypeInput({ clientRequestId: "task-form", title: "Before work", taskId: "task-1", questions }).taskId).toBe("task-1");
  expect(prototypePublishSchema.safeParse({ ...form, questions: fixed.map(q => ({ ...q, skippable: "no" })) }).success).toBe(false);
});
