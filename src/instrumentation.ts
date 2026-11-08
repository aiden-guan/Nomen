// Next.js calls register() once when the server starts: that is where the background worker begins.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // On Vercel the worker never starts (Convex calls /api/worker/tick instead; src/lib/worker.ts).
  // NOMEN_VERCEL_BUILD is inlined at build time (next.config.ts), so a Vercel build drops the import
  // below, and with it the worker's files from the trace Vercel ships with the proxy function.
  if (process.env.NOMEN_VERCEL_BUILD) return;
  const { startWorker } = await import("./lib/worker");
  startWorker();
}
