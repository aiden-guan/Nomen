// A stand-in for the Mobilerun API behind a mocked global fetch. Shapes follow docs.mobilerun.ai.
import { vi } from "vitest";
import { db, now } from "@/lib/db";
import { resetSchemaFlag } from "@/lib/phones/store";

type FakeDevice = { id: string; name: string; state: string; type: string; platform: "android"; stateMessage: string; streamUrl: string; createdAt: string; updatedAt: string; assignedAt: null; terminatesAt: null; taskCount: number; activeTaskId: string };
type FakeTask = { id: string; deviceId: string; status: string; succeeded: boolean | null; message: string | null; steps: number | null; execution?: unknown; recordingId: string | null; body: Record<string, unknown> };
type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Record<string, string> };

export function fakeMobilerun() {
  const devices = new Map<string, FakeDevice>();
  const tasks = new Map<string, FakeTask>();
  const idempotent = new Map<string, string>();
  const calls: Call[] = [];
  /** Errors to answer the next matching calls with. */
  const failures: Array<{ method: string; path: RegExp; status: number; body: unknown }> = [];
  let taskSeq = 0;

  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number, detail: string, title = "Error") => json(status, { title, status, detail, errors: [] });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, query: url.searchParams, body, headers });

    const failure = failures.findIndex((f) => f.method === method && f.path.test(path));
    if (failure >= 0) {
      const [error] = failures.splice(failure, 1);
      return json(error.status, error.body);
    }

    if (headers.authorization !== "Bearer dr_sk_test") return problem(401, "You are not authorized to access this resource", "Unauthorized");

    let match: RegExpMatchArray | null;
    if (method === "GET" && path === "/devices") {
      const states = url.searchParams.get("state")?.split(",");
      const items = [...devices.values()].filter((d) => (states ? states.includes(d.state) : !["terminated", "unknown"].includes(d.state)));
      return json(200, { items, pagination: { hasNext: false, hasPrev: false, page: 1, pageSize: 100, pages: 1, total: items.length } });
    }
    if (method === "POST" && path === "/devices") {
      const key = headers["idempotency-key"];
      if (key && idempotent.has(key)) return json(200, devices.get(idempotent.get(key)!));
      const device = addDevice({ id: `dev_${devices.size + 1}xxxxxx`, state: "creating", name: String(body?.name ?? "phone") });
      if (key) idempotent.set(key, device.id);
      return json(200, device);
    }
    if ((match = path.match(/^\/devices\/([^/]+)$/)) && method === "GET") {
      const device = devices.get(match[1]);
      return device ? json(200, device) : json(404, { code: "DEVICE_NOT_FOUND", message: "device not found" });
    }
    if ((match = path.match(/^\/devices\/([^/]+)\/resume$/)) && method === "POST") {
      const device = devices.get(match[1]);
      if (!device) return json(404, { code: "DEVICE_NOT_FOUND", message: "device not found" });
      if (device.state === "stopped") device.state = "assigned";
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/tasks") {
      const key = headers["idempotency-key"];
      if (key && idempotent.has(key)) {
        const task = tasks.get(idempotent.get(key)!)!;
        return json(201, { id: task.id, status: task.status, streamUrl: null });
      }
      const busy = [...tasks.values()].some((t) => t.deviceId === body?.deviceId && ["queued", "running", "created"].includes(t.status));
      const task: FakeTask = { id: `task_${++taskSeq}xxxxxx`, deviceId: String(body?.deviceId), status: busy ? "queued" : "running", succeeded: null, message: null, steps: 0, recordingId: null, body: body ?? {} };
      tasks.set(task.id, task);
      if (key) idempotent.set(key, task.id);
      return json(201, { id: task.id, status: task.status, streamUrl: busy ? null : "wss://stream" });
    }
    if ((match = path.match(/^\/tasks\/([^/]+)\/status$/)) && method === "GET") {
      const task = tasks.get(match[1]);
      if (!task) return problem(404, "Task not found");
      return json(200, { status: task.status, succeeded: task.succeeded, message: task.message, output: null, steps: task.steps, recordingId: task.recordingId, execution: task.execution ?? null });
    }
    if ((match = path.match(/^\/tasks\/([^/]+)\/cancel$/)) && method === "POST") {
      const task = tasks.get(match[1]);
      if (!task) return problem(404, "Task not found");
      if (["completed", "failed", "cancelled"].includes(task.status)) return problem(400, "Task already finished");
      task.status = "cancelled";
      return json(200, { cancelled: true });
    }
    if (method === "GET" && path === "/credentials") {
      return json(200, {
        items: [
          { packageName: "com.zhiliaoapp.musically", credentialName: "acme-tiktok", secretPath: "x", ownerId: "u", createdBy: "u", userId: "u", fields: [{ fieldType: "password", value: "hunter2" }] },
          { packageName: "com.instagram.android", credentialName: "acme-ig", secretPath: "y", ownerId: "u", createdBy: "u", userId: "u", fields: [{ fieldType: "password", value: "hunter3" }] },
        ],
        pagination: { hasNext: false, hasPrev: false, page: 1, pageSize: 100, pages: 1, total: 2 },
      });
    }
    return problem(404, `no fake route for ${method} ${path}`);
  });

  function addDevice(input: { id: string; state?: string; name?: string }) {
    const device: FakeDevice = {
      id: input.id,
      name: input.name ?? input.id,
      state: input.state ?? "ready",
      type: "android_cloud_phone",
      platform: "android",
      stateMessage: "",
      streamUrl: "",
      createdAt: now(),
      updatedAt: now(),
      assignedAt: null,
      terminatesAt: null,
      taskCount: 0,
      activeTaskId: "",
    };
    devices.set(device.id, device);
    return device;
  }

  return {
    fetchMock,
    devices,
    tasks,
    calls,
    addDevice,
    /** Answer the next `method` call whose path matches `path` with an error. */
    failNext(method: string, path: RegExp, status: number, body: unknown) {
      failures.push({ method, path, status, body });
    },
    /** Forget the calls made so far (setup calls such as the panel status fetch). */
    clearCalls() {
      calls.length = 0;
      fetchMock.mockClear();
    },
    callsTo: (method: string, pattern: RegExp) => calls.filter((call) => call.method === method && pattern.test(call.path)),
    finishTask(id: string, outcome: Partial<FakeTask>) {
      Object.assign(tasks.get(id)!, { status: "completed", succeeded: true, ...outcome });
    },
  };
}

/** Empties every table the tests touch and adds one brand. */
export function resetDb(brands: Array<{ id: string; name: string }> = [{ id: "brand_acme", name: "Acme Skin" }]) {
  const conn = db();
  for (const table of ["phone_sessions", "phone_accounts", "phone_links"]) conn.exec(`drop table if exists ${table}`);
  resetSchemaFlag();
  conn.exec("delete from events; delete from brands;");
  for (const brand of brands) {
    conn
      .prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
      .run(brand.id, brand.name, `${brand.id}.com`, `https://${brand.id}.com`, now(), now());
  }
}

export const events = () => db().prepare("select level, message from events order by id").all() as Array<{ level: string; message: string }>;
