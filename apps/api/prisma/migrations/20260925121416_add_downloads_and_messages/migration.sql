-- CreateEnum
CREATE TYPE "MessageAuthorRole" AS ENUM ('END_USER', 'ADMIN');

-- AlterEnum
ALTER TYPE "AssetOwnerType" ADD VALUE 'MESSAGE_IMAGE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "downloadsAllowed" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "downloadsUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "threadUserId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "MessageAuthorRole" NOT NULL,
    "body" TEXT,
    "imageAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_imageAssetId_key" ON "messages"("imageAssetId");

-- CreateIndex
CREATE INDEX "messages_threadUserId_createdAt_idx" ON "messages"("threadUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_threadUserId_fkey" FOREIGN KEY ("threadUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
