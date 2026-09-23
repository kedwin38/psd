import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { STEP_UP_KEY } from "../decorators/step-up.decorator";
import type { AuthenticatedUser } from "../auth.types";

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user?.steppedUp) {
      throw new ForbiddenException("This action requires a fresh passkey re-authentication (step-up).");
    }
    return true;
  }
}
