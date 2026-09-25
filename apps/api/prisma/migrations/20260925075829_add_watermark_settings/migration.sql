-- AlterEnum
ALTER TYPE "AssetOwnerType" ADD VALUE 'WATERMARK';

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "watermarkAssetId" TEXT,
    "watermarkOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_watermarkAssetId_key" ON "app_settings"("watermarkAssetId");

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_watermarkAssetId_fkey" FOREIGN KEY ("watermarkAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
