import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { RoleName } from "../../generated/prisma";
import type { AuthenticatedUser } from "../auth.types";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user || !required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException("You do not have permission to perform this action.");
    }
    return true;
  }
}
