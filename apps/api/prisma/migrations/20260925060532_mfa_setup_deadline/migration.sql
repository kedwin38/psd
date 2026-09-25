-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfaSetupDeadline" TIMESTAMP(3),
ADD COLUMN     "mfaSetupRequired" BOOLEAN NOT NULL DEFAULT false;
