import axios from 'axios';

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

interface CloudflareDnsRecord {
  id?: string;
  type: 'A' | 'MX' | 'TXT' | 'CNAME';
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

class CloudflareService {
  private apiToken: string;
  private zoneId: string;

  constructor() {
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
    this.zoneId = process.env.CLOUDFLARE_ZONE_ID || '';

    if (!this.apiToken || !this.zoneId) {
      console.warn('Cloudflare credentials not configured');
    }
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create a DNS record in Cloudflare
   */
  async createDnsRecord(
    record: CloudflareDnsRecord
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const response = await axios.post<CloudflareResponse<{ id: string }>>(
        `${CLOUDFLARE_API_URL}/zones/${this.zoneId}/dns_records`,
        {
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 1, // 1 = automatic
          priority: record.priority,
          proxied: record.proxied || false,
        },
        { headers: this.headers }
      );

      if (response.data.success) {
        return { success: true, id: response.data.result.id };
      } else {
        return {
          success: false,
          error: response.data.errors.map((e: { message: string }) => e.message).join(', '),
        };
      }
    } catch (error: any) {
      console.error('Cloudflare DNS create error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.message || error.message,
      };
    }
  }

  /**
   * Delete a DNS record by ID
   */
  async deleteDnsRecord(recordId: string): Promise<{ success: boolean; error?: string; code?: number }> {
    try {
      const response = await axios.delete<CloudflareResponse<{ id: string }>>(
        `${CLOUDFLARE_API_URL}/zones/${this.zoneId}/dns_records/${recordId}`,
        { headers: this.headers }
      );

      if (response.data.success) {
        return { success: true };
      }
      // Non-throwing failure (HTTP 2xx, success:false) — surface the numeric error code
      // so callers can classify (e.g. already-absent) on the stable code, not message text.
      return {
        success: false,
        error: response.data.errors?.map((e: { message: string }) => e.message).join(', '),
        code: response.data.errors?.[0]?.code,
      };
    } catch (error: any) {
      console.error('Cloudflare DNS delete error:', error.response?.data || error.message);
      // Surface Cloudflare's numeric error code from the response body (e.g. 81044 =
      // "record does not exist") so callers match on the code, never the message string.
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.message || error.message,
        code: error.response?.data?.errors?.[0]?.code,
      };
    }
  }

  /**
   * List DNS records for a subdomain
   */
  async listDnsRecords(subdomain: string): Promise<CloudflareDnsRecord[]> {
    try {
      const baseDomain = process.env.BASE_DOMAIN || 'skyrack.com';
      const fullDomain = `${subdomain}.${baseDomain}`;

      const response = await axios.get<CloudflareResponse<CloudflareDnsRecord[]>>(
        `${CLOUDFLARE_API_URL}/zones/${this.zoneId}/dns_records`,
        {
          headers: this.headers,
          params: { name: fullDomain },
        }
      );

      return response.data.success ? response.data.result : [];
    } catch (error: any) {
      console.error('Cloudflare DNS list error:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Add all DNS records required for a tenant subdomain
   * Returns the IDs of created records for potential rollback
   */
  async addTenantDnsRecords(
    subdomain: string,
    dnsRecords: Array<{
      record: string;
      name: string;
      type: string;
      value: string;
      priority?: number;
    }>
  ): Promise<{ success: boolean; recordIds: string[]; errors: string[] }> {
    const baseDomain = process.env.BASE_DOMAIN || 'skyrack.com';
    const recordIds: string[] = [];
    const errors: string[] = [];

    for (const record of dnsRecords) {
      const fullName = `${record.name}.${baseDomain}`;

      const result = await this.createDnsRecord({
        type: record.type as 'MX' | 'TXT' | 'CNAME',
        name: fullName,
        content: record.value,
        priority: record.priority,
      });

      if (result.success && result.id) {
        recordIds.push(result.id);
      } else {
        errors.push(`Failed to create ${record.type} record for ${fullName}: ${result.error}`);
      }
    }

    return {
      success: errors.length === 0,
      recordIds,
      errors,
    };
  }

  /**
   * Remove all DNS records for a tenant subdomain
   */
  async removeTenantDnsRecords(
    recordIds: string[]
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const recordId of recordIds) {
      const result = await this.deleteDnsRecord(recordId);
      if (result.success) continue;
      // Deletion is idempotent: a record that is already absent is SUCCESS, not a failure.
      // Cloudflare returns error code 81044 ("Record does not exist") for this. Match on
      // the numeric code (stable API contract), NOT the English message string. Log at a
      // low level so the information is retained without implying failure, and leave it out
      // of errors[] so it counts toward the deleted total.
      if (result.code === 81044) {
        console.log(`Cloudflare DNS record ${recordId} already absent (code 81044) — treating as deleted`);
        continue;
      }
      errors.push(`Failed to delete record ${recordId}: ${result.error}`);
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }
}

export const cloudflareService = new CloudflareService();
