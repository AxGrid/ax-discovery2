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
  version?: string;
  interfaces: Interface[];
  weight: number;
  status: Status;
  metadata?: Record<string, string>;
  ttlSeconds: number;
  managed?: boolean;
  blocked?: boolean;
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
  version?: string;
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

export interface CorpUserHit {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  accountId?: string;
}

export interface TokensResponse {
  role: "none" | "read" | "write" | "admin";
  read?: string[];
  write?: string[];
  admin?: string[];
}

export interface Me {
  authenticated: boolean;
  userId?: string;
  username?: string;
  email?: string;
  displayName?: string;
  accountId?: string;
  isAdmin?: boolean;
  system?: boolean;
  role: string;
  perms?: Record<string, string>;
  iframe?: boolean;
}

// Permission-check helper mirroring the backend's RoleFromPerms + Can.
export function canPerm(me: Me | null, key: string, level: "r" | "w" | "a"): boolean {
  if (!me?.authenticated) return false;
  if (me.isAdmin) return true;
  const p = me.perms || {};
  const has = (v?: string) => !!v && v.toLowerCase().includes(level);
  return has(p[key]) || has(p["*"]);
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

// --- live request stats (dashboard) ---

export interface StatsLookup {
  time: string;
  client?: string;
  service: string;
  kind: "discover" | "pick" | "tag";
  version?: string;
  count: number;
  instance?: string;
  address?: string;
}

export interface ServiceStat {
  service: string;
  total: number;
  byKind: Record<string, number>;
  rps: number;
  sparkline: number[];
}

export interface ClientServiceStat {
  service: string;
  count: number;
  lastInstance?: string;
}

export interface ClientStat {
  name: string;
  total: number;
  lastSeen: string;
  services: ClientServiceStat[];
}

export interface StatsSnapshot {
  services: ServiceStat[];
  clients: ClientStat[];
  feed: StatsLookup[];
  generatedAt: string;
}

// --- config store ---

export type VarType = "string" | "int" | "float" | "bool" | "json" | "bytes";

// value is the raw JSON value: a string for string/bytes(base64), number for
// int/float, boolean for bool, or any JSON for json.
export interface TypedValue {
  type: VarType;
  value: any;
}

export type ScopeKind = "global" | "service" | "version";

export interface ConfigScope {
  kind: ScopeKind;
  service?: string;
  constraint?: string;
}

export interface ConfigRevision {
  scope: ConfigScope;
  revision: number;
  vars: Record<string, TypedValue>;
  note?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigDraft {
  scope: ConfigScope;
  vars: Record<string, TypedValue>;
  baseRevision: number;
  author?: string;
  updatedAt: string;
}

export interface ConfigScopeSummary {
  scope: ConfigScope;
  revision: number;
  varCount: number;
  hasDraft: boolean;
  updatedAt: string;
}

export interface ConfigScopeResponse {
  scope: ConfigScope;
  active?: ConfigRevision;
  draft?: ConfigDraft;
  history?: ConfigRevision[];
}

export interface ResolvedConfig {
  service: string;
  version?: string;
  vars: Record<string, TypedValue>;
  provenance?: Record<string, string>;
}

export function scopeId(s: ConfigScope): string {
  if (s.kind === "global") return "global";
  if (s.kind === "service") return `service:${s.service}`;
  return `version:${s.service}:${s.constraint}`;
}

// --- client tokens ---

export interface ClientToken {
  id: string;
  token: string;
  name: string;
  role: "read" | "write" | "admin";
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
}

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

// bearerToken is set by lib/auth.tsx after CorpSDK.ready() resolves in
// iframe mode. Standalone mode leaves it null and relies on the cookie.
let bearerToken: string | null = null;
export function setBearerToken(tok: string | null) { bearerToken = tok; }
export function getBearerToken(): string | null { return bearerToken; }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
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
  login: (identifier: string, password: string) =>
    req<Me>("POST", "/v1/auth/login", { identifier, password }),
  logout: () => req<void>("POST", "/v1/auth/logout"),
  searchCorpUsers: (q: string) =>
    req<CorpUserHit[]>("GET", `/v1/corp/users/search?q=${encodeURIComponent(q)}`),
  tokens: () => req<TokensResponse>("GET", "/v1/tokens"),

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
  listAllInstances: () => req<Instance[]>("GET", "/v1/instances"),
  listInstances: (service: string) =>
    req<Instance[]>("GET", `/v1/services/${encodeURIComponent(service)}/instances`),
  putInstance: (service: string, id: string, body: InstanceInput) =>
    req<Instance>("PUT", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}`, body),
  deleteInstance: (service: string, id: string) =>
    req<void>("DELETE", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}`),
  checkInstance: (service: string, id: string) =>
    req<CheckResponse>("POST", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}/check`),
  blockInstance: (service: string, id: string, blocked: boolean) =>
    req<Instance>("POST", `/v1/services/${encodeURIComponent(service)}/instances/${encodeURIComponent(id)}/block`, { blocked }),

  // live request stats (dashboard)
  stats: () => req<StatsSnapshot>("GET", "/v1/stats"),

  // audit
  listAudit: (limit = 200, service?: string) =>
    req<AuditEntry[]>("GET", `/v1/audit?limit=${limit}${service ? `&service=${encodeURIComponent(service)}` : ""}`),

  // cluster
  members: () => req<string[]>("GET", "/v1/cluster/members"),
  joinCluster: (seeds: string[]) =>
    req<{ contacted: number; members: string[] }>("POST", "/v1/cluster/join", { seeds }),

  // config store
  configScopes: () => req<ConfigScopeSummary[]>("GET", "/v1/config/scopes"),
  configGetScope: (scope: ConfigScope, include?: string) => {
    const q = new URLSearchParams({ kind: scope.kind });
    if (scope.service) q.set("service", scope.service);
    if (scope.constraint) q.set("constraint", scope.constraint);
    if (include) q.set("include", include);
    return req<ConfigScopeResponse>("GET", `/v1/config/scope?${q.toString()}`);
  },
  configResolve: (service: string, version?: string, prefixes?: string[]) => {
    const q = new URLSearchParams();
    if (service) q.set("service", service);
    if (version) q.set("version", version);
    (prefixes ?? []).forEach(p => q.append("prefix", p));
    return req<ResolvedConfig>("GET", `/v1/config/resolve?${q.toString()}`);
  },
  configApply: (scope: ConfigScope, vars: Record<string, TypedValue>, note?: string) =>
    req<ConfigRevision>("POST", "/v1/config/apply", { scope, vars, note }),
  configSaveDraft: (scope: ConfigScope, vars: Record<string, TypedValue>) =>
    req<ConfigDraft>("POST", "/v1/config/draft", { scope, vars }),
  configDeleteDraft: (scope: ConfigScope) =>
    req<void>("DELETE", "/v1/config/draft", { scope }),
  configRollback: (scope: ConfigScope, revision: number) =>
    req<ConfigRevision>("POST", "/v1/config/rollback", { scope, revision }),
  configDeleteScope: (scope: ConfigScope) =>
    req<void>("DELETE", "/v1/config/scope", { scope }),

  // client tokens (write/admin only)
  listClientTokens: () => req<ClientToken[]>("GET", "/v1/client-tokens"),
  createClientToken: (name: string, role: string) =>
    req<ClientToken>("POST", "/v1/client-tokens", { name, role }),
  revokeClientToken: (id: string) =>
    req<void>("DELETE", `/v1/client-tokens/${encodeURIComponent(id)}`),
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
