-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "assets_projectId_idx" ON "assets"("projectId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
