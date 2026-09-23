import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api, request, setAccessToken } from "./api";
import type { AuthenticatedUser } from "./types";

export async function register(email: string, displayName: string): Promise<void> {
  await api.post("/auth/register", { email, displayName });
}

/** Registers a brand-new passkey for the account identified by email (spec §12). */
export async function registerPasskey(email: string, deviceLabel?: string): Promise<void> {
  const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>("/auth/webauthn/register/options", { email });
  const response = await startRegistration({ optionsJSON });
  await api.post("/auth/webauthn/register/verify", { email, response, deviceLabel });
}

export async function loginWithPasskey(email: string): Promise<AuthenticatedUser> {
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>("/auth/webauthn/login/options", { email });
  const response = await startAuthentication({ optionsJSON });
  const result = await request<{ accessToken: string }>("/auth/webauthn/login/verify", { method: "POST", body: { email, response } });
  setAccessToken(result.accessToken);
  return api.get<AuthenticatedUser>("/auth/me");
}

export async function passwordLoginStart(email: string, password: string): Promise<{ pendingToken: string }> {
  return api.post("/auth/login/password", { email, password });
}

export async function passwordLoginVerifyTotp(pendingToken: string, code: string): Promise<AuthenticatedUser> {
  const result = await request<{ accessToken: string }>("/auth/login/totp", { method: "POST", body: { pendingToken, code } });
  setAccessToken(result.accessToken);
  return api.get<AuthenticatedUser>("/auth/me");
}

export async function enrollTotpOptions(): Promise<{ otpauthUrl: string; secretBase32: string }> {
  return api.post("/auth/totp/enroll/options");
}

export async function enrollTotpVerify(code: string): Promise<{ recoveryCodes: string[] }> {
  return api.post("/auth/totp/enroll/verify", { code });
}

export async function setPassword(password: string): Promise<void> {
  await api.post("/auth/password", { password });
}

/** Performs a fresh WebAuthn re-assertion and returns a short-lived step-up token (spec §12). */
export async function stepUp(): Promise<string> {
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>("/auth/step-up/options");
  const response = await startAuthentication({ optionsJSON });
  const result = await api.post<{ stepUpToken: string }>("/auth/step-up/verify", { response });
  return result.stepUpToken;
}

export async function logout(): Promise<void> {
  await api.post("/auth/logout");
  setAccessToken(null);
}
