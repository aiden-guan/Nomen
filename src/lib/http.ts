/** A failed call to one of Nomen's providers, with enough detail to decide what to do next. */
export class ApiError extends Error {
  constructor(
    readonly service: "naive" | "monid" | "mobilerun",
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(`${service}: ${message}`);
  }

  /** Worth retrying later: rate limits, provider outages and network trouble. */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /** The account is out of money (Naive `insufficient_credits`, Monid 402). */
  get outOfCredits() {
    return this.status === 402 || this.code === "insufficient_credits";
  }
}

type Request = {
  service: ApiError["service"];
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON over HTTPS with a timeout, and retries for rate limits and 5xx answers. */
export async function requestJson<T>({ service, url, method = "GET", headers = {}, body, timeoutMs = 60_000, retries = 2 }: Request): Promise<{ status: number; data: T }> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ApiError(service, 0, "network_error", error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (response.ok) return { status: response.status, data: data as T };
    const retryAfter = Number(response.headers.get("retry-after"));
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw toApiError(service, response.status, data, response.headers.get("x-request-id") ?? undefined);
  }
}

function toApiError(service: ApiError["service"], status: number, data: unknown, requestId?: string): ApiError {
  const body = (data ?? {}) as Record<string, unknown>;
  const envelope = (typeof body.error === "object" && body.error !== null ? body.error : body) as Record<string, unknown>;
  const code = String(envelope.code ?? envelope.type ?? status);
  const message = String(envelope.message ?? envelope.detail ?? envelope.raw ?? `HTTP ${status}`);
  return new ApiError(service, status, code, message, String(envelope.request_id ?? requestId ?? "") || undefined);
}
