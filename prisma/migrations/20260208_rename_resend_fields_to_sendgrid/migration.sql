-- Rename resendId to sendgridMessageId in EmailLog
ALTER TABLE "EmailLog" RENAME COLUMN "resendId" TO "sendgridMessageId";

-- Rename resendDomainId to sendgridDomainId in tenant_email_configs
ALTER TABLE "tenant_email_configs" RENAME COLUMN "resendDomainId" TO "sendgridDomainId";
