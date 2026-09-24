const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";

/** Share of an access token's lifetime after which it's renewed ahead of expiry. */
const PROACTIVE_REFRESH_AT = 0.8;

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<string | null> | null = null;

function lifetimeMs(token: string): number | null {
  try {
    const { iat, exp } = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { iat?: number; exp?: number };
    return iat && exp ? (exp - iat) * 1000 : null;
  } catch {
    return null;
  }
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  clearTimeout(refreshTimer);
  const lifetime = token && lifetimeMs(token);
  if (lifetime) refreshTimer = setTimeout(() => tryRefresh().catch(() => null), lifetime * PROACTIVE_REFRESH_AT);
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public errors?: string[],
  ) {
    super(detail ?? title);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  stepUpToken?: string;
  isFormData?: boolean;
  skipAuthRetry?: boolean;
  signal?: AbortSignal;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (options.stepUpToken) headers["x-step-up-token"] = options.stepUpToken;

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.isFormData) {
      body = options.body as FormData;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }

  return fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
    credentials: "include",
    signal: options.signal,
  });
}

async function refresh(): Promise<string | null> {
  const res = await fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "include" });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string };
  setAccessToken(data.accessToken);
  return accessToken;
}

/**
 * Mints a fresh access token from the refresh cookie; used at boot, on 401 and ahead of expiry. Concurrent callers
 * share one request: the refresh token rotates on use, and the API treats a second use of the old one as a replay and
 * revokes the whole session.
 */
export function tryRefresh(): Promise<string | null> {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const sentWith = accessToken;
  let res = await rawRequest(path, options);

  if (res.status === 401 && !options.skipAuthRetry && path !== "/auth/refresh") {
    // Someone else already renewed the token while this request was out: just retry with it.
    const refreshed = accessToken !== sentWith ? accessToken : await tryRefresh();
    if (refreshed) {
      res = await rawRequest(path, options);
    } else {
      onUnauthorized?.();
    }
  }

  if (!res.ok) {
    let problem: { title?: string; detail?: string; errors?: string[] } = {};
    try {
      problem = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, problem.title ?? res.statusText, problem.detail, problem.errors);
  }
  return res;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, stepUpToken?: string) => request<T>(path, { method: "POST", body: body ?? {}, stepUpToken }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form, isFormData: true }),
  blob: (path: string, signal?: AbortSignal) => send(path, { signal }).then((res) => res.blob()),
};
