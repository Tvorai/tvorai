// server.js
import express from "express";
import cors from "cors";
import helmet from "helmet";
import mysql from "mysql2/promise";
import dotenv from "dotenv";


import klingImagineRoutes from "./routes/kling-v2-5-turbo-imagine-i2v.js";
import klingV25TurboT2VRoutes from "./routes/kling-v2-5-turbo-text-to-video.js";

// Načítaj .env (lokálne). Na Renderi ide z Environment Variables.
dotenv.config();

// ===== DB CONFIG =================================================
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
};

let db;
async function initDB() {
  db = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  console.log("✅ DB pool ready");
}

// ===== EXPRESS APP ==============================================
const app = express();
const PORT = process.env.PORT || 8080;

// security headers
app.use(helmet());

// CORS – povoľujeme tvoj web
app.use(
  cors({
    origin: "https://tvorai.developerska.eu/",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// preflight
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://tvorai.developerska.eu/");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res.sendStatus(200);
});

// ⬆️ DÔLEŽITÉ: väčší limit kvôli base64 (10 MB súbor ≈ 13–14 MB base64)
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ===== HELPERS ==================================================
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

  if (!subs.length) {
    return { subscription: null, balance: null };
  }

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

// ===== /consume =================================================
//
// Request body:
// { wp_user_id, feature_type, estimated_cost?, metadata? }
//
app.post("/consume", async (req, res) => {
  try {
    const { wp_user_id, feature_type, estimated_cost, metadata } = req.body || {};

    if (!wp_user_id || !feature_type) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        details: "wp_user_id and feature_type are required",
      });
    }

    // fallback cenník
    const PRICING = {
      translate_text: 10,
      gemini_chat: 5,
      heygen_video: 200,
      voice_tts: 2,
      photo_avatar: 50,
      kling_video: 250,           // fallback
      test_feature: 10,
      kling_v21_t2v: 300,
      kling_v25_i2v_imagine: 300, // fallback, ak by neprišli metadata

      // ✅ NOVÉ: V2.5 Turbo T2V fallback
      kling_v25_t2v: 320
    };

    let finalCost;

    // A) explicitná cena z WP
    if (typeof estimated_cost === "number" && Number.isFinite(estimated_cost)) {
      finalCost = Math.max(0, Math.floor(estimated_cost));
    } else {
      // B) KLING V2.5 I2V – podľa ratio + duration
      if (feature_type === "kling_v25_i2v_imagine" && metadata) {
        const d = Number(metadata.duration);
        const r = String(metadata.aspect_ratio || "").trim();
        const TABLE = {
          "1:1":  { 5: 280, 10: 680 },
          "16:9": { 5: 300, 10: 700 },
          "9:16": { 5: 320, 10: 740 },
        };
        if (TABLE[r] && TABLE[r][d]) {
          finalCost = TABLE[r][d];
        }
      }

      // ✅ B2) KLING V2.5 Turbo T2V – podľa ratio + duration
      if (typeof finalCost === "undefined" && feature_type === "kling_v25_t2v" && metadata) {
        const d = Number(metadata.duration);
        const r = String(metadata.aspect_ratio || "").trim();
        const TABLE_T2V = {
          "1:1":  { 5: 300, 10: 700 },
          "16:9": { 5: 320, 10: 720 },
          "9:16": { 5: 340, 10: 760 },
        };
        if (TABLE_T2V[r] && TABLE_T2V[r][d]) {
          finalCost = TABLE_T2V[r][d];
        }
      }

      // C) existujúce pravidlo pre "kling_video" podľa dĺžky
      if (typeof finalCost === "undefined" && feature_type === "kling_video" && metadata?.duration) {
        const d = Number(metadata.duration);
        if (d === 5) finalCost = 200;
        else if (d === 10) finalCost = 500;
      }

      // D) fallback tabuľka
      if (typeof finalCost === "undefined") {
        finalCost = PRICING[feature_type];
      }
    }

    if (typeof finalCost === "undefined") {
      return res.status(400).json({
        error: "UNKNOWN_FEATURE_TYPE",
        details: `No pricing rule for feature_type=${feature_type} and no usable estimated_cost`,
      });
    }

    // 1) user
    const user = await getUserByWpId(wp_user_id);
    if (!user) {
      return res.status(400).json({ error: "USER_NOT_FOUND" });
    }

    // 2) subscription + balance
    const { subscription, balance } = await getActiveSubscriptionAndBalance(user.id);

    if (!subscription || !subscription.active) {
      return res.status(403).json({ error: "NO_ACTIVE_SUBSCRIPTION" });
    }

    if (!balance) {
      return res.status(400).json({ error: "NO_BALANCE_RECORD" });
    }

    // 3) dosť kreditov?
    if (balance.credits_remaining < finalCost) {
      return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });
    }

    // 4) transakčne odpíš
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [balRows] = await connection.execute(
        "SELECT * FROM credit_balances WHERE id = ? FOR UPDATE",
        [balance.id]
      );

      if (!balRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ error: "BALANCE_NOT_FOUND_AGAIN" });
      }

      const currentBalance = balRows[0];

      if (currentBalance.credits_remaining < finalCost) {
        await connection.rollback();
        connection.release();
        return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });
      }

      const newBalance = currentBalance.credits_remaining - Number(finalCost);

      // update credit_balances
      await connection.execute(
        "UPDATE credit_balances SET credits_remaining = ?, updated_at = NOW() WHERE id = ?",
        [newBalance, currentBalance.id]
      );

      // insert usage_logs
      await connection.execute(
        "INSERT INTO usage_logs (user_id, feature_type, credits_spent, metadata) VALUES (?, ?, ?, ?)",
        [user.id, feature_type, finalCost, metadata ? JSON.stringify(metadata) : null]
      );

      await connection.commit();
      connection.release();

      return res.json({
        ok: true,
        credits_remaining: newBalance,
        charged: finalCost,
      });
    } catch (err) {
      await connection.rollback();
      connection.release();
      console.error("TX ERROR", err.message, err.stack);
      return res.status(500).json({ error: "TX_FAILED", detail: err.message });
    }
  } catch (err) {
    console.error("consume error", err.message, err.stack);
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// ===== /usage/:wp_user_id =========================================
app.get("/usage/:wp_user_id", async (req, res) => {
  try {
    const { wp_user_id } = req.params;

    const user = await getUserByWpId(wp_user_id);
    if (!user) {
      return res.status(400).json({ error: "USER_NOT_FOUND" });
    }

    const { subscription, balance } = await getActiveSubscriptionAndBalance(user.id);

    if (!subscription) {
      return res.status(404).json({ error: "NO_ACTIVE_SUBSCRIPTION" });
    }

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
    console.error("usage error", err.message, err.stack);
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// ===== /webhook/subscription-update ===============================
app.post("/webhook/subscription-update", async (req, res) => {
  try {
    const {
      wp_user_id,
      email,
      plan_id,
      monthly_credit_limit,
      cycle_start,
      cycle_end,
      active,
    } = req.body;

    if (!wp_user_id || !plan_id || !monthly_credit_limit || !cycle_start || !cycle_end) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        details: "wp_user_id, plan_id, monthly_credit_limit, cycle_start, cycle_end are required",
      });
    }

    // 1. user existuje?
    let user = await getUserByWpId(wp_user_id);

    if (!user) {
      const [result] = await db.execute(
        "INSERT INTO users (wp_user_id, email) VALUES (?, ?)",
        [wp_user_id, email || null]
      );
      const insertedId = result.insertId;
      const [rows] = await db.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [insertedId]);
      user = rows[0];
    } else {
      if (email && email !== user.email) {
        await db.execute("UPDATE users SET email = ? WHERE id = ?", [email, user.id]);
      }
    }

    // 2. subscriptions upsert
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

    // 3. credit_balances upsert
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
    console.error("webhook error", err.message, err.stack);
    return res.status(500).json({ error: "SERVER_ERROR", detail: err.message });
  }
});

// ===== ROUTES: AI services =======================================
app.use("/", deeplRoutes);
app.use("/", elevenRoutes);
app.use("/", geminiRoutes);
app.use("/", heygenRoutes);
app.use("/", photoAvatarRoutes);
app.use("/", klingRoutes);            // text->video
app.use("/", klingI2vRoutes);         // image->video
app.use("/", klingV21MasterRoutes);   // text->video (V2.1 Master, 9:16/1:1/16:9)
app.use("/api", klingImagineRoutes);  // V2.5 Imagine I2V

// ✅ NOVÉ: mount pre V2.5 Turbo T2V
app.use("/api", klingV25TurboT2VRoutes); // POST /kling-v25-t2v/generate, GET /kling-v25-t2v/status/:taskId

// ===== START SERVER ==============================================
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 API gateway running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB INIT FAILED", err.message, err.stack);
    process.exit(1);
  });
