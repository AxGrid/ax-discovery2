export type Status = "up" | "down" | "starting" | "draining" | "";
export type Visibility = "public" | "private" | "";
export type CheckMode = "heartbeat" | "http" | "tcp" | "none" | "";

export interface Service {
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  visibility?: Visibility;
  ownerId?: string;
  grants?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Interface {
  name: string;
  protocol: string;
  port: number;
  path?: string;
  tls?: boolean;
  healthUrl?: string;
  metadata?: Record<string, string>;
}

export interface InstanceCheck {
  timestamp: string;
  ok: boolean;
  mode?: CheckMode;
  results?: ProbeResult[];
}

export interface Instance {
  id: string;
  service: string;
  address: string;
  interfaces: Interface[];
  weight: number;
  status: Status;
  metadata?: Record<string, string>;
  ttlSeconds: number;
  managed?: boolean;
  checkMode?: CheckMode;
  checkIntervalSec?: number;
  lastCheck?: InstanceCheck;
  lastHeartbeat: string;
  registeredAt: string;
  updatedAt: string;
}

// Subset of Instance the UI sends on save — never includes managed timestamps,
// since the server treats empty time strings as malformed input.
export type InstanceInput = {
  id?: string;
  address: string;
  interfaces: Interface[];
  weight: number;
  status: Status;
  ttlSeconds: number;
  checkMode?: CheckMode;
  checkIntervalSec?: number;
  metadata?: Record<string, string>;
};

export type ServiceInput = {
  description?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  visibility?: Visibility;
  ownerId?: string;
  grants?: string[];
};

export interface User {
  id: string;
  username: string;
  displayName?: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Me {
  authenticated: boolean;
  userId?: string;
  username?: string;
  displayName?: string;
  isAdmin?: boolean;
  system?: boolean;
  role: string;
}

export interface ProbeResult {
  interface: string;
  url?: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  latencyMs: number;
}

export interface CheckResponse {
  ok: boolean;
  status: Status;
  mode: CheckMode;
  results: ProbeResult[];
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorId?: string;
  actorName?: string;
  action: string;
  target?: string;
  targetType?: string;
  details?: Record<string, any>;
}

export interface DiscoveryEvent {
  type: string;
  service?: string;
  instance?: string;
  payload?: any;
  timestamp: string;
  originId?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface TagCount {
  tag: string;
  count: number;
}

export const api = {
  // auth
  me: () => req<Me>("GET", "/v1/auth/me"),
  login: (username: string, password: string) =>
    req<{ user: User }>("POST", "/v1/auth/login", { username, password }),
  logout: () => req<void>("POST", "/v1/auth/logout"),

  // services
  listServices: (tag?: string) =>
    req<Service[]>("GET", `/v1/services${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
  getService: (name: string) => req<Service>("GET", `/v1/services/${encodeURIComponent(name)}`),
  putService: (name: string, body: ServiceInput) =>
    req<Service>("PUT", `/v1/services/${encodeURIComponent(name)}`, body),
  deleteService: (name: string) => req<void>("DELETE", `/v1/services/${encodeURIComponent(name)}`),
  renameService: (oldName: string, newName: string) =>
    req<Service>("POST", `/v1/services/${encodeURIComponent(oldName)}/rename`, { newName }),
  listTags: () => req<TagCount[]>("GET", "/v1/tags"),

  // grants
  addGrant: (service: string, userId: string) =>
    req<Service>("POST", `/v1/services/${encodeURIComponent(service)}/grants`, { userId }),
  removeGrant: (service: string, userId: string) =>
    req<void>("DELETE", `/v1/services/${encodeURIComponent(service)}/grants/${encodeURIComponent(userId)}`),

  // instances
  listInstances: (service: string) =>
    req<Instance[]>("GET", `/v1/services/${encodeURIComponent(service)}/instances`),
  putInstance: (service: string, id: string, body: InstanceInput) =>
    req<Instance>("PUT", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}`, body),
  deleteInstance: (service: string, id: string) =>
    req<void>("DELETE", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}`),
  checkInstance: (service: string, id: string) =>
    req<CheckResponse>("POST", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}/check`),

  // users
  listUsers: () => req<User[]>("GET", "/v1/users"),
  createUser: (u: { username: string; displayName?: string; password: string; isAdmin: boolean }) =>
    req<User>("POST", "/v1/users", u),
  updateUser: (id: string, u: Partial<{ username: string; displayName: string; password: string; isAdmin: boolean }>) =>
    req<User>("PUT", `/v1/users/${encodeURIComponent(id)}`, u),
  deleteUser: (id: string) => req<void>("DELETE", `/v1/users/${encodeURIComponent(id)}`),

  // audit
  listAudit: (limit = 200, service?: string) =>
    req<AuditEntry[]>("GET", `/v1/audit?limit=${limit}${service ? `&service=${encodeURIComponent(service)}` : ""}`),

  // cluster
  members: () => req<string[]>("GET", "/v1/cluster/members"),
  joinCluster: (seeds: string[]) =>
    req<{ contacted: number; members: string[] }>("POST", "/v1/cluster/join", { seeds }),
};

export function watch(onEvent: (ev: DiscoveryEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/v1/watch`;
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { backoff = 500; };
    ws.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => { ws?.close(); };
  };
  connect();

  return () => { closed = true; ws?.close(); };
}
