import type { Pipeline, PipelineStage } from "./types";

export type BriefWarning = {
  stageId: string | null;
  source: "spec" | "prompt" | "role/controller";
  reason: "restriction-reason" | "acceptance-conflict" | "advisory-limit";
  restriction: string;
  criterion?: string;
  message: string;
};

// Advisory English indicators, never an authority or a semantic launch gate.
// The seat still traces dependencies through the effective composed contract.
const restriction = /\b(?:no|never|do not|must not|only|forbid\w*|prohibit\w*|excluded?|read.only|requires? .*approval)\b/i;
const clauses = (text: string) => text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map(line => line.trim()).filter(Boolean);
const required = /\b(?:acceptance|must|required|ensure|deliver|implement|update|change|support|complete|pass|verify)\b/i;
const assignedAction = /\b(?:add|change|create|edit|extend|implement|modify|repair|run|test|update|verify|write)\b/i;
const resourceEdit = /\b(?:add|change|create|edit|extend|implement|modify|repair|update|write)\b(?:\s+[\w-]+){0,3}\s+\b(?:tests?|checks?)\b/i;

const resources = [
  { name: "tests", subject: /\b(?:tests?|checks?)\b/i, ban: /(?:\bno\b[^\n.]*\btests?|\b(?:do not|never)\s+(?!skip\b|weaken\b)[^\n.]*\btests?|\b(?:forbid\w*|prohibit\w*)\b[^\n.]*\btests?|\btests?\b[^\n.]*\b(?:excluded|forbidden|prohibited)\b)/i },
  { name: "server dependencies", subject: /\b(?:server|readback|queue|recipient|archiv\w*|interruption|adapter|pipeline.store)\b/i, ban: /(?:\bno|do not|never|forbid\w*|prohibit\w*)\b[^\n.]*\b(?:server|adapter|pipeline.store|archiv\w*|interruption)|\b(?:server|adapter|pipeline.store|archiv\w*|interruption)\b[^\n.]*\b(?:excluded|forbidden|prohibited)\b/i },
  { name: "production actions", subject: /\b(?:production|live)\b.*\b(?:write|deploy|restart|mutation)\b/i, ban: /\b(?:no|do not|never)\b[^\n.]*\b(?:production|live|runtime)\b[^\n.]*\b(?:writes?|changes?|deploys?|restarts?)\b/i },
];

function explicitlyAssignedToSuccessor(block: string, current: PipelineStage | undefined, resource: typeof resources[number], stages: PipelineStage[]): boolean {
  const owner = block.match(/\b(?:owner|continuation)\s*:\s*([^\n;]+)/i)?.[1];
  if (!owner) return false;
  const ownerTokens = owner.split(/[^a-z0-9_-]+/i);
  return stages.some(candidate => {
    if (candidate.id === current?.id || !ownerTokens.includes(candidate.id)
      || (candidate.access ?? candidate.effectiveRole.access) !== "read-write") return false;
    const successorFences = candidate.effectiveRole.promptScaffold?.split("\n\nSafety fences:\n")[1] ?? "";
    const successorContract = `${candidate.prompt}\n${successorFences}`;
    if (clauses(successorContract).some(line => resource.ban.test(line))) return false;
    return clauses(candidate.prompt).some(line => resource.subject.test(line)
      && (resource.name === "tests" ? resourceEdit.test(line) : assignedAction.test(line)));
  });
}

/** Bounded, recomputed from the admitted record, including frozen role access.
 * No persisted schema, model call, permission widening or hidden refusal.
 * Reasons use four labelled fields (in any order), or one project-policy
 * reference carrying those fields for the brief. Free prose still launches
 * and gets a reminder for the seat to review.
 */
export function briefWarnings(pipeline: Pick<Pipeline, "spec" | "stages">, scope?: { spec: boolean; stages: ReadonlySet<string>; newStages: ReadonlySet<string> }): BriefWarning[] {
  const warnings: BriefWarning[] = [];
  let omitted = 0;
  const seen = new Set<string>();
  const add = (warning: BriefWarning) => {
    const key = JSON.stringify(warning);
    if (seen.has(key)) return;
    seen.add(key);
    if (warnings.length < 23) warnings.push(warning);
    else omitted++;
  };
  const spec = pipeline.spec ?? "";
  const inspect = (text: string, source: BriefWarning["source"], stage?: PipelineStage) => {
    const contextLines = clauses(`${spec}\n${stage?.prompt ?? ""}\n${text}`);
    const criteria = resources.map(resource => contextLines.find(candidate => required.test(candidate) && resource.subject.test(candidate) && !restriction.test(candidate)));
    const domainCriterion = contextLines.find(candidate => required.test(candidate) && /\b(?:equivalence|full .*domain|all .*inputs)\b/i.test(candidate));
    for (const block of text.split(/\n\s*\n/)) {
      const justified = [/(?:authority|source)\s*:\s*\S/i, /reason\s*:\s*\S/i, /(?:resource|protects)\s*:\s*\S/i, /(?:owner|continuation)\s*:\s*\S/i].every(pattern => pattern.test(block));
      for (const line of clauses(block).filter(line => restriction.test(line))) {
        if (source !== "role/controller" && !justified) add({ stageId: source === "spec" ? null : stage?.id ?? null, source, reason: "restriction-reason", restriction: line.slice(0, 500),
          message: "Review this additional restriction: name its authority, current reason, protected resource and continuation owner, or reference the project's policy. Trace acceptance before launch; this warning grants no authority and does not block launch." });
      }
      for (const line of clauses(block)) {
        for (const [index, resource] of resources.entries()) {
          const criterion = criteria[index];
          if (resource.ban.test(line) && criterion && !explicitlyAssignedToSuccessor(block, stage, resource, pipeline.stages)) add({ stageId: stage?.id ?? null, source, reason: "acceptance-conflict", restriction: line.slice(0, 500), criterion: criterion.slice(0, 500),
            message: `Acceptance needs ${resource.name} while this restriction excludes them. Identify the required action and permitted dependency owner; resolve a seat-added restriction within existing authority. Keep unresolved full acceptance open.` });
        }
      }
      for (const line of clauses(block)) {
        if (/\b(?:only|exactly|fixed)\s+(?:\w+\s+)?\d+\s+patterns?\b/i.test(line) && domainCriterion) add({ stageId: stage?.id ?? null, source, reason: "acceptance-conflict", restriction: line.slice(0, 500), criterion: domainCriterion.slice(0, 500),
          message: "A fixed implementation limit may exclude accepted inputs. Check the full domain against the protected invariant and allow a mechanism that satisfies it." });
      }
    }
  };
  if (!pipeline.stages.length && (!scope || scope.spec)) inspect(spec, "spec");
  for (const stage of pipeline.stages) {
    if (!scope || scope.spec) inspect(spec, "spec", stage);
    if (scope && !scope.stages.has(stage.id)) continue;
    inspect(stage.prompt, "prompt", stage);
    const fences = stage.effectiveRole.promptScaffold?.split("\n\nSafety fences:\n")[1];
    if (fences && (!scope || scope.newStages.has(stage.id))) inspect(fences, "role/controller", stage);
    // Global acceptance belongs to the lane. Only an action assigned in this
    // stage's brief conflicts with its read-only/controller contract.
    const action = clauses(stage.prompt).find(line => /^(?:[-*]\s*)?(?:must\s+|then\s+)?(?:close|merge|deploy|restart|push|rerun)\b/i.test(line));
    if (action && (stage.access ?? stage.effectiveRole.access) === "read-only") add({ stageId: stage.id, source: "role/controller", reason: "acceptance-conflict",
      restriction: "Effective role is read-only; controller publication and later operations retain their declared owners.", criterion: action.slice(0, 500),
      message: "This assigned action requires another owner's authority. Keep this stage's artifact review separate, name the authorized continuation owner and report its pending status; do not ask for broader worker access." });
  }
  if (omitted) warnings.push({ stageId: null, source: "spec", reason: "advisory-limit", restriction: "",
    message: `${omitted} additional advisory items omitted. Review the full brief and effective role/controller contract against every acceptance dependency.` });
  return warnings;
}

export type BriefTextSnapshot = { spec: string; prompts: ReadonlyMap<string, string> };

export function briefTextSnapshot(pipeline: Pick<Pipeline, "spec" | "stages">): BriefTextSnapshot {
  return { spec: pipeline.spec ?? "", prompts: new Map(pipeline.stages.map(stage => [stage.id, stage.prompt])) };
}

export function withBriefWarnings<T extends { pipeline?: Pipeline; briefWarnings?: BriefWarning[]; briefWarningCount?: number }>(result: T, before?: BriefTextSnapshot): T & { briefWarnings?: BriefWarning[]; briefWarningCount?: number } {
  if (!result.pipeline) return result;
  const pipeline = result.pipeline;
  const all = briefWarnings(pipeline);
  // Select sources before applying the advisory cap: old warnings must never
  // crowd a newly added prompt out of its own acknowledgement.
  const warnings = before ? briefWarnings(pipeline, {
    spec: before.spec !== (pipeline.spec ?? ""),
    stages: new Set(pipeline.stages.filter(stage => before.prompts.get(stage.id) !== stage.prompt).map(stage => stage.id)),
    newStages: new Set(pipeline.stages.filter(stage => !before.prompts.has(stage.id)).map(stage => stage.id)),
  }) : all;
  return { ...result, briefWarningCount: all.length, ...(warnings.length ? { briefWarnings: warnings } : {}) };
}

/** Wire acknowledgements share each diagnostic's explanation once. Full
 * reads retain the original self-contained warning records. */
export function briefWarningAnswer(result: { briefWarnings?: BriefWarning[]; briefWarningCount?: number }) {
  const messages: string[] = [];
  const warnings = result.briefWarnings?.map(({ message, ...warning }) => {
    let messageIndex = messages.indexOf(message);
    if (messageIndex === -1) { messageIndex = messages.length; messages.push(message); }
    return { ...warning, messageIndex };
  });
  return {
    ...(result.briefWarningCount !== undefined ? { briefWarningCount: result.briefWarningCount } : {}),
    ...(warnings?.length ? { briefWarnings: warnings, briefWarningMessages: messages } : {}),
  };
}
