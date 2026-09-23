import type { RoleName } from "../generated/prisma";

export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: RoleName[];
  organizationId: string | null;
  /** Present when the caller supplied a valid, fresh step-up token on this request. */
  steppedUp: boolean;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  roles: RoleName[];
  organizationId: string | null;
}

export interface StepUpTokenClaims {
  sub: string;
  stepUp: true;
}
