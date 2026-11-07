import { bakeJob, type Job } from "./jobs";

// Bakes sprites off the main thread so the page stays responsive while the camp is drawn.

type Scope = {
  onmessage: ((event: MessageEvent<{ id: number; job: Job }>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const scope = self as unknown as Scope;

scope.onmessage = (event) => {
  const { id, job } = event.data;
  try {
    const sprite = bakeJob(job);
    scope.postMessage({ id, sprite }, [sprite.rgba.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
