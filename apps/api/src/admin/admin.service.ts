import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../auth/token.service";
import { PasswordService } from "../auth/password.service";
import { RoleName, UserStatus, type Prisma } from "../generated/prisma";
import type { AssignRoleDto, AuditLogQueryDto, CreateUserDto, SetUserStatusDto } from "./dto/admin.dto";

// Credential material (passwordHash, TOTP secrets, passkeys, refresh tokens) never leaves the API.
const USER_SUMMARY = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  mfaEnrolled: true,
  mfaSetupRequired: true,
  createdAt: true,
  roles: { select: { id: true, role: true, organizationId: true, categoryId: true, createdAt: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly password: PasswordService,
  ) {}

  async listUsers() {
    return this.prisma.user.findMany({ select: USER_SUMMARY, orderBy: { createdAt: "desc" } });
  }

  /** The account signs in with the password the admin chose; an admin role also obliges it to enroll TOTP first. */
  async createUser(dto: CreateUserDto, actorId: string) {
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) throw new ConflictException("An account with this email already exists.");
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        displayName: dto.displayName,
        status: UserStatus.ACTIVE,
        passwordHash: await this.password.hash(dto.password),
        mfaSetupRequired: dto.role !== RoleName.END_USER,
        roles: { create: { role: dto.role } },
      },
      select: USER_SUMMARY,
    });
    await this.audit.record({ actorId, action: "admin.user.created", resourceType: "User", resourceId: user.id, metadata: { role: dto.role } });
    return user;
  }

  private async hasSecondFactor(userId: string): Promise<boolean> {
    const [passkeys, totp] = await Promise.all([
      this.prisma.webAuthnCredential.count({ where: { userId } }),
      this.prisma.totpCredential.findUnique({ where: { userId }, select: { verifiedAt: true } }),
    ]);
    return passkeys > 0 || !!totp?.verifiedAt;
  }

  async assignRole(userId: string, dto: AssignRoleDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    const assignment = await this.prisma.userRoleAssignment.create({
      data: {
        userId,
        role: dto.role,
        organizationId: dto.organizationId ?? null,
        categoryId: dto.categoryId ?? null,
      },
    });
    // An admin role never rides on a password-only session: without a second factor the account must enroll one first.
    if (dto.role !== RoleName.END_USER && !(await this.hasSecondFactor(userId))) {
      await this.prisma.user.update({ where: { id: userId }, data: { mfaSetupRequired: true } });
    }
    await this.audit.record({ actorId, action: "admin.role.assigned", resourceType: "UserRoleAssignment", resourceId: assignment.id, metadata: { userId, role: dto.role } });
    return assignment;
  }

  async revokeRole(assignmentId: string, actorId: string) {
    const assignment = await this.prisma.userRoleAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) throw new NotFoundException("Role assignment not found.");
    await this.prisma.userRoleAssignment.delete({ where: { id: assignmentId } });
    const adminRolesLeft = await this.prisma.userRoleAssignment.count({ where: { userId: assignment.userId, role: { not: RoleName.END_USER } } });
    if (adminRolesLeft === 0) {
      await this.prisma.user.update({ where: { id: assignment.userId }, data: { mfaSetupRequired: false, mfaSetupDeadline: null } });
    }
    await this.audit.record({ actorId, action: "admin.role.revoked", resourceType: "UserRoleAssignment", resourceId: assignmentId, metadata: { userId: assignment.userId, role: assignment.role } });
  }

  async setUserStatus(userId: string, dto: SetUserStatusDto, actorId: string) {
    if (userId === actorId) throw new BadRequestException("You cannot change the status of your own account.");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { status: dto.status }, select: USER_SUMMARY });
    if (dto.status === UserStatus.SUSPENDED) await this.tokens.revokeAllSessionsForUser(userId);
    await this.audit.record({ actorId, action: "admin.user.status_changed", resourceType: "User", resourceId: userId, metadata: { from: user.status, to: dto.status } });
    return updated;
  }

  async auditLog(query: AuditLogQueryDto) {
    const entries = await this.prisma.auditLogEntry.findMany({
      where: {
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return {
      entries,
      nextCursor: entries.length === query.limit ? entries[entries.length - 1]?.id : null,
    };
  }

  async verifyAuditChain() {
    return this.audit.verifyChain();
  }
}
