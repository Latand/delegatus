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
} else if (process.argv[3]?.startsWith("claude-recovery-")) {
  if (!cloud || !pipeline) throw new Error("cloud attempt missing after restart");
  const { defaultPipelinePorts, tickPipelines } = await import("../engine");
  const { registerPipelineTick } = await import("../controllerSignal");
  const { settlePipelineControllerJobs } = await import("../controllerJobs");
  registerPipelineTick(async () => {});
  const ports = defaultPipelinePorts();
  ports.now = () => process.argv[4]!;
  ports.allowedAccountIds = () => [cloud.accountId!];
  ports.accountExhausted = () => false;
  ports.worktreePresent = () => true;
  ports.cpuPressureHold = () => null;
  ports.cpuAdmissionReconcile = () => {};
  ports.cpuAdmissionSuspend = () => {};
  ports.exec = (_command, args) => ({ code: 0, stderr: "", stdout: args.includes("ls-remote")
    ? `${cloud.headSha}\trefs/heads/${cloud.branch}\n` : args.includes("--show-current") ? `${pipeline.branch}\n` : args.includes("rev-parse") ? `${cloud.headSha}\n` : "" });
  ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: cloud.accountId!,
    kind: "managed", home: process.cwd(), transcriptRoot: process.cwd(), env: { NODE_ENV: "test" } } });
  let recoveries = 0;
  ports.claudeCloudClient = {
    supportsModel: () => true,
    hasEnvironment: async () => { throw new Error("recovery must use its saved account and target"); },
    submit: async () => { throw new Error("recovery must never submit a new session"); },
    recoverSubmission: async () => {
      recoveries++;
      // Exit at the durable admission boundary, as an abruptly stopped controller would.
      if (process.argv[3] === "claude-recovery-interrupt") process.exit(0);
      if (process.argv[3] === "claude-recovery-absent") return { state: "absent", reason: "The fake provider proved no execution" };
      return { state: "found", receipt: { taskId: cloud.claudeSubmission!.sessionId!,
        taskUrl: `https://claude.ai/code/${cloud.claudeSubmission!.sessionId!}`,
        thread: { threadId: cloud.claudeSubmission!.sessionId!, turnId: cloud.claudeSubmission!.lastToken! } } };
    },
    poll: async () => ({ state: "pending", model: null }),
    readFinalMessage: async () => { throw new Error("this probe never settles a result"); },
    readDiff: async () => { throw new Error("this probe never applies a result"); },
  };
  await tickPipelines([], ports);
  await settlePipelineControllerJobs();
  const current = findPipelineRecord(pipeline.id);
  process.stdout.write(JSON.stringify({ recoveries, state: current?.state,
    cloud: current?.runs.find(run => run.stageId === current.cursor?.stageId)?.attempts.at(-1)?.cloud }));
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
