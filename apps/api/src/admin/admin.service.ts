import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AssignRoleDto, AuditLogQueryDto } from "./dto/admin.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUsers() {
    return this.prisma.user.findMany({
      include: { roles: true },
      orderBy: { createdAt: "desc" },
    });
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
    await this.audit.record({ actorId, action: "admin.role.assigned", resourceType: "UserRoleAssignment", resourceId: assignment.id, metadata: { userId, role: dto.role } });
    return assignment;
  }

  async revokeRole(assignmentId: string, actorId: string) {
    const assignment = await this.prisma.userRoleAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) throw new NotFoundException("Role assignment not found.");
    await this.prisma.userRoleAssignment.delete({ where: { id: assignmentId } });
    await this.audit.record({ actorId, action: "admin.role.revoked", resourceType: "UserRoleAssignment", resourceId: assignmentId, metadata: { userId: assignment.userId, role: assignment.role } });
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
