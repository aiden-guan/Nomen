// Next.js calls register() once when the server starts: that is where the background worker begins.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("./lib/worker");
  startWorker();
}
