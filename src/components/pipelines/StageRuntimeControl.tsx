"use client";

import { useEffect, useState } from "react";
import { RuntimeControlsView, type RuntimeDraft } from "@/components/AgentRuntimeControls";
import { EngineRadioGroup } from "@/components/draft/AgentLaunchControls";
import { browserPipelinePorts, type PipelinePorts } from "@/components/kanban/pipelinePorts";
import { accountStanding, parseProjectPolicy, type ProjectPolicy } from "@/components/kanban/accountChoice";
import { Select } from "@/components/ui/Select";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { effortScale } from "@/lib/agent/efforts";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage, PipelineStageAttempt, PatchPipelineRequest } from "@/lib/pipelines/types";
import { latestAttempt } from "./pipelineModel";

export function RuntimeSwitchLine({ attempt }: { attempt: PipelineStageAttempt | null }) {
  const { t } = useLocale();
  const record = attempt?.runtimeSwitches?.at(-1);
  if (!record) return null;
  const runtime = `${record.to.engine} · ${record.to.model ?? ""}`;
  const open = ["requested", "cutting", "switching", "continuing"].includes(record.phase);
  const key = open ? attempt?.state === "needs_decision" ? "waiting" : "switching"
    : record.phase === "committed" ? "continued"
      : record.phase === "rolled-back" ? "rolledBack"
        : record.phase === "failed" ? "failed" : "superseded";
  const outcome = record.outcome;
  const reasonKey = outcome === "stage stopped by kill during runtime switch" ? "reason.kill"
    : outcome?.startsWith("target account is no longer allowed") || outcome?.startsWith("runtime switch rollback refused") || outcome?.startsWith("actual account is no longer allowed") ? "reason.accountDisallowed"
      : outcome?.startsWith("target engine is unavailable") ? "reason.engineUnavailable"
        : outcome?.startsWith("runtime switch did not settle") ? "reason.didNotSettle"
          : outcome?.startsWith("runtime switch failed") ? "reason.switchFailed"
            : outcome?.startsWith("could not stop the running agent") ? "reason.stopFailed"
              : outcome?.startsWith("runtime switch was not started") || outcome?.startsWith("stage stopped mid-turn") ? "reason.deliveryPending"
                : outcome?.startsWith("runtime switch stop remains unconfirmed") || outcome?.startsWith("runtime switch launch could not be proven stopped") ? "reason.stopUnconfirmed"
                  : outcome?.startsWith("runtime switch rollback waiting") || outcome?.startsWith("continued runtime generation is unavailable") ? "reason.sourceUnconfirmed"
                    : outcome?.startsWith("continuation delivered") ? "reason.turnStartPending"
                      : outcome?.startsWith("runtime switch continuation failed") ? "reason.continuationFailed"
                        : outcome?.startsWith("runtime switch continuation fenced") ? "reason.accountDisallowed"
                          : outcome ? "reason.generic" : null;
  const reason = reasonKey ? t(`stageRuntime.${reasonKey}`) : "";
  const oldRuntime = `${attempt?.effectiveRole.engine ?? record.from.engine} · ${attempt?.effectiveRole.model ?? record.from.model ?? ""}`;
  const tone = key === "failed" || key === "rolledBack" || key === "waiting" ? "text-danger" : "text-secondary";
  return <p data-stage-runtime-status={record.phase} className={`text-ui leading-relaxed break-words ${tone}`} role="status">
    {t(`stageRuntime.${key}`, { runtime: key === "failed" || key === "rolledBack" ? oldRuntime : runtime, reason })}
  </p>;
}
const signature = (stage: PipelineStage) => JSON.stringify([stage.effectiveRole.engine, stage.effectiveRole.model, stage.effectiveRole.effort, stage.effectiveRole.serviceTier, stage.account]);

export function StageRuntimeControl({ pipeline, stage, ports = browserPipelinePorts }: { pipeline: Pipeline; stage: PipelineStage; ports?: PipelinePorts }) {
  const { t } = useLocale();
  const attempt = latestAttempt(pipeline, stage.id);
  const role = stage.effectiveRole;
  const [base] = useState(() => signature(stage));
  const [engine, setEngine] = useState(role.engine);
  const [draft, setDraft] = useState<RuntimeDraft>({ model: role.model ?? ENGINE_MODELS[role.engine][0]!.id, effort: role.effort ?? "high", fast: role.serviceTier === "priority" });
  const [account, setAccount] = useState(stage.account ?? "");
  const [policy, setPolicy] = useState<ProjectPolicy>({ state: "loading" });
  const accounts = useEngineAccounts(engine);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const parked = attempt?.state === "needs_decision" || pipeline.state === "needs_decision";
  useEffect(() => {
    let active = true;
    void fetch(`/api/account-project-bindings?project=${encodeURIComponent(pipeline.project)}`, { cache: "no-store" })
      .then(async response => response.ok ? parseProjectPolicy(await response.json()) : { state: "unknown" } as ProjectPolicy)
      .catch(() => ({ state: "unknown" } as ProjectPolicy)).then(value => { if (active) setPolicy(value); });
    return () => { active = false; };
  }, [pipeline.project]);
  const open = attempt?.runtimeSwitches?.some(record => ["requested", "cutting", "switching", "continuing"].includes(record.phase));
  const reason = open ? t(parked ? "stageRuntime.parked" : "stageRuntime.busy") : attempt?.state === "spawning" ? t("stageRuntime.starting")
    : pipeline.state !== "running" || attempt?.state !== "running" ? t("stageRuntime.held") : attempt.report ? t("stageRuntime.reported") : null;
  const disabled = saving || !!reason;
  const save = async (applyNow: boolean) => {
    if (disabled) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const read = await ports.read(pipeline.id);
      const fresh = read?.pipeline.stages.find(value => value.id === stage.id);
      const digest = read?.stageDigests[stage.id];
      if (!fresh || !digest) { setError(t("stageRuntime.unread")); return; }
      if (signature(fresh) !== base) { setError(t("stageRuntime.changed")); return; }
      const body: PatchPipelineRequest = { action: "override-stage", stageId: stage.id, expectedStageDigest: digest, ...(applyNow ? { applyNow: true } : {}) };
      if (engine !== role.engine) body.engine = engine;
      if (draft.model !== role.model) body.model = draft.model;
      if (draft.effort !== role.effort) body.effort = draft.effort;
      if (engine === "codex" && (draft.fast !== (role.serviceTier === "priority") || engine !== role.engine)) body.serviceTier = draft.fast ? "priority" : "standard";
      if (account !== (stage.account ?? "") || engine !== role.engine) body.account = account || null;
      if (!applyNow && Object.keys(body).length === 3) { setSaved(true); return; }
      const answer = await ports.patch(pipeline.id, body);
      if (answer.ok) { setSaved(!applyNow); ports.refresh(); }
      else setError(answer.unknown ? t("stageRuntime.unconfirmed") : answer.error);
    } catch { setError(t("stageRuntime.unconfirmed")); }
    finally { setSaving(false); }
  };
  return <div data-stage-runtime-control={stage.id} className="flex min-w-0 flex-col gap-3 p-3 text-ui [&_select]:max-w-full [&_select]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11">
    <p className="break-words text-secondary">{t("stageRuntime.current", { runtime: `${attempt?.effectiveRole.engine ?? role.engine} · ${attempt?.effectiveRole.model ?? role.model ?? ""}`, account: accounts.accounts.find(item => item.id === attempt?.accountId)?.label ?? attempt?.accountId ?? t("kanban.account.projectChoice") })}</p>
    <EngineRadioGroup engine={engine} disabled={disabled} onChange={next => {
      if (next === "copilot") return;
      const model = ENGINE_MODELS[next][0]!.id;
      setEngine(next); setAccount(""); setDraft({ model, effort: effortScale(next, model)?.includes("high") ? "high" : effortScale(next, model)?.[0] ?? "", fast: false });
    }} />
    <RuntimeControlsView engine={engine} draft={draft} state={saving ? "saving" : "idle"} error={error ?? ""} disabled={disabled} hideApply onEdit={setDraft} onApply={() => {}} />
    <label className="flex min-w-0 flex-col gap-1">{t("stageRuntime.account")}
      <Select value={account} disabled={disabled || policy.state !== "known"} onChange={event => setAccount(event.target.value)}>
        <option value="">{t("kanban.account.projectChoice")}</option>
        {accounts.accounts.filter(item => accountStanding(policy, engine, item.id) === "inside").map(item => <option key={item.id} value={item.id} disabled={!item.authPresent}>{item.label}</option>)}
      </Select>
    </label>
    <RuntimeSwitchLine attempt={attempt} />
    {reason ? <p data-stage-runtime-disabled className="text-ui text-secondary">{reason}</p> : null}
    <button type="button" data-stage-runtime-action="now" className="rounded-control bg-accent px-3 py-2 font-semibold text-white disabled:opacity-50" disabled={disabled} onClick={() => void save(true)}>{t("stageRuntime.now")}</button>
    <p className="text-ui leading-relaxed text-secondary">{t(engine === attempt?.effectiveRole.engine ? "stageRuntime.forkConsequence" : "stageRuntime.handoffConsequence")}</p>
    <button type="button" data-stage-runtime-action="next" className="rounded-control border border-border px-3 py-2 font-semibold disabled:opacity-50" disabled={disabled} onClick={() => void save(false)}>{t("stageRuntime.next")}</button>
    {error ? <p role="alert" className="break-words text-danger">{error}</p> : saved ? <p role="status">{t("stageRuntime.saved")}</p> : null}
  </div>;
}
