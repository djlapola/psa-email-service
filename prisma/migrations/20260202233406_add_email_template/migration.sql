-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "subject" TEXT NOT NULL,
    "htmlBody" TEXT NOT NULL,
    "textBody" TEXT,
    "variables" JSONB NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailTemplate_tenantId_idx" ON "EmailTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "EmailTemplate_name_idx" ON "EmailTemplate"("name");

-- CreateIndex
CREATE INDEX "EmailTemplate_isSystem_idx" ON "EmailTemplate"("isSystem");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_tenantId_name_key" ON "EmailTemplate"("tenantId", "name");
