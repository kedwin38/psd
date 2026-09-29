-- CreateEnum
CREATE TYPE "IdPhotoStandard" AS ENUM ('US_PASSPORT', 'ICAO');

-- CreateEnum
CREATE TYPE "IdPhotoStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETE', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssetOwnerType" ADD VALUE 'ID_PHOTO_SOURCE';
ALTER TYPE "AssetOwnerType" ADD VALUE 'ID_PHOTO_OUTPUT';

-- CreateTable
CREATE TABLE "id_photo_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "standard" "IdPhotoStandard" NOT NULL,
    "status" "IdPhotoStatus" NOT NULL DEFAULT 'QUEUED',
    "sourceAssetId" TEXT NOT NULL,
    "outputAssetId" TEXT,
    "report" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "id_photo_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "id_photo_jobs_sourceAssetId_key" ON "id_photo_jobs"("sourceAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "id_photo_jobs_outputAssetId_key" ON "id_photo_jobs"("outputAssetId");

-- CreateIndex
CREATE INDEX "id_photo_jobs_userId_createdAt_idx" ON "id_photo_jobs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "id_photo_jobs" ADD CONSTRAINT "id_photo_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_photo_jobs" ADD CONSTRAINT "id_photo_jobs_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_photo_jobs" ADD CONSTRAINT "id_photo_jobs_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
