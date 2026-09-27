import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import apiRouter from './routes/api.js';
import adminRouter from './routes/admin.js';
import { queueManager } from './services/queue.js';
import { apiMonitor } from './services/apiMonitorService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = process.env.NODE_ENV || 'development';
const envFile = path.resolve(process.cwd(), `.env.${env}`);
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
  console.log(`[ENV] Loaded environment: ${envFile}`);
} else {
  dotenv.config(); 
  console.log(`[ENV] Loaded fallback .env (NODE_ENV=${env})`);
}

const app = express();
const PORT = process.env.PORT || 5000;

// CORS setup
const allowedOrigins = [
  'http://localhost:5177', 
  'http://localhost:5173',
  'https://brandifytrends.space',
  'https://www.brandifytrends.space',
  'https://brandify-crm-65d8f.web.app',
  'https://brandify-crmbavkend.onrender.com'
];

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.use(apiMonitor);
app.use('/api', apiRouter);
app.use('/api/admin', adminRouter);

app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
});

const possibleDistPaths = [
  path.join(__dirname, '../../frontend/dist'),
  path.join(__dirname, '../frontend/dist'),
  path.join(process.cwd(), 'frontend/dist'),
  path.join(process.cwd(), 'dist'),
  path.join(process.cwd(), '../frontend/dist')
];

const distPath = possibleDistPaths.find(p => fs.existsSync(p));

if (distPath) {
  console.log(`[SERVER] Serving static frontend files from: ${distPath}`);
  app.use(express.static(distPath));
  
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'API endpoint not found' });
    }
  });
} else {
  app.get('/', (req, res) => {
    res.json({ name: 'Brandify Outreach API', version: '1.0.0', status: 'OK' });
  });
}

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[UNCAUGHT ERROR]', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

async function bootstrap() {
  try {
    await initDb();
    queueManager.start();
    app.listen(PORT, () => {
      console.log(`[SERVER] Brandify Outreach API listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[BOOTSTRAP ERROR] Fatal error during backend startup:', error);
    process.exit(1);
  }
}

const handleExit = () => {
  console.log('\n[SERVER] Shutdown signal received. Cleaning up...');
  queueManager.stop();
  process.exit(0);
};

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

let isDbInitialized = false;
app.use(async (req, res, next) => {
  if (!isDbInitialized) {
    try {
      await initDb();
      isDbInitialized = true;
    } catch (err) {
      console.error('Failed to init DB for serverless:', err);
    }
  }
  next();
});

import { onRequest } from 'firebase-functions/v2/https';
export const api = onRequest(app);

// START THE SERVER
bootstrap();
