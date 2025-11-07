// server.js — TvorAI (KLING v2.5 T2V + I2V) + kredity/DB
conn.release();
}
} catch (err) {
console.error('consume outer error', err);
res.status(500).json({ error: 'SERVER_ERROR' });
}
});


wp_user_id = Number(wp_user_id);
credits_spent = Math.max(0, Number(credits_spent));


const conn = await pool.getConnection();
try {
await conn.beginTransaction();


const [[userRow]] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
if (!userRow) { await conn.rollback(); return res.status(404).json({ error: 'USER_NOT_FOUND' }); }
const userId = userRow.id;


const [[sub]] = await conn.query('SELECT active FROM subscriptions WHERE user_id = ? LIMIT 1', [userId]);
if (!sub || !sub.active) { await conn.rollback(); return res.status(403).json({ error: 'SUBSCRIPTION_INACTIVE' }); }


const [[bal]] = await conn.query('SELECT credits_remaining FROM credit_balances WHERE user_id = ? LIMIT 1', [userId]);
if (!bal) { await conn.rollback(); return res.status(404).json({ error: 'BALANCE_NOT_FOUND' }); }


if (bal.credits_remaining < credits_spent) {
await conn.rollback();
return res.status(402).json({ error: 'INSUFFICIENT_CREDITS', credits_remaining: bal.credits_remaining });
}


await conn.query('UPDATE credit_balances SET credits_remaining = credits_remaining - ?, updated_at = NOW() WHERE user_id = ?', [credits_spent, userId]);
await conn.query(
'INSERT INTO usage_logs (user_id, feature_type, credits_spent, metadata) VALUES (?, ?, ?, CAST(? AS JSON))',
[userId, feature_type || 'generic', credits_spent, JSON.stringify(metadata || {})]
);


const [[after]] = await conn.query('SELECT credits_remaining FROM credit_balances WHERE user_id = ? LIMIT 1', [userId]);


await conn.commit();
res.json({ ok: true, credits_remaining: after.credits_remaining });
} catch (e) {
await conn.rollback();
console.error('consume error', e);
res.status(500).json({ error: 'DB_ERROR', detail: String(e?.message || e) });
} finally {
conn.release();
}
} catch (err) {
console.error('consume outer error', err);
res.status(500).json({ error: 'SERVER_ERROR' });
}
});


// ====== USAGE ======
app.get('/usage/:wp_user_id', async (req, res) => {
try {
const wp_user_id = Number(req.params.wp_user_id);
const conn = await pool.getConnection();
try {
const [[userRow]] = await conn.query('SELECT id FROM users WHERE wp_user_id = ? LIMIT 1', [wp_user_id]);
if (!userRow) return res.status(404).json({ error: 'USER_NOT_FOUND' });
const userId = userRow.id;


const [[sub]] = await conn.query('SELECT plan_id, monthly_credit_limit, active FROM subscriptions WHERE user_id = ? LIMIT 1', [userId]);
const [[bal]] = await conn.query('SELECT credits_remaining, cycle_start FROM credit_balances WHERE user_id = ? LIMIT 1', [userId]);


res.json({
wp_user_id,
plan_id: sub ? sub.plan_id : null,
monthly_credit_limit: sub ? sub.monthly_credit_limit : 0,
active: sub ? !!sub.active : false,
credits_remaining: bal ? bal.credits_remaining : 0,
cycle_start: bal ? bal.cycle_start : null,
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
app.get('/', (_, res) => res.send('TvorAI backend OK'));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
