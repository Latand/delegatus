import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { agentRegistry } from "@/lib/agent/registry";
import { bridgeDirectiveBody, bridgeDirectiveId } from "@/lib/bridge/directive";
import { statePath } from "@/lib/configDir";
import { dispatchConversationMessage } from "@/lib/conversation/messageDispatch";
import { deliverConversationMessage } from "@/lib/delivery";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";
import { readSelf } from "@/lib/links/self";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { resolveOrchestratorRelay } from "@/lib/orchestrator/relay";
import { namedProjectDirectory } from "@/lib/projects/nameResolution";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import { waitForStateLock } from "@/lib/state/lockWait";
import { createTask, patchTask, TASK_DETAILS_LIMIT, TASK_TEXT_LIMIT } from "@/lib/tasks/commands";
import { readMutationTask } from "@/lib/tasks/mutationView";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { loadTasksByIds, mutateTasksFile, withTaskPreparation } from "@/lib/tasks/store";
import { safeRelayUrl, type AnswerCapabilities } from "./answerV2";
import { elevatedRequesterFor, ownerBindingRefusal } from "./profile";
import { ownerRequesterTrigger, relayChoiceButtonsSchema, RELAY_DM_TASK_CHOICES, requesterTrigger, type ExternalRelayAnswer, type ExternalRelayRequest } from "./protocol";
import { readRelayStore, RelayStoreBusy, withFileLockAsync, writeRelayFile, type PairedRelay } from "./store";
import { canonicalRelayProject, pairedOwnerTier } from "./trustedRequesters";

const choiceLifetimeMs = 10 * 60_000;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const projectSchema = z.string().min(1).max(256);
const frozenChoice = z.strictObject({
  expiresAt: z.iso.datetime(),
  projects: z.array(z.strictObject({ project: projectSchema, label: z.string().min(1).max(128), value: hashSchema })).min(1).max(100),
});
const persistedRequestContext = z.strictObject({
  targetId: z.string().min(1).max(128),
  chatKey: z.string().min(16).max(64),
  requester: z.object({ key: z.string().min(1).max(128), is_admin: z.boolean(), can_restrict_members: z.boolean(),
    can_delete_messages: z.boolean(), is_anonymous_admin: z.boolean(), is_owner: z.boolean() }).strict(),
  trigger: z.object({ id: z.string().min(1).max(128), text: z.string().max(20000), authorKey: z.string().min(1).max(128) }).strict(),
  ownerChatId: z.number().int().positive().optional(),
});
const base = { request: hashSchema, sender: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) };
const receiptSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...base, phase: z.literal("choice"), choice: frozenChoice }),
  z.strictObject({ ...base, phase: z.enum(["creating", "created", "submitted"]), choice: frozenChoice.optional(), project: projectSchema,
    requestContext: persistedRequestContext.optional() }),
]);
type Receipt = z.infer<typeof receiptSchema>;

function readReceipt(file: string): Receipt | null {
  try { return receiptSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const taskPoliteness = /^(?:please|could you|can you|would you|будь ласка|пожалуйста)[,\s]+/iu;
// The object of a card-creation request must end at the task noun. A following
// noun can make a different object, such as a task list or an issue summary.
const createCard = /^(?:(?:create|add)\s+(?:(?:a|the)\s+)?task|file\s+(?:(?:a|an)\s+)?(?:task|issue|bug))(?=$|\s*[:.!?,–—“"]|\r?\n|\s+(?:for|to|about|on|in|with|called|named)\b)/iu;
const projectWork = /^(?:fix|implement|investigate|refactor|update (?:the |a )?(?:task|build|docs?|documentation|feature|project)|обнови|онови|виправ|виправте|реалізуй|исправь|реализуй|(?:створи|створіть|додай|додайте|закинь|постав|создай|добавь|заведи)\s+(?:задачу|завдання))(?=$|[^\p{L}\p{N}_])/iu;

export function dmTaskTrigger(request: ExternalRelayRequest) {
  if (request.delivery === "guest" || request.chat?.type !== "private") return null;
  const trigger = requesterTrigger(request.input);
  if (!trigger || request.button_choice) return trigger;
  const text = trigger.text.trim();
  const imperative = text.replace(taskPoliteness, "");
  return /^\/task(?:\s|$)/iu.test(text) || createCard.test(imperative) || projectWork.test(imperative) ? trigger : null;
}

function liveScope(relay: PairedRelay, request: ExternalRelayRequest): { project: string | null } | null {
  const { relays } = readRelayStore();
  const paired = relays.find(item => item.id === relay.id && item.credential === relay.credential);
  const target = paired?.targets.find(item => item.id === request.target_id);
  if (!paired || paired.paused !== false || target?.enabled !== true || ownerBindingRefusal(paired, request)) return null;
  if (ownerRequesterTrigger(request.input) && pairedOwnerTier(paired, relays) === "owner") return { project: null };
  const grant = elevatedRequesterFor(paired, target, request, relays);
  const project = grant && canonicalRelayProject(grant.entry.project);
  return project ? { project } : null;
}

function projectWord(text: string, spelling: string): boolean {
  let start = text.indexOf(spelling);
  while (start >= 0) {
    const end = start + spelling.length;
    if (!/[\p{L}\p{N}_-]/u.test(text[start - 1] ?? "") && !/[\p{L}\p{N}_-]/u.test(text[end] ?? "")) return true;
    start = text.indexOf(spelling, start + 1);
  }
  return false;
}

function taskWords(text: string, fallback: string): { text: string; details?: string } | null {
  const words = text.replace(/^\/task\b/i, "").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) ?? [];
  const title = words.filter(word => word.length <= 32).slice(0, 10);
  const heading = title.length >= 3 ? title.join(" ") : fallback;
  const body = `${heading}\n\n${text}`;
  if (body.length <= TASK_TEXT_LIMIT) return { text: body };
  return text.length <= TASK_DETAILS_LIMIT ? { text: heading, details: text } : null;
}

const replies = {
  en: {
    denied: "This chat cannot create that board task.", expired: "This project choice is unavailable. Resend the task request.",
    chooseProject: "Which project should receive this task?", retry: "Please resend the full request with the project name.",
    noSeat: "This project needs a designated orchestrator before it can receive tasks.",
    noUrl: "Set a public HTTPS address for Delegatus to receive task links here.",
    tooLong: "Please shorten the task request.", missing: "This request already had a board card. It is no longer on the board.",
    blocked: "The board could not accept the task.", created: "Task created and submitted to the orchestrator.",
    pending: "Task created. Delivery to the orchestrator is unconfirmed.", open: "Open board card", title: "Review Telegram task request",
  },
  uk: {
    denied: "У цьому чаті не можна створити цю задачу.", expired: "Цей вибір проєкту недоступний. Надішліть задачу ще раз.",
    chooseProject: "До якого проєкту додати задачу?", retry: "Надішліть повний запит ще раз із назвою проєкту.",
    noSeat: "Призначте оркестратора проєкту, щоб він міг приймати задачі.",
    noUrl: "Налаштуйте публічну HTTPS-адресу Delegatus, щоб отримувати тут посилання на задачі.",
    tooLong: "Скоротіть, будь ласка, текст запиту.", missing: "Для цього запиту вже була картка. Її більше немає на дошці.",
    blocked: "Дошка не прийняла задачу.", created: "Задачу створено й передано оркестратору.",
    pending: "Задачу створено. Доставку оркестратору ще не підтверджено.", open: "Відкрити картку", title: "Розглянути запит із Telegram",
  },
} as const;

const seats = () => authorizedManagerSeats(productionManagerAuthoritySources()).filter(seat => seat.project !== null);
const pendingDirectory = () => statePath("external-relay/dm-task-pending");
const receiptPath = (identity: string) => statePath(`external-relay/dm-tasks/${identity}.json`);
const pendingSchema = z.strictObject({ identity: hashSchema, relayId: z.string().min(1).max(128), receipt: receiptSchema });
const recoveryBatchSize = 4;

function pendingPath(identity: string) { return path.join(pendingDirectory(), `${identity}.json`); }
function writePendingDelivery(identity: string, relayId: string, receipt: Receipt) {
  writeRelayFile(pendingPath(identity), { identity, relayId, receipt });
}
function removePendingDelivery(identity: string) {
  try { fs.unlinkSync(pendingPath(identity)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** The serving poller owns one directory cursor and one batch at a time.
 * Each tick resumes the scan, so locked, revoked or unreadable entries cannot
 * keep later files out of the bounded batch. */
export class DmTaskDeliveryRecovery {
  private directory: fs.Dir | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly canRun: () => boolean) {}

  run(deliver = submitDirective): Promise<void> {
    return this.running ??= this.scan(deliver).finally(() => { this.running = null; });
  }

  async close(): Promise<void> {
    this.stopped = true;
    try { await this.running; }
    finally { await this.closeDirectory(); }
  }

  private async closeDirectory() {
    const directory = this.directory;
    this.directory = null;
    await directory?.close();
  }

  private enabled = () => !this.stopped && this.canRun();

  private async scan(deliver: typeof submitDirective) {
    if (!this.enabled()) return;
    try {
      this.directory ??= await fs.promises.opendir(pendingDirectory(), { bufferSize: recoveryBatchSize });
      let relays: PairedRelay[] | undefined;
      for (let count = 0; count < recoveryBatchSize && this.enabled(); count++) {
        const entry = await this.directory.read();
        if (!entry) { await this.closeDirectory(); break; }
        if (!this.enabled()) break;
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const identity = entry.name.slice(0, -5);
        try {
          relays ??= readRelayStore().relays;
          await recoverPendingDelivery(identity, relays, deliver, this.enabled);
        } catch (error) {
          if (!(error instanceof RelayStoreBusy) && (error as NodeJS.ErrnoException).code !== "ENOENT")
            console.warn("Relay DM task outbox entry deferred", error instanceof Error ? error.name : "unknown");
        }
      }
    } catch (error) {
      await this.closeDirectory();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function recoverPendingDelivery(identity: string, relays: PairedRelay[], deliver: typeof submitDirective, enabled: () => boolean) {
  const file = receiptPath(identity);
  await withFileLockAsync(file, async () => {
    if (!enabled()) return;
    const pending = pendingSchema.parse(JSON.parse(fs.readFileSync(pendingPath(identity), "utf8")));
    if (pending.identity !== identity) throw new Error("Relay DM task outbox identity mismatch");
    const receipt = readReceipt(file) ?? pending.receipt;
    const taskId = taskIdFor(identity);
    const cardExists = (project: string) => loadTasksByIds(new Set([taskId]))[0]?.project === project;
    // The claim uses this same lock through board commit and seat admission.
    // A receipt-only retry can recreate its intent before trying the board again.
    if (receipt.phase === "submitted" || receipt.phase === "choice" || !cardExists(receipt.project)) {
      removePendingDelivery(identity);
      return;
    }
    const { requestContext } = receipt;
    const relay = relays.find(item => item.id === pending.relayId);
    if (!relay || !requestContext) return;
    const request = {
      target_id: requestContext.targetId,
      chat: { key: requestContext.chatKey, type: "private" },
      input: { requester: requestContext.requester, respond_to: requestContext.trigger.id,
        conversation: [{ id: requestContext.trigger.id, text: requestContext.trigger.text,
          author: { key: requestContext.trigger.authorKey, self: false } }] },
      ...(requestContext.ownerChatId ? { owner_delivery: { chat_id: requestContext.ownerChatId } } : {}),
    } as ExternalRelayRequest;
    const allowed = () => {
      if (!enabled()) return false;
      const current = liveScope(relay, request);
      return current !== null && (current.project === null || current.project === receipt.project)
        && seats().some(seat => seat.project === receipt.project) && cardExists(receipt.project);
    };
    if (!allowed()) return;
    if (receipt.phase === "creating") writeRelayFile(file, { ...receipt, phase: "created" });
    const instruction = bridgeDirectiveBody(`Owner request via the Telegram relay. Work on the existing board task ${taskId}.\n\nRequest: ${JSON.stringify(requestContext.trigger.text)}`);
    const key = bridgeDirectiveId(`telegram_dm_${identity}`, 0);
    if (await deliver(receipt.project, key, instruction, allowed)) {
      writeRelayFile(file, { ...receipt, phase: "submitted" });
      removePendingDelivery(identity);
    }
  }, Date.now());
}

function taskIdFor(identity: string): string {
  return [identity.slice(0, 8), identity.slice(8, 12), `8${identity.slice(13, 16)}`,
    `8${identity.slice(17, 20)}`, identity.slice(20, 32)].join("-");
}

async function submitDirective(project: string, key: string, text: string, allowed: () => boolean): Promise<boolean> {
  const origin = { kind: "operator" as const };
  const admitted = resolveOrchestratorRelay(project, undefined, { origin, text }, text, key);
  if (!admitted.ok || admitted.terminalReceipt?.state === "failed") return false;
  if (admitted.operationId) return true;
  const { recipient } = admitted;
  const seat = seats().find(candidate => candidate.project === project && candidate.conversationId === recipient);
  if (!seat) return false;
  const admissionGuard = () => {
    if (!allowed() || !seats().some(candidate => candidate.project === project && candidate.conversationId === recipient))
      throw new DeliveryAdmissionRefusedError("dm_task_authority_changed");
  };
  admissionGuard();
  const message = { conversationId: recipient, path: seat.path ?? "", clientMessageId: key, text, origin,
    policy: "steer-or-queue" as const, images: [], admissionGuard, recoveryAuthorityGuard: admissionGuard };
  const selected = await dispatchConversationMessage(message, { ...message, pid: null }, {
    structured: enqueueStructuredMessage, legacy: deliverConversationMessage,
  });
  return selected.result.ok;
}

export async function answerDmTask(
  relay: PairedRelay, request: ExternalRelayRequest, trigger: NonNullable<ReturnType<typeof dmTaskTrigger>>,
  caps: AnswerCapabilities, deadline: number, leaseHeld: () => boolean,
): Promise<ExternalRelayAnswer | null> {
  const chat = request.chat!;
  const text = trigger.text.trim();
  const copy = replies[operatorLocale() === "uk" ? "uk" : "en"];
  const answer = (text: string, parts?: Pick<ExternalRelayAnswer, "buttons" | "choice_buttons">): ExternalRelayAnswer => ({
    action: "reply", reply_to: trigger.id, text: [...text].slice(0, caps.plainMax).join(""),
    ...(caps.rich ? { format: "plain", buttons: [] } : {}), ...parts,
  });
  // References are opaque and scoped to the pairing and target. Exclude the
  // lease and request ids so a new claim of the original message is a replay.
  const identity = digest(JSON.stringify([relay.id, request.target_id, chat.key, trigger.id]));
  const promptId = `dm_${identity.slice(0, 48)}`;
  const taskId = taskIdFor(identity);
  const key = bridgeDirectiveId(`telegram_dm_${identity}`, 0);
  const file = receiptPath(identity);
  const requestHash = digest(text);
  const sender = trigger.author.key;
  const choice = request.button_choice;
  const choicesAvailable = relay.features?.includes(RELAY_DM_TASK_CHOICES) && request.features?.includes(RELAY_DM_TASK_CHOICES);
  const live = () => leaseHeld() ? liveScope(relay, request) : null;

  return withFileLockAsync(file, async () => {
    const scope = live();
    if (!scope) return leaseHeld() ? answer(copy.denied) : null;
    if (choice && !choicesAvailable) return answer(copy.expired);
    let prior = readReceipt(file);
    if (prior && (prior.sender !== sender || prior.request !== requestHash)) return answer(copy.denied);
    const projectAllowed = (project: string) => {
      const current = live();
      return current !== null && (current.project === null || current.project === project);
    };
    let committed = prior?.phase === "created" || prior?.phase === "submitted";
    if (!committed && prior?.phase === "creating") {
      const [boardTask] = loadTasksByIds(new Set([taskId]));
      if (boardTask?.project === prior.project) {
        prior = { ...prior, phase: "created" };
        committed = true;
        writeRelayFile(file, prior);
      }
    }
    const chosenOption = choice && prior?.choice && choice.message_id === promptId
      && choice.expires_at === prior.choice.expiresAt && (committed || Date.parse(choice.expires_at) > Date.now())
      ? prior.choice.projects.find(option => option.value === choice.value) : undefined;
    const choiceProject = canonicalRelayProject(chosenOption?.project ?? null);
    if (choice && (!chosenOption || choiceProject !== canonicalRelayProject(prior?.phase === "choice" ? chosenOption.project : prior?.project ?? null))) return answer(copy.expired);
    if (choice && !committed && (!choiceProject || prior?.phase !== "choice" && canonicalRelayProject(prior?.project ?? null) !== choiceProject)) return answer(copy.expired);
    let project = prior?.phase !== "choice" ? prior?.project : choiceProject;
    if (!project) {
      const directory = namedProjectDirectory({ includeActiveSeats: false, authorizedSeats: seats });
      const allowed = [...directory.active].filter(project => scope.project === null || scope.project === project);
      if (!allowed.length) return answer(copy.noSeat);
      const lower = text.toLowerCase();
      const matched = new Set([...directory.names].flatMap(([name, projects]) => projectWord(lower, name) ? [...projects] : []));
      if (!prior && matched.size === 1) {
        project = [...matched][0]!;
        if (!allowed.includes(project)) return answer(scope.project !== null ? copy.denied : copy.noSeat);
      } else {
        const fallback = answer(`${copy.chooseProject} ${copy.retry}`);
        if (!choicesAvailable || allowed.length > 100) return fallback;
        if (!prior) {
          const projects = allowed.sort().map(project => ({
            project, value: digest(JSON.stringify([identity, project])),
            label: [...((directory.labels.get(project) ?? project).replace(/[\x00-\x1f\x7f]/g, " ").trim() || project)].slice(0, 64).join(""),
          }));
          prior = { phase: "choice", request: requestHash, sender, choice: { projects,
            expiresAt: new Date(Date.now() + choiceLifetimeMs).toISOString() } };
          writeRelayFile(file, prior);
        }
        if (Date.parse(prior.choice!.expiresAt) <= Date.now()) return answer(copy.expired);
        const rows = prior.choice!.projects.filter(option => allowed.includes(directory.canonical(option.project)))
          .map(({ label, value }) => [{ text: label, value }]);
        if (!rows.length) return fallback;
        return answer(`${copy.chooseProject} ${copy.retry}`, { choice_buttons: relayChoiceButtonsSchema.parse({
          message_id: promptId, expires_at: prior.choice!.expiresAt, rows,
        }) });
      }
    }
    project = canonicalRelayProject(project)!;
    const selected = project;
    if (!projectAllowed(selected)) return answer(copy.denied);
    const publicUrl = readSelf()?.publicUrl;
    if (!safeRelayUrl(publicUrl)) return answer(copy.noUrl);
    const url = new URL(new URL(publicUrl).origin);
    url.hash = `task=${encodeURIComponent(taskId)}`;
    if (!safeRelayUrl(url.href)) return answer(copy.noUrl);
    // A richer answer can be downgraded after a refused completion. Keep a
    // complete link in the plain channel so the card is always reachable.
    if ([...url.href].length > caps.plainMax) return answer(copy.tooLong);
    const body = taskWords(text, copy.title);
    if (!body) return answer(copy.tooLong);
    const triggerAuthor = trigger.author.key;
    const next = { request: requestHash, sender, project: selected, ...(prior?.choice ? { choice: prior.choice } : {}), requestContext: {
      targetId: request.target_id, chatKey: chat.key, requester: request.input.requester!,
      trigger: { id: trigger.id, text, authorKey: triggerAuthor },
      ...(request.owner_delivery?.chat_id ? { ownerChatId: request.owner_delivery.chat_id } : {}),
    } };
    const canUseChoice = () => !next.choice || Date.parse(next.choice.expiresAt) > Date.now();
    if ((!prior || prior.phase === "choice") && !seats().some(seat => seat.project === selected)) return answer(copy.noSeat);
    if (!prior || prior.phase === "choice") {
      prior = { ...next, phase: "creating" };
      writeRelayFile(file, prior);
    }
    const alreadyCreated = prior.phase !== "creating";
    // Every attempt starts with recoverable intent, including a retry after
    // writing only the receipt. The worker needs no post-commit outbox write.
    if (prior.phase !== "submitted") writePendingDelivery(identity, relay.id, { ...next, phase: prior.phase });
    type CreateResult = "created" | "denied" | "expired" | "missing" | "noSeat" | "blocked";
    const result = await withTaskPreparation(() => waitForStateLock("relay.dm-task.create", () => mutateTasksFile<CreateResult>(state => {
      if (!projectAllowed(selected)) return { state: undefined, result: "denied" };
      if (choice && !alreadyCreated && !canUseChoice()) return { state: undefined, result: "expired" };
      const existing = readMutationTask(state.tasks, taskId);
      if (existing) return { state: undefined, result: existing.project === selected ? "created" : "missing" };
      if (alreadyCreated || state.recentCreates.some(receipt => receipt.clientRequestId === key))
        return { state: undefined, result: "missing" };
      if (!alreadyCreated && !canUseChoice()) return { state: undefined, result: "expired" };
      if (!seats().some(seat => seat.project === selected)) return { state: undefined, result: "noSeat" };
      // Recheck after the task-store admission wait, in the actual write path.
      if (!projectAllowed(selected)) return { state: undefined, result: "denied" };
      const made = createTask(state.tasks, { ...body, project: selected, placement: "unplaced", clientRequestId: key },
        state.recentCreates, { id: () => taskId, explicit: true, actor: "operator", defaultDue: true,
          dueTimeZone: operatorTimeZone() ?? undefined, seatHolding: taskSeatHoldingSnapshot() });
      if (!made.ok) return { state: undefined, result: "blocked" };
      const assigned = patchTask(made.tasks, taskId, { status: "assigned" }, made.task.createdAt,
        { actor: "operator", statusActor: { kind: "operator" } });
      if (!assigned.ok) return { state: undefined, result: "blocked" };
      return { state: { tasks: assigned.tasks, recentCreates: made.recentCreates }, result: "created" };
    }), { waitMs: Math.max(0, deadline - Date.now()), subject: "tasks" }));
    if (result !== "created") return leaseHeld() ? answer(copy[result]) : null;
    if (!alreadyCreated) writeRelayFile(file, { ...next, phase: "created" });
    if (!projectAllowed(selected)) return leaseHeld() ? answer(copy.denied) : null;
    const instruction = bridgeDirectiveBody(`Owner request via the Telegram relay. Work on the existing board task ${taskId}.\n\nRequest: ${JSON.stringify(text)}`);
    let submitted = prior.phase === "submitted";
    // A durable receipt makes this safe to retry with the same operation
    // identity when admission fails transiently before the claim completes.
    for (let attempt = 0; !submitted && attempt < 2; attempt++)
      submitted = await submitDirective(selected, key, instruction, () => projectAllowed(selected)).catch(() => false);
    if (submitted && prior.phase !== "submitted") {
      writeRelayFile(file, { ...next, phase: "submitted" });
      removePendingDelivery(identity);
    }
    if (!projectAllowed(selected)) return leaseHeld() ? answer(copy.denied) : null;
    const message = submitted ? copy.created : copy.pending;
    const confirmation = [...`${message}\n${url.href}`].length <= caps.plainMax ? `${message}\n${url.href}` : url.href;
    return caps.rows && caps.perRow && caps.totalButtons
      ? answer(confirmation, { buttons: [[{ text: copy.open, url: url.href }]] })
      : answer(confirmation);
  }, deadline);
}
