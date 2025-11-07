// server.js — tvor-ai (len KLING v2.5 T2V + I2V) + DB zachovaná
import express from "express";
import cors from "cors";
import helmet from "helmet";
import mysql from "mysql2/promise";
import "dotenv/config";

// PONECHANÉ IBA TIETO DVE ROUTY
import t2vRouter from "./routes/kling-v2-5-turbo-text-to-video.js";
import i2vRouter from "./routes/kling-v2-5-turbo-imagine-i2v.js";

// ===== DB CONFIG (MySQL 8.0) ====================================
// Primárne ber z ENV (Render → Environment), ale fallback na tvoje hodnoty:
const DB_HOST_RAW = process.env.DB_HOST || "db.r6.websupport.sk:3314";
const [DB_HOST, DB_PORT_STR] = DB_HOST_RAW.split(":");
const DB_PORT = Number(DB_PORT_STR || "3314");

const dbConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: process.env.DB_USER || "dXySARjj",
  password: process.env.DB_PASS || "Ps040121@",
  database: process.env.DB_NAME || "dXySARjj",
  // Ak provider vyžaduje TLS, zapni cez ENV DB_SSL=true
  ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}),
};

let db;
async function initDB() {
  db = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // MySQL 8.0 je OK; mysql2 to zistí automaticky
  });
  console.log("✅ DB pool ready", {
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    db: dbConfig.database,
    ssl: !!dbConfig.ssl,
  });
}

// ===== EXPRESS APP ==============================================
const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(cors()); // zjednodušené; ak chceš, zúž na tvoje domény
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));

// ===== HEALTH ====================================================
app.get("/health", (_req, res) => res.json({ ok: true, service: "tvor-ai" }));

app.get("/health/db", async (_req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "DB_NOT_READY" });
    const [r] = await db.query("SELECT 1 AS ok");
    res.json({ ok: true, result: r });
  } catch (err) {
    res.status(500).json({
      ok: false,
      code: err?.code,
      errno: err?.errno,
      message: err?.message,
      sqlMessage: err?.sqlMessage,
    });
  }
});

// ===== HELPERS (NECHANÉ) ========================================
// načíta z tab. users podľa wp_user_id
async function getUserByWpId(wp_user_id) {
  const [rows] = await db.execute(
    "SELECT * FROM users WHERE wp_user_id = ? LIMIT 1",
    [wp_user_id]
  );
  return rows.length ? rows[0] : null;
}

// načíta aktívne predplatné + kredity
async function getActiveSubscriptionAndBalance(user_id) {
  const [subs] = await db.execute(
    `SELECT * FROM subscriptions
     WHERE user_id = ? AND active = 1
     ORDER BY id DESC
     LIMIT 1`,
    [user_id]
  );

  if (!subs.length) return { subscription: null, balance: null };
  const subscription = subs[0];

  const [balances] = await db.execute(
    `SELECT * FROM credit_balances
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [user_id]
  );

  const balance = balances.length ? balances[0] : null;
  return { subscription, balance };
}

// ===== API ENDPOINTS S DB (NECHANÉ) =============================
// /consume — odpočet kreditov
app.post("/consume", async (req, res) => {
  try {
    const { wp_user_id, feature_type, estimated_cost, metadata } = req.body || {};
    if (!wp_user_id || !feature_type) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // fallback cenník (ponechaný, uprav si podľa potrieb)
    const PRICING = {
      kling_v25_i2v_imagine: 300,
      kling_v25_t2v: 320,
    };

    let finalCost;
    if (typeof estimated_cost === "number" && Number.isFinite(estimated_cost)) {
      finalCost = Math.max(0, Math.floor(estimated_cost));
    } else if (feature_type === "kling_v25_i2v_imagine" && metadata) {
      const d = Number(metadata.duration);
      const r = String(metadata.aspect_ratio || "").trim();
      const T = { "1:1": { 5: 280, 10: 680 }, "16:9": { 5: 300, 10: 700 }, "9:16": { 5: 320, 10: 740 } };
      if (T[r] && T[r][d]) finalCost = T[r][d];
    } else if (feature_type === "kling_v25_t2v" && metadata) {
      const d = Number(metadata.duration);
      const r = String(metadata.aspect_ratio || "").trim();
      const T = { "1:1": { 5: 300, 10: 700 }, "16:9": { 5: 320, 10: 720 }, "9:16": { 5: 340, 10: 760 } };
      if (T[r] && T[r][d]) finalCost = T[r][d];
    } else {
      finalCost = PRICING[feature_type];
    }

    if (typeof finalCost === "undefined") {
      return res.status(400).json({ error: "UNKNOWN_FEATURE_TYPE" });
    }

    const user = await getUserByWpId(wp_user_id);
    if (!user) return res.status(400).json({ error: "USER_NOT_FOUND" });

    const { subscription, balance } = await getActiveSubscriptionAndBalance(user.id);
    if (!subscription || !subscription.active) return res.status(403).json({ error: "NO_ACTIVE_SUBSCRIPTION" });
    if (!balance) return res.status(400).json({ error: "NO_BALANCE_RECORD" });
    if (balance.credits_remaining < finalCost) return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [balRows] = await conn.execute(
        "SELECT * FROM credit_balances WHERE id = ? FOR UPDATE",
        [balance.id]
      );
      if (!balRows.length) {
        await conn.rollback(); conn.release();
        return res.status(400).json({ error: "BALANCE_NOT_FOUND_AGAIN" });
      }
      const currentBalance = balRows[0];
      if (currentBalance.credits_remaining < finalCost) {
        await conn.rollback(); conn.release();
        return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });
      }

      const newBalance = currentBalance.credits_remaining - Number(finalCost);

      await conn.execute(
        "UPDATE credit_balances SET credits_remaining = ?, updated_at = NOW() WHERE id = ?",
        [newBalance, currentBalance.id]
      );
      await conn.execute(
        "INSERT INTO usage_logs (user_id, feature_type, credits_spent, metadata) VALUES (?, ?, ?, ?)",
        [user.id, feature_type, finalCost, metadata ? JSON.stringify(metadata) : null]
      );

      await conn.commit();
      conn.release();

      return res.json({ ok: true, credits_remaining: newBalance, charged: finalCost });
    } catch (err) {
      await conn.rollback(); conn.release();
      return res.status(500).json({ error: "TX_FAILED", detail: err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// /usage/:wp_user_id — prehľad
app.get("/usage/:wp_user_id", async (req, res) => {
  try {
    const { wp_user_id } = req.params;
    const user = await getUserByWpId(wp_user_id);
    if (!user) return res.status(400).json({ error: "USER_NOT_FOUND" });

    const { subscription, balance } = await getActiveSubscriptionAndBalance(user.id);
    if (!subscription) return res.status(404).json({ error: "NO_ACTIVE_SUBSCRIPTION" });

    const [logs] = await db.execute(
      `SELECT timestamp, feature_type, credits_spent
       FROM usage_logs
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 10`,
      [user.id]
    );

    return res.json({
      plan_id: subscription.plan_id,
      credits_remaining: balance ? balance.credits_remaining : 0,
      monthly_credit_limit: subscription.monthly_credit_limit,
      cycle_end: subscription.cycle_end,
      recent_usage: logs,
    });
  } catch (err) {
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// /webhook/subscription-update — upsert z MemberPress
app.post("/webhook/subscription-update", async (req, res) => {
  try {
    const { wp_user_id, email, plan_id, monthly_credit_limit, cycle_start, cycle_end, active } = req.body;

    if (!wp_user_id || !plan_id || !monthly_credit_limit || !cycle_start || !cycle_end) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // user
    let user = await getUserByWpId(wp_user_id);
    if (!user) {
      const [result] = await db.execute(
        "INSERT INTO users (wp_user_id, email) VALUES (?, ?)",
        [wp_user_id, email || null]
      );
      const insertedId = result.insertId;
      const [rows] = await db.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [insertedId]);
      user = rows[0];
    } else if (email && email !== user.email) {
      await db.execute("UPDATE users SET email = ? WHERE id = ?", [email, user.id]);
    }

    // subscriptions upsert
    await db.execute(
      `INSERT INTO subscriptions
        (user_id, plan_id, monthly_credit_limit, cycle_start, cycle_end, active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        plan_id = VALUES(plan_id),
        monthly_credit_limit = VALUES(monthly_credit_limit),
        cycle_start = VALUES(cycle_start),
        cycle_end = VALUES(cycle_end),
        active = VALUES(active)`,
      [user.id, plan_id, monthly_credit_limit, cycle_start, cycle_end, active ? 1 : 0]
    );

    // credit_balances upsert
    await db.execute(
      `INSERT INTO credit_balances
        (user_id, cycle_start, credits_remaining, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
        cycle_start = VALUES(cycle_start),
        credits_remaining = VALUES(credits_remaining),
        updated_at = NOW()`,
      [user.id, cycle_start, monthly_credit_limit]
    );

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// ===== ROUTES: KLING v2.5 ========================================
// T2V
//  POST /api/kling-v25-t2v/generate
//  GET  /api/kling-v25-t2v/status/:taskId
app.use("/api", t2vRouter);

// I2V Imagine
//  POST /api/kling-v25-i2v/generate
//  GET  /api/kling-v25-i2v/status/:taskId
app.use("/api", i2vRouter);

// 404 & error
app.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: "SERVER_ERROR", details: err.message || String(err) });
});

// ===== START =====================================================
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 tvor-ai on http://0.0.0.0:${PORT}`));
  })
  .catch((err) => {
    console.error("DB INIT FAILED", err.message);
    process.exit(1);
  });
