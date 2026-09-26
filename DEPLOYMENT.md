# Brandify Outreach CRM — Hostinger Production Deployment Guide

This guide provides step-by-step instructions for deploying the **Brandify Outreach CRM** to **Hostinger Node.js Hosting** under the production domain:

> **Production Domain:** `https://brandifytrends.space`  
> **Production Webhook URL:** `https://brandifytrends.space/api/webhooks/whatsapp`  
> **Health Check Endpoint:** `https://brandifytrends.space/api/health`

---

## 1. System Architecture Overview

- **Frontend:** React 18, Vite, TypeScript, Tailwind CSS, Lucide Icons, Recharts.
- **Backend:** Node.js (v18+ / v22), Express, TypeScript, REST API (`/api/*`).
- **Database:** Dual driver support — PostgreSQL (Production recommended via `DATABASE_URL`) or SQLite (`outreach.db`).
- **Webhooks:** Official Meta WhatsApp Cloud API Webhook at `/api/webhooks/whatsapp`.
- **Static Serving & SPA Routing:** Express automatically serves compiled frontend assets from `frontend/dist` with single-page fallback for client-side routes (`/dashboard`, `/leads`, `/campaigns`, `/inbox`, `/settings`, `/login`, `/signup`).

---

## 2. Environment Variables Configuration

Set these environment variables in your **Hostinger hPanel → Node.js Web App → Environment Variables**:

| Variable Name | Example Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production mode optimizations |
| `PORT` | `5000` | Server listening port (Hostinger handles this automatically if omitted) |
| `FRONTEND_URL` | `https://brandifytrends.space` | Public frontend URL |
| `BACKEND_URL` | `https://brandifytrends.space` | Public backend URL |
| `DATABASE_URL` | `postgres://user:password@localhost:5432/brandify_crm` | (Optional) PostgreSQL Connection String. If omitted, local SQLite is used |
| `JWT_SECRET` | `a_very_secure_random_string_32_chars_min` | JWT Token Secret for Authentication |
| `META_APP_ID` | `1234567890123456` | Meta Developer App ID |
| `META_APP_SECRET` | `ab12cd34ef56gh78ij90kl` | Meta Developer App Secret |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `1098765432109876` | WhatsApp Business Account (WABA) ID |
| `WHATSAPP_PHONE_NUMBER_ID` | `5432109876543210` | WhatsApp Phone Number ID |
| `WHATSAPP_ACCESS_TOKEN` | `EAAG...` | Meta Permanent System User Access Token |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `brandify_wa_verify_2026_prod` | Secret Verification Token for WhatsApp Webhook Handshake |

---

## 3. Hostinger Deployment Steps

### Step 1: Upload Files or Connect Git Repository
1. Log in to your **Hostinger hPanel**.
2. Navigate to **Websites → Manage → Node.js App** (or File Manager / Git Integration).
3. Push/Upload the `brandify-outreach` codebase.

### Step 2: Configure Node.js Application Settings
In Hostinger hPanel Node.js App settings:
- **Node.js Version:** Select `18.x`, `20.x`, or `22.x`.
- **Application Root:** `/public_html` or `/brandify-outreach`
- **Application Startup File:** `backend/dist/server.js`
- **Build Command:** `npm run build`
- **Start Command:** `npm start`

### Step 3: Run Build & Install Dependencies
Run the initial setup via Hostinger SSH terminal or hPanel button:
```bash
# 1. Install all dependencies (Frontend & Backend)
npm run install:all

# 2. Build Frontend & Backend
npm run build

# 3. Start Application
npm start
```

---

## 4. Domain & SSL Setup

1. In **Hostinger hPanel → Domains**, bind domain / subdomain `brandifytrends.space` to your Node.js application directory.
2. Enable **Free SSL (Let's Encrypt)** for `brandifytrends.space` in Hostinger hPanel → Security → SSL.
3. Ensure **Force HTTPS** is enabled.

---

## 5. Meta WhatsApp Cloud API Webhook Setup

1. Go to **[Meta Developer Portal](https://developers.facebook.com/)** → Your App → **WhatsApp** → **Configuration**.
2. Under **Webhook**, click **Edit**.
3. Set **Callback URL**:  
   `https://brandifytrends.space/api/webhooks/whatsapp`
4. Set **Verify Token**:  
   *(Must match `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in your environment variables, e.g. `brandify_wa_verify_2026_prod`)*.
5. Click **Verify and Save**.
6. Under **Webhook fields**, subscribe to **`messages`**.

---

## 6. Post-Deployment Verification Checklist

After deployment completes, verify all system endpoints:

1. **System Health Check:**
   - Open: `https://brandifytrends.space/api/health`
   - Expected Output: `{"status":"ok", "timestamp":"..."}`
2. **Frontend Routing:**
   - Open: `https://brandifytrends.space/login`
   - Refresh the browser directly to confirm SPA client-side routing fallback is active.
3. **Authentication & Lead Operations:**
   - Log in with registered mobile number & password.
   - Verify pipeline, contacts, campaigns, and inbox loading.
4. **Meta WhatsApp Integration:**
   - Open Settings & APIs → WhatsApp Status Card → Verify **CONNECTED** status.
   - Send a test WhatsApp message to verify real-time status updates via webhook.

---
*Created automatically for Brandify Outreach CRM production release.*
