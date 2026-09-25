const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";

/** Share of an access token's lifetime after which it's renewed ahead of expiry. */
const PROACTIVE_REFRESH_AT = 0.8;

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onMfaSetupRequired: (() => void) | null = null;
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
/** Called when the API refuses a request until the account enrolls TOTP (e.g. an admin role was just granted). */
export function setMfaSetupRequiredHandler(handler: (() => void) | null): void {
  onMfaSetupRequired = handler;
}

const MFA_SETUP_REQUIRED = "MFA_SETUP_REQUIRED";

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public errors?: string[],
    public code?: string,
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
  /** Reports the share (0–1) of the request body sent so far. */
  onUploadProgress?: (fraction: number) => void;
}

/** fetch() can't report upload progress, so bodies that need it go through XHR, answered as a regular Response. */
function xhrRequest(
  url: string,
  { method, headers, body }: { method: string; headers: Record<string, string>; body?: FormData | string },
  onUploadProgress: (fraction: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUploadProgress(e.loaded / e.total);
    xhr.onload = () => {
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      resolve(new Response(xhr.status === 204 ? null : xhr.responseText, { status: xhr.status, statusText: xhr.statusText, headers }));
    };
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.send(body);
  });
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (options.stepUpToken) headers["x-step-up-token"] = options.stepUpToken;

  let body: FormData | string | undefined;
  if (options.body !== undefined) {
    if (options.isFormData) {
      body = options.body as FormData;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }

  const url = `${API_BASE}${path}`;
  const method = options.method ?? "GET";
  if (options.onUploadProgress) return xhrRequest(url, { method, headers, body }, options.onUploadProgress);
  return fetch(url, { method, headers, body, credentials: "include", signal: options.signal });
}

async function refresh(): Promise<string | null> {
  const res = await fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "include" });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string };
  setAccessToken(data.accessToken);
  return accessToken;
}

/** Tabs take turns, so each sends the refresh cookie the previous one left behind. */
async function refreshInTurn(): Promise<string | null> {
  return "locks" in navigator ? await navigator.locks.request("session-refresh", refresh) : refresh();
}

/**
 * Mints a fresh access token from the refresh cookie; used at boot, on 401 and ahead of expiry. The refresh token
 * rotates on use and the API treats a second use of the old one as a replay that revokes the whole session, so
 * concurrent callers share one request.
 */
export function tryRefresh(): Promise<string | null> {
  refreshing ??= refreshInTurn().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const sentWith = accessToken;
  let res = await rawRequest(path, options);

  // Only a bearer challenge means the access token itself was refused; any other 401 is the action's own answer
  // (a wrong code, an unknown credential) and neither a refresh nor a sign-out would change it.
  if (res.status === 401 && res.headers.has("WWW-Authenticate") && !options.skipAuthRetry && path !== "/auth/refresh") {
    // Someone else already renewed the token while this request was out: just retry with it.
    const refreshed = accessToken !== sentWith ? accessToken : await tryRefresh();
    if (refreshed) {
      res = await rawRequest(path, options);
    } else {
      onUnauthorized?.();
    }
  }

  if (!res.ok) {
    let problem: { title?: string; detail?: string; errors?: string[]; code?: string } = {};
    try {
      problem = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 403 && problem.code === MFA_SETUP_REQUIRED) onMfaSetupRequired?.();
    throw new ApiError(res.status, problem.title ?? res.statusText, problem.detail, problem.errors, problem.code);
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
  patch: <T>(path: string, body?: unknown, stepUpToken?: string) => request<T>(path, { method: "PATCH", body, stepUpToken }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string, stepUpToken?: string) => request<T>(path, { method: "DELETE", stepUpToken }),
  upload: <T>(path: string, form: FormData, stepUpToken?: string, onUploadProgress?: (fraction: number) => void) =>
    request<T>(path, { method: "POST", body: form, isFormData: true, stepUpToken, onUploadProgress }),
  blob: (path: string, signal?: AbortSignal) => send(path, { signal }).then((res) => res.blob()),
};
