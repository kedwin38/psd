-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('SUPER_ADMIN', 'CONTENT_ADMIN', 'ORG_ADMIN', 'AUDITOR', 'END_USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TemplateVisibility" AS ENUM ('PUBLIC', 'ORG_RESTRICTED', 'PLAN_TIER');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('PENDING', 'PARSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'IMAGE', 'VISIBILITY', 'SMART_OBJECT');

-- CreateEnum
CREATE TYPE "AssetOwnerType" AS ENUM ('TEMPLATE_SOURCE', 'TEMPLATE_LAYER', 'USER_UPLOAD', 'EXPORT_OUTPUT');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('IN_PROGRESS', 'EXPORTED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RENDERING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('PNG', 'JPEG', 'PDF', 'TIFF');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "planTier" TEXT NOT NULL DEFAULT 'free',
    "seatLimit" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "organizationId" TEXT,
    "passwordHash" TEXT,
    "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role_assignments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,
    "organizationId" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "totp_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "recoveryCodesHash" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "visibility" "TemplateVisibility" NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "visibilityScope" "TemplateVisibility" NOT NULL DEFAULT 'PUBLIC',
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "psdAssetId" TEXT NOT NULL,
    "sceneGraph" JSONB,
    "nativeDpi" INTEGER,
    "colorProfile" TEXT,
    "ingestStatus" "IngestStatus" NOT NULL DEFAULT 'PENDING',
    "ingestWarnings" JSONB,
    "ingestError" TEXT,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_fields" (
    "id" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "layerPath" TEXT NOT NULL,
    "fieldType" "FieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "constraints" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "ownerType" "AssetOwnerType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "templateId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_field_values" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateFieldId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "outputFormat" "ExportFormat" NOT NULL,
    "outputDpi" INTEGER NOT NULL,
    "outputAssetId" TEXT,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "user_role_assignments_userId_idx" ON "user_role_assignments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_assignments_userId_role_organizationId_categoryId_key" ON "user_role_assignments"("userId", "role", "organizationId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credentialId_key" ON "webauthn_credentials"("credentialId");

-- CreateIndex
CREATE INDEX "webauthn_credentials_userId_idx" ON "webauthn_credentials"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "totp_credentials_userId_key" ON "totp_credentials"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "templates_currentVersionId_key" ON "templates"("currentVersionId");

-- CreateIndex
CREATE INDEX "templates_categoryId_idx" ON "templates"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_templateId_versionNo_key" ON "template_versions"("templateId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "template_fields_templateVersionId_nodeId_key" ON "template_fields"("templateVersionId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storageKey_key" ON "assets"("storageKey");

-- CreateIndex
CREATE INDEX "projects_userId_idx" ON "projects"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_field_values_projectId_templateFieldId_key" ON "project_field_values"("projectId", "templateFieldId");

-- CreateIndex
CREATE UNIQUE INDEX "export_jobs_idempotencyKey_key" ON "export_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "export_jobs_projectId_idx" ON "export_jobs"("projectId");

-- CreateIndex
CREATE INDEX "export_jobs_requestedById_idx" ON "export_jobs"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_entries_hash_key" ON "audit_log_entries"("hash");

-- CreateIndex
CREATE INDEX "audit_log_entries_createdAt_idx" ON "audit_log_entries"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entries_actorId_idx" ON "audit_log_entries"("actorId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "template_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_categories" ADD CONSTRAINT "template_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "template_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "template_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_psdAssetId_fkey" FOREIGN KEY ("psdAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_field_values" ADD CONSTRAINT "project_field_values_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_field_values" ADD CONSTRAINT "project_field_values_templateFieldId_fkey" FOREIGN KEY ("templateFieldId") REFERENCES "template_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
