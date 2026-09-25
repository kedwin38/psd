-- AlterEnum
ALTER TYPE "AssetOwnerType" ADD VALUE 'TEMPLATE_THUMBNAIL';

-- AlterTable
ALTER TABLE "template_versions" ADD COLUMN     "thumbnailAssetId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_thumbnailAssetId_key" ON "template_versions"("thumbnailAssetId");

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

