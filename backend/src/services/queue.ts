import { query } from '../db.js';
import { processMockOutreach } from './mock_service.js';

class QueueManager {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  public start() {
    if (this.intervalId) return;
    console.log('[QUEUE] Starting outreach queue processor...');
    this.intervalId = setInterval(() => this.processNextQueueItem(), 2000);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[QUEUE] Stopped outreach queue processor.');
    }
  }

  private async processNextQueueItem() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const sql = `
        SELECT q.*, c.channel, c.status as campaign_status, l.phone, l.whatsapp_number, l.instagram_username, l.whatsapp_opt_in, l.business_name, l.contact_name
        FROM outreach_queue q
        JOIN campaigns c ON q.campaign_id = c.id
        JOIN leads l ON q.lead_id = l.id
        WHERE q.status = 'WAITING' AND c.status = 'RUNNING'
        ORDER BY q.scheduled_at ASC
        LIMIT 1
      `;
      
      const { rows } = await query(sql);
      if (rows.length === 0) {
        this.isProcessing = false;
        return;
      }

      const job = rows[0];
      console.log(`[QUEUE] Processing job ${job.id} for lead ${job.business_name} (${job.channel})`);

      await query(`UPDATE outreach_queue SET status = 'PROCESSING' WHERE id = $1`, [job.id]);

      const recipientPhone = job.whatsapp_number || job.phone;
      const suppressedCheck = await query(
        `SELECT * FROM suppression_list WHERE (phone = $1 AND phone IS NOT NULL) OR (instagram_username = $2 AND instagram_username IS NOT NULL)`,
        [recipientPhone, job.instagram_username]
      );

      if (suppressedCheck.rows.length > 0) {
        console.warn(`[QUEUE] Job ${job.id} failed: Lead is on the suppression list.`);
        await query(
          `UPDATE outreach_queue SET status = 'FAILED', error_message = 'Lead is on the suppression list' WHERE id = $1`,
          [job.id]
        );
        await query(
          `UPDATE leads SET crm_status = 'DO_NOT_CONTACT' WHERE id = $1`,
          [job.lead_id]
        );
        this.isProcessing = false;
        return;
      }

      if (job.channel === 'WHATSAPP' && !job.whatsapp_opt_in) {
        console.warn(`[QUEUE] Job ${job.id} failed: No opt-in consent for WhatsApp.`);
        await query(
          `UPDATE outreach_queue SET status = 'FAILED', error_message = 'WhatsApp outreach requires explicit opt-in' WHERE id = $1`,
          [job.id]
        );
        await query(
          `UPDATE leads SET crm_status = 'NOT_ELIGIBLE' WHERE id = $1`,
          [job.lead_id]
        );
        this.isProcessing = false;
        return;
      }

      const modeResult = await query(`SELECT value FROM integrations WHERE key = 'mode'`);
      const isLiveMode = modeResult.rows.length > 0 && modeResult.rows[0].value === 'LIVE';

      if (!isLiveMode) {
        await processMockOutreach({
          leadId: job.lead_id,
          campaignId: job.campaign_id,
          queueId: job.id,
          recipient: job.channel === 'WHATSAPP' ? recipientPhone : job.instagram_username,
          messageBody: job.message_body,
          channel: job.channel
        });
      } else {
        await this.processLiveOutreach(job);
      }

    } catch (error) {
      console.error('[QUEUE] Error processing queue item:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processLiveOutreach(job: any) {
    const recipientPhone = job.whatsapp_number || job.phone;
    try {
      const waConfigResult = await query(`SELECT value FROM integrations WHERE key = 'whatsapp_credentials'`);
      const igConfigResult = await query(`SELECT value FROM integrations WHERE key = 'instagram_credentials'`);

      if (job.channel === 'WHATSAPP') {
        if (!waConfigResult.rows.length) {
          throw new Error('WhatsApp Business API credentials not configured.');
        }

        const creds = JSON.parse(waConfigResult.rows[0].value);
        if (!creds.accessToken || !creds.phoneNumberId) {
          throw new Error('Incomplete WhatsApp Cloud API credentials.');
        }

        const response = await fetch(`https://graph.facebook.com/v20.0/${creds.phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: recipientPhone,
            type: 'template',
            template: {
              name: job.template_name || 'clinic_intro_v1',
              language: { code: 'en' },
              components: []
            }
          })
        });

        const resData = await response.json() as any;

        if (!response.ok) {
          throw new Error(resData.error?.message || 'Meta API error');
        }

        await query(
          `UPDATE outreach_queue SET status = 'SENT', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [job.id]
        );
        await query(
          `UPDATE leads SET crm_status = 'SENT', last_contacted_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [job.lead_id]
        );
        
        await query(
          `INSERT INTO conversations (id, lead_id, direction, channel, message_text, status) 
           VALUES ($1, $2, 'OUTGOING', 'WHATSAPP', $3, 'SENT')`,
          [crypto.randomUUID(), job.lead_id, job.message_body]
        );

      } else if (job.channel === 'INSTAGRAM') {
        if (!igConfigResult.rows.length) {
          throw new Error('Instagram API credentials not configured.');
        }

        const creds = JSON.parse(igConfigResult.rows[0].value);
        if (!creds.accessToken || !creds.pageId) {
          throw new Error('Incomplete Instagram Messaging credentials.');
        }

        const conversationCheck = await query(
          `SELECT * FROM conversations WHERE lead_id = $1 AND direction = 'INCOMING' AND channel = 'INSTAGRAM'`,
          [job.lead_id]
        );

        if (conversationCheck.rows.length === 0) {
          console.warn(`[LIVE ENGINE] Cold Instagram outreach not permitted. Marking lead not available.`);
          await query(
            `UPDATE outreach_queue SET status = 'FAILED', error_message = 'INSTAGRAM MESSAGE NOT AVAILABLE: No incoming interaction' WHERE id = $1`,
            [job.id]
          );
          await query(
            `UPDATE leads SET crm_status = 'NOT_ELIGIBLE' WHERE id = $1`,
            [job.lead_id]
          );
          return;
        }

        const response = await fetch(`https://graph.facebook.com/v20.0/me/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            recipient: { username: job.instagram_username },
            message: { text: job.message_body }
          })
        });

        const resData = await response.json() as any;
        if (!response.ok) {
          throw new Error(resData.error?.message || 'Meta IG API error');
        }

        await query(
          `UPDATE outreach_queue SET status = 'SENT', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [job.id]
        );
        await query(
          `UPDATE leads SET crm_status = 'SENT', last_contacted_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [job.lead_id]
        );
      }

    } catch (e: any) {
      console.error('[LIVE ENGINE] Live outreach failed:', e.message);
      await query(
        `UPDATE outreach_queue SET status = 'FAILED', error_message = $1 WHERE id = $2`,
        [e.message, job.id]
      );
      await query(
        `UPDATE leads SET crm_status = 'FAILED' WHERE id = $1`,
        [job.lead_id]
      );

      await query(`INSERT INTO audit_logs (id, action, details) VALUES ($1, $2, $3)`, [
        crypto.randomUUID(),
        'API_ERROR',
        `Live outreach error for lead ${job.business_name} (${job.channel}): ${e.message}`
      ]);
    }
  }
}

export const queueManager = new QueueManager();
