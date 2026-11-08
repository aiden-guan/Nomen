// A stand-in for the Mobilerun API behind a mocked global fetch. Shapes follow docs.mobilerun.ai.
import { vi } from "vitest";
import { db, now } from "@/lib/db";
import { resetSchemaFlag } from "@/lib/phones/store";

type FakeDevice = { id: string; name: string; state: string; type: string; platform: "android"; stateMessage: string; streamUrl: string; createdAt: string; updatedAt: string; assignedAt: null; terminatesAt: null; taskCount: number; activeTaskId: string };
type FakeTask = {
  id: string;
  deviceId: string;
  status: string;
  succeeded: boolean | null;
  message: string | null;
  steps: number | null;
  execution?: unknown;
  output?: Record<string, unknown> | null;
  recordingId: string | null;
  body: Record<string, unknown>;
};
type FakeFile = { name: string; size: number; type: string; bytes: Buffer; modifiedAt: string };
type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Record<string, string>; upload?: { name: string; size: number; type: string } };

/** Folders a fresh Android phone's shared storage has. */
const DEFAULT_DIRS = ["/", "/DCIM", "/DCIM/Camera", "/Download", "/Movies", "/Pictures"];
const cleanPath = (path: string) => `/${path.split("/").filter(Boolean).join("/")}`;
const parentOf = (path: string) => path.replace(/\/[^/]+$/, "") || "/";

export function fakeMobilerun() {
  const devices = new Map<string, FakeDevice>();
  const tasks = new Map<string, FakeTask>();
  /** Per phone: its folders, and its files by full path. */
  const dirs = new Map<string, Set<string>>();
  const files = new Map<string, Map<string, FakeFile>>();
  const idempotent = new Map<string, string>();
  const calls: Call[] = [];
  /** Errors to answer the next matching calls with. */
  const failures: Array<{ method: string; path: RegExp; status: number; body: unknown }> = [];
  /** Uploads to store cut short (a transfer that broke off but still answered 204). */
  let truncateUploads = 0;
  let taskSeq = 0;

  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number, detail: string, title = "Error") => json(status, { title, status, detail, errors: [] });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const form = init?.body instanceof FormData ? init.body : null;
    const body = init?.body && !form ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const part = form?.get("file");
    const upload = part && typeof part === "object" ? { name: part.name, size: part.size, type: part.type, bytes: Buffer.from(await part.arrayBuffer()) } : null;
    calls.push({ method, path, query: url.searchParams, body, headers, ...(upload ? { upload: { name: upload.name, size: upload.size, type: upload.type } } : {}) });

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
    if ((match = path.match(/^\/devices\/([^/]+)\/stop$/)) && method === "POST") {
      // Parks the phone: apps and logins stay, nothing is billed until it is resumed.
      const device = devices.get(match[1]);
      if (!device) return problem(404, "device not found", "Not Found");
      device.state = "stopped";
      return new Response(null, { status: 204 });
    }
    if ((match = path.match(/^\/devices\/([^/]+)\/files$/))) {
      // Android shared storage: `path` is a folder for uploads and listings, a file for deletes.
      const device = devices.get(match[1]);
      if (!device) return problem(404, "device not found", "Not Found");
      const target = url.searchParams.get("path");
      if (!target) return problem(422, "path is required", "Unprocessable Entity");
      if (device.state !== "ready") return problem(409, "the device is not running", "Conflict");
      const known = dirs.get(device.id) ?? new Set(DEFAULT_DIRS);
      dirs.set(device.id, known);
      const stored = files.get(device.id) ?? new Map<string, FakeFile>();
      files.set(device.id, stored);
      const notFound = () => problem(404, "DEVICE_PATH_NOT_FOUND: no such file or directory", "Not Found");
      const at = cleanPath(target);
      if (method === "POST") {
        if (!upload) return problem(422, "file is required", "Unprocessable Entity");
        if (!known.has(at)) return notFound();
        const bytes = truncateUploads-- > 0 ? upload.bytes.subarray(0, Math.floor(upload.size / 2)) : upload.bytes;
        stored.set(`${at === "/" ? "" : at}/${upload.name}`, { ...upload, bytes, size: bytes.length, modifiedAt: now() });
        return new Response(null, { status: 204 });
      }
      if (method === "GET") {
        if (!known.has(at)) return notFound();
        const entries = [...stored.entries()].filter(([full]) => parentOf(full) === at).map(([, file]) => fileInfo(file));
        return json(200, { path: at, total: entries.length, files: entries });
      }
      if (method === "DELETE") return stored.delete(at) ? new Response(null, { status: 204 }) : notFound();
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
      return json(200, { status: task.status, succeeded: task.succeeded, message: task.message, output: task.output ?? null, steps: task.steps, recordingId: task.recordingId, execution: task.execution ?? null });
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

  /** `FileInfo`, as `GET /devices/{id}/files` lists it. */
  function fileInfo(file: FakeFile) {
    const rw = { read: true, write: true, execute: false };
    return {
      name: file.name,
      owner: "media_rw",
      group: "media_rw",
      size: file.size,
      type: "file",
      permissions: { owner: rw, group: rw, others: { read: true, write: false, execute: false }, special: { setUid: false, setGid: false, sticky: false } },
      hardLinks: 1,
      modifiedAt: file.modifiedAt,
      extendedAttributes: false,
    };
  }

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
    /** The next upload answers 204 but only half the file reaches the phone. */
    truncateNextUpload() {
      truncateUploads = 1;
    },
    /** A file on a phone, by its full path ("/DCIM/Camera/clip.mp4"). */
    fileAt: (deviceId: string, path: string) => files.get(deviceId)?.get(path),
    /** Puts a file on a phone, as if someone had saved it there. */
    putFile(deviceId: string, path: string, bytes = Buffer.from("x")) {
      const stored = files.get(deviceId) ?? new Map<string, FakeFile>();
      files.set(deviceId, stored);
      stored.set(path, { name: path.split("/").pop()!, size: bytes.length, type: "application/octet-stream", bytes, modifiedAt: now() });
    },
    /** Removes a folder from a phone's shared storage (a phone whose camera never ran has no DCIM/Camera). */
    removeDir(deviceId: string, dir: string) {
      const known = dirs.get(deviceId) ?? new Set(DEFAULT_DIRS);
      known.delete(dir);
      dirs.set(deviceId, known);
    },
  };
}

/** Empties every table the tests touch and adds one brand. */
export function resetDb(brands: Array<{ id: string; name: string }> = [{ id: "brand_acme", name: "Acme Skin" }]) {
  const conn = db();
  for (const table of ["phone_posts", "phone_parks", "phone_sessions", "phone_accounts", "phone_links"]) conn.exec(`drop table if exists ${table}`);
  resetSchemaFlag();
  conn.exec("delete from events; delete from brands;");
  for (const brand of brands) {
    conn
      .prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
      .run(brand.id, brand.name, `${brand.id}.com`, `https://${brand.id}.com`, now(), now());
  }
}

export const events = () => db().prepare("select level, message from events order by id").all() as Array<{ level: string; message: string }>;
