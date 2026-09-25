import { SetMetadata } from "@nestjs/common";

export const MFA_SETUP_ALLOWED_KEY = "mfaSetupAllowed";
/** Route stays reachable for an account that must enroll TOTP before anything else (JwtAuthGuard). */
export const MfaSetupAllowed = () => SetMetadata(MFA_SETUP_ALLOWED_KEY, true);
