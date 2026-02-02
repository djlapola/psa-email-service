-- CreateTable
CREATE TABLE "TenantEmailConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "domain" TEXT,
    "domainVerified" BOOLEAN NOT NULL DEFAULT false,
    "resendDomainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantEmailConfig_tenantId_key" ON "TenantEmailConfig"("tenantId");
