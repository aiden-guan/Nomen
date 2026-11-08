import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();

// Ticks chain themselves every 10 s while a campaign is in flight (worker.ts). This restarts the
// chain after a crash and drives slow work (scheduled posts, analytics) when nothing else is.
crons.interval("worker heartbeat", { minutes: 5 }, makeFunctionReference<"mutation">("worker:heartbeat"));

export default crons;
