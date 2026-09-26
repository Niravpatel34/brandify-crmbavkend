import { query } from '../db.js';
const MOCK_REPLIES = [
    { text: "Hey! This sounds interesting. Let's schedule a call next week.", sentiment: "positive" },
    { text: "Can you send me more details about your pricing plans?", sentiment: "positive" },
    { text: "I would love to learn more. Here is my email.", sentiment: "positive" },
    { text: "Are you guys based in India? What is your website?", sentiment: "neutral" },
    { text: "Please send this information over email.", sentiment: "neutral" },
    { text: "How does this work?", sentiment: "neutral" },
    { text: "UNSUBSCRIBE", sentiment: "opt_out" },
    { text: "STOP messaging me", sentiment: "opt_out" },
    { text: "Not interested, thanks.", sentiment: "opt_out" },
    { text: "No thank you.", sentiment: "opt_out" }
];
export async function processMockOutreach(params) {
    const { leadId, campaignId, queueId, recipient, messageBody, channel } = params;
    try {
        console.log(`[MOCK ENGINE] Initiating ${channel} message to ${recipient}.`);
        const convId = crypto.randomUUID();
        await query(`INSERT INTO conversations (id, lead_id, direction, channel, message_text, status) 
       VALUES ($1, $2, 'OUTGOING', $3, $4, 'SENT')`, [convId, leadId, channel, messageBody]);
        await query(`UPDATE outreach_queue SET status = 'SENT', processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [queueId]);
        await query(`UPDATE leads SET crm_status = 'SENT', last_contacted_at = CURRENT_TIMESTAMP WHERE id = $1`, [leadId]);
        simulateWebhooks(leadId, campaignId, convId, recipient, channel);
    }
    catch (error) {
        console.error('[MOCK ENGINE] Error in processMockOutreach:', error);
        await query(`UPDATE outreach_queue SET status = 'FAILED', error_message = $1 WHERE id = $2`, [String(error), queueId]);
        await query(`UPDATE leads SET crm_status = 'FAILED' WHERE id = $1`, [leadId]);
    }
}
function simulateWebhooks(leadId, campaignId, convId, recipient, channel) {
    setTimeout(async () => {
        try {
            const leadCheck = await query(`SELECT crm_status FROM leads WHERE id = $1`, [leadId]);
            if (!leadCheck.rows.length || leadCheck.rows[0].crm_status === 'OPTED_OUT')
                return;
            console.log(`[MOCK WEBHOOK] Message ${convId} delivered to ${recipient}`);
            await query(`UPDATE conversations SET status = 'DELIVERED' WHERE id = $1`, [convId]);
            await query(`UPDATE leads SET crm_status = 'DELIVERED' WHERE id = $1`, [leadId]);
            await query(`INSERT INTO audit_logs (id, action, details) VALUES ($1, $2, $3)`, [
                crypto.randomUUID(),
                'MESSAGE_DELIVERED',
                `Mock message delivered to ${recipient} via ${channel}`
            ]);
        }
        catch (e) {
            console.error(e);
        }
    }, 1000);
    setTimeout(async () => {
        try {
            const leadCheck = await query(`SELECT crm_status FROM leads WHERE id = $1`, [leadId]);
            if (!leadCheck.rows.length || leadCheck.rows[0].crm_status === 'OPTED_OUT')
                return;
            if (Math.random() < 0.8) {
                console.log(`[MOCK WEBHOOK] Message ${convId} read by ${recipient}`);
                await query(`UPDATE conversations SET status = 'READ' WHERE id = $1`, [convId]);
                await query(`UPDATE leads SET crm_status = 'READ' WHERE id = $1`, [leadId]);
            }
        }
        catch (e) {
            console.error(e);
        }
    }, 3000);
    setTimeout(async () => {
        try {
            const leadCheck = await query(`SELECT crm_status, whatsapp_opt_in FROM leads WHERE id = $1`, [leadId]);
            if (!leadCheck.rows.length || leadCheck.rows[0].crm_status === 'OPTED_OUT')
                return;
            if (Math.random() < 0.5) {
                const reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
                console.log(`[MOCK WEBHOOK] Incoming reply from ${recipient}: "${reply.text}"`);
                const replyConvId = crypto.randomUUID();
                await query(`INSERT INTO conversations (id, lead_id, direction, channel, message_text, status) 
           VALUES ($1, $2, 'INCOMING', $3, $4, 'READ')`, [replyConvId, leadId, channel, reply.text]);
                if (reply.sentiment === 'opt_out') {
                    console.log(`[MOCK WEBHOOK] Opt-out request detected from ${recipient}. Suppressing lead.`);
                    await query(`UPDATE leads 
             SET crm_status = 'OPTED_OUT', whatsapp_opt_in = 0, reply_status = 'OPTED_OUT', sentiment = 'negative' 
             WHERE id = $1`, [leadId]);
                    const suppressId = crypto.randomUUID();
                    if (channel === 'WHATSAPP') {
                        await query(`INSERT INTO suppression_list (id, phone, reason, source) VALUES ($1, $2, $3, 'USER_OPT_OUT')`, [suppressId, recipient, `User sent opt-out message: "${reply.text}"`]);
                    }
                    else {
                        await query(`INSERT INTO suppression_list (id, instagram_username, reason, source) VALUES ($1, $2, $3, 'USER_OPT_OUT')`, [suppressId, recipient, `User sent opt-out message: "${reply.text}"`]);
                    }
                    await query(`UPDATE outreach_queue SET status = 'CANCELLED', error_message = 'Lead opted out' 
             WHERE lead_id = $1 AND status = 'WAITING'`, [leadId]);
                    await query(`INSERT INTO audit_logs (id, action, details) VALUES ($1, $2, $3)`, [
                        crypto.randomUUID(),
                        'LEAD_OPT_OUT',
                        `Lead ${recipient} opted out via message: "${reply.text}"`
                    ]);
                }
                else {
                    const newStatus = reply.sentiment === 'positive' ? 'INTERESTED' : 'REPLIED';
                    await query(`UPDATE leads 
             SET crm_status = $1, reply_status = $2, sentiment = $3 
             WHERE id = $4`, [newStatus, 'REPLIED', reply.sentiment, leadId]);
                    await query(`INSERT INTO audit_logs (id, action, details) VALUES ($1, $2, $3)`, [
                        crypto.randomUUID(),
                        'LEAD_REPLY',
                        `Lead ${recipient} replied: "${reply.text}" (Sentiment: ${reply.sentiment})`
                    ]);
                }
            }
        }
        catch (e) {
            console.error(e);
        }
    }, 7000);
}
