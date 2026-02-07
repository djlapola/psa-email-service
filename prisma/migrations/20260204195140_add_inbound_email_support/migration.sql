-- AlterTable
ALTER TABLE "tenant_email_configs" ADD COLUMN     "receivingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receivingVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmailMessageId" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "commentId" TEXT,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessageId_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessageId_messageId_idx" ON "EmailMessageId"("messageId");

-- CreateIndex
CREATE INDEX "EmailMessageId_tenantId_ticketId_idx" ON "EmailMessageId"("tenantId", "ticketId");
