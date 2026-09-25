export type RoleName = "SUPER_ADMIN" | "CONTENT_ADMIN" | "ORG_ADMIN" | "AUDITOR" | "END_USER";

export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: RoleName[];
  organizationId: string | null;
  steppedUp: boolean;
  /** Nothing but TOTP enrollment works for this account until it's done. */
  mfaSetupRequired: boolean;
  mfaSetupDeadline: string | null;
}

export type UserStatus = "ACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION";

export interface RoleAssignment {
  id: string;
  role: RoleName;
  organizationId: string | null;
  categoryId: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  mfaEnrolled: boolean;
  mfaSetupRequired: boolean;
  createdAt: string;
  roles: RoleAssignment[];
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  visibility: "PUBLIC" | "ORG_RESTRICTED" | "PLAN_TIER";
}

export interface TemplateVersionSummary {
  id: string;
  versionNo: number;
  nativeDpi: number | null;
}

export interface Template {
  id: string;
  name: string;
  categoryId: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  currentVersionId: string | null;
  currentVersion?: TemplateVersionSummary | null;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  versionNo: number;
  ingestStatus: "PENDING" | "PARSING" | "READY" | "FAILED";
  ingestError: string | null;
  ingestWarnings: { path: string; message: string }[] | null;
  nativeDpi: number | null;
  publishedAt: string | null;
}

export type FieldType = "TEXT" | "IMAGE" | "VISIBILITY" | "SMART_OBJECT";

export interface TemplateField {
  id: string;
  templateVersionId: string;
  nodeId: string;
  layerPath: string;
  fieldType: FieldType;
  label: string;
  order: number;
  constraints: Record<string, unknown>;
}

export interface Project {
  id: string;
  templateId: string;
  templateVersionId: string;
  name: string;
  status: "IN_PROGRESS" | "EXPORTED";
  fieldValues?: { templateFieldId: string; value: unknown }[];
}

export interface WatermarkConfig {
  url: string;
  opacity: number;
}

export interface ExportJob {
  id: string;
  status: "QUEUED" | "RENDERING" | "COMPLETE" | "FAILED";
  outputFormat: "PNG" | "JPEG" | "PDF" | "TIFF";
  outputDpi: number;
  error: string | null;
  downloadUrl?: string;
}
