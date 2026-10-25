export {};
if (process.env.LLV_CLOUD_RESTART_PROBE !== "1") throw new Error("test probe only");
const { findPipelineRecord } = await import("../store");
const pipeline = findPipelineRecord(process.argv[2]!);
const cloud = pipeline?.runs.find(run => run.stageId === pipeline.cursor?.stageId)?.attempts.at(-1)?.cloud;
if (!cloud) throw new Error("cloud attempt missing after restart");
process.stdout.write(JSON.stringify(cloud));
