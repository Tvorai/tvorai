// server.js — KLING v2.5 (T2V/I2V) + Seedream T2I + Merge Face + kredity/DB (ESM)

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mysql from 'mysql2/promise';
import Stripe from 'stripe';
import fetch from 'node-fetch';
import 'dotenv/config';

// ROUTES
import t2vRouter from './routes/kling-v2-5-turbo-text-to-video.js';
import i2vRouter from './routes/kling-v2-5-turbo-imagine-i2v.js';
import seedreamRouter from './routes/seedream-3-0-txt2img.js';
import mergeFaceRouter from './routes/merge-face.js';
import seedream4Router from './routes/seedream-4-0-txt2img.js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * ======================================================
 * STRIPE WEBHOOK — MUSÍ BYŤ PRED express.json()
 * ======================================================
 */
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Stripe signature error:', err.message);
      return res.status(400).send('Invalid signature');
    }

    // Reagujeme len na úspešnú platbu
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;

      console.log('✅ Stripe payment succeeded:', intent.id);

      const txnId  = intent.metadata?.mepr_transaction_id;
      const userId = intent.metadata?.wp_user_id;

      if (txnId && userId) {
        try {
          await fetch('https://www.tvorai.cz/wp-json/lyra/v1/confirm-payment', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-LYRA-SECRET': process.env.LYRA_SHARED_SECRET,
            },
            body: JSON.stringify({
              transaction_id: txnId,
              user_id: userId,
            }),
          });
        } catch (e) {
          console.error('❌ Failed to notify WordPress:', e.message);
        }
      }
    }

    res.json({ received: true });
  }
);

// ====== MIDDLEWARE (AŽ PO WEBHOOKE) ======
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' })); // pre bežné API

// ====== DB POOL ======
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3314,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});
app.locals.db = pool;

// --- Pool event logy (debug) ---
pool.on('connection', (conn) => {
  console.log('✅ New MySQL connection established');
  conn.on('error', (err) => console.error('⚠️ MySQL connection error:', err.message));
  conn.on('end', () => console.warn('⚠️ MySQL connection ended'));
});

// --- DB ping po štarte ---
try {
  const [rows] = await pool.query('SELECT 1 AS ok');
  console.log('DB ping OK:', rows[0]?.ok === 1);
} catch (e) {
  console.error('DB ping FAILED:', e?.message || e);
}

// --- Keepalive ping každé 4 minúty ---
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.warn('⚠️ Keepalive ping failed:', e.message);
  }
}, 1000 * 60 * 4);

// ====== DEBUG ======
app.get('/debug/db', async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [[u]]  = await conn.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
      const [[s]]  = await conn.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'subscriptions'");
      const [[b]]  = await conn.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'credit_balances'");
      const [[ul]] = await conn.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'usage_logs'");
      res.json({ ok: true, tables: { users: !!u.c, subscriptions: !!s.c, credit_balances: !!b.c, usage_logs: !!ul.c } });
    } finally {
      conn.release();
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ====== MOUNT ROUTERS ======
app.use('/api/kling/v2-5/t2v', t2vRouter);
app.use('/api/kling/v2-5/i2v', i2vRouter);
app.use('/api/seedream/3/t2i', seedreamRouter);
app.use('/api/novita/merge-face', mergeFaceRouter);
app.use('/api/seedream/4/t2i', seedream4Router);

// ====== WEBHOOK: subscription update (z WP) ======
app.post('/webhook/subscription-update', async (req, res) => {
  const payload = req.body || {};
  let conn;
  try {
    let { wp_user_id, email, plan_id, monthly_credit_limit, cycle_start, cycle_end, active } = payload;
    if (!wp_user_id || plan_id === undefined || monthly_credit_limit === undefined || !cycle_start || !cycle_end) {
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    wp_user_id = Number(wp_user_id);
    plan_id = Number(plan_id);
    monthly_credit_limit = Number(monthly_credit_limit);
    active = !!active;

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
    const userId = rows.length ? rows[0].id :
      (await conn.query('INSERT INTO users (wp_user_id, email) VALUES (?, ?)', [wp_user_id, email || null]))[0].insertId;

    await conn.query(
      `INSERT INTO subscriptions (user_id, plan_id, monthly_credit_limit, cycle_start, cycle_end, active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         plan_id = VALUES(plan_id),
         monthly_credit_limit = VALUES(monthly_credit_limit),
         cycle_start = VALUES(cycle_start),
         cycle_end = VALUES(cycle_end),
         active = VALUES(active)`,
      [userId, plan_id, monthly_credit_limit, cycle_start, cycle_end, active]
    );

    await conn.query(
      `INSERT INTO credit_balances (user_id, cycle_start, credits_remaining, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         cycle_start = VALUES(cycle_start),
         credits_remaining = VALUES(credits_remaining),
         updated_at = NOW()`,
      [userId, cycle_start, monthly_credit_limit]
    );

    await conn.commit();
    res.json({ ok: true, user_id: userId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error('subscription-update error', e);
    res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    if (conn) conn.release();
  }
});

// Healthcheck
app.get('/', (_, res) => res.send('TvorAI backend OK'));

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
