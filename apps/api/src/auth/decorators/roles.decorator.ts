import { SetMetadata } from "@nestjs/common";
import type { RoleName } from "../../generated/prisma";

export const ROLES_KEY = "roles";
/** Route is allowed if the caller holds ANY of the listed roles (RolesGuard). */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
