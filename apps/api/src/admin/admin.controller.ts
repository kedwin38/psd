import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { AdminService } from "./admin.service";
import {
  AssignRoleSchema,
  AuditLogQuerySchema,
  CreateUserSchema,
  SetUserStatusSchema,
  type AssignRoleDto,
  type AuditLogQueryDto,
  type CreateUserDto,
  type SetUserStatusDto,
} from "./dto/admin.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { StepUp } from "../auth/decorators/step-up.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RoleName } from "../generated/prisma";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Roles(RoleName.SUPER_ADMIN)
  @Get("users")
  listUsers() {
    return this.admin.listUsers();
  }

  @Roles(RoleName.SUPER_ADMIN)
  @StepUp()
  @Post("users")
  createUser(@Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.createUser(body, user.id);
  }

  @Roles(RoleName.SUPER_ADMIN)
  @StepUp()
  @Post("users/:id/roles")
  assignRole(@Param("id") id: string, @Body(new ZodValidationPipe(AssignRoleSchema)) body: AssignRoleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.assignRole(id, body, user.id);
  }

  @Roles(RoleName.SUPER_ADMIN)
  @StepUp()
  @Patch("users/:id/status")
  setUserStatus(@Param("id") id: string, @Body(new ZodValidationPipe(SetUserStatusSchema)) body: SetUserStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.setUserStatus(id, body, user.id);
  }

  @Roles(RoleName.SUPER_ADMIN)
  @StepUp()
  @Delete("roles/:assignmentId")
  async revokeRole(@Param("assignmentId") assignmentId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.revokeRole(assignmentId, user.id);
    return { ok: true };
  }

  @Roles(RoleName.SUPER_ADMIN, RoleName.AUDITOR)
  @Get("audit-log")
  auditLog(@Query(new ZodValidationPipe(AuditLogQuerySchema)) query: AuditLogQueryDto) {
    return this.admin.auditLog(query);
  }

  @Roles(RoleName.SUPER_ADMIN, RoleName.AUDITOR)
  @Get("audit-log/verify")
  verifyAuditChain() {
    return this.admin.verifyAuditChain();
  }
}
