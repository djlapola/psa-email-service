-- CreateTable
CREATE TABLE "tenant_email_domains" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sendgridDomainId" TEXT,
    "dnsRecords" JSONB,
    "lastVerifiedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_email_domains_tenantId_idx" ON "tenant_email_domains"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_email_domains_domain_idx" ON "tenant_email_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_email_domains_tenantId_domain_key" ON "tenant_email_domains"("tenantId", "domain");

-- RenameIndex
ALTER INDEX "EmailLog_resendId_idx" RENAME TO "EmailLog_sendgridMessageId_idx";
