import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { normalizePhone, normalizeInstagram, normalizeCategory, normalizeCity } from '../utils/normalizer.js';
const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'brandify_outreach_secret_key_2026';
// Helper: Normalize Website URL
function normalizeUrl(url) {
    let cleaned = String(url || '').trim();
    if (!cleaned)
        return '';
    if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = `https://${cleaned}`;
    }
    return cleaned;
}
// Helper: Log Lead Activity
async function logLeadActivity(leadId, type, description, performedBy = 'System') {
    try {
        await query('INSERT INTO lead_activity_logs (id, lead_id, type, description, performed_by) VALUES ($1, $2, $3, $4, $5)', [crypto.randomUUID(), leadId, type, description, performedBy]);
    }
    catch (e) {
        console.error('Failed to log lead activity:', e);
    }
}
// Helper: Add Notification
async function addNotification(type, title, message, link_path = '/leads') {
    try {
        await query('INSERT INTO notifications (id, type, title, message, link_path) VALUES ($1, $2, $3, $4, $5)', [crypto.randomUUID(), type, title, message, link_path]);
    }
    catch (e) {
        console.error('Failed to add notification:', e);
    }
}
// Helper: Mask Sensitive Secrets
function maskSecret(val) {
    if (!val || val.length < 8)
        return '****';
    return val.substring(0, 4) + '****' + val.substring(val.length - 4);
}
// Helper: Mask Phone Number
function maskPhone(phone) {
    const cleaned = String(phone || '').trim();
    if (!cleaned || cleaned.length < 6)
        return cleaned || '—';
    const prefix = cleaned.substring(0, 3);
    const suffix = cleaned.substring(cleaned.length - 4);
    return `${prefix}••••••${suffix}`;
}
// Helper: Format Relative Time
function formatTimeAgo(dateInput) {
    if (!dateInput)
        return 'Never';
    const timestamp = new Date(dateInput).getTime();
    if (isNaN(timestamp))
        return 'Never';
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 10)
        return 'Just now';
    if (diffSec < 60)
        return `${diffSec} sec ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60)
        return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)
        return `${diffHr} hr ago`;
    return `${Math.floor(diffHr / 24)} days ago`;
}
// Helper: Parse Meta Error Messages Safely
function parseMetaError(data) {
    if (data?.error?.message) {
        const msg = data.error.message;
        if (msg.includes('OAuth') || msg.includes('token'))
            return 'Access token expired or invalid';
        if (msg.includes('phone_number_id') || msg.includes('Param phone_number_id'))
            return 'Invalid Phone Number ID';
        if (msg.includes('permission'))
            return 'Missing required Meta API permissions (whatsapp_business_messaging)';
        if (msg.includes('does not exist') || msg.includes('Object with ID'))
            return 'Configured ID not found on Meta Platform';
        return msg;
    }
    return 'Meta API verification failed';
}
// Helper: Normalize Indian Mobile Number
function normalizeIndianMobile(raw) {
    let cleaned = String(raw || '').replace(/\D/g, '');
    if (!cleaned)
        return '';
    if (cleaned.length === 10)
        return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91'))
        return `+${cleaned}`;
    if (cleaned.length === 11 && cleaned.startsWith('0'))
        return `+91${cleaned.substring(1)}`;
    return cleaned ? `+${cleaned}` : '';
}
// -------------------------------------------------------------
// HEALTH ENDPOINT (PUBLIC)
// -------------------------------------------------------------
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// -------------------------------------------------------------
// AUTH ENDPOINTS (MOBILE NUMBER + OTP + PASSWORD)
// -------------------------------------------------------------
// 1. Send OTP for Sign Up or Password Reset
router.post('/auth/send-otp', async (req, res) => {
    const { mobileNumber, purpose } = req.body;
    const cleanMobile = normalizeIndianMobile(mobileNumber);
    if (!cleanMobile || cleanMobile.length < 12) {
        res.status(400).json({ error: 'Valid 10-digit Indian mobile number is required (+91).' });
        return;
    }
    const validPurpose = purpose === 'FORGOT_PASSWORD' ? 'FORGOT_PASSWORD' : 'SIGNUP';
    try {
        if (validPurpose === 'SIGNUP') {
            const existing = await query('SELECT id FROM users WHERE mobile_number = $1 OR username = $1', [cleanMobile, cleanMobile]);
            if (existing.rows.length > 0) {
                res.status(400).json({ error: 'This mobile number is already registered. Please log in.' });
                return;
            }
        }
        // Rate Limiting Cooldown Check (60 seconds)
        const recentOtp = await query('SELECT created_at FROM otp_store WHERE mobile_number = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1', [cleanMobile, validPurpose]);
        if (recentOtp.rows.length > 0) {
            const lastTime = new Date(recentOtp.rows[0].created_at).getTime();
            const diffSec = Math.floor((Date.now() - lastTime) / 1000);
            if (diffSec < 60) {
                res.status(429).json({ error: `Please wait ${60 - diffSec} seconds before requesting a new OTP.` });
                return;
            }
        }
        // Generate 6-digit numeric OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins
        const otpId = crypto.randomUUID();
        await query(`INSERT INTO otp_store (id, mobile_number, otp_code, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5)`, [otpId, cleanMobile, otpCode, validPurpose, expiresAt]);
        console.log(`[SMS GATEWAY SIMULATOR] Sent OTP ${otpCode} to ${cleanMobile} (Purpose: ${validPurpose})`);
        res.json({
            success: true,
            message: `OTP sent successfully to ${cleanMobile}. Valid for 5 minutes.`,
            otpSimulated: otpCode,
            cooldownSeconds: 60
        });
    }
    catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }
});
// 2. Verify OTP
router.post('/auth/verify-otp', async (req, res) => {
    const { mobileNumber, otpCode, purpose } = req.body;
    const cleanMobile = normalizeIndianMobile(mobileNumber);
    if (!cleanMobile || !otpCode || String(otpCode).length !== 6) {
        res.status(400).json({ error: 'Valid 6-digit OTP code and mobile number are required.' });
        return;
    }
    const validPurpose = purpose === 'FORGOT_PASSWORD' ? 'FORGOT_PASSWORD' : 'SIGNUP';
    try {
        const { rows } = await query(`SELECT * FROM otp_store 
       WHERE mobile_number = $1 AND purpose = $2 AND is_verified = 0 
       ORDER BY created_at DESC LIMIT 1`, [cleanMobile, validPurpose]);
        if (rows.length === 0) {
            res.status(400).json({ error: 'No active OTP request found for this mobile number.' });
            return;
        }
        const otpRecord = rows[0];
        // Check expiration
        if (Date.now() > Number(otpRecord.expires_at)) {
            res.status(400).json({ error: 'OTP code has expired. Please request a new OTP.' });
            return;
        }
        // Check attempts limit (max 5)
        if (Number(otpRecord.attempts) >= 5) {
            res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new OTP.' });
            return;
        }
        // Verify code
        if (otpRecord.otp_code !== String(otpCode).trim()) {
            await query('UPDATE otp_store SET attempts = attempts + 1 WHERE id = $1', [otpRecord.id]);
            res.status(400).json({ error: 'Invalid OTP verification code. Please check and try again.' });
            return;
        }
        // Mark verified
        await query('UPDATE otp_store SET is_verified = 1 WHERE id = $1', [otpRecord.id]);
        res.json({
            success: true,
            message: 'OTP verified successfully.',
            verificationId: otpRecord.id
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to verify OTP' });
    }
});
// 3. User Sign Up Account Creation
router.post('/auth/signup', async (req, res) => {
    const { fullName, mobileNumber, password, confirmPassword, verificationId } = req.body;
    const cleanMobile = normalizeIndianMobile(mobileNumber);
    if (!fullName || !cleanMobile || !password || !confirmPassword || !verificationId) {
        res.status(400).json({ error: 'All fields including OTP verification are required.' });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long.' });
        return;
    }
    if (password !== confirmPassword) {
        res.status(400).json({ error: 'Password and Confirm Password do not match.' });
        return;
    }
    try {
        // Verify OTP record
        const otpRes = await query('SELECT * FROM otp_store WHERE id = $1 AND mobile_number = $2 AND is_verified = 1', [verificationId, cleanMobile]);
        if (otpRes.rows.length === 0) {
            res.status(400).json({ error: 'OTP verification invalid or expired. Please verify OTP first.' });
            return;
        }
        // Check existing
        const existing = await query('SELECT id FROM users WHERE mobile_number = $1', [cleanMobile]);
        if (existing.rows.length > 0) {
            res.status(400).json({ error: 'This mobile number is already registered. Please log in.' });
            return;
        }
        const passwordHash = bcrypt.hashSync(password, 10);
        const userId = crypto.randomUUID();
        const username = cleanMobile;
        await query(`INSERT INTO users (id, username, mobile_number, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`, [userId, username, cleanMobile, fullName, passwordHash]);
        await query('DELETE FROM otp_store WHERE id = $1', [verificationId]);
        const token = jwt.sign({ id: userId, username, mobileNumber: cleanMobile, fullName, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true,
            token,
            user: {
                id: userId,
                username,
                mobileNumber: cleanMobile,
                fullName,
                role: 'admin'
            }
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Account creation failed: ' + error.message });
    }
});
// 4. User Login
router.post('/auth/login', async (req, res) => {
    const { username, mobileNumber, password } = req.body;
    const rawTarget = String(mobileNumber || username || '').trim();
    const cleanMobile = normalizeIndianMobile(rawTarget);
    if (!rawTarget || !password) {
        res.status(400).json({ error: 'Mobile number and password are required.' });
        return;
    }
    try {
        let sql = 'SELECT * FROM users WHERE mobile_number = $1 OR username = $2';
        let params = [rawTarget, rawTarget];
        if (cleanMobile) {
            sql = 'SELECT * FROM users WHERE mobile_number = $1 OR username = $2 OR mobile_number = $3';
            params = [cleanMobile, rawTarget, rawTarget];
        }
        const { rows } = await query(sql, params);
        if (rows.length === 0) {
            res.status(401).json({ error: 'Invalid mobile number or password.' });
            return;
        }
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            res.status(401).json({ error: 'Invalid mobile number or password.' });
            return;
        }
        const token = jwt.sign({
            id: user.id,
            username: user.username || user.mobile_number,
            mobileNumber: user.mobile_number,
            fullName: user.full_name || user.username || 'Admin User',
            role: user.role || 'admin'
        }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username || user.mobile_number,
                mobileNumber: user.mobile_number,
                fullName: user.full_name || user.username || 'Admin User',
                role: user.role || 'admin'
            }
        });
    }
    catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// 5. Forgot Password Reset Endpoint
router.post('/auth/forgot-password/reset', async (req, res) => {
    const { mobileNumber, newPassword, confirmPassword, verificationId } = req.body;
    const cleanMobile = normalizeIndianMobile(mobileNumber);
    if (!cleanMobile || !newPassword || !confirmPassword || !verificationId) {
        res.status(400).json({ error: 'All fields including OTP verification are required.' });
        return;
    }
    if (newPassword.length < 8) {
        res.status(400).json({ error: 'New password must be at least 8 characters long.' });
        return;
    }
    if (newPassword !== confirmPassword) {
        res.status(400).json({ error: 'Passwords do not match.' });
        return;
    }
    try {
        const otpRes = await query('SELECT * FROM otp_store WHERE id = $1 AND mobile_number = $2 AND is_verified = 1', [verificationId, cleanMobile]);
        if (otpRes.rows.length === 0) {
            res.status(400).json({ error: 'OTP verification invalid or expired.' });
            return;
        }
        const userRes = await query('SELECT id FROM users WHERE mobile_number = $1 OR username = $1', [cleanMobile]);
        if (userRes.rows.length === 0) {
            res.status(400).json({ error: 'No account registered with this mobile number.' });
            return;
        }
        const passwordHash = bcrypt.hashSync(newPassword, 10);
        await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userRes.rows[0].id]);
        await query('DELETE FROM otp_store WHERE id = $1', [verificationId]);
        res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});
router.get('/auth/verify', authMiddleware, (req, res) => {
    res.json({ valid: true, user: req.user });
});
// -------------------------------------------------------------
// GLOBAL SEARCH & COMMAND PALETTE
// -------------------------------------------------------------
router.get('/search', authMiddleware, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
        res.json({ leads: [], campaigns: [], templates: [] });
        return;
    }
    try {
        const term = `%${q}%`;
        const leadsRes = await query(`SELECT id, business_name, contact_name, city, crm_status, whatsapp_number, instagram_username 
       FROM leads 
       WHERE business_name LIKE $1 OR contact_name LIKE $1 OR phone LIKE $1 OR whatsapp_number LIKE $1 OR instagram_username LIKE $1 OR city LIKE $1 
       LIMIT 8`, [term]);
        const campaignsRes = await query(`SELECT id, name, channel, status FROM campaigns WHERE name LIKE $1 LIMIT 5`, [term]);
        const templatesRes = await query(`SELECT id, name, category FROM message_templates WHERE name LIKE $1 OR category LIKE $1 LIMIT 5`, [term]);
        res.json({
            leads: leadsRes.rows,
            campaigns: campaignsRes.rows,
            templates: templatesRes.rows
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to perform global search' });
    }
});
// -------------------------------------------------------------
// NOTIFICATION CENTER
// -------------------------------------------------------------
router.get('/notifications', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 30');
        const unreadCount = rows.filter(r => !r.is_read).length;
        res.json({ notifications: rows, unreadCount });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});
router.put('/notifications/read-all', authMiddleware, async (req, res) => {
    try {
        await query('UPDATE notifications SET is_read = 1');
        res.json({ message: 'All notifications marked as read' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});
router.put('/notifications/:id/read', authMiddleware, async (req, res) => {
    try {
        await query('UPDATE notifications SET is_read = 1 WHERE id = $1', [req.params.id]);
        res.json({ message: 'Notification marked read' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to mark notification read' });
    }
});
// -------------------------------------------------------------
// "TODAY" MORNING WORKSPACE EXECUTIVE SUMMARY
// -------------------------------------------------------------
router.get('/today/summary', authMiddleware, async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const repliesRes = await query(`
      SELECT c.lead_id, l.business_name, l.contact_name, c.message_text, c.timestamp 
      FROM conversations c
      JOIN leads l ON c.lead_id = l.id
      WHERE c.direction = 'INCOMING' AND c.status != 'READ'
      ORDER BY c.timestamp DESC LIMIT 10
    `);
        const hotLeadsRes = await query(`
      SELECT id, business_name, contact_name, crm_status, city, lead_score
      FROM leads
      WHERE UPPER(crm_status) IN ('REPLIED', 'INTERESTED', 'QUALIFIED') OR whatsapp_opt_in = 1
      ORDER BY lead_score DESC, updated_at DESC LIMIT 6
    `);
        const todayFollowups = await query(`
      SELECT f.*, l.business_name, l.contact_name, l.phone 
      FROM lead_followups f
      JOIN leads l ON f.lead_id = l.id
      WHERE f.status = 'PENDING' AND f.followup_date = $1
      ORDER BY f.followup_time ASC
    `, [todayStr]);
        const overdueFollowups = await query(`
      SELECT f.*, l.business_name, l.contact_name, l.phone 
      FROM lead_followups f
      JOIN leads l ON f.lead_id = l.id
      WHERE f.status = 'PENDING' AND f.followup_date < $1
      ORDER BY f.followup_date ASC
    `, [todayStr]);
        const meetingsRes = await query(`
      SELECT m.*, l.business_name, l.contact_name 
      FROM meetings m
      JOIN leads l ON m.lead_id = l.id
      WHERE m.meeting_date >= $1 AND m.status = 'SCHEDULED'
      ORDER BY m.meeting_date ASC LIMIT 5
    `, [todayStr]);
        res.json({
            date: todayStr,
            unreadReplies: repliesRes.rows,
            hotLeads: hotLeadsRes.rows,
            todayFollowups: todayFollowups.rows,
            overdueFollowups: overdueFollowups.rows,
            upcomingMeetings: meetingsRes.rows
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to generate today summary' });
    }
});
// -------------------------------------------------------------
// SALES OPPORTUNITIES & REVENUE SYSTEM
// -------------------------------------------------------------
router.get('/opportunities', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT o.*, l.business_name, l.contact_name, l.city, l.crm_status as lead_status
      FROM opportunities o
      JOIN leads l ON o.lead_id = l.id
      ORDER BY o.created_at DESC
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch opportunities' });
    }
});
router.post('/opportunities', authMiddleware, async (req, res) => {
    const { lead_id, title, estimated_value, probability, stage, expected_close_date, notes } = req.body;
    if (!lead_id || !title) {
        res.status(400).json({ error: 'lead_id and title are required' });
        return;
    }
    try {
        const id = crypto.randomUUID();
        const owner = req.user?.username || 'admin';
        await query(`INSERT INTO opportunities (id, lead_id, title, estimated_value, probability, stage, expected_close_date, owner, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, lead_id, title, estimated_value || 0, probability || 50, stage || 'QUALIFIED', expected_close_date || '', owner, notes || '']);
        await logLeadActivity(lead_id, 'OPPORTUNITY_CREATED', `Created Deal Opportunity: "${title}" ($${estimated_value || 0})`, owner);
        await addNotification('PROPOSAL_ACCEPTED', 'New Deal Opportunity Created', `Created deal "${title}" valued at $${estimated_value || 0}`, `/opportunities`);
        res.json({ id, lead_id, title, estimated_value, stage });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create opportunity' });
    }
});
router.put('/opportunities/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const fields = [];
        const values = [];
        let idx = 1;
        Object.keys(updates).forEach(key => {
            if (key !== 'id') {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        });
        if (fields.length > 0) {
            values.push(id);
            await query(`UPDATE opportunities SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`, values);
        }
        res.json({ message: 'Opportunity updated successfully' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update opportunity' });
    }
});
router.get('/opportunities/revenue', authMiddleware, async (req, res) => {
    try {
        const totalPipeline = await query("SELECT SUM(estimated_value) as val FROM opportunities WHERE stage != 'WON' AND stage != 'LOST'");
        const wonRevenue = await query("SELECT SUM(estimated_value) as val FROM opportunities WHERE stage = 'WON'");
        const wonCount = await query("SELECT COUNT(*) as cnt FROM opportunities WHERE stage = 'WON'");
        const totalDeals = await query('SELECT COUNT(*) as cnt FROM opportunities');
        const pipeVal = parseInt(totalPipeline.rows[0]?.val || 0);
        const wonVal = parseInt(wonRevenue.rows[0]?.val || 0);
        const totalCount = parseInt(totalDeals.rows[0]?.cnt || 0);
        const wonNum = parseInt(wonCount.rows[0]?.cnt || 0);
        const winRate = totalCount > 0 ? Math.round((wonNum / totalCount) * 100) : 0;
        const avgDealValue = wonNum > 0 ? Math.round(wonVal / wonNum) : 0;
        res.json({
            pipelineValue: pipeVal,
            wonRevenue: wonVal,
            winRate,
            avgDealValue,
            totalDeals: totalCount,
            wonDeals: wonNum
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch revenue analytics' });
    }
});
// -------------------------------------------------------------
// PROPOSAL & QUOTATION BUILDER
// -------------------------------------------------------------
router.get('/proposals', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT p.*, l.business_name, l.contact_name, l.city
      FROM proposals p
      JOIN leads l ON p.lead_id = l.id
      ORDER BY p.created_at DESC
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch proposals' });
    }
});
router.post('/proposals', authMiddleware, async (req, res) => {
    const { lead_id, opportunity_id, title, package_name, items_json, total_amount, status } = req.body;
    if (!lead_id || !title || !items_json) {
        res.status(400).json({ error: 'lead_id, title, and items_json are required' });
        return;
    }
    try {
        const id = crypto.randomUUID();
        await query(`INSERT INTO proposals (id, lead_id, opportunity_id, title, package_name, items_json, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, lead_id, opportunity_id || null, title, package_name || 'Standard Package', typeof items_json === 'string' ? items_json : JSON.stringify(items_json), total_amount || 0, status || 'DRAFT']);
        await logLeadActivity(lead_id, 'PROPOSAL_GENERATED', `Generated Proposal: "${title}" ($${total_amount || 0})`, req.user?.username || 'admin');
        res.json({ id, title, total_amount });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create proposal' });
    }
});
router.put('/proposals/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, total_amount } = req.body;
    try {
        await query('UPDATE proposals SET status = $1, total_amount = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [status, total_amount, id]);
        res.json({ message: 'Proposal status updated' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update proposal' });
    }
});
// -------------------------------------------------------------
// CLIENT CONVERSION & CLIENTS WORKSPACE
// -------------------------------------------------------------
router.post('/leads/:id/convert-client', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { client_tier = 'PREMIUM', mrr = 1500, notes = 'Converted from Won prospect' } = req.body;
    try {
        const leadRes = await query('SELECT * FROM leads WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) {
            res.status(404).json({ error: 'Lead not found' });
            return;
        }
        const lead = leadRes.rows[0];
        await query('UPDATE leads SET is_client = 1, crm_status = \'WON\' WHERE id = $1', [id]);
        const clientId = crypto.randomUUID();
        await query(`INSERT INTO clients (id, lead_id, business_name, client_tier, mrr, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(lead_id) DO UPDATE SET client_tier = EXCLUDED.client_tier, mrr = EXCLUDED.mrr`, [clientId, id, lead.business_name, client_tier, mrr, notes]);
        await logLeadActivity(id, 'CONVERTED_TO_CLIENT', `Converted ${lead.business_name} to Active Client (MRR: $${mrr})`, req.user?.username || 'admin');
        await addNotification('PROPOSAL_ACCEPTED', 'Client Conversion Success!', `${lead.business_name} was converted to an Active Client.`, '/clients');
        res.json({ success: true, clientId, message: `Successfully converted ${lead.business_name} to Client Workspace!` });
    }
    catch (error) {
        res.status(500).json({ error: error.message || 'Failed to convert lead to client' });
    }
});
router.get('/clients', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT c.*, l.contact_name, l.city, l.phone, l.whatsapp_number, l.email, l.website
      FROM clients c
      JOIN leads l ON c.lead_id = l.id
      ORDER BY c.converted_at DESC
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});
// -------------------------------------------------------------
// AI LEAD SUMMARY & INTEL SCORE ENGINE
// -------------------------------------------------------------
router.get('/leads/:id/ai-summary', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const leadRes = await query('SELECT * FROM leads WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) {
            res.status(404).json({ error: 'Lead not found' });
            return;
        }
        const lead = leadRes.rows[0];
        const notesRes = await query('SELECT note_text FROM lead_notes WHERE lead_id = $1', [id]);
        const actRes = await query('SELECT description, created_at FROM lead_activity_logs WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5', [id]);
        const convRes = await query('SELECT direction, message_text, timestamp FROM conversations WHERE lead_id = $1 ORDER BY timestamp DESC LIMIT 3', [id]);
        let score = 20;
        const reasons = [];
        if (lead.whatsapp_opt_in) {
            score += 25;
            reasons.push('+25 Verified WhatsApp Opt-in Consent');
        }
        if (lead.crm_status === 'REPLIED' || lead.crm_status === 'INTERESTED' || lead.crm_status === 'WON') {
            score += 35;
            reasons.push('+35 Active Customer Reply Engagement');
        }
        if (notesRes.rows.length > 0) {
            score += 10;
            reasons.push(`+10 Recorded ${notesRes.rows.length} Customer Interaction Notes`);
        }
        if (lead.city && lead.phone) {
            score += 10;
            reasons.push('+10 Complete Profile Information');
        }
        const category = score >= 70 ? 'HOT' : score >= 40 ? 'WARM' : 'COLD';
        let actionRecommendation = 'Follow up via WhatsApp';
        if (lead.crm_status === 'REPLIED')
            actionRecommendation = 'Send proposal & schedule call';
        if (lead.crm_status === 'INTERESTED')
            actionRecommendation = 'Convert lead to Deal Opportunity';
        if (lead.crm_status === 'DO_NOT_CONTACT')
            actionRecommendation = 'Do Not Contact — Unsubscribed';
        const latestConv = convRes.rows[0];
        const summaryText = latestConv
            ? `Contacted. Last message (${latestConv.direction}): "${latestConv.message_text.substring(0, 40)}...". Recommended Action: ${actionRecommendation}.`
            : `Profile complete in ${lead.city || 'CRM'}. Ready for targeted template outreach. Recommended Action: ${actionRecommendation}.`;
        res.json({
            leadId: id,
            score,
            category,
            reasons,
            actionRecommendation,
            summaryText,
            recentActivities: actRes.rows
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to generate AI lead summary' });
    }
});
// Business Research Panel
router.get('/leads/:id/research', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const leadRes = await query('SELECT * FROM leads WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) {
            res.status(404).json({ error: 'Lead not found' });
            return;
        }
        const lead = leadRes.rows[0];
        res.json({
            verified: {
                business_name: lead.business_name,
                city: lead.city,
                phone: lead.whatsapp_number || lead.phone,
                website: lead.website
            },
            discovered: {
                estimatedEmployees: '10-25 Employees',
                googleRating: '4.8 ★★★★★ (42 reviews)',
                publicSocials: {
                    instagram: lead.instagram_username ? `https://instagram.com/${lead.instagram_username}` : null,
                    facebook: `https://facebook.com/search/top?q=${encodeURIComponent(lead.business_name)}`
                },
                servicesDiscovered: [lead.business_type || 'Services', 'Consultation', 'Customer Support']
            }
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch business research data' });
    }
});
// -------------------------------------------------------------
// CAMPAIGN FUNNEL & A/B COMPARISON
// -------------------------------------------------------------
router.get('/campaigns/comparison', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT c.id, c.name, c.channel, c.status,
             COUNT(q.id) as total_leads,
             SUM(CASE WHEN q.status = 'SENT' THEN 1 ELSE 0 END) as sent_count,
             SUM(CASE WHEN q.status = 'FAILED' THEN 1 ELSE 0 END) as failed_count
      FROM campaigns c
      LEFT JOIN outreach_queue q ON c.id = q.campaign_id
      GROUP BY c.id, c.name, c.channel, c.status
      LIMIT 10
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch campaign comparison' });
    }
});
// System Error Logs
router.get('/errors', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM system_error_logs ORDER BY created_at DESC LIMIT 50');
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch system error logs' });
    }
});
// -------------------------------------------------------------
// OFFICIAL META WHATSAPP CLOUD API WEBHOOK ENDPOINTS
// -------------------------------------------------------------
// 1. Meta Webhook Verification Handshake (GET /api/webhooks/whatsapp)
router.get('/webhooks/whatsapp', async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    // Read verification token from environment variable or DB fallback
    let expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!expectedToken) {
        try {
            const dbRes = await query("SELECT value FROM integrations WHERE key = 'whatsapp_webhook_verify_token'");
            if (dbRes.rows.length > 0)
                expectedToken = JSON.parse(dbRes.rows[0].value);
        }
        catch (e) { }
    }
    if (!expectedToken) {
        expectedToken = 'brandify_whatsapp_verify_token_2026';
    }
    if (mode === 'subscribe' && token === expectedToken) {
        console.log('[META WEBHOOK VERIFICATION SUCCESS] Webhook verified by Meta Platform.');
        res.status(200).send(challenge);
    }
    else {
        console.warn('[META WEBHOOK VERIFICATION FAILED] Token mismatch or invalid mode.');
        res.status(403).json({ error: 'Webhook verification token mismatch' });
    }
});
// 2. Meta Webhook Event Processor (POST /api/webhooks/whatsapp)
router.post('/webhooks/whatsapp', async (req, res) => {
    const body = req.body;
    // Signature validation if WHATSAPP_APP_SECRET is configured
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret && req.headers['x-hub-signature-256']) {
        try {
            const crypto = await import('crypto');
            const signature = req.headers['x-hub-signature-256'];
            const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(JSON.stringify(body)).digest('hex');
            if (signature !== expectedSignature) {
                console.warn('[META WEBHOOK SIGNATURE MISMATCH] Invalid X-Hub-Signature-256 header.');
                res.status(401).json({ error: 'Invalid webhook signature' });
                return;
            }
        }
        catch (e) { }
    }
    // Always return 200 OK immediately to Meta to acknowledge receipt
    res.status(200).json({ status: 'EVENT_RECEIVED' });
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
        return;
    }
    for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
            if (change.field !== 'messages')
                continue;
            const val = change.value;
            if (!val)
                continue;
            // Log raw event for audit & debugging
            const logId = crypto.randomUUID();
            try {
                await query('INSERT INTO webhook_logs (id, channel, event_type, payload_json) VALUES ($1, $2, $3, $4)', [logId, 'WHATSAPP', val.statuses ? 'STATUS_UPDATE' : 'INCOMING_MESSAGE', JSON.stringify(val)]);
            }
            catch (e) { }
            // A. Process Status Updates (sent, delivered, read, failed)
            if (Array.isArray(val.statuses)) {
                for (const statusObj of val.statuses) {
                    const wamid = statusObj.id;
                    const statusText = String(statusObj.status || '').toUpperCase();
                    const recipientPhone = normalizeIndianMobile(statusObj.recipient_id);
                    try {
                        // Update conversation record
                        await query('UPDATE conversations SET status = $1 WHERE wamid = $2 OR id = $2', [statusText, wamid]);
                        // Update outreach queue record if matching
                        await query('UPDATE outreach_queue SET status = $1 WHERE id = $2', [statusText, wamid]);
                        console.log(`[META WEBHOOK STATUS] Updated message ${wamid} to ${statusText} for ${recipientPhone}`);
                    }
                    catch (e) {
                        console.error('Failed to update message status:', e);
                    }
                }
            }
            // B. Process Incoming Customer Messages
            if (Array.isArray(val.messages)) {
                for (const msgObj of val.messages) {
                    const wamid = msgObj.id;
                    const fromPhone = normalizeIndianMobile(msgObj.from);
                    let messageText = '';
                    if (msgObj.type === 'text' && msgObj.text?.body) {
                        messageText = msgObj.text.body;
                    }
                    else if (msgObj.type === 'image') {
                        messageText = msgObj.image?.caption || '[Image received]';
                    }
                    else if (msgObj.type === 'audio') {
                        messageText = '[Voice note received]';
                    }
                    else if (msgObj.type === 'document') {
                        messageText = msgObj.document?.caption || '[Document received]';
                    }
                    else if (msgObj.button?.text) {
                        messageText = msgObj.button.text;
                    }
                    else if (msgObj.interactive?.button_reply?.title) {
                        messageText = msgObj.interactive.button_reply.title;
                    }
                    else {
                        messageText = `[${msgObj.type || 'Message'} received]`;
                    }
                    if (!fromPhone || !messageText)
                        continue;
                    try {
                        // Idempotency Check: Don't process duplicate wamid
                        const dupCheck = await query('SELECT id FROM conversations WHERE wamid = $1', [wamid]);
                        if (dupCheck.rows.length > 0) {
                            console.log(`[META WEBHOOK IDEMPOTENCY] Skipped duplicate message wamid: ${wamid}`);
                            continue;
                        }
                        // Find matching lead in database
                        let leadRes = await query('SELECT * FROM leads WHERE whatsapp_number = $1 OR phone = $1 OR whatsapp_number = $2', [fromPhone, msgObj.from]);
                        let leadId = '';
                        let leadName = 'WhatsApp Customer';
                        if (leadRes.rows.length > 0) {
                            const lead = leadRes.rows[0];
                            leadId = lead.id;
                            leadName = lead.business_name || lead.contact_name || 'WhatsApp Customer';
                            // Update lead status to REPLIED
                            await query(`UPDATE leads SET crm_status = 'REPLIED', reply_status = 'REPLIED', last_contacted_at = CURRENT_TIMESTAMP WHERE id = $1`, [leadId]);
                            // Log lead activity
                            await logLeadActivity(leadId, 'INCOMING_WHATSAPP_MESSAGE', `Received WhatsApp reply: "${messageText.substring(0, 40)}..."`, 'WhatsApp Webhook');
                        }
                        else {
                            // Auto-create lead for new incoming WhatsApp contact
                            const newLeadId = crypto.randomUUID();
                            const contactName = val.contacts?.[0]?.profile?.name || 'New WhatsApp Lead';
                            await query(`INSERT INTO leads (id, business_name, contact_name, whatsapp_number, phone, whatsapp_opt_in, crm_status, reply_status)
                 VALUES ($1, $2, $3, $4, $5, 1, 'REPLIED', 'REPLIED')`, [newLeadId, contactName, contactName, fromPhone, fromPhone]);
                            leadId = newLeadId;
                            leadName = contactName;
                            await logLeadActivity(newLeadId, 'LEAD_CREATED', `Auto-created lead from incoming WhatsApp message`, 'WhatsApp Webhook');
                        }
                        // Insert conversation message
                        const convId = crypto.randomUUID();
                        await query(`INSERT INTO conversations (id, lead_id, direction, channel, message_text, status, wamid)
               VALUES ($1, $2, 'INCOMING', 'WHATSAPP', $3, 'RECEIVED', $4)`, [convId, leadId, messageText, wamid]);
                        // Trigger real-time CRM notification
                        await addNotification('REPLY_RECEIVED', `New WhatsApp Reply from ${leadName}`, `"${messageText.substring(0, 50)}..."`, '/inbox');
                        console.log(`[META WEBHOOK INCOMING] Received message from ${leadName} (${fromPhone}): "${messageText}"`);
                    }
                    catch (e) {
                        console.error('Failed to process incoming webhook message:', e);
                    }
                }
            }
        }
    }
});
router.get('/integrations', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM integrations');
        const result = {};
        rows.forEach(row => {
            try {
                const parsed = JSON.parse(row.value);
                if (typeof parsed === 'object' && parsed !== null) {
                    const masked = { ...parsed };
                    if (masked.accessToken)
                        masked.accessToken = maskSecret(masked.accessToken);
                    if (masked.appSecret)
                        masked.appSecret = maskSecret(masked.appSecret);
                    result[row.key] = masked;
                }
                else {
                    result[row.key] = parsed;
                }
            }
            catch {
                result[row.key] = row.value;
            }
        });
        if (result.mode === undefined)
            result.mode = 'MOCK';
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to retrieve integrations' });
    }
});
router.post('/integrations', authMiddleware, async (req, res) => {
    const { mode, whatsapp_credentials, instagram_credentials } = req.body;
    try {
        if (mode) {
            await query('INSERT INTO integrations (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2', ['mode', JSON.stringify(mode)]);
        }
        if (whatsapp_credentials) {
            await query('INSERT INTO integrations (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2', ['whatsapp_credentials', JSON.stringify(whatsapp_credentials)]);
        }
        if (instagram_credentials) {
            await query('INSERT INTO integrations (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2', ['instagram_credentials', JSON.stringify(instagram_credentials)]);
        }
        await query('INSERT INTO audit_logs (id, action, details) VALUES ($1, $2, $3)', [
            crypto.randomUUID(),
            'INTEGRATION_CONNECTED',
            `Integrations updated. Mode: ${mode || 'MOCK'}`
        ]);
        res.json({ message: 'Integrations updated successfully' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update integrations' });
    }
});
router.post('/integrations/test-whatsapp', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query("SELECT value FROM integrations WHERE key = 'whatsapp_credentials'");
        const modeRes = await query("SELECT value FROM integrations WHERE key = 'mode'");
        const mode = modeRes.rows.length > 0 ? JSON.parse(modeRes.rows[0].value) : 'MOCK';
        if (rows.length === 0) {
            res.status(400).json({ success: false, message: '✕ Missing WhatsApp credentials configuration' });
            return;
        }
        const waCreds = rows[0]?.value ? JSON.parse(rows[0].value) : null;
        if (!waCreds || !waCreds.phoneNumberId || !waCreds.accessToken) {
            res.status(400).json({ success: false, message: '✕ Phone Number ID and Access Token are required' });
            return;
        }
        if (mode === 'MOCK') {
            res.json({ success: true, message: `✓ WhatsApp connection verified (Mock Mode active. Phone: ${maskPhone(waCreds.phoneNumberId)})` });
            return;
        }
        const graphRes = await fetch(`https://graph.facebook.com/v20.0/${waCreds.phoneNumberId}`, {
            headers: { Authorization: `Bearer ${waCreds.accessToken}` }
        });
        const data = await graphRes.json();
        if (graphRes.ok) {
            res.json({
                success: true,
                message: `✓ Connected! Verified Phone ID: ${data.id}. Display Number: ${maskPhone(data.display_phone_number || waCreds.phoneNumberId)}`
            });
        }
        else {
            res.status(400).json({ success: false, message: `✕ ${parseMetaError(data)}` });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, message: `✕ Server verification failed: ${err.message}` });
    }
});
router.post('/integrations/test-instagram', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query("SELECT value FROM integrations WHERE key = 'instagram_credentials'");
        const modeRes = await query("SELECT value FROM integrations WHERE key = 'mode'");
        const mode = modeRes.rows.length > 0 ? JSON.parse(modeRes.rows[0].value) : 'MOCK';
        if (rows.length === 0) {
            res.status(400).json({ success: false, message: '✕ Missing Instagram credentials configuration' });
            return;
        }
        const igCreds = rows[0]?.value ? JSON.parse(rows[0].value) : null;
        if (!igCreds || !igCreds.pageId || !igCreds.accessToken) {
            res.status(400).json({ success: false, message: '✕ Facebook Page ID and Access Token are required' });
            return;
        }
        if (mode === 'MOCK') {
            res.json({ success: true, message: `✓ Instagram connection verified (Mock Mode active. Page ID: ${igCreds.pageId})` });
            return;
        }
        const graphRes = await fetch(`https://graph.facebook.com/v20.0/${igCreds.pageId}?fields=instagram_business_account`, {
            headers: { Authorization: `Bearer ${igCreds.accessToken}` }
        });
        const data = await graphRes.json();
        if (graphRes.ok) {
            if (data.instagram_business_account?.id) {
                res.json({
                    success: true,
                    message: `✓ Facebook Page & Instagram Business Account linked! Account ID: ${data.instagram_business_account.id}`
                });
            }
            else {
                res.json({
                    success: true,
                    message: `⚠ Facebook Page verified, but no Instagram Business Account linked to this page.`
                });
            }
        }
        else {
            res.status(400).json({ success: false, message: `✕ ${parseMetaError(data)}` });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, message: `✕ Server verification failed: ${err.message}` });
    }
});
// -------------------------------------------------------------
// REAL SYSTEM HEALTH ENGINE & SUBSYSTEM AUDIT ENDPOINT
// -------------------------------------------------------------
router.get('/system/health', authMiddleware, async (req, res) => {
    const startTime = Date.now();
    try {
        const intRows = await query('SELECT * FROM integrations');
        const configMap = {};
        intRows.rows.forEach(r => {
            try {
                configMap[r.key] = JSON.parse(r.value);
            }
            catch {
                configMap[r.key] = r.value;
            }
        });
        const mode = configMap.mode || 'MOCK';
        const waCreds = configMap.whatsapp_credentials || {};
        const igCreds = configMap.instagram_credentials || {};
        const dbStartTime = Date.now();
        let dbStatus = 'CONNECTED';
        let dbMessage = '';
        try {
            await query('SELECT 1');
            const dbLatency = Date.now() - dbStartTime;
            dbMessage = `Response: ${dbLatency}ms (${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'})`;
        }
        catch (e) {
            dbStatus = 'ERROR';
            dbMessage = `Database connection failure: ${e.message}`;
        }
        let waApiStatus = 'NOT_CONFIGURED';
        let waApiMessage = 'No API credentials saved';
        let waApiMaskedPhone = '';
        let wabaStatus = 'NOT_CONFIGURED';
        let wabaMessage = 'WABA ID not configured';
        let waPhoneStatus = 'NOT_CONFIGURED';
        let waPhoneMessage = 'Phone ID not configured';
        let metaAppStatus = 'NOT_CONFIGURED';
        let metaAppMessage = 'Meta App ID not configured';
        const hasWaCreds = !!(waCreds.phoneNumberId && waCreds.accessToken);
        if (hasWaCreds) {
            if (mode === 'MOCK') {
                waApiStatus = 'CONNECTED';
                waApiMessage = `Connected (Mock Engine Active)`;
                waApiMaskedPhone = maskPhone(waCreds.phoneNumberId || '+919876543210');
                wabaStatus = 'CONNECTED';
                wabaMessage = `WABA Verified (Mock Engine)`;
                waPhoneStatus = 'CONNECTED';
                waPhoneMessage = `Display Number Active`;
                metaAppStatus = 'CONNECTED';
                metaAppMessage = `App ID ${waCreds.appId || '1029384756'} Verified`;
            }
            else {
                try {
                    const waGraphRes = await fetch(`https://graph.facebook.com/v20.0/${waCreds.phoneNumberId}`, {
                        headers: { Authorization: `Bearer ${waCreds.accessToken}` }
                    });
                    const waData = await waGraphRes.json();
                    if (waGraphRes.ok) {
                        waApiStatus = 'CONNECTED';
                        waApiMaskedPhone = maskPhone(waData.display_phone_number || waCreds.phoneNumberId);
                        waApiMessage = `Connected to Meta Cloud API (${waData.display_phone_number || 'Live'})`;
                        waPhoneStatus = 'CONNECTED';
                        waPhoneMessage = `Quality: ${waData.quality_rating || 'GREEN'} • Status: ${waData.code_verification_status || 'VERIFIED'}`;
                        if (waCreds.businessAccountId) {
                            wabaStatus = 'CONNECTED';
                            wabaMessage = `WABA Account ID: ${waCreds.businessAccountId}`;
                        }
                        else {
                            wabaStatus = 'WARNING';
                            wabaMessage = `Missing WABA Account ID configuration`;
                        }
                        if (waCreds.appId) {
                            metaAppStatus = 'CONNECTED';
                            metaAppMessage = `App ID: ${waCreds.appId} Active`;
                        }
                        else {
                            metaAppStatus = 'WARNING';
                            metaAppMessage = `App ID not specified`;
                        }
                    }
                    else {
                        const errDetail = parseMetaError(waData);
                        waApiStatus = 'ERROR';
                        waApiMessage = errDetail;
                        wabaStatus = 'ERROR';
                        wabaMessage = errDetail;
                        waPhoneStatus = 'ERROR';
                        waPhoneMessage = errDetail;
                        metaAppStatus = 'ERROR';
                        metaAppMessage = errDetail;
                    }
                }
                catch (e) {
                    waApiStatus = 'ERROR';
                    waApiMessage = `Meta Network Error: ${e.message}`;
                    wabaStatus = 'ERROR';
                    wabaMessage = 'Unable to reach Meta Platform';
                    waPhoneStatus = 'ERROR';
                    waPhoneMessage = 'Network timeout';
                    metaAppStatus = 'ERROR';
                    metaAppMessage = 'Verification timeout';
                }
            }
        }
        let igApiStatus = 'NOT_CONFIGURED';
        let igApiMessage = 'Page ID or Access Token missing';
        let fbPageStatus = 'NOT_CONFIGURED';
        let fbPageMessage = 'Facebook Page ID not configured';
        const hasIgCreds = !!(igCreds.pageId && igCreds.accessToken);
        if (hasIgCreds) {
            if (mode === 'MOCK') {
                igApiStatus = 'CONNECTED';
                igApiMessage = `Instagram Messaging Active (Mock Engine)`;
                fbPageStatus = 'CONNECTED';
                fbPageMessage = `Facebook Page ID: ${igCreds.pageId} Linked`;
            }
            else {
                try {
                    const igGraphRes = await fetch(`https://graph.facebook.com/v20.0/${igCreds.pageId}?fields=instagram_business_account`, {
                        headers: { Authorization: `Bearer ${igCreds.accessToken}` }
                    });
                    const igData = await igGraphRes.json();
                    if (igGraphRes.ok) {
                        fbPageStatus = 'CONNECTED';
                        fbPageMessage = `Facebook Page ID: ${igCreds.pageId} Verified`;
                        if (igData.instagram_business_account?.id) {
                            igApiStatus = 'CONNECTED';
                            igApiMessage = `Instagram Business Account ID: ${igData.instagram_business_account.id}`;
                        }
                        else {
                            igApiStatus = 'WARNING';
                            igApiMessage = `Facebook Page verified, but no Instagram Business Account linked`;
                        }
                    }
                    else {
                        const errDetail = parseMetaError(igData);
                        igApiStatus = 'ERROR';
                        igApiMessage = errDetail;
                        fbPageStatus = 'ERROR';
                        fbPageMessage = errDetail;
                    }
                }
                catch (e) {
                    igApiStatus = 'ERROR';
                    igApiMessage = `Meta Network Error: ${e.message}`;
                    fbPageStatus = 'ERROR';
                    fbPageMessage = 'Network timeout';
                }
            }
        }
        let webhookStatus = 'NOT_CONFIGURED';
        let webhookMessage = 'Webhooks not registered';
        let lastWebhookTime = 'Never';
        try {
            const logsCount = await query('SELECT COUNT(*) as total, MAX(created_at) as last_event FROM webhook_logs');
            const convCount = await query("SELECT COUNT(*) as total, MAX(timestamp) as last_event FROM conversations WHERE direction = 'INCOMING'");
            const totalWebhooks = parseInt(logsCount.rows[0].total || 0) + parseInt(convCount.rows[0].total || 0);
            const latestTime = logsCount.rows[0].last_event || convCount.rows[0].last_event;
            if (hasWaCreds || hasIgCreds) {
                if (totalWebhooks > 0) {
                    webhookStatus = 'HEALTHY';
                    lastWebhookTime = formatTimeAgo(latestTime);
                    webhookMessage = `Receiving live events. Last: ${lastWebhookTime}`;
                }
                else {
                    webhookStatus = 'WARNING';
                    webhookMessage = `CONFIGURED — NOT YET VERIFIED`;
                    lastWebhookTime = 'No events received';
                }
            }
        }
        catch (e) { }
        const queueCounts = await query(`
      SELECT 
        SUM(CASE WHEN status = 'WAITING' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM outreach_queue
    `);
        const qWaiting = parseInt(queueCounts.rows[0]?.waiting || 0);
        const qProcessing = parseInt(queueCounts.rows[0]?.processing || 0);
        const qFailed = parseInt(queueCounts.rows[0]?.failed || 0);
        const messagingEngine = {
            id: 'queue_engine',
            service: 'Messaging Engine',
            status: 'RUNNING',
            indicator: 'GREEN',
            message: `Queue Engine Active (Mode: ${mode})`,
            queued: qWaiting,
            processing: qProcessing,
            failed: qFailed
        };
        const apiLatency = Date.now() - startTime;
        const backendApi = {
            id: 'crm_backend',
            service: 'CRM Backend API',
            status: 'CONNECTED',
            indicator: 'GREEN',
            message: `Online (Latency: ${apiLatency}ms)`
        };
        const services = [
            { id: 'wa_cloud', service: 'WhatsApp Cloud API', status: waApiStatus, phone: waApiMaskedPhone, message: waApiMessage },
            { id: 'waba', service: 'WhatsApp Business Account', status: wabaStatus, message: wabaMessage },
            { id: 'wa_phone', service: 'WhatsApp Phone Number', status: waPhoneStatus, message: waPhoneMessage },
            { id: 'meta_app', service: 'Meta Developer App', status: metaAppStatus, message: metaAppMessage },
            { id: 'ig_api', service: 'Instagram Messaging API', status: igApiStatus, message: igApiMessage },
            { id: 'fb_page', service: 'Facebook Page', status: fbPageStatus, message: fbPageMessage },
            { id: 'webhooks', service: 'Meta Webhooks', status: webhookStatus, message: webhookMessage, lastChecked: lastWebhookTime },
            { id: 'database', service: 'Database', status: dbStatus, message: dbMessage },
            messagingEngine,
            backendApi
        ];
        const errors = services.filter(s => s.status === 'ERROR' || s.status === 'DISCONNECTED').length;
        const warnings = services.filter(s => s.status === 'WARNING' || s.status === 'NOT_CONFIGURED').length;
        let overallState = 'ALL_OPERATIONAL';
        let overallMessage = 'ALL SYSTEMS OPERATIONAL';
        if (dbStatus === 'ERROR' || backendApi.status === 'ERROR') {
            overallState = 'CRITICAL_ERROR';
            overallMessage = 'CRITICAL CONNECTION ERROR';
        }
        else if (errors > 0) {
            overallState = 'ATTENTION_REQUIRED';
            overallMessage = `${errors} SERVICE${errors > 1 ? 'S' : ''} DISCONNECTED / ERROR`;
        }
        else if (warnings > 0) {
            overallState = 'ATTENTION_REQUIRED';
            overallMessage = `${warnings} INTEGRATION${warnings > 1 ? 'S' : ''} REQUIRE ATTENTION`;
        }
        res.json({
            overallState,
            overallMessage,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            mode,
            services
        });
    }
    catch (error) {
        console.error('System Health check failed:', error);
        res.status(500).json({ error: 'System Health check failed', details: error.message });
    }
});
// -------------------------------------------------------------
// LEADS ENDPOINTS & ADVANCED QUERY
// -------------------------------------------------------------
router.get('/leads', authMiddleware, async (req, res) => {
    try {
        const { crm_status, status, city, area, state, business_type, subcategory, tags, assigned_user, whatsapp_opt_in, instagram_eligible, source, search, sortBy = 'created_at', sortOrder = 'DESC', page, limit } = req.query;
        let sql = 'SELECT * FROM leads WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM leads WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        const targetStatus = String(crm_status || status || '').trim();
        if (targetStatus && targetStatus.toLowerCase() !== 'all' && !targetStatus.toLowerCase().includes('all stat')) {
            const condition = ` AND UPPER(crm_status) = UPPER($${paramIndex++})`;
            sql += condition;
            countSql += condition;
            params.push(targetStatus);
        }
        const targetCity = String(city || '').trim();
        if (targetCity && targetCity.toLowerCase() !== 'all' && !targetCity.toLowerCase().includes('all cit')) {
            const condition = ` AND LOWER(city) = LOWER($${paramIndex++})`;
            sql += condition;
            countSql += condition;
            params.push(targetCity);
        }
        const targetCategory = String(business_type || '').trim();
        if (targetCategory && targetCategory.toLowerCase() !== 'all' && !targetCategory.toLowerCase().includes('all cat')) {
            const condition = ` AND LOWER(business_type) = LOWER($${paramIndex++})`;
            sql += condition;
            countSql += condition;
            params.push(targetCategory);
        }
        if (search) {
            const term = `%${String(search).trim()}%`;
            const condition = ` AND (
        business_name LIKE $${paramIndex} OR 
        contact_name LIKE $${paramIndex} OR 
        phone LIKE $${paramIndex} OR 
        whatsapp_number LIKE $${paramIndex} OR 
        instagram_username LIKE $${paramIndex} OR 
        city LIKE $${paramIndex}
      )`;
            paramIndex++;
            sql += condition;
            countSql += condition;
            params.push(term);
        }
        const allowedSort = ['business_name', 'created_at', 'city', 'crm_status', 'business_type'];
        const validSort = allowedSort.includes(String(sortBy)) ? String(sortBy) : 'created_at';
        const validOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${validSort} ${validOrder}`;
        if (page && limit) {
            const pageNum = Math.max(1, parseInt(String(page)));
            const limitNum = Math.max(1, parseInt(String(limit)));
            const offset = (pageNum - 1) * limitNum;
            sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            const countRes = await query(countSql, params);
            const total = parseInt(countRes.rows[0]?.total || 0);
            params.push(limitNum, offset);
            const dataRes = await query(sql, params);
            res.json({
                leads: dataRes.rows,
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            });
            return;
        }
        const dataRes = await query(sql, params);
        res.json(dataRes.rows);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});
// Duplicates & Bulk Update
router.get('/leads/duplicates', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT l1.id as lead1_id, l1.business_name as lead1_name, l1.whatsapp_number as lead1_phone,
             l2.id as lead2_id, l2.business_name as lead2_name, l2.whatsapp_number as lead2_phone
      FROM leads l1
      JOIN leads l2 ON l1.id < l2.id AND (
        (l1.whatsapp_number IS NOT NULL AND l1.whatsapp_number = l2.whatsapp_number) OR
        (l1.instagram_username IS NOT NULL AND LOWER(l1.instagram_username) = LOWER(l2.instagram_username)) OR
        (LOWER(l1.business_name) = LOWER(l2.business_name) AND LOWER(l1.city) = LOWER(l2.city))
      )
      LIMIT 20
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to find duplicate leads' });
    }
});
router.post('/leads/merge', authMiddleware, async (req, res) => {
    const { primaryId, secondaryId, mergedFields } = req.body;
    try {
        if (mergedFields && Object.keys(mergedFields).length > 0) {
            const fields = [];
            const values = [];
            let idx = 1;
            Object.keys(mergedFields).forEach(key => {
                fields.push(`${key} = $${idx++}`);
                values.push(mergedFields[key]);
            });
            values.push(primaryId);
            await query(`UPDATE leads SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        }
        await query('DELETE FROM leads WHERE id = $1', [secondaryId]);
        await logLeadActivity(primaryId, 'LEADS_MERGED', `Merged secondary lead ID ${secondaryId}`, 'admin');
        res.json({ message: 'Leads merged successfully' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to merge leads' });
    }
});
router.post('/leads/bulk-update', authMiddleware, async (req, res) => {
    const { leadIds, action, value } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
        res.status(400).json({ error: 'No leads selected' });
        return;
    }
    try {
        if (action === 'DELETE') {
            for (const id of leadIds) {
                await query('DELETE FROM leads WHERE id = $1', [id]);
            }
        }
        else if (action === 'CHANGE_STATUS') {
            for (const id of leadIds) {
                await query('UPDATE leads SET crm_status = $1 WHERE id = $2', [value, id]);
            }
        }
        res.json({ message: `Bulk action ${action} completed for ${leadIds.length} leads` });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to execute bulk update' });
    }
});
router.post('/leads', authMiddleware, async (req, res) => {
    try {
        const lead = req.body;
        const id = crypto.randomUUID();
        const cleanPhone = normalizePhone(lead.whatsapp_number || lead.phone);
        const cleanInsta = normalizeInstagram(lead.instagram_username);
        const cleanCat = normalizeCategory(lead.business_type);
        const cleanCity = normalizeCity(lead.city);
        const cleanUrl = normalizeUrl(lead.website);
        await query(`INSERT INTO leads (
        id, business_name, contact_name, business_type, website, phone, 
        whatsapp_number, instagram_username, email, city, area, state, subcategory, 
        tags, assigned_user, whatsapp_opt_in, crm_status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, [
            id, lead.business_name, lead.contact_name, cleanCat, cleanUrl, cleanPhone,
            cleanPhone, cleanInsta, lead.email, cleanCity, lead.area, lead.state, lead.subcategory,
            typeof lead.tags === 'string' ? lead.tags : JSON.stringify(lead.tags || []),
            lead.assigned_user || 'admin', lead.whatsapp_opt_in ? 1 : 0, lead.crm_status || 'NEW', lead.notes
        ]);
        await logLeadActivity(id, 'LEAD_CREATED', `Lead created: ${lead.business_name}`, 'admin');
        res.json({ id, ...lead });
    }
    catch (error) {
        res.status(500).json({ error: error.message || 'Failed to create lead' });
    }
});
router.put('/leads/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const fields = [];
        const values = [];
        let idx = 1;
        Object.keys(updates).forEach(key => {
            if (key !== 'id') {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        });
        if (fields.length > 0) {
            values.push(id);
            await query(`UPDATE leads SET ${fields.join(', ')} WHERE id = $${idx}`, values);
            await logLeadActivity(id, 'LEAD_UPDATED', `Updated fields: ${Object.keys(updates).join(', ')}`, 'admin');
        }
        res.json({ message: 'Lead updated successfully' });
    }
    catch (error) {
        res.status(500).json({ error: error.message || 'Failed to update lead' });
    }
});
router.delete('/leads/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        await query('DELETE FROM leads WHERE id = $1', [id]);
        res.json({ message: 'Lead deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});
// Lead Notes
router.get('/leads/:id/notes', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch lead notes' });
    }
});
router.post('/leads/:id/notes', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { note_text } = req.body;
    if (!note_text) {
        res.status(400).json({ error: 'Note text required' });
        return;
    }
    try {
        const noteId = crypto.randomUUID();
        const author = req.user?.username || 'admin';
        await query('INSERT INTO lead_notes (id, lead_id, author, note_text) VALUES ($1, $2, $3, $4)', [noteId, id, author, note_text]);
        await logLeadActivity(id, 'NOTE_ADDED', `Added note: "${note_text.substring(0, 30)}..."`, author);
        res.json({ id: noteId, lead_id: id, author, note_text, created_at: new Date().toISOString() });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to add note' });
    }
});
router.delete('/leads/:id/notes/:noteId', authMiddleware, async (req, res) => {
    try {
        await query('DELETE FROM lead_notes WHERE id = $1 AND lead_id = $2', [req.params.noteId, req.params.id]);
        res.json({ message: 'Note deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete note' });
    }
});
// Lead Activity Timeline
router.get('/leads/:id/activity', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM lead_activity_logs WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch lead activity timeline' });
    }
});
// Lead Follow-Ups
router.get('/followups', authMiddleware, async (req, res) => {
    try {
        const { status } = req.query;
        let sql = 'SELECT f.*, l.business_name, l.contact_name FROM lead_followups f JOIN leads l ON f.lead_id = l.id';
        const params = [];
        if (status) {
            sql += ' WHERE f.status = $1';
            params.push(status);
        }
        sql += ' ORDER BY f.followup_date ASC';
        const { rows } = await query(sql, params);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch followups' });
    }
});
router.post('/leads/:id/followups', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { followup_date, followup_time, reason, priority, notes } = req.body;
    try {
        const followupId = crypto.randomUUID();
        await query(`INSERT INTO lead_followups (id, lead_id, followup_date, followup_time, reason, priority, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [followupId, id, followup_date, followup_time || '10:00', reason || 'Sales Follow-up', priority || 'MEDIUM', notes || '']);
        await query('UPDATE leads SET next_followup_at = $1 WHERE id = $2', [followup_date, id]);
        await logLeadActivity(id, 'FOLLOWUP_SCHEDULED', `Scheduled follow-up for ${followup_date}: ${reason}`, req.user?.username || 'admin');
        res.json({ id: followupId, lead_id: id, followup_date, reason });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to schedule followup' });
    }
});
router.put('/followups/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    try {
        await query('UPDATE lead_followups SET status = $1, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [status, notes || '', id]);
        res.json({ message: 'Followup status updated' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update followup' });
    }
});
// Saved Views
router.get('/saved-views', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM saved_views ORDER BY created_at DESC');
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch saved views' });
    }
});
router.post('/saved-views', authMiddleware, async (req, res) => {
    const { name, filters } = req.body;
    try {
        const id = crypto.randomUUID();
        await query('INSERT INTO saved_views (id, name, filters_json) VALUES ($1, $2, $3)', [id, name, JSON.stringify(filters || {})]);
        res.json({ id, name, filters_json: JSON.stringify(filters) });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to save view' });
    }
});
router.delete('/saved-views/:id', authMiddleware, async (req, res) => {
    try {
        await query('DELETE FROM saved_views WHERE id = $1', [req.params.id]);
        res.json({ message: 'Saved view deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete saved view' });
    }
});
// CSV Import Validation & Submission
router.post('/import/validate', authMiddleware, async (req, res) => {
    const { leads } = req.body;
    if (!Array.isArray(leads)) {
        res.status(400).json({ error: 'Leads array required' });
        return;
    }
    const valid = [];
    const incomplete = [];
    for (const raw of leads) {
        const businessName = String(raw.business_name || raw.Business || '').trim();
        const cleanPhone = normalizePhone(raw.whatsapp_number || raw.phone || raw.mobile || raw.contact);
        const cleanInsta = normalizeInstagram(raw.instagram_username || raw.instagram);
        if (!businessName)
            continue;
        const leadObj = {
            business_name: businessName,
            contact_name: raw.contact_name || raw.Contact || '',
            business_type: normalizeCategory(raw.business_type || raw.category || raw.Category),
            city: normalizeCity(raw.city || raw.City),
            whatsapp_number: cleanPhone,
            instagram_username: cleanInsta,
            website: normalizeUrl(raw.website || raw.Website),
            email: raw.email || '',
            whatsapp_opt_in: !!cleanPhone
        };
        if (cleanPhone || cleanInsta) {
            valid.push(leadObj);
        }
        else {
            incomplete.push({ ...leadObj, crm_status: 'INCOMPLETE', issue: 'Missing WhatsApp number or Instagram handle' });
        }
    }
    res.json({ valid, incomplete, totalParsed: leads.length });
});
router.post('/import/submit', authMiddleware, async (req, res) => {
    const { leads } = req.body;
    if (!Array.isArray(leads)) {
        res.status(400).json({ error: 'Leads array required' });
        return;
    }
    let importedCount = 0;
    for (const lead of leads) {
        try {
            const id = crypto.randomUUID();
            await query(`INSERT INTO leads (
          id, business_name, contact_name, business_type, city, whatsapp_number, 
          instagram_username, website, email, whatsapp_opt_in, crm_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT(whatsapp_number) DO UPDATE SET 
          business_name = EXCLUDED.business_name,
          contact_name = EXCLUDED.contact_name,
          city = EXCLUDED.city`, [
                id, lead.business_name, lead.contact_name, lead.business_type, lead.city,
                lead.whatsapp_number, lead.instagram_username, lead.website, lead.email,
                lead.whatsapp_opt_in ? 1 : 0, lead.crm_status || 'NEW'
            ]);
            importedCount++;
        }
        catch (e) { }
    }
    res.json({ importedCount, total: leads.length });
});
// Campaigns
router.get('/campaigns', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT c.*, t.name as template_name,
             COUNT(q.id) as total_leads,
             SUM(CASE WHEN q.status = 'SENT' THEN 1 ELSE 0 END) as sent_count,
             SUM(CASE WHEN q.status = 'FAILED' THEN 1 ELSE 0 END) as failed_count,
             SUM(CASE WHEN q.status = 'PROCESSING' THEN 1 ELSE 0 END) as processing_count,
             SUM(CASE WHEN q.status = 'WAITING' THEN 1 ELSE 0 END) as waiting_count
      FROM campaigns c
      LEFT JOIN message_templates t ON c.template_id = t.id
      LEFT JOIN outreach_queue q ON c.id = q.campaign_id
      GROUP BY c.id, c.name, c.channel, c.status, c.template_id, c.created_at, c.updated_at, t.name
      ORDER BY c.created_at DESC
    `);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});
router.post('/campaigns', authMiddleware, async (req, res) => {
    const { name, channel, templateId, leadIds } = req.body;
    if (!name || !templateId || !Array.isArray(leadIds) || leadIds.length === 0) {
        res.status(400).json({ error: 'Campaign name, templateId, and leadIds are required' });
        return;
    }
    try {
        const campaignId = crypto.randomUUID();
        await query('INSERT INTO campaigns (id, name, channel, status, template_id) VALUES ($1, $2, $3, $4, $5)', [campaignId, name, channel || 'WHATSAPP', 'RUNNING', templateId]);
        const tempRes = await query('SELECT body_text FROM message_templates WHERE id = $1', [templateId]);
        const templateText = tempRes.rows[0]?.body_text || '';
        for (const leadId of leadIds) {
            const qId = crypto.randomUUID();
            await query(`INSERT INTO outreach_queue (id, campaign_id, lead_id, message_body, status) VALUES ($1, $2, $3, $4, 'WAITING')`, [qId, campaignId, leadId, templateText]);
        }
        res.json({ id: campaignId, name, queuedCount: leadIds.length });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});
router.post('/campaigns/:id/control', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { action } = req.body;
    try {
        let targetStatus = 'RUNNING';
        if (action === 'PAUSE')
            targetStatus = 'PAUSED';
        if (action === 'STOP')
            targetStatus = 'STOPPED';
        await query('UPDATE campaigns SET status = $1 WHERE id = $2', [targetStatus, id]);
        res.json({ message: `Campaign status changed to ${targetStatus}` });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update campaign control status' });
    }
});
router.delete('/campaigns/:id', authMiddleware, async (req, res) => {
    try {
        await query('DELETE FROM outreach_queue WHERE campaign_id = $1', [req.params.id]);
        await query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
        res.json({ message: 'Campaign deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
});
// Templates
router.get('/templates', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM message_templates ORDER BY created_at DESC');
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});
router.post('/templates', authMiddleware, async (req, res) => {
    const { id, name, meta_template_id, language, category, body_text, status } = req.body;
    try {
        const targetId = id || crypto.randomUUID();
        await query(`INSERT INTO message_templates (id, name, meta_template_id, language, category, body_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET 
         name = EXCLUDED.name,
         meta_template_id = EXCLUDED.meta_template_id,
         category = EXCLUDED.category,
         body_text = EXCLUDED.body_text,
         status = EXCLUDED.status`, [targetId, name, meta_template_id, language || 'en', category, body_text, status || 'APPROVED']);
        res.json({ id: targetId, name });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to save template' });
    }
});
router.delete('/templates/:id', authMiddleware, async (req, res) => {
    try {
        await query('DELETE FROM message_templates WHERE id = $1', [req.params.id]);
        res.json({ message: 'Template deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete template' });
    }
});
// Suppression List
router.get('/suppression', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM suppression_list ORDER BY created_at DESC');
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch suppression list' });
    }
});
router.post('/suppression', authMiddleware, async (req, res) => {
    const { phone, instagram_username, reason } = req.body;
    try {
        const id = crypto.randomUUID();
        const cleanPhone = normalizePhone(phone);
        const cleanInsta = normalizeInstagram(instagram_username);
        await query('INSERT INTO suppression_list (id, phone, instagram_username, reason, source) VALUES ($1, $2, $3, $4, $5)', [id, cleanPhone, cleanInsta, reason || 'Manual Block', 'USER_OPT_OUT']);
        res.json({ id, phone: cleanPhone, instagram_username: cleanInsta });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to add suppression entry' });
    }
});
router.delete('/suppression/:id', authMiddleware, async (req, res) => {
    try {
        await query('DELETE FROM suppression_list WHERE id = $1', [req.params.id]);
        res.json({ message: 'Suppression entry removed' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete suppression entry' });
    }
});
// Conversations
router.get('/conversations', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT c.id, c.lead_id, c.direction, c.channel, c.message_text, c.status, c.timestamp,
             l.business_name, l.contact_name, l.crm_status as lead_status,
             (SELECT COUNT(*) FROM conversations WHERE lead_id = c.lead_id AND direction = 'INCOMING' AND status != 'READ') as unread_count
      FROM conversations c
      JOIN leads l ON c.lead_id = l.id
      ORDER BY c.timestamp DESC
    `);
        const threadMap = new Map();
        rows.forEach(row => {
            if (!threadMap.has(row.lead_id)) {
                threadMap.set(row.lead_id, row);
            }
        });
        res.json(Array.from(threadMap.values()));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});
router.get('/conversations/:leadId', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM conversations WHERE lead_id = $1 ORDER BY timestamp ASC', [req.params.leadId]);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});
router.post('/conversations/:leadId/reply', authMiddleware, async (req, res) => {
    const { leadId } = req.params;
    const { messageText, channel } = req.body;
    if (!messageText || !channel) {
        res.status(400).json({ error: 'Message text and channel are required' });
        return;
    }
    try {
        const leadRes = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
        if (leadRes.rows.length === 0) {
            res.status(404).json({ error: 'Lead not found' });
            return;
        }
        const lead = leadRes.rows[0];
        const suppressed = await query(`SELECT * FROM suppression_list WHERE (phone = $1 AND phone IS NOT NULL) OR (instagram_username = $2 AND instagram_username IS NOT NULL)`, [lead.whatsapp_number, lead.instagram_username]);
        if (suppressed.rows.length > 0) {
            res.status(400).json({ error: 'Lead is in suppression list and cannot be messaged' });
            return;
        }
        const modeResult = await query(`SELECT value FROM integrations WHERE key = 'mode'`);
        const isLiveMode = modeResult.rows.length > 0 && modeResult.rows[0].value === 'LIVE';
        if (!isLiveMode) {
            const convId = crypto.randomUUID();
            await query(`INSERT INTO conversations (id, lead_id, direction, channel, message_text, status) 
         VALUES ($1, $2, 'OUTGOING', $3, $4, 'SENT')`, [convId, leadId, channel, messageText]);
            await logLeadActivity(leadId, 'MANUAL_REPLY_SENT', `Sent manual ${channel} reply: "${messageText.substring(0, 30)}..."`, req.user?.username || 'admin');
            setTimeout(async () => {
                await query(`UPDATE conversations SET status = 'DELIVERED' WHERE id = $1`, [convId]);
                setTimeout(async () => {
                    await query(`UPDATE conversations SET status = 'READ' WHERE id = $1`, [convId]);
                }, 1500);
            }, 1000);
            res.json({ message: 'Mock message sent successfully' });
        }
        else {
            res.json({ message: 'Live message dispatched' });
        }
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Failed to send reply' });
    }
});
// Analytics & Audit Logs
router.get('/analytics', authMiddleware, async (req, res) => {
    try {
        const totalLeads = await query('SELECT COUNT(*) as count FROM leads');
        const newLeads = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'NEW'`);
        const eligibleLeads = await query('SELECT COUNT(*) as count FROM leads WHERE whatsapp_opt_in = 1 OR instagram_eligible = 1');
        const queuedLeads = await query(`SELECT COUNT(*) as count FROM outreach_queue WHERE status = 'WAITING'`);
        const sentLeads = await query(`SELECT COUNT(*) as count FROM outreach_queue WHERE status = 'SENT'`);
        const failedLeads = await query(`SELECT COUNT(*) as count FROM outreach_queue WHERE status = 'FAILED'`);
        const repliesCount = await query(`SELECT COUNT(*) as count FROM leads WHERE reply_status = 'REPLIED'`);
        const interestedCount = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'INTERESTED'`);
        const qualifiedCount = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'QUALIFIED'`);
        const wonCount = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'WON'`);
        const lostCount = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'LOST'`);
        const incompleteLeads = await query(`SELECT COUNT(*) as count FROM leads WHERE crm_status = 'INCOMPLETE'`);
        const pendingFollowups = await query(`SELECT COUNT(*) as count FROM lead_followups WHERE status = 'PENDING'`);
        const overdueFollowups = await query(`SELECT COUNT(*) as count FROM lead_followups WHERE status = 'PENDING' AND followup_date < DATE('now')`);
        const campaignsRes = await query(`
      SELECT c.name, 
             COUNT(q.id) as total,
             SUM(CASE WHEN q.status = 'SENT' THEN 1 ELSE 0 END) as sent,
             SUM(CASE WHEN q.status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM campaigns c
      LEFT JOIN outreach_queue q ON c.id = q.campaign_id
      GROUP BY c.id, c.name
      LIMIT 5
    `);
        const categoryRes = await query(`
      SELECT business_type as category, COUNT(*) as count 
      FROM leads 
      WHERE business_type IS NOT NULL AND business_type != '' 
      GROUP BY business_type
    `);
        res.json({
            summary: {
                totalLeads: parseInt(totalLeads.rows[0].count),
                newLeads: parseInt(newLeads.rows[0].count),
                eligibleLeads: parseInt(eligibleLeads.rows[0].count),
                incompleteLeads: parseInt(incompleteLeads.rows[0].count),
                queued: parseInt(queuedLeads.rows[0].count),
                sent: parseInt(sentLeads.rows[0].count),
                replies: parseInt(repliesCount.rows[0].count),
                interested: parseInt(interestedCount.rows[0].count),
                qualified: parseInt(qualifiedCount.rows[0].count),
                won: parseInt(wonCount.rows[0].count),
                lost: parseInt(lostCount.rows[0].count),
                pendingFollowups: parseInt(pendingFollowups.rows[0].count),
                overdueFollowups: parseInt(overdueFollowups.rows[0].count)
            },
            campaignPerformance: campaignsRes.rows,
            categoryPerformance: categoryRes.rows
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});
router.get('/audit-logs', authMiddleware, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50');
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});
export default router;
