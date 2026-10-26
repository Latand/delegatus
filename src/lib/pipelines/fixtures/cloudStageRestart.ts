export {};
if (process.env.LLV_CLOUD_RESTART_PROBE !== "1") throw new Error("test probe only");
const { findPipelineRecord } = await import("../store");
const pipeline = findPipelineRecord(process.argv[2]!);
const cloud = pipeline?.runs.find(run => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1)?.cloud;
if (process.argv[3] === "hold-settings-lock") {
  const { statePath } = await import("@/lib/configDir");
  const { withFileTransaction } = await import("@/lib/state/fileTransaction");
  await withFileTransaction(statePath("project-settings.json"), "fixture lock busy", async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    process.stdin.once("data", release);
    const watchdog = setTimeout(() => { process.exitCode = 2; release(); }, 10_000);
    process.stdout.write("locked\n");
    try { await released; } finally { clearTimeout(watchdog); process.stdin.pause(); }
  });
} else if (process.argv[3] === "poll-unavailable") {
  if (!cloud || !pipeline) throw new Error("cloud attempt missing after restart");
  const { defaultPipelinePorts, tickPipelines } = await import("../engine");
  const { registerPipelineTick } = await import("../controllerSignal");
  const { settlePipelineControllerJobs } = await import("../controllerJobs");
  const { HostedCloudError } = await import("../cloudHostedErrors");
  registerPipelineTick(async () => {});
  let pollRequests = 0, submissions = 0;
  const accountId = cloud.accountId ?? pipeline.runs.find(run => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1)?.accountId;
  if (!accountId) throw new Error("cloud task account missing after restart");
  const ports = defaultPipelinePorts();
  ports.allowedAccountIds = () => [accountId];
  ports.accountExhausted = () => false;
  ports.now = () => process.argv[4]!;
  ports.exec = () => { throw new Error("outage reconciliation must not run Git"); };
  ports.worktreePresent = () => true;
  ports.cpuPressureHold = () => null;
  ports.cpuAdmissionReconcile = () => {};
  ports.cpuAdmissionSuspend = () => {};
  ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: { engine: "codex",
    accountId: request.requestedId ?? accountId, kind: "managed", home: process.cwd(), transcriptRoot: process.cwd(), env: { NODE_ENV: "test" } } });
  ports.cloudClient = {
    supportsModel: () => true,
    submit: async () => { submissions++; throw new Error("receipt recovery must not submit"); },
    hasEnvironment: async () => { throw new Error("an admitted receipt must reuse its account"); },
    poll: async () => { pollRequests++; throw new HostedCloudError("Cloud unavailable", "unavailable"); },
    readFinalMessage: async () => { throw new Error("outage has no final message"); },
    readDiff: async () => { throw new Error("outage has no diff"); },
  };
  await tickPipelines([], ports);
  await settlePipelineControllerJobs();
  const current = findPipelineRecord(pipeline.id)?.runs.find(run => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1)?.cloud;
  process.stdout.write(JSON.stringify({ ...current, pollRequests, submissions }));
} else if (process.argv[3] === "reserve") {
  const { reserveCloudStageAccount } = await import("@/lib/projects/settings");
  process.stdout.write(JSON.stringify({ accountId: await reserveCloudStageAccount(pipeline!.project, JSON.parse(process.argv[4]!)) }));
} else {
  if (!cloud) throw new Error("cloud attempt missing after restart");
  process.stdout.write(JSON.stringify(cloud));
}
