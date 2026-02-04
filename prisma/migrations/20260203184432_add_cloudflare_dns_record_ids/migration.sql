/*
  Warnings:

  - You are about to drop the `TenantEmailConfig` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "TenantEmailConfig";

-- CreateTable
CREATE TABLE "tenant_email_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "domain" TEXT,
    "domainVerified" BOOLEAN NOT NULL DEFAULT false,
    "resendDomainId" TEXT,
    "cloudflareDnsRecordIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_email_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_email_configs_tenantId_key" ON "tenant_email_configs"("tenantId");
