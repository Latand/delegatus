import { statePath } from "@/lib/configDir";
import type { Locale } from "@/lib/i18n/core";
import { projectView } from "./roleStore";
import type { RoleMemoryProjectView } from "./roleTypes";
import { MemoryProfileError, PROFILE_PROMPT_VERSION, profileInputs, profileView, validateProfileAnswer } from "./profile";
import { MEMORY_PROFILE_MODEL, prepareProfileCaller, type ProfileCaller } from "./profileModel";
import { readProfileRow, writeProfileRow } from "./profileStore";
import type { MemoryProfileView, ProfileRow } from "./profileTypes";

export type ProfileRun = { latest: MemoryProfileView; done: Promise<void>; subscribe: (listener: (view: MemoryProfileView) => void) => () => void };
type Ports = {
  rules: (project: string) => RoleMemoryProjectView;
  read: (project: string, locale: Locale) => ProfileRow | null;
  write: (row: ProfileRow) => void;
  prepare: (project: string) => Promise<ProfileCaller>;
  model: string;
};
const RUNS_KEY = Symbol.for("delegatus.memory-profile.runs");
const shared = globalThis as typeof globalThis & { [RUNS_KEY]?: Map<string, ProfileRun> };
const sharedRuns = shared[RUNS_KEY] ??= new Map<string, ProfileRun>();

/** Starts work only on an explicit action; every completed part is durable and visible. */
export function createProfileService(ports: Ports, runs = new Map<string, ProfileRun>(), namespace = "") {
  const runKey = (project: string, locale: Locale) => JSON.stringify([namespace, project, locale]);
  function read(project: string, locale: Locale): MemoryProfileView {
    const rules = ports.rules(project);
    const row = ports.read(rules.project, locale);
    if (row?.run?.state === "running" && !runs.has(runKey(rules.project, locale))) {
      row.run = { ...row.run, state: "failed", errors: [{ scope: "overall", code: "interrupted" }] };
    }
    return profileView(rules, locale, ports.model, row);
  }
  function start(project: string, locale: Locale): ProfileRun {
    const rules = ports.rules(project);
    const key = runKey(rules.project, locale);
    const priorRun = runs.get(key);
    if (priorRun) return priorRun;
    const inputs = rules.enabled ? profileInputs(rules) : [];
    const prior = ports.read(rules.project, locale);
    const row: ProfileRow = { project: rules.project, locale, model: ports.model, promptVersion: PROFILE_PROMPT_VERSION,
      parts: prior?.parts.filter(part => inputs.some(input => input.scope === part.scope)) ?? [],
      run: { state: "running", startedAt: new Date().toISOString(), errors: [] },
    };
    const pending = inputs.filter(input => {
      const cached = row.parts.find(part => part.model === ports.model && part.promptVersion === PROFILE_PROMPT_VERSION && part.scope === input.scope && part.hash === input.hash);
      if (cached) cached.basis = input.basis;
      return !cached;
    });
    if (!pending.length) row.run!.state = "done";
    const listeners = new Set<(view: MemoryProfileView) => void>();
    let settle!: () => void;
    const run: ProfileRun = { latest: profileView(rules, locale, ports.model, row), done: new Promise(resolve => { settle = resolve; }),
      subscribe(listener) { listeners.add(listener); listener(run.latest); return () => { listeners.delete(listener); }; },
    };
    const emit = () => {
      ports.write(row);
      run.latest = profileView(ports.rules(rules.project), locale, ports.model, row);
      for (const listener of listeners) listener(run.latest);
    };
    ports.write(row);
    if (!pending.length) { settle(); return run; }
    runs.set(key, run);
    const started = performance.now();
    void (async () => {
      try {
        const call = await ports.prepare(rules.project);
        const outcomes = await Promise.allSettled(pending.map(async input => {
          const partStarted = performance.now();
          try {
            let answer;
            let model = ports.model;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const result = await call(input, locale);
                answer = validateProfileAnswer(result.answer, input, locale);
                model = result.model;
                break;
              }
              catch (error) { if (!(error instanceof MemoryProfileError && error.code === "language" && attempt === 0)) throw error; }
            }
            const part = { scope: input.scope, model, promptVersion: PROFILE_PROMPT_VERSION, hash: input.hash, basis: input.basis, answer: answer!, createdAt: new Date().toISOString(), durationMs: Math.round(performance.now() - partStarted) };
            row.parts = [...row.parts.filter(part => part.scope !== input.scope), part];
            row.run!.firstResultMs ??= Math.round(performance.now() - started);
          } catch (error) {
            row.run!.errors.push({ scope: input.scope, code: error instanceof MemoryProfileError ? error.code : "failed" });
          }
          emit();
        }));
        if (outcomes.some(outcome => outcome.status === "rejected")) row.run!.errors.push({ scope: "overall", code: "failed" });
      } catch (error) { row.run!.errors.push({ scope: "overall", code: error instanceof MemoryProfileError ? error.code : "failed" }); }
      finally {
        row.run!.state = row.run!.errors.length ? "failed" : "done";
        row.run!.durationMs = Math.round(performance.now() - started);
        try { emit(); }
        catch {
          run.latest = { ...run.latest, run: { ...row.run!, state: "failed", errors: [{ scope: "overall", code: "failed" }] } };
          for (const listener of listeners) listener(run.latest);
        }
        finally { runs.delete(key); settle(); }
      }
    })().catch(() => { // A storage refusal is observable to every waiting caller, without an unhandled rejection.
      run.latest = { ...run.latest, run: { state: "failed", startedAt: row.run!.startedAt, errors: [{ scope: "overall", code: "failed" }] } };
      for (const listener of listeners) listener(run.latest);
    });
    return run;
  }
  return { read, start };
}
export function memoryProfileService() {
  return createProfileService({ rules: projectView, read: readProfileRow, write: writeProfileRow, prepare: prepareProfileCaller, model: MEMORY_PROFILE_MODEL }, sharedRuns, statePath("state.sqlite"));
}
