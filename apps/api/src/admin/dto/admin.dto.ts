import { z } from "zod";

export const AssignRoleSchema = z.object({
  role: z.enum(["SUPER_ADMIN", "CONTENT_ADMIN", "ORG_ADMIN", "AUDITOR", "END_USER"]),
  organizationId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
});
export type AssignRoleDto = z.infer<typeof AssignRoleSchema>;

export const SetUserStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});
export type SetUserStatusDto = z.infer<typeof SetUserStatusSchema>;

export const AuditLogQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
});
export type AuditLogQueryDto = z.infer<typeof AuditLogQuerySchema>;
