// src/server.js — KLING v2.5 (T2V/I2V) + Seedream T2I + Merge Face + kredity/DB (ESM)
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mysql from 'mysql2/promise';
import 'dotenv/config';
import crypto from 'crypto';

// ROUTES
import t2vRouter from './routes/kling-v2-5-turbo-text-to-video.js';
import i2vRouter from './routes/kling-v2-5-turbo-imagine-i2v.js';
import seedreamRouter from './routes/seedream-3-0-txt2img.js';
import mergeFaceRouter from './routes/merge-face.js';
import seedream4Router from './routes/seedream-4-0-txt2img.js';

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' })); // väčší limit kvôli base64 obrázkom

// ====== INTERNAL AUTH (WordPress -> Backend) ======
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireInternalToken(req, res, next) {
  if (!INTERNAL_TOKEN) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED_NO_INTERNAL_TOKEN' });
  }
  const token = req.get('X-Internal-Token');
  if (!timingSafeEqualString(token, INTERNAL_TOKEN)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  return next();
}

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

// --- Keepalive ping každé 4 minúty (Render idle fix) ---
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.warn('⚠️ Keepalive ping failed:', e.message);
  }
}, 1000 * 60 * 4);

// --- DEBUG endpoint ---
app.get('/debug/db', requireInternalToken, async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [[u]] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'"
      );
      const [[s]] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'subscriptions'"
      );
      const [[b]] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'credit_balances'"
      );
      const [[ul]] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'usage_logs'"
      );

      res.json({
        ok: true,
        tables: {
          users: !!u.c,
          subscriptions: !!s.c,
          credit_balances: !!b.c,
          usage_logs: !!ul.c,
        },
      });
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

// ====== PRICING (fallback) ======
const PRICING = {
  kling_v25_i2v_imagine: 36,
  kling_v25_t2v: 36,
  seedream_30_t2i: 12,
  seedream_40_t2i: 12,
  novita_merge_face: 12,
};

function resolveCost(featureType, units = 1) {
  const base = PRICING[featureType];
  if (typeof base !== 'number') return null;
  const u = Math.max(1, Number(units || 1));
  return base * u;
}

// ====== HELPERS ======
async function getOrCreateUserByWpId(conn, wp_user_id, email) {
  const [rows] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
  if (rows.length > 0) return rows[0].id;
  const [ins] = await conn.query('INSERT INTO users (wp_user_id, email) VALUES (?, ?)', [
    wp_user_id,
    email || null,
  ]);
  return ins.insertId;
}

// ====== WEBHOOK: subscription update ======
app.post('/webhook/subscription-update', requireInternalToken, async (req, res) => {
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

    const userId = await getOrCreateUserByWpId(conn, wp_user_id, email);

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
    if (conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    console.error('subscription-update error', e);
    res.status(500).json({ error: 'DB_ERROR', detail: String(e?.message || e) });
  } finally {
    if (conn) conn.release();
  }
});

// ====== CONSUME CREDITS ======
app.post('/consume', requireInternalToken, async (req, res) => {
  let conn;
  try {
    let { wp_user_id, feature_type, credits_spent, metadata, units } = req.body || {};
    if (!credits_spent && feature_type) {
      const computed = resolveCost(feature_type, units);
      if (computed != null) credits_spent = computed;
    }
    if (!wp_user_id || !credits_spent) return res.status(400).json({ error: 'MISSING_FIELDS' });

    wp_user_id = Number(wp_user_id);
    credits_spent = Math.max(0, Number(credits_spent));

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[userRow]] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
    if (!userRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }
    const userId = userRow.id;

    const [[sub]] = await conn.query('SELECT active FROM subscriptions WHERE user_id = ? LIMIT 1', [userId]);
    if (!sub || !sub.active) {
      await conn.rollback();
      return res.status(403).json({ error: 'SUBSCRIPTION_INACTIVE' });
    }

    // Atómový update (race-free)
    const [upd] = await conn.query(
      'UPDATE credit_balances SET credits_remaining = credits_remaining - ?, updated_at = NOW() WHERE user_id = ? AND credits_remaining >= ?',
      [credits_spent, userId, credits_spent]
    );

    if (!upd.affectedRows) {
      const [[bal]] = await conn.query(
        'SELECT credits_remaining FROM credit_balances WHERE user_id = ? LIMIT 1',
        [userId]
      );
      await conn.rollback();
      return res.status(402).json({
        error: 'INSUFFICIENT_CREDITS',
        credits_remaining: bal?.credits_remaining ?? 0,
      });
    }

    await conn.query(
      'INSERT INTO usage_logs (user_id, feature_type, credits_spent, metadata) VALUES (?, ?, ?, CAST(? AS JSON))',
      [userId, feature_type || 'generic', credits_spent, JSON.stringify(metadata || { units: units || 1 })]
    );

    const [[after]] = await conn.query('SELECT credits_remaining FROM credit_balances WHERE user_id = ? LIMIT 1', [
      userId,
    ]);

    await conn.commit();
    res.json({ ok: true, credits_remaining: after.credits_remaining });
  } catch (e) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    console.error('consume error', e);
    res.status(500).json({ error: 'DB_ERROR', detail: String(e?.message || e) });
  } finally {
    if (conn) conn.release();
  }
});

// ====== USAGE ======
app.get('/usage/:wp_user_id', requireInternalToken, async (req, res) => {
  try {
    const wp_user_id = Number(req.params.wp_user_id);
    const conn = await pool.getConnection();
    try {
      const [[userRow]] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
      if (!userRow) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      const userId = userRow.id;

      const [[sub]] = await conn.query(
        'SELECT plan_id, monthly_credit_limit, active, cycle_end FROM subscriptions WHERE user_id = ? LIMIT 1',
        [userId]
      );
      const [[bal]] = await conn.query(
        'SELECT credits_remaining, cycle_start FROM credit_balances WHERE user_id = ? LIMIT 1',
        [userId]
      );

      res.json({
        wp_user_id,
        plan_id: sub ? sub.plan_id : null,
        monthly_credit_limit: sub ? sub.monthly_credit_limit : 0,
        active: sub ? !!sub.active : false,
        credits_remaining: bal ? bal.credits_remaining : 0,
        cycle_start: bal ? bal.cycle_start : null,
        cycle_end: sub ? sub.cycle_end : null,
      });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('usage error', e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Healthcheck
app.get('/', (_req, res) => res.send('TvorAI backend OK'));

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
