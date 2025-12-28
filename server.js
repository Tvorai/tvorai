// server.js — TVORAI backend (Render-safe, no Stripe SDK)
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mysql from 'mysql2/promise';
import 'dotenv/config';

// ROUTES
import t2vRouter from './routes/kling-v2-5-turbo-text-to-video.js';
import i2vRouter from './routes/kling-v2-5-turbo-imagine-i2v.js';
import seedreamRouter from './routes/seedream-3-0-txt2img.js';
import mergeFaceRouter from './routes/merge-face.js';
import seedream4Router from './routes/seedream-4-0-txt2img.js';

const app = express();

/**
 * ====== MIDDLEWARE ======
 */
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' })); // ⚠️ DÔLEŽITÉ (Elementor + base64)

/**
 * ====== DB POOL ======
 */
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

/**
 * ====== DB DEBUG ======
 */
pool.on('connection', (conn) => {
  console.log('✅ New MySQL connection');
  conn.on('error', (err) => console.error('⚠️ MySQL error:', err.message));
  conn.on('end', () => console.warn('⚠️ MySQL connection ended'));
});

// DB ping on boot
try {
  const [rows] = await pool.query('SELECT 1 AS ok');
  console.log('DB ping OK:', rows[0]?.ok === 1);
} catch (e) {
  console.error('DB ping FAILED:', e?.message || e);
}

// Keepalive (Render idle fix)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.warn('⚠️ Keepalive ping failed:', e.message);
  }
}, 1000 * 60 * 4);

/**
 * ====== HELPERS ======
 */
async function getOrCreateUserByWpId(conn, wp_user_id, email) {
  const [rows] = await conn.query(
    'SELECT id FROM users WHERE wp_user_id = ? LIMIT 1',
    [wp_user_id]
  );
  if (rows.length > 0) return rows[0].id;

  const [ins] = await conn.query(
    'INSERT INTO users (wp_user_id, email) VALUES (?, ?)',
    [wp_user_id, email || null]
  );
  return ins.insertId;
}

/**
 * ====== ROUTES (AI) ======
 */
app.use('/api/kling/v2-5/t2v', t2vRouter);
app.use('/api/kling/v2-5/i2v', i2vRouter);
app.use('/api/seedream/3/t2i', seedreamRouter);
app.use('/api/novita/merge-face', mergeFaceRouter);
app.use('/api/seedream/4/t2i', seedream4Router);

/**
 * ====== WEBHOOK: subscription update (z WordPressu)
 * URL: POST /webhook/subscription-update
 */
app.post('/webhook/subscription-update', async (req, res) => {
  const payload = req.body || {};
  let conn;

  try {
    let {
      wp_user_id,
      email,
      plan_id,
      monthly_credit_limit,
      cycle_start,
      cycle_end,
      active,
    } = payload;

    if (
      !wp_user_id ||
      plan_id === undefined ||
      monthly_credit_limit === undefined ||
      !cycle_start ||
      !cycle_end
    ) {
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    wp_user_id = Number(wp_user_id);
    plan_id = Number(plan_id);
    monthly_credit_limit = Number(monthly_credit_limit);
    active = !!active;

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const userId = await getOrCreateUserByWpId(conn, wp_user_id, email);

    await conn.query(
      `INSERT INTO subscriptions
        (user_id, plan_id, monthly_credit_limit, cycle_start, cycle_end, active)
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
      `INSERT INTO credit_balances
        (user_id, cycle_start, credits_remaining, updated_at)
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
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error('subscription-update error', e);
    res.status(500).json({ error: 'DB_ERROR', detail: String(e?.message || e) });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * ====== CONSUME CREDITS ======
 */
app.post('/consume', async (req, res) => {
  let conn;

  try {
    let { wp_user_id, feature_type, credits_spent, metadata } = req.body || {};
    if (!wp_user_id || !credits_spent) {
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    wp_user_id = Number(wp_user_id);
    credits_spent = Math.max(0, Number(credits_spent));

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[userRow]] = await conn.query(
      'SELECT id FROM users WHERE wp_user_id = ? LIMIT 1',
      [wp_user_id]
    );
    if (!userRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }

    const userId = userRow.id;

    const [[sub]] = await conn.query(
      'SELECT active FROM subscriptions WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!sub || !sub.active) {
      await conn.rollback();
      return res.status(403).json({ error: 'SUBSCRIPTION_INACTIVE' });
    }

    const [[bal]] = await conn.query(
      'SELECT credits_remaining FROM credit_balances WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!bal || bal.credits_remaining < credits_spent) {
      await conn.rollback();
      return res.status(402).json({ error: 'INSUFFICIENT_CREDITS' });
    }

    await conn.query(
      'UPDATE credit_balances SET credits_remaining = credits_remaining - ?, updated_at = NOW() WHERE user_id = ?',
      [credits_spent, userId]
    );

    await conn.query(
      'INSERT INTO usage_logs (user_id, feature_type, credits_spent, metadata) VALUES (?, ?, ?, CAST(? AS JSON))',
      [userId, feature_type || 'generic', credits_spent, JSON.stringify(metadata || {})]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error('consume error', e);
    res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * ====== HEALTH ======
 */
app.get('/', (_, res) => res.send('TvorAI backend OK'));

/**
 * ====== START ======
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
