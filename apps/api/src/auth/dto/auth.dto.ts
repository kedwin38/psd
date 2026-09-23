import { z } from "zod";

export const RegisterSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

export const EmailOnlySchema = z.object({
  email: z.string().email().max(320),
});
export type EmailOnlyDto = z.infer<typeof EmailOnlySchema>;

// WebAuthn response JSON bodies are broad/nested and verified structurally by
// @simplewebauthn/server itself — we only assert they're plain objects here.
export const WebAuthnResponseSchema = z.object({}).passthrough();

export const WebAuthnRegisterVerifySchema = z.object({
  email: z.string().email(),
  response: WebAuthnResponseSchema,
  deviceLabel: z.string().max(200).optional(),
});
export type WebAuthnRegisterVerifyDto = z.infer<typeof WebAuthnRegisterVerifySchema>;

export const WebAuthnLoginVerifySchema = z.object({
  email: z.string().email(),
  response: WebAuthnResponseSchema,
});
export type WebAuthnLoginVerifyDto = z.infer<typeof WebAuthnLoginVerifySchema>;

export const SetPasswordSchema = z.object({
  password: z.string().min(12).max(200),
});
export type SetPasswordDto = z.infer<typeof SetPasswordSchema>;

export const PasswordLoginStartSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type PasswordLoginStartDto = z.infer<typeof PasswordLoginStartSchema>;

export const PasswordLoginTotpSchema = z.object({
  pendingToken: z.string().min(1),
  code: z.string().min(6).max(10),
});
export type PasswordLoginTotpDto = z.infer<typeof PasswordLoginTotpSchema>;

export const TotpEnrollVerifySchema = z.object({
  code: z.string().min(6).max(10),
});
export type TotpEnrollVerifyDto = z.infer<typeof TotpEnrollVerifySchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type RefreshDto = z.infer<typeof RefreshSchema>;
