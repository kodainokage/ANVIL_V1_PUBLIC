const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const discovery = require('./discovery');
const contentGen = require('./content-generator');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const API_KEY = (() => {
  const key = process.env.API_KEY;
  if (!key || key === 'dev-key-change-in-production') {
    if (NODE_ENV === 'production') {
      console.error('[FATAL] API_KEY must be set to a strong secret in production. Exiting.');
      process.exit(1);
    }
    console.warn('[WARN] Using insecure default API_KEY — do NOT use in production');
    return 'dev-key-change-in-production';
  }
  return key;
})();
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'anvil.db');
const NICHES_FILE = path.join(__dirname, 'niches.json');

// ── SQLite Database Setup ──────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    answers TEXT DEFAULT '[]',
    recommended_niches TEXT DEFAULT '[]',
    referral_code TEXT,
    referred_by TEXT DEFAULT '',
    utm_source TEXT DEFAULT '',
    utm_medium TEXT DEFAULT '',
    utm_campaign TEXT DEFAULT '',
    ip TEXT DEFAULT 'unknown',
    submitted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    page TEXT DEFAULT '',
    data TEXT DEFAULT '{}',
    fingerprint TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_code TEXT NOT NULL,
    referred_page TEXT DEFAULT '',
    fingerprint TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS testimonials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    niche TEXT DEFAULT '',
    rating INTEGER DEFAULT 5,
    approved INTEGER DEFAULT 0,
    submitted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS graduates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    niche TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    joined_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS niche_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT DEFAULT '',
    source_data TEXT DEFAULT '{}',
    category TEXT DEFAULT '',
    score_demand INTEGER DEFAULT 0,
    score_pain INTEGER DEFAULT 0,
    score_competition INTEGER DEFAULT 0,
    score_ai_leverage INTEGER DEFAULT 0,
    score_composite INTEGER DEFAULT 0,
    draft_niche_json TEXT DEFAULT '{}',
    draft_playbook TEXT DEFAULT '',
    draft_quiz_tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'new',
    admin_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    results_found INTEGER DEFAULT 0,
    new_candidates INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    error TEXT DEFAULT '',
    scanned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS niche_intelligence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    period TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_unique ON niche_intelligence(niche_id, metric, period);

  CREATE TABLE IF NOT EXISTS niche_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche_id TEXT NOT NULL,
    niche_name TEXT NOT NULL,
    category TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- ANVIL Kids tables
  CREATE TABLE IF NOT EXISTS kids_children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    age_group TEXT NOT NULL CHECK(age_group IN ('explorer','builder')),
    birth_year INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (parent_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS kids_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_customer_id TEXT,
    stripe_sub_id TEXT,
    plan TEXT NOT NULL DEFAULT 'trial',
    status TEXT NOT NULL DEFAULT 'trialing',
    trial_ends_at TEXT,
    current_period_end TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS kids_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    path_id TEXT NOT NULL,
    quest_index INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    started_at TEXT NOT NULL,
    last_activity TEXT,
    completed_at TEXT,
    FOREIGN KEY (child_id) REFERENCES kids_children(id)
  );
  CREATE TABLE IF NOT EXISTS kids_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    path_id TEXT NOT NULL,
    quest_index INTEGER NOT NULL,
    artifact_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_public INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES kids_children(id)
  );
  CREATE TABLE IF NOT EXISTS kids_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    xp_earned INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES kids_children(id)
  );
  CREATE TABLE IF NOT EXISTS kids_referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_user_id INTEGER NOT NULL,
    referred_email TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    redeemed_by INTEGER,
    redeemed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (referrer_user_id) REFERENCES users(id)
  );
`);

// Migrate existing JSON data into SQLite (one-time, idempotent)
function migrateJsonToDb() {
  const jsonFiles = {
    submissions: path.join(DATA_DIR, 'submissions.json'),
    analytics: path.join(DATA_DIR, 'analytics.json'),
    referrals: path.join(DATA_DIR, 'referrals.json'),
    testimonials: path.join(DATA_DIR, 'testimonials.json'),
    graduates: path.join(DATA_DIR, 'graduates.json')
  };

  // Migrate each table independently (idempotent per-table check)
  // Bug fix: checking only submissions count caused analytics/referrals/testimonials/graduates
  // to be skipped forever once a single submission existed — data loss on restart after first use.

  for (const [table, filePath] of Object.entries(jsonFiles)) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data) || data.length === 0) continue;

      // Per-table idempotency check: skip only if this specific table already has data
      // Use allowlisted table names only (never interpolate user input into SQL)
      const allowedTables = { submissions: 1, analytics: 1, referrals: 1, testimonials: 1, graduates: 1 };
      if (!allowedTables[table]) continue;
      const countStmts = {
        submissions: db.prepare('SELECT COUNT(*) as c FROM submissions'),
        analytics: db.prepare('SELECT COUNT(*) as c FROM analytics'),
        referrals: db.prepare('SELECT COUNT(*) as c FROM referrals'),
        testimonials: db.prepare('SELECT COUNT(*) as c FROM testimonials'),
        graduates: db.prepare('SELECT COUNT(*) as c FROM graduates'),
      };
      const tableCount = countStmts[table].get().c;
      if (tableCount > 0) {
        console.log(`[DB] Skipping ${table}.json migration — table already has ${tableCount} records`);
        continue;
      }

      if (table === 'submissions') {
        const stmt = db.prepare(`INSERT OR IGNORE INTO submissions (id, name, email, phone, answers, recommended_niches, referral_code, referred_by, utm_source, utm_medium, utm_campaign, ip, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.id, r.name, r.email, r.phone || '', JSON.stringify(r.answers || []), JSON.stringify(r.recommendedNiches || []), r.referralCode, r.referredBy || '', r.utmSource || '', r.utmMedium || '', r.utmCampaign || '', r.ip || 'unknown', r.submittedAt); });
        tx(data);
      } else if (table === 'analytics') {
        const stmt = db.prepare(`INSERT INTO analytics (event, page, data, fingerprint, timestamp) VALUES (?, ?, ?, ?, ?)`);
        const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.event, r.page || '', JSON.stringify(r.data || {}), r.fingerprint, r.timestamp); });
        tx(data);
      } else if (table === 'referrals') {
        const stmt = db.prepare(`INSERT INTO referrals (referral_code, referred_page, fingerprint, timestamp) VALUES (?, ?, ?, ?)`);
        const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.referralCode, r.referredPage || '', r.fingerprint, r.timestamp); });
        tx(data);
      } else if (table === 'testimonials') {
        const stmt = db.prepare(`INSERT OR IGNORE INTO testimonials (id, name, text, niche, rating, approved, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.id, r.name, r.text, r.niche || '', r.rating || 5, r.approved ? 1 : 0, r.submittedAt); });
        tx(data);
      } else if (table === 'graduates') {
        const stmt = db.prepare(`INSERT OR IGNORE INTO graduates (id, name, niche, city, state, joined_at) VALUES (?, ?, ?, ?, ?, ?)`);
        const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.id, r.name, r.niche || '', r.city || '', r.state || '', r.joinedAt); });
        tx(data);
      }
      console.log(`[DB] Migrated ${data.length} records from ${table}.json`);
    } catch (err) {
      console.error(`[DB] Migration failed for ${table}:`, err.message);
    }
  }
}
migrateJsonToDb();

// Initialize auth tables
auth.initAuthTables(db);

console.log(`[DB] SQLite database ready at ${DB_PATH}`);

// Prepared statements (cached for performance)
const stmts = {
  insertSubmission: db.prepare(`INSERT INTO submissions (id, name, email, phone, answers, recommended_niches, referral_code, referred_by, utm_source, utm_medium, utm_campaign, ip, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getSubmissions: db.prepare(`SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 1000`),
  getSubmissionById: db.prepare(`SELECT * FROM submissions WHERE id = ?`),
  getSubmissionByReferral: db.prepare(`SELECT id FROM submissions WHERE referral_code = ? LIMIT 1`),
  insertAnalytics: db.prepare(`INSERT INTO analytics (event, page, data, fingerprint, timestamp) VALUES (?, ?, ?, ?, ?)`),
  getAnalytics: db.prepare(`SELECT * FROM analytics ORDER BY timestamp DESC`),
  insertReferral: db.prepare(`INSERT INTO referrals (referral_code, referred_page, fingerprint, timestamp) VALUES (?, ?, ?, ?)`),
  getReferrals: db.prepare(`SELECT * FROM referrals ORDER BY timestamp DESC`),
  getReferralCounts: db.prepare(`SELECT referral_code, COUNT(*) as count FROM referrals GROUP BY referral_code ORDER BY count DESC LIMIT 10`),
  getReferralCountByCode: db.prepare(`SELECT COUNT(*) as count FROM referrals WHERE referral_code = ?`),
  insertTestimonial: db.prepare(`INSERT INTO testimonials (id, name, text, niche, rating, approved, submitted_at) VALUES (?, ?, ?, ?, ?, 0, ?)`),
  getApprovedTestimonials: db.prepare(`SELECT * FROM testimonials WHERE approved = 1 ORDER BY submitted_at DESC`),
  getAllTestimonials: db.prepare(`SELECT * FROM testimonials ORDER BY submitted_at DESC`),
  approveTestimonial: db.prepare(`UPDATE testimonials SET approved = 1 WHERE id = ?`),
  insertGraduate: db.prepare(`INSERT INTO graduates (id, name, niche, city, state, joined_at) VALUES (?, ?, ?, ?, ?, ?)`),
  getGraduates: db.prepare(`SELECT * FROM graduates ORDER BY joined_at DESC`),
  // Discovery & Intelligence
  insertCandidate: db.prepare(`INSERT OR IGNORE INTO niche_candidates (slug, title, source, source_url, source_data, category, score_demand, score_pain, score_competition, score_ai_leverage, score_composite, draft_niche_json, draft_playbook, draft_quiz_tags, status, admin_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', ?, ?)`),
  getCandidates: db.prepare(`SELECT * FROM niche_candidates ORDER BY score_composite DESC`),
  getCandidatesByStatus: db.prepare(`SELECT * FROM niche_candidates WHERE status = ? ORDER BY score_composite DESC`),
  getCandidateById: db.prepare(`SELECT * FROM niche_candidates WHERE id = ?`),
  getCandidateBySlug: db.prepare(`SELECT id FROM niche_candidates WHERE slug = ?`),
  updateCandidateStatus: db.prepare(`UPDATE niche_candidates SET status = ?, admin_notes = ?, updated_at = ? WHERE id = ?`),
  updateCandidateDrafts: db.prepare(`UPDATE niche_candidates SET draft_niche_json = ?, draft_playbook = ?, draft_quiz_tags = ?, updated_at = ? WHERE id = ?`),
  insertScanLog: db.prepare(`INSERT INTO scan_log (source, results_found, new_candidates, duration_ms, error, scanned_at) VALUES (?, ?, ?, ?, ?, ?)`),
  getScanLogs: db.prepare(`SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 50`),
  upsertIntelligence: db.prepare(`INSERT INTO niche_intelligence (niche_id, metric, period, count, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(niche_id, metric, period) DO UPDATE SET count = count + 1, updated_at = ?`),
  getIntelligence: db.prepare(`SELECT niche_id, metric, SUM(count) as total FROM niche_intelligence WHERE period >= ? GROUP BY niche_id, metric ORDER BY total DESC`),
  getIntelligenceByNiche: db.prepare(`SELECT metric, period, count FROM niche_intelligence WHERE niche_id = ? ORDER BY period DESC LIMIT 90`),
  insertNicheNotification: db.prepare(`INSERT INTO niche_notifications (niche_id, niche_name, category, created_at) VALUES (?, ?, ?, ?)`),
  getRecentNotifications: db.prepare(`SELECT niche_id, niche_name, category, created_at FROM niche_notifications WHERE created_at >= ? ORDER BY created_at DESC`),
  getSearchSignals: db.prepare(`SELECT niche_id, SUM(count) as total FROM niche_intelligence WHERE metric = 'search_signal' AND period >= ? GROUP BY niche_id ORDER BY total DESC LIMIT 20`),
  getUnmatchedSignals: db.prepare(`SELECT niche_id, SUM(count) as total FROM niche_intelligence WHERE metric = 'unmatched_demand' AND period >= ? GROUP BY niche_id ORDER BY total DESC LIMIT 10`),
  // ANVIL Kids
  insertChild: db.prepare(`INSERT INTO kids_children (parent_user_id, display_name, age_group, birth_year, created_at) VALUES (?, ?, ?, ?, ?)`),
  getChildrenByParent: db.prepare(`SELECT * FROM kids_children WHERE parent_user_id = ? ORDER BY created_at`),
  getChildById: db.prepare(`SELECT * FROM kids_children WHERE id = ?`),
  updateChild: db.prepare(`UPDATE kids_children SET display_name = ?, age_group = ?, birth_year = ? WHERE id = ?`),
  deleteChild: db.prepare(`DELETE FROM kids_children WHERE id = ? AND parent_user_id = ?`),
  insertKidsSub: db.prepare(`INSERT INTO kids_subscriptions (user_id, stripe_customer_id, stripe_sub_id, plan, status, trial_ends_at, current_period_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getKidsSubByUser: db.prepare(`SELECT * FROM kids_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`),
  updateKidsSubStatus: db.prepare(`UPDATE kids_subscriptions SET status = ? WHERE id = ?`),
  updateKidsSubStripe: db.prepare(`UPDATE kids_subscriptions SET stripe_customer_id = ?, stripe_sub_id = ?, plan = ?, status = ?, current_period_end = ? WHERE id = ?`),
  insertKidsProgress: db.prepare(`INSERT INTO kids_progress (child_id, path_id, quest_index, xp, level, started_at, last_activity) VALUES (?, ?, 0, 0, 1, ?, ?)`),
  getProgressByChild: db.prepare(`SELECT * FROM kids_progress WHERE child_id = ? ORDER BY started_at`),
  getProgressByChildPath: db.prepare(`SELECT * FROM kids_progress WHERE child_id = ? AND path_id = ?`),
  updateProgress: db.prepare(`UPDATE kids_progress SET quest_index = ?, xp = ?, level = ?, last_activity = ? WHERE child_id = ? AND path_id = ?`),
  completeProgress: db.prepare(`UPDATE kids_progress SET completed_at = ?, last_activity = ? WHERE child_id = ? AND path_id = ?`),
  insertArtifact: db.prepare(`INSERT INTO kids_artifacts (child_id, path_id, quest_index, artifact_type, title, content, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`),
  getArtifactsByChild: db.prepare(`SELECT * FROM kids_artifacts WHERE child_id = ? ORDER BY created_at DESC`),
  getPublicArtifacts: db.prepare(`SELECT * FROM kids_artifacts WHERE child_id = ? AND is_public = 1 ORDER BY created_at DESC`),
  toggleArtifactPublic: db.prepare(`UPDATE kids_artifacts SET is_public = ? WHERE id = ? AND child_id = ?`),
  logKidsActivity: db.prepare(`INSERT INTO kids_activity_log (child_id, action, detail, xp_earned, created_at) VALUES (?, ?, ?, ?, ?)`),
  getActivityByChild: db.prepare(`SELECT * FROM kids_activity_log WHERE child_id = ? ORDER BY created_at DESC LIMIT 50`),
  getActivityByParent: db.prepare(`SELECT a.* FROM kids_activity_log a JOIN kids_children c ON a.child_id = c.id WHERE c.parent_user_id = ? ORDER BY a.created_at DESC LIMIT 100`),
  insertKidsReferral: db.prepare(`INSERT INTO kids_referrals (referrer_user_id, referred_email, code, created_at) VALUES (?, ?, ?, ?)`),
  getKidsReferralByCode: db.prepare(`SELECT * FROM kids_referrals WHERE code = ?`),
  redeemKidsReferral: db.prepare(`UPDATE kids_referrals SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by IS NULL`),
  getKidsReferralsByUser: db.prepare(`SELECT * FROM kids_referrals WHERE referrer_user_id = ? ORDER BY created_at DESC`),
  getKidsSubByStripeId: db.prepare(`SELECT * FROM kids_subscriptions WHERE stripe_sub_id = ?`),
  getArtifactWithParent: db.prepare(`SELECT a.*, c.parent_user_id FROM kids_artifacts a JOIN kids_children c ON a.child_id = c.id WHERE a.id = ?`),
};

// Load niches registry (cached in memory, reloads on admin toggle)
let nichesData = { niches: [], categories: [], quiz_questions: [] };
function loadNiches() {
  try {
    const raw = fs.readFileSync(NICHES_FILE, 'utf8');
    nichesData = JSON.parse(raw);
  } catch (err) {
    console.error('[ERROR] Failed to load niches.json:', err.message);
  }
}
loadNiches();

// Community links
const COMMUNITY_DISCORD = process.env.COMMUNITY_DISCORD || '';
const COMMUNITY_SIGNAL = process.env.COMMUNITY_SIGNAL || '';

// Admin auth helper (dual-mode: session cookie OR legacy API key)
function requireAdmin(req, res) {
  // Check session-based auth first
  if (req.user && req.user.role === 'admin') return true;
  // Fallback: legacy API key (timing-safe comparison)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token && timingSafeCompare(token, API_KEY)) return true;
  res.status(403).json({ success: false, error: 'Unauthorized' });
  return false;
}

// Require any authenticated user
function requireUser(req, res) {
  if (req.user) return true;
  res.status(401).json({ success: false, error: 'Authentication required' });
  return false;
}

// Allowed origins for CORS
const ALLOWED_ORIGINS = NODE_ENV === 'production'
  ? [process.env.ALLOWED_ORIGIN || 'https://anvil.onrender.com']
  : ['http://localhost:10000', 'http://127.0.0.1:10000'];

// Rate limiting (in-memory, no extra dependency)
// Bug fix: /health previously shared the same rate limit pool as user-facing endpoints.
// A monitoring system pinging /health every 30s could exhaust the 10-request quota and
// block real quiz submissions from the same IP. /health now uses a separate, higher limit.
const rateLimits = new Map();        // user-facing: 10 req / 15 min
const healthRateLimits = new Map(); // health check: 120 req / 15 min
const authRateLimits = new Map();   // auth endpoints: 10 req / 15 min per IP
const kidsRateLimits = new Map();   // kids endpoints: 60 req / 15 min per IP
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 10;                 // max user-facing submissions per window per IP
const HEALTH_RATE_MAX = 120;         // max health checks per window per IP (1 per 7.5s)
const KIDS_RATE_MAX = 200;           // max kids API requests per window per IP

function rateLimitFromMap(map, ip, max) {
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    map.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function rateLimit(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return rateLimitFromMap(rateLimits, ip, RATE_MAX);
}

function healthRateLimit(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return rateLimitFromMap(healthRateLimits, ip, HEALTH_RATE_MAX);
}

function authRateLimit(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return rateLimitFromMap(authRateLimits, ip, RATE_MAX);
}

function kidsRateLimit(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return rateLimitFromMap(kidsRateLimits, ip, KIDS_RATE_MAX);
}

// Clean stale rate limit entries + expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) rateLimits.delete(ip);
  }
  for (const [ip, entry] of healthRateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) healthRateLimits.delete(ip);
  }
  for (const [ip, entry] of authRateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) authRateLimits.delete(ip);
  }
  for (const [ip, entry] of kidsRateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) kidsRateLimits.delete(ip);
  }
  // Bug fix: searchSignalLimiter was never cleaned — unbounded growth under sustained traffic.
  const searchWindow = 60 * 1000; // 1-minute window used by the search signal limiter
  for (const [ip, timestamps] of Object.entries(searchSignalLimiter)) {
    const fresh = timestamps.filter(t => now - t < searchWindow);
    if (fresh.length === 0) delete searchSignalLimiter[ip];
    else searchSignalLimiter[ip] = fresh;
  }
  auth.cleanExpiredSessions();
}, 30 * 60 * 1000);

// Middleware
// Skip JSON parsing for Stripe webhook (needs raw body for signature verification)
app.use((req, res, next) => {
  if (req.path === '/api/kids/subscribe/webhook') return next();
  express.json({ limit: '16kb' })(req, res, next);
});

// Cookie parsing + user resolver
app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  const sid = req.cookies.anvil_sid;
  if (sid) {
    req.user = auth.getSessionUser(sid);
    req.sessionId = sid;
  } else {
    req.user = null;
  }
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://accounts.google.com https://discord.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com https://discord.com"
  ].join('; '));
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS — restrict to allowed origins in production
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOriginsList = ALLOWED_ORIGINS;

  // Check if origin is allowed
  if (origin && allowedOriginsList.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  } else if (!origin) {
    // No origin = same-origin request, allow with default
    res.header('Access-Control-Allow-Origin', allowedOriginsList[0]);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  } else {
    // Origin not allowed - log and deny (don't set CORS headers)
    console.warn(`[CORS] Rejected request from unauthorized origin: ${origin}`);
  }

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Data directory ensured during DB init above

// Input sanitization
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars including null bytes
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .trim()
    .slice(0, 500);
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  // Reject null bytes and other control characters (fix: regex allowed \x00 through [^\s@])
  if (/[\x00-\x1F\x7F]/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  if (parts[0].length > 64 || parts[0].length === 0) return false;
  if (parts[1].length === 0 || !parts[1].includes('.')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return true; // optional field
  const digits = phone.replace(/[\s\-\(\)\.\+]/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (!/^\d+$/.test(digits)) return false;
  return true;
}

function isValidName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/<script/i.test(trimmed)) return false;
  return true;
}

// Hash-then-compare: prevents timing oracle on key length
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Health check — uses separate rate limiter (healthRateLimit) so monitoring systems
// do not exhaust the user-facing submission quota.
app.get('/health', (req, res) => {
  if (!healthRateLimit(req)) {
    return res.status(429).json({
      success: false,
      error: 'Too many health check requests. Try again in 15 minutes.'
    });
  }

  res.json({
    status: 'ok',
    service: 'anvil',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Quiz submission — rate limited + validated
app.post('/api/quiz-submit', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({
      success: false,
      error: 'Too many submissions. Try again in 15 minutes.'
    });
  }

  try {
    const { name, email, phone, answers, recommendedNiches } = req.body;

    // Validate raw name first (before sanitize strips HTML chars)
    if (!isValidName(typeof name === 'string' ? name : '')) {
      return res.status(400).json({ success: false, error: 'Name is required (1-100 characters, no scripts)' });
    }
    const cleanName = sanitize(name);
    const cleanEmail = (typeof email === 'string' ? email.trim().toLowerCase() : '');
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number format' });
    }

    const id = crypto.randomBytes(10).toString('hex');
    const referralCode = crypto.randomBytes(6).toString('hex');
    const cleanPhone = sanitize(phone || '');
    const cleanAnswers = Array.isArray(answers) ? answers.slice(0, 20).map(a => sanitize(String(a))) : [];
    const cleanNiches = Array.isArray(recommendedNiches) ? recommendedNiches.slice(0, 7).map(n => sanitize(String(n))) : [];
    const now = new Date().toISOString();

    stmts.insertSubmission.run(
      id, cleanName, cleanEmail, cleanPhone,
      JSON.stringify(cleanAnswers), JSON.stringify(cleanNiches),
      referralCode, sanitize(req.body.referredBy || ''),
      sanitize(req.body.utmSource || ''), sanitize(req.body.utmMedium || ''),
      sanitize(req.body.utmCampaign || ''), req.ip || 'unknown', now
    );

    // Intelligence: record quiz_match signal for each recommended niche
    const period = now.slice(0, 10);
    for (const nicheId of cleanNiches) {
      try { stmts.upsertIntelligence.run(nicheId, 'quiz_match', period, now, now); } catch (e) { /* non-critical */ }
    }

    // Unmatched quiz demand: capture when no niches match the user's answers
    if (cleanNiches.length === 0 && cleanAnswers.length > 0) {
      const topTags = cleanAnswers.slice(0, 3).map(a => a.replace(/[^a-z0-9-]/gi, '').toLowerCase()).filter(Boolean);
      if (topTags.length > 0) {
        const key = '_unmatched:' + topTags.join('+');
        try { stmts.upsertIntelligence.run(key, 'unmatched_demand', period, now, now); } catch (e) { /* non-critical */ }
      }
    }

    console.log(`[SUBMISSION] ${id} | ${cleanName} <${cleanEmail}> | Niches: ${cleanNiches.join(', ') || 'none'}`);

    // If user is logged in, link submission to their account
    if (req.user) {
      try { auth.stmts.updateQuizLink.run(id, new Date().toISOString(), req.user.id); } catch (e) { /* non-critical */ }
    }

    res.json({
      success: true,
      id,
      referralCode,
      link_token: id, // For linking to account during signup
      message: 'Quiz submitted successfully'
    });
  } catch (err) {
    console.error('[ERROR] Quiz submission failed:', err.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get submissions — protected by admin auth
app.get('/api/submissions', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const rows = stmts.getSubmissions.all();
    const submissions = rows.map(r => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone,
      answers: JSON.parse(r.answers || '[]'),
      recommendedNiches: JSON.parse(r.recommended_niches || '[]'),
      referralCode: r.referral_code, referredBy: r.referred_by,
      utmSource: r.utm_source, utmMedium: r.utm_medium, utmCampaign: r.utm_campaign,
      ip: r.ip, submittedAt: r.submitted_at
    }));
    res.json({ success: true, count: submissions.length, submissions });
  } catch (err) {
    console.error('[ERROR] Failed to read submissions:', err.message);
    res.json({ success: true, count: 0, submissions: [] });
  }
});

// --- Public results for shareable links (rate limited to prevent enumeration) ---
app.get('/api/results/:id', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }
  try {
    // Validate ID format: alphanumeric only, max 20 chars
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    if (!id) return res.status(404).json({ success: false, error: 'Result not found' });

    const sub = stmts.getSubmissionById.get(id);
    if (!sub) {
      return res.status(404).json({ success: false, error: 'Result not found' });
    }
    const firstName = (sub.name || '').split(' ')[0];
    res.json({
      success: true,
      result: {
        id: sub.id,
        name: firstName,
        recommendedNiches: JSON.parse(sub.recommended_niches || '[]'),
        submittedAt: sub.submitted_at
      }
    });
  } catch (err) {
    console.error('[ERROR] Results lookup failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Privacy-respecting analytics ---
app.post('/api/analytics/event', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { event, page, data } = req.body;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const hash = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    const cleanEvent = sanitize(event || '');
    const cleanPage = sanitize(page || '');
    const cleanData = typeof data === 'object' && data !== null ? JSON.stringify(data) : '{}';

    const analyticsNow = new Date().toISOString();
    stmts.insertAnalytics.run(cleanEvent, cleanPage, cleanData, hash, analyticsNow);

    // Intelligence: record niche_view / playbook_view signals
    if (typeof data === 'object' && data !== null && data.nicheId) {
      const metric = cleanEvent.includes('playbook') ? 'playbook_view' : 'niche_view';
      const period = analyticsNow.slice(0, 10);
      try { stmts.upsertIntelligence.run(String(data.nicheId), metric, period, analyticsNow, analyticsNow); } catch (e) { /* non-critical */ }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Analytics event failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Record referral visit ---
app.post('/api/referrals/track', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { referralCode, referredPage } = req.body;
    const cleanCode = sanitize(referralCode || '');
    if (!cleanCode) {
      return res.status(400).json({ success: false, error: 'referralCode is required' });
    }

    // Verify referralCode exists in submissions
    const exists = stmts.getSubmissionByReferral.get(cleanCode);
    if (!exists) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const fingerprint = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    stmts.insertReferral.run(cleanCode, sanitize(referredPage || ''), fingerprint, new Date().toISOString());

    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Referral tracking failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Top 10 referrers (public) ---
app.get('/api/referrals/leaderboard', (req, res) => {
  try {
    const leaderboard = stmts.getReferralCounts.all().map(r => ({
      referralCode: r.referral_code, count: r.count
    }));
    res.json({ success: true, leaderboard });
  } catch (err) {
    console.error('[ERROR] Leaderboard failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Referral count for specific code (rate limited) ---
app.get('/api/referrals/status/:code', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }
  try {
    // Validate code format
    const code = String(req.params.code || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    if (!code) return res.json({ success: true, referralCode: '', count: 0 });

    const result = stmts.getReferralCountByCode.get(code);
    res.json({ success: true, referralCode: code, count: result ? result.count : 0 });
  } catch (err) {
    console.error('[ERROR] Referral status failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Submit testimonial ---
app.post('/api/testimonials', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { name, text, niche, rating } = req.body;
    const cleanName = sanitize(name);
    const cleanText = sanitize(text);
    const cleanNiche = sanitize(niche || '');
    const cleanRating = parseInt(rating, 10);

    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    // Bug fix: sanitize() caps at 500 chars, so cleanText.length > 500 was unreachable dead code.
    // Check raw text length before sanitization to properly enforce the 500-char limit.
    if (typeof text !== 'string' || text.trim().length > 500) {
      return res.status(400).json({ success: false, error: 'Text must be between 10 and 500 characters' });
    }
    if (!cleanText || cleanText.length < 10) {
      return res.status(400).json({ success: false, error: 'Text must be between 10 and 500 characters' });
    }
    if (isNaN(cleanRating) || cleanRating < 1 || cleanRating > 5) {
      return res.status(400).json({ success: false, error: 'Rating must be between 1 and 5' });
    }

    const id = crypto.randomBytes(10).toString('hex');
    stmts.insertTestimonial.run(id, cleanName, cleanText, cleanNiche, cleanRating, new Date().toISOString());

    console.log(`[TESTIMONIAL] ${id} | ${cleanName} | Rating: ${cleanRating}`);
    res.json({ success: true, id });
  } catch (err) {
    console.error('[ERROR] Testimonial submission failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Public approved testimonials (rate limited) ---
app.get('/api/testimonials', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }
  try {
    const testimonials = stmts.getApprovedTestimonials.all().map(t => ({
      id: t.id, name: t.name, text: t.text, niche: t.niche,
      rating: t.rating, approved: true, submittedAt: t.submitted_at
    }));
    res.json({ success: true, testimonials });
  } catch (err) {
    console.error('[ERROR] Testimonials read failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Graduate directory opt-in ---
app.post('/api/graduates', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { name, niche, city, state } = req.body;
    const cleanName = sanitize(name);
    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const id = crypto.randomBytes(10).toString('hex');
    const cleanNiche = sanitize(niche || '');
    const cleanCity = sanitize(city || '');
    const cleanState = sanitize(state || '');
    stmts.insertGraduate.run(id, cleanName, cleanNiche, cleanCity, cleanState, new Date().toISOString());

    console.log(`[GRADUATE] ${id} | ${cleanName} | ${cleanNiche}`);
    res.json({ success: true, id });
  } catch (err) {
    console.error('[ERROR] Graduate registration failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Analytics summary (API key protected) ---
app.get('/api/admin/analytics', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const totalEvents = db.prepare('SELECT COUNT(*) as c FROM analytics').get().c;
    const uniqueFingerprints = db.prepare('SELECT COUNT(DISTINCT fingerprint) as c FROM analytics').get().c;
    const eventRows = db.prepare('SELECT event, COUNT(*) as count FROM analytics GROUP BY event').all();
    const dailyRows = db.prepare("SELECT substr(timestamp, 1, 10) as day, COUNT(*) as count FROM analytics GROUP BY day ORDER BY day").all();

    const eventBreakdown = {};
    eventRows.forEach(r => { eventBreakdown[r.event] = r.count; });
    const dailyCounts = {};
    dailyRows.forEach(r => { dailyCounts[r.day] = r.count; });

    res.json({ success: true, totalEvents, uniqueFingerprints, eventBreakdown, dailyCounts });
  } catch (err) {
    console.error('[ERROR] Admin analytics failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Full referral data (API key protected) ---
app.get('/api/admin/referrals', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const referrals = stmts.getReferrals.all().map(r => ({
      referralCode: r.referral_code, referredPage: r.referred_page,
      fingerprint: r.fingerprint, timestamp: r.timestamp
    }));
    res.json({ success: true, count: referrals.length, referrals });
  } catch (err) {
    console.error('[ERROR] Admin referrals failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Curriculum progress stats (API key protected) ---
app.get('/api/admin/curriculum-progress', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event LIKE 'curriculum_%' OR event LIKE 'lesson_%'").get().c;
    const learners = db.prepare("SELECT COUNT(DISTINCT fingerprint) as c FROM analytics WHERE event LIKE 'curriculum_%' OR event LIKE 'lesson_%'").get().c;
    const eventRows = db.prepare("SELECT event, COUNT(*) as count FROM analytics WHERE event LIKE 'curriculum_%' OR event LIKE 'lesson_%' GROUP BY event").all();

    const eventBreakdown = {};
    eventRows.forEach(r => { eventBreakdown[r.event] = r.count; });

    res.json({ success: true, totalCurriculumEvents: total, uniqueLearners: learners, eventBreakdown });
  } catch (err) {
    console.error('[ERROR] Admin curriculum progress failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Export submissions as CSV (API key protected) ---
app.get('/api/admin/export/csv', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const submissions = stmts.getSubmissions.all();
    // CSV-safe: escape formula injection characters and quote fields properly
    function csvSafe(val) {
      if (!val) return '""';
      let s = String(val);
      // Strip formula injection prefixes
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      // Quote and escape internal quotes
      return '"' + s.replace(/"/g, '""') + '"';
    }
    const headers = 'id,name,email,phone,niches,date,referralCode,referredBy';
    const rows = submissions.map(s => {
      const niches = JSON.parse(s.recommended_niches || '[]').join('; ');
      return [
        csvSafe(s.id),
        csvSafe(s.name),
        csvSafe(s.email),
        csvSafe(s.phone),
        csvSafe(niches),
        csvSafe(s.submitted_at),
        csvSafe(s.referral_code),
        csvSafe(s.referred_by)
      ].join(',');
    });

    const csv = [headers, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="anvil-submissions.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[ERROR] CSV export failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Content calendar: TikTok + outreach as JSON (API key protected) ---
app.get('/api/content-calendar', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const tiktokPath = path.join(__dirname, 'content', 'tiktok-scripts.md');
    const outreachPath = path.join(__dirname, 'content', 'outreach-templates.md');

    // Parse TikTok scripts
    const tiktokScripts = [];
    if (fs.existsSync(tiktokPath)) {
      const raw = fs.readFileSync(tiktokPath, 'utf8');
      const scriptBlocks = raw.split(/\n## /).slice(1); // split on ## headers
      scriptBlocks.forEach(block => {
        const lines = block.split('\n');
        const title = lines[0].trim();
        let format = '', duration = '', hook = '', body = '', cta = '', hashtags = '';
        let section = '';

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('**Format:**')) {
            format = line.replace('**Format:**', '').trim();
          } else if (line.startsWith('**Duration:**')) {
            duration = line.replace('**Duration:**', '').trim();
          } else if (line.match(/^\*\*HOOK/)) {
            section = 'hook';
          } else if (line.match(/^\*\*BODY/)) {
            section = 'body';
          } else if (line.match(/^\*\*CTA/)) {
            section = 'cta';
          } else if (line.match(/^\*\*HASHTAGS/)) {
            section = 'hashtags';
          } else if (line.startsWith('---')) {
            section = '';
          } else {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (section === 'hook') hook += (hook ? ' ' : '') + trimmed.replace(/^"|"$/g, '');
            else if (section === 'body') body += (body ? ' ' : '') + trimmed.replace(/^"|"$/g, '');
            else if (section === 'cta') cta += (cta ? ' ' : '') + trimmed.replace(/^"|"$/g, '');
            else if (section === 'hashtags') hashtags = trimmed;
          }
        }

        tiktokScripts.push({ title, format, duration, hook, body, cta, hashtags });
      });
    }

    // Parse outreach templates
    const outreachTemplates = [];
    if (fs.existsSync(outreachPath)) {
      const raw = fs.readFileSync(outreachPath, 'utf8');
      const templateBlocks = raw.split(/\n### /).slice(1); // split on ### headers
      templateBlocks.forEach(block => {
        const lines = block.split('\n');
        const title = lines[0].trim();
        let subject = '', body = '';
        let section = '';

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('**Title:**') || line.startsWith('**Subject:**')) {
            subject = line.replace(/^\*\*(Title|Subject):\*\*/, '').trim();
          } else if (line.match(/^\*\*Body/)) {
            section = 'body';
          } else if (line.startsWith('---')) {
            section = '';
          } else if (line.startsWith('### ')) {
            break;
          } else {
            if (section === 'body') {
              body += (body ? '\n' : '') + line;
            }
          }
        }

        outreachTemplates.push({ title, subject, body: body.trim() });
      });
    }

    res.json({ success: true, tiktokScripts, outreachTemplates });
  } catch (err) {
    console.error('[ERROR] Content calendar failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Backup all data (API key protected) ---
app.post('/api/admin/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const backup = {
      exportedAt: new Date().toISOString(),
      submissions: stmts.getSubmissions.all(),
      analytics: stmts.getAnalytics.all(),
      referrals: stmts.getReferrals.all(),
      testimonials: stmts.getAllTestimonials.all(),
      graduates: stmts.getGraduates.all()
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="anvil-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
    res.json(backup);
  } catch (err) {
    console.error('[ERROR] Backup failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: All testimonials including unapproved (API key protected) ---
app.get('/api/admin/testimonials', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const testimonials = stmts.getAllTestimonials.all().map(t => ({
      id: t.id, name: t.name, text: t.text, niche: t.niche,
      rating: t.rating, approved: !!t.approved, submittedAt: t.submitted_at
    }));
    res.json({ success: true, count: testimonials.length, testimonials });
  } catch (err) {
    console.error('[ERROR] Admin testimonials failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Approve a testimonial (API key protected) ---
app.post('/api/admin/testimonials/:id/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 64);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const result = stmts.approveTestimonial.run(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Testimonial not found' });
    }
    console.log(`[TESTIMONIAL APPROVED] ${id}`);
    const testimonial = db.prepare('SELECT * FROM testimonials WHERE id = ?').get(id);
    // Bug fix: spreading raw DB row exposed both `submitted_at` (SQLite column) AND `submittedAt`
    // (camelCase alias). Explicitly construct the response object to avoid the duplicate field.
    res.json({ success: true, testimonial: {
      id: testimonial.id, name: testimonial.name, text: testimonial.text,
      niche: testimonial.niche, rating: testimonial.rating,
      approved: true, submittedAt: testimonial.submitted_at
    } });
  } catch (err) {
    console.error('[ERROR] Testimonial approval failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Dynamic sitemap ---
app.get('/sitemap.xml', (req, res) => {
  const baseUrl = NODE_ENV === 'production'
    ? (process.env.ALLOWED_ORIGIN || 'https://anvil.onrender.com')
    : 'http://localhost:' + PORT;

  const pages = ['/', '/learn.html', '/certificate.html', '/about.html', '/terms.html', '/privacy.html', '/disclaimer.html', '/accessibility.html', '/kids/', '/kids/learn.html', '/kids/portfolio.html'];
  const urls = pages.map(p =>
    `  <url>\n    <loc>${baseUrl}${p}</loc>\n    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n  </url>`
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

// --- Robots.txt ---
app.get('/robots.txt', (req, res) => {
  const baseUrl = NODE_ENV === 'production'
    ? (process.env.ALLOWED_ORIGIN || 'https://anvil.onrender.com')
    : 'http://localhost:' + PORT;

  res.setHeader('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);
});

// --- Niches registry (public — returns enabled niches + quiz questions) ---
app.get('/api/niches', (req, res) => {
  const enabledNiches = nichesData.niches.filter(n => n.enabled);
  res.json({
    success: true,
    categories: nichesData.categories || [],
    niches: enabledNiches.map(n => ({
      id: n.id,
      name: n.name,
      tier: n.tier,
      category: n.category,
      icon: n.icon,
      earn: n.earn,
      avg_rate: n.avg_rate,
      who_pays: n.who_pays,
      desc: n.desc,
      quiz_tags: n.quiz_tags,
      coming_soon: n.coming_soon || false,
      application_links: n.application_links || []
    })),
    quiz_questions: nichesData.quiz_questions || []
  });
});

// --- Admin: All niches (API key protected) ---
app.get('/api/admin/niches', (req, res) => {
  if (!requireAdmin(req, res)) return;

  // Check which playbooks exist
  const nichesWithStatus = nichesData.niches.map(n => {
    let hasPlaybook = false;
    if (n.playbook_path) {
      hasPlaybook = fs.existsSync(path.join(__dirname, n.playbook_path));
    }
    return { ...n, hasPlaybook };
  });

  res.json({ success: true, niches: nichesWithStatus, categories: nichesData.categories });
});

// --- Admin: Toggle niche enabled/disabled (API key protected) ---
app.post('/api/admin/niches/:id/toggle', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const nicheId = req.params.id;
  const niche = nichesData.niches.find(n => n.id === nicheId);
  if (!niche) {
    return res.status(404).json({ success: false, error: 'Niche not found' });
  }

  niche.enabled = !niche.enabled;

  // Write back to file
  const tmp = NICHES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(nichesData, null, 2), 'utf8');
  fs.renameSync(tmp, NICHES_FILE);

  console.log(`[NICHES] ${nicheId} ${niche.enabled ? 'enabled' : 'disabled'}`);
  res.json({ success: true, id: nicheId, enabled: niche.enabled });
});

// ── Discovery & Intelligence Routes ────────────────────

// Trigger discovery scan
app.post('/api/admin/discovery/scan', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { sources } = req.body;
    const validSources = ['bls', 'federal_register', 'regulations_gov', 'onet', 'onet_keyword', 'nvd'];
    const requested = Array.isArray(sources) ? sources.filter(s => validSources.includes(s)) : ['federal_register'];

    if (requested.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid sources specified' });
    }

    const result = await discovery.scan(requested, stmts);
    res.json({
      success: true,
      sources_scanned: requested,
      total_results: result.results.length,
      logs: result.logs,
      available_sources: discovery.getAvailableSources()
    });
  } catch (err) {
    console.error('[ERROR] Discovery scan failed:', err.message);
    res.status(500).json({ success: false, error: 'Discovery scan failed' });
  }
});

// List candidates with optional status filter
app.get('/api/admin/discovery/candidates', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const status = req.query.status;
    const rows = status
      ? stmts.getCandidatesByStatus.all(status)
      : stmts.getCandidates.all();

    const candidates = rows.map(r => ({
      id: r.id, slug: r.slug, title: r.title,
      source: r.source, source_url: r.source_url,
      category: r.category, status: r.status,
      scores: {
        demand: r.score_demand, pain: r.score_pain,
        competition: r.score_competition, ai_leverage: r.score_ai_leverage,
        composite: r.score_composite
      },
      admin_notes: r.admin_notes,
      created_at: r.created_at, updated_at: r.updated_at
    }));

    res.json({ success: true, count: candidates.length, candidates });
  } catch (err) {
    console.error('[ERROR] Candidates list failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get full candidate detail with drafts
app.get('/api/admin/discovery/candidates/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const row = stmts.getCandidateById.get(candidateId);
    if (!row) return res.status(404).json({ success: false, error: 'Candidate not found' });

    res.json({
      success: true,
      candidate: {
        ...row,
        source_data: JSON.parse(row.source_data || '{}'),
        draft_niche_json: JSON.parse(row.draft_niche_json || '{}'),
        draft_quiz_tags: JSON.parse(row.draft_quiz_tags || '[]')
      }
    });
  } catch (err) {
    console.error('[ERROR] Candidate detail failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Review candidate: update status + admin notes
app.post('/api/admin/discovery/candidates/:id/review', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const row = stmts.getCandidateById.get(candidateId);
    if (!row) return res.status(404).json({ success: false, error: 'Candidate not found' });

    const { status, notes } = req.body;
    const validStatuses = ['new', 'reviewed', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status. Use: ' + validStatuses.join(', ') });
    }

    const now = new Date().toISOString();
    stmts.updateCandidateStatus.run(status, sanitize(notes || row.admin_notes), now, row.id);

    // Auto-generate drafts on approval if not yet generated
    if (status === 'approved') {
      const existing = JSON.parse(row.draft_niche_json || '{}');
      if (!existing.id) {
        const candidate = { ...row, source_data: JSON.parse(row.source_data || '{}') };
        const nicheJSON = contentGen.generateNicheJSON(candidate);
        const playbook = contentGen.generatePlaybook(candidate);
        const quizTags = contentGen.generateQuizTags(candidate);
        stmts.updateCandidateDrafts.run(JSON.stringify(nicheJSON), playbook, JSON.stringify(quizTags), now, row.id);
      }
    }

    console.log(`[DISCOVERY] Candidate ${row.id} "${row.title}" → ${status}`);
    res.json({ success: true, id: row.id, status });
  } catch (err) {
    console.error('[ERROR] Candidate review failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Deploy candidate: write to niches.json + create playbook + reload
app.post('/api/admin/discovery/candidates/:id/deploy', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const row = stmts.getCandidateById.get(candidateId);
    if (!row) return res.status(404).json({ success: false, error: 'Candidate not found' });
    if (row.status !== 'approved') {
      return res.status(400).json({ success: false, error: 'Candidate must be approved before deploying' });
    }

    let nicheJSON = JSON.parse(row.draft_niche_json || '{}');
    if (!nicheJSON.id) {
      return res.status(400).json({ success: false, error: 'No draft niche JSON. Run regenerate first.' });
    }

    // Allow admin overrides from request body — strict allowlist only
    if (req.body.niche_json && typeof req.body.niche_json === 'object') {
      const allowed = ['name', 'category', 'icon', 'earn', 'avg_rate', 'who_pays', 'desc', 'tier'];
      for (const key of allowed) {
        if (req.body.niche_json[key] !== undefined) {
          nicheJSON[key] = typeof req.body.niche_json[key] === 'string'
            ? sanitize(req.body.niche_json[key])
            : req.body.niche_json[key];
        }
      }
      nicheJSON.enabled = false;
      nicheJSON.coming_soon = true;
    }

    // Add deployed_at timestamp
    nicheJSON.deployed_at = new Date().toISOString();

    const playbookContent = row.draft_playbook || '';
    const result = contentGen.deployCandidate(nicheJSON, playbookContent);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    const candidate = { ...row, source_data: JSON.parse(row.source_data || '{}') };
    const deployedPaths = [result.playbook_path];
    const baseDir = path.resolve(__dirname);

    // Generate outreach scripts
    try {
      const outreach = contentGen.generateOutreach(candidate);
      const outreachPath = path.resolve(path.join(__dirname, 'content', 'outreach', `${candidate.slug}.md`));
      if (outreachPath.startsWith(baseDir + path.sep)) {
        const outreachDir = path.dirname(outreachPath);
        if (!fs.existsSync(outreachDir)) fs.mkdirSync(outreachDir, { recursive: true });
        fs.writeFileSync(outreachPath, outreach, 'utf8');
        deployedPaths.push(`content/outreach/${candidate.slug}.md`);
      }
    } catch (e) { console.error('[DEPLOY] Outreach generation failed:', e.message); }

    // Generate report template
    try {
      const template = contentGen.generateTemplate(candidate);
      const templatePath = path.resolve(path.join(__dirname, 'templates', candidate.slug, 'report-template.md'));
      if (templatePath.startsWith(baseDir + path.sep)) {
        const templateDir = path.dirname(templatePath);
        if (!fs.existsSync(templateDir)) fs.mkdirSync(templateDir, { recursive: true });
        fs.writeFileSync(templatePath, template, 'utf8');
        deployedPaths.push(`templates/${candidate.slug}/report-template.md`);
      }
    } catch (e) { console.error('[DEPLOY] Template generation failed:', e.message); }

    // Generate Pulse keywords
    try {
      const keywords = contentGen.generatePulseKeywords(candidate);
      const kwFile = path.resolve(path.join(__dirname, 'data', 'pulse-niche-keywords.json'));
      if (kwFile.startsWith(baseDir + path.sep)) {
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(kwFile, 'utf8')); } catch { /* fresh file */ }
        existing[candidate.slug] = keywords;
        fs.writeFileSync(kwFile, JSON.stringify(existing, null, 2), 'utf8');
        deployedPaths.push('data/pulse-niche-keywords.json');
      }
    } catch (e) { console.error('[DEPLOY] Pulse keywords generation failed:', e.message); }

    // Record notification
    const now = new Date().toISOString();
    try { stmts.insertNicheNotification.run(nicheJSON.id, nicheJSON.name, nicheJSON.category || '', now); } catch (e) { /* non-critical */ }

    // Update candidate status to deployed
    stmts.updateCandidateStatus.run('deployed', row.admin_notes, now, row.id);

    // Reload niches in memory
    loadNiches();

    console.log(`[DISCOVERY] Deployed niche "${nicheJSON.id}" from candidate ${row.id} — ${deployedPaths.length} files`);
    res.json({ success: true, niche_id: result.id, playbook_path: result.playbook_path, deployed_paths: deployedPaths });
  } catch (err) {
    console.error('[ERROR] Candidate deploy failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Regenerate drafts for a candidate
app.post('/api/admin/discovery/candidates/:id/regenerate', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const row = stmts.getCandidateById.get(candidateId);
    if (!row) return res.status(404).json({ success: false, error: 'Candidate not found' });

    const candidate = { ...row, source_data: JSON.parse(row.source_data || '{}') };
    const nicheJSON = contentGen.generateNicheJSON(candidate);
    const playbook = contentGen.generatePlaybook(candidate);
    const quizTags = contentGen.generateQuizTags(candidate);
    const now = new Date().toISOString();

    stmts.updateCandidateDrafts.run(JSON.stringify(nicheJSON), playbook, JSON.stringify(quizTags), now, row.id);

    res.json({ success: true, draft_niche_json: nicheJSON, draft_quiz_tags: quizTags });
  } catch (err) {
    console.error('[ERROR] Regenerate failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Scan logs
app.get('/api/admin/discovery/logs', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const logs = stmts.getScanLogs.all();
    res.json({ success: true, logs });
  } catch (err) {
    console.error('[ERROR] Scan logs failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Intelligence: demand signals, rising niches, unmet demand
app.get('/api/admin/intelligence', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString().split('T')[0];
    const sixtyDaysAgo = new Date(now - 60 * 86400000).toISOString().split('T')[0];

    // Current 30-day signals
    const currentSignals = stmts.getIntelligence.all(thirtyDaysAgo);
    // Prior 30-day signals (for trend comparison)
    const priorSignals = stmts.getIntelligence.all(sixtyDaysAgo);

    // Build per-niche summary
    const nicheMap = {};

    for (const row of currentSignals) {
      if (!nicheMap[row.niche_id]) nicheMap[row.niche_id] = { niche_id: row.niche_id, current: {}, prior: {} };
      nicheMap[row.niche_id].current[row.metric] = row.total;
    }

    // Prior period: subtract current to get prior-only
    for (const row of priorSignals) {
      if (!nicheMap[row.niche_id]) nicheMap[row.niche_id] = { niche_id: row.niche_id, current: {}, prior: {} };
      const currentVal = nicheMap[row.niche_id].current[row.metric] || 0;
      nicheMap[row.niche_id].prior[row.metric] = Math.max(0, row.total - currentVal);
    }

    // Calculate trends and sort by total demand
    const intelligence = Object.values(nicheMap).map(n => {
      const currentTotal = Object.values(n.current).reduce((s, v) => s + v, 0);
      const priorTotal = Object.values(n.prior).reduce((s, v) => s + v, 0);
      const trend = priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal * 100).toFixed(1) : (currentTotal > 0 ? 100 : 0);

      return {
        niche_id: n.niche_id,
        quiz_matches: n.current.quiz_match || 0,
        niche_views: n.current.niche_view || 0,
        playbook_views: n.current.playbook_view || 0,
        total_signals: currentTotal,
        trend: parseFloat(trend),
        direction: parseFloat(trend) > 10 ? 'rising' : (parseFloat(trend) < -10 ? 'declining' : 'stable')
      };
    }).sort((a, b) => b.total_signals - a.total_signals);

    // Identify unmet demand: niches with quiz_matches but no playbook
    const existingNiches = nichesData.niches || [];
    const unmetDemand = intelligence
      .filter(n => {
        const niche = existingNiches.find(en => en.id === n.niche_id || en.name === n.niche_id);
        return n.quiz_matches > 0 && (!niche || niche.coming_soon || !niche.enabled);
      })
      .slice(0, 10);

    // Demand gaps: search terms + unmatched quiz profiles
    let demandGaps = { search_terms: [], unmatched_profiles: [] };
    try {
      const searchRows = stmts.getSearchSignals.all(thirtyDaysAgo);
      demandGaps.search_terms = searchRows.map(r => ({
        query: r.niche_id.replace('_search:', ''),
        count: r.total
      }));
      const unmatchedRows = stmts.getUnmatchedSignals.all(thirtyDaysAgo);
      demandGaps.unmatched_profiles = unmatchedRows.map(r => ({
        tags: r.niche_id.replace('_unmatched:', '').split('+'),
        count: r.total
      }));
    } catch (e) { /* non-critical */ }

    res.json({
      success: true,
      period: { from: thirtyDaysAgo, to: now.toISOString().split('T')[0] },
      intelligence,
      rising: intelligence.filter(n => n.direction === 'rising').slice(0, 10),
      top_converting: intelligence.filter(n => n.quiz_matches > 0).sort((a, b) => b.quiz_matches - a.quiz_matches).slice(0, 10),
      unmet_demand: unmetDemand,
      demand_gaps: demandGaps
    });
  } catch (err) {
    console.error('[ERROR] Intelligence failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Search Signal Capture ────────────────────────────────
const searchSignalLimiter = {};
app.post('/api/analytics/niche-search', (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim().toLowerCase().slice(0, 100) : '';
  if (query.length < 2) return res.status(400).json({ success: false, error: 'Query too short' });

  // Rate limit: 10 per minute per IP
  const ip = req.ip || 'unknown';
  const now = Date.now();
  if (!searchSignalLimiter[ip]) searchSignalLimiter[ip] = [];
  searchSignalLimiter[ip] = searchSignalLimiter[ip].filter(t => now - t < 60000);
  if (searchSignalLimiter[ip].length >= 10) return res.status(429).json({ success: false, error: 'Rate limited' });
  searchSignalLimiter[ip].push(now);

  try {
    const period = new Date().toISOString().split('T')[0];
    const safeQuery = query.replace(/[^a-z0-9\s-]/g, '').slice(0, 60);
    const nowISO = new Date().toISOString();
    stmts.upsertIntelligence.run('_search:' + safeQuery, 'search_signal', period, nowISO, nowISO);
    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Search signal failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── New Niche Notifications ─────────────────────────────
app.get('/api/niches/new', (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = stmts.getRecentNotifications.all(thirtyDaysAgo);
    res.json({ success: true, count: rows.length, niches: rows.map(r => ({ niche_id: r.niche_id, name: r.niche_name, category: r.category, added_at: r.created_at })) });
  } catch (err) {
    console.error('[ERROR] New niches failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Auth Routes ─────────────────────────────────────────

// Sign up with email + password
app.post('/api/auth/signup', async (req, res) => {
  if (!authRateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }

  try {
    const { email, password, name, link_token } = req.body;
    const cleanEmail = (typeof email === 'string' ? email.trim().toLowerCase() : '');
    const rawName = typeof name === 'string' ? name : cleanEmail.split('@')[0];

    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    if (rawName && !isValidName(rawName)) {
      return res.status(400).json({ success: false, error: 'Invalid name (1-100 characters, no scripts)' });
    }
    const cleanName = sanitize(rawName);
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    if (password.length > 128) {
      return res.status(400).json({ success: false, error: 'Password too long' });
    }

    // Check if email already exists
    const existing = auth.stmts.getUserByEmail.get(cleanEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }

    const { hash, salt } = await auth.hashPassword(password);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const role = (process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase().trim()) ? 'admin' : 'user';

    // Validate link_token: must be alphanumeric and max 20 chars, and exist in submissions
    let quizLink = '';
    if (link_token && typeof link_token === 'string') {
      const cleaned = link_token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
      if (cleaned && stmts.getSubmissionById.get(cleaned)) {
        quizLink = cleaned;
      }
    }

    auth.stmts.insertUser.run(id, cleanEmail, 0, `${hash}:${salt}`, cleanName, role, '', '', quizLink, '{}', 0, now, now);

    const sessionId = auth.createSession(id, req);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId));

    const user = auth.stmts.getUserById.get(id);
    res.json({
      success: true,
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, onboarding_done: !!user.onboarding_done },
      providers_configured: auth.getProvidersConfigured(),
    });
  } catch (err) {
    console.error('[AUTH] Signup error:', err.message);
    res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

// Sign in with email + password
app.post('/api/auth/login', async (req, res) => {
  if (!authRateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }

  try {
    const { email, password } = req.body;
    const cleanEmail = (typeof email === 'string' ? email.trim().toLowerCase() : '');

    if (!cleanEmail || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const user = auth.stmts.getUserByEmail.get(cleanEmail);
    if (!user || !user.password_hash) {
      await auth.dummyHash(); // timing-safe
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const parts = user.password_hash.split(':');
    if (parts.length !== 2) {
      await auth.dummyHash();
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const valid = await auth.verifyPassword(password, parts[0], parts[1]);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const sessionId = auth.createSession(user.id, req);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId));

    res.json({
      success: true,
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, onboarding_done: !!user.onboarding_done },
      providers_configured: auth.getProvidersConfigured(),
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req.sessionId);
  res.setHeader('Set-Cookie', auth.clearSessionCookie());
  res.json({ success: true });
});

// Current user info
app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    return res.json({ authenticated: false, providers_configured: auth.getProvidersConfigured() });
  }
  res.json({
    authenticated: true,
    user: {
      id: req.user.id, email: req.user.email, display_name: req.user.display_name,
      role: req.user.role, onboarding_done: !!req.user.onboarding_done,
      has_google: !!req.user.oauth_google_id, has_discord: !!req.user.oauth_discord_id,
    },
    providers_configured: auth.getProvidersConfigured(),
    magic_link_available: true,
  });
});

// ── Magic Link Auth ─────────────────────────────────────

app.post('/api/auth/magic-link', (req, res) => {
  if (!authRateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, error: 'Valid email is required' });
  }
  if (auth.isMagicLinkRateLimited(email)) {
    return res.status(429).json({ success: false, error: 'Too many magic link requests for this email. Try again in 15 minutes.' });
  }
  const token = auth.generateMagicToken(email);
  const origin = ALLOWED_ORIGINS[0] || `${req.protocol}://${req.headers.host}`;
  const magicUrl = auth.getMagicLinkUrl(token, origin);
  const delivery = auth.sendMagicLinkEmail(email, magicUrl);
  // SECURITY: In production, never return the magic link in the API response.
  // If email provider is not configured in production, fail with 503 rather than
  // leaking a valid auth token to the API caller (which bypasses email ownership).
  if (delivery === 'console' && NODE_ENV === 'production') {
    return res.status(503).json({
      success: false,
      error: 'Email delivery is not configured. Set EMAIL_PROVIDER and EMAIL_API_KEY environment variables.'
    });
  }
  const response = { success: true, message: 'Check your email for a sign-in link.' };
  // dev_link only returned in non-production environments when no email provider is configured
  if (delivery === 'console') response.dev_link = magicUrl;
  res.json(response);
});

app.get('/api/auth/verify', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const result = auth.verifyMagicToken(token);
  if (!result) return res.redirect('/?auth_error=invalid_or_expired');
  const user = auth.findOrCreateMagicUser(result.email);
  const sessionId = auth.createSession(user.id, req);
  res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId));
  res.redirect('/?auth_success=1');
});

app.post('/api/auth/link-progress', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const { sprint_progress } = req.body;
    if (!sprint_progress || typeof sprint_progress !== 'object') {
      return res.json({ success: true, merged: false });
    }
    const user = auth.stmts.getUserById.get(req.user.id);
    let existing = {};
    try { existing = JSON.parse(user.sprint_progress || '{}'); } catch { /* ignore */ }
    const merged = {};
    merged.currentDay = Math.max(existing.currentDay || 1, sprint_progress.currentDay || 1);
    const existingCompleted = Array.isArray(existing.completed) ? existing.completed : [];
    const anonCompleted = Array.isArray(sprint_progress.completed) ? sprint_progress.completed.filter(n => typeof n === 'number' && n >= 1 && n <= 7) : [];
    merged.completed = [...new Set([...existingCompleted, ...anonCompleted])].sort((a, b) => a - b).slice(0, 7);
    const existingScores = (typeof existing.quizScores === 'object' && existing.quizScores) ? existing.quizScores : {};
    const anonScores = (typeof sprint_progress.quizScores === 'object' && sprint_progress.quizScores) ? sprint_progress.quizScores : {};
    merged.quizScores = { ...existingScores };
    for (const [k, v] of Object.entries(anonScores)) {
      const key = String(k).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
      const val = Number(v);
      if (key && !isNaN(val) && val >= 0 && val <= 100) {
        merged.quizScores[key] = Math.max(merged.quizScores[key] || 0, Math.round(val));
      }
    }
    auth.stmts.updateProgress.run(JSON.stringify(merged), new Date().toISOString(), req.user.id);
    res.json({ success: true, merged: true, sprint_progress: merged });
  } catch (err) {
    console.error('[AUTH] Link progress error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to link progress' });
  }
});

app.get('/api/auth/progress', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const user = auth.stmts.getUserById.get(req.user.id);
    let sprintProgress = {};
    try { sprintProgress = JSON.parse(user.sprint_progress || '{}'); } catch { /* ignore */ }
    res.json({ success: true, sprint_progress: sprintProgress });
  } catch (err) {
    console.error('[AUTH] Progress fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load progress' });
  }
});

// ── OAuth: Google ───────────────────────────────────────
app.get('/auth/google', (req, res) => {
  if (!auth.isGoogleConfigured()) {
    return res.status(404).json({ success: false, error: 'Google OAuth not configured' });
  }
  const redirectTo = auth.isValidRedirect(req.query.redirect) ? req.query.redirect : '/';
  const state = auth.generateState('google', redirectTo);
  // Use configured origin instead of Host header to prevent host header injection
  const origin = ALLOWED_ORIGINS[0] || `${req.protocol}://${req.headers.host}`;
  const callbackUrl = `${origin}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state: stateParam } = req.query;
    if (!code || !stateParam) return res.redirect('/login.html?error=OAuth+failed');

    const stateData = auth.verifyState(stateParam);
    if (!stateData || stateData.provider !== 'google') return res.redirect('/login.html?error=Invalid+state');

    const origin = ALLOWED_ORIGINS[0] || `${req.protocol}://${req.headers.host}`;
    const callbackUrl = `${origin}/auth/google/callback`;

    const tokenRes = await auth.oauthFetchToken('google', code, callbackUrl);
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      return res.redirect('/login.html?error=Google+auth+failed');
    }

    const profileRes = await auth.oauthFetchProfile('google', tokenRes.data.access_token);
    if (profileRes.status !== 200) return res.redirect('/login.html?error=Google+profile+failed');

    const user = auth.findOrCreateOAuthUser('google', profileRes.data);
    const sessionId = auth.createSession(user.id, req);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId));
    const safeRedirect = auth.isValidRedirect(stateData.redirect_to) ? stateData.redirect_to : '/';
    res.redirect(safeRedirect);
  } catch (err) {
    console.error('[AUTH] Google callback error:', err.message);
    res.redirect('/login.html?error=Google+auth+error');
  }
});

// ── OAuth: Discord ──────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  if (!auth.isDiscordConfigured()) {
    return res.status(404).json({ success: false, error: 'Discord OAuth not configured' });
  }
  const redirectTo = auth.isValidRedirect(req.query.redirect) ? req.query.redirect : '/';
  const state = auth.generateState('discord', redirectTo);
  const origin = ALLOWED_ORIGINS[0] || `${req.protocol}://${req.headers.host}`;
  const callbackUrl = `${origin}/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'identify email',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state: stateParam } = req.query;
    if (!code || !stateParam) return res.redirect('/login.html?error=OAuth+failed');

    const stateData = auth.verifyState(stateParam);
    if (!stateData || stateData.provider !== 'discord') return res.redirect('/login.html?error=Invalid+state');

    const origin = ALLOWED_ORIGINS[0] || `${req.protocol}://${req.headers.host}`;
    const callbackUrl = `${origin}/auth/discord/callback`;

    const tokenRes = await auth.oauthFetchToken('discord', code, callbackUrl);
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      return res.redirect('/login.html?error=Discord+auth+failed');
    }

    const profileRes = await auth.oauthFetchProfile('discord', tokenRes.data.access_token);
    if (profileRes.status !== 200) return res.redirect('/login.html?error=Discord+profile+failed');

    const user = auth.findOrCreateOAuthUser('discord', profileRes.data);
    const sessionId = auth.createSession(user.id, req);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId));
    const safeRedirect = auth.isValidRedirect(stateData.redirect_to) ? stateData.redirect_to : '/';
    res.redirect(safeRedirect);
  } catch (err) {
    console.error('[AUTH] Discord callback error:', err.message);
    res.redirect('/login.html?error=Discord+auth+error');
  }
});

// ── User Profile & Progress ─────────────────────────────

// Full profile data
app.get('/api/user/profile', (req, res) => {
  if (!requireUser(req, res)) return;

  try {
    const user = auth.stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Get linked quiz submission if any
    let quizResults = null;
    if (user.quiz_submission_id) {
      const sub = stmts.getSubmissionById.get(user.quiz_submission_id);
      if (sub) {
        quizResults = {
          id: sub.id,
          recommendedNiches: JSON.parse(sub.recommended_niches || '[]'),
          submittedAt: sub.submitted_at,
        };
      }
    }

    let sprintProgress = {};
    try { sprintProgress = JSON.parse(user.sprint_progress || '{}'); } catch { /* ignore */ }

    // Certificate eligibility
    const completed = Array.isArray(sprintProgress.completed) ? sprintProgress.completed : [];
    const certificateEligible = completed.length >= 7;

    res.json({
      success: true,
      profile: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        has_google: !!user.oauth_google_id,
        has_discord: !!user.oauth_discord_id,
        onboarding_done: !!user.onboarding_done,
        created_at: user.created_at,
        has_password: !!user.password_hash,
      },
      quiz_results: quizResults,
      sprint_progress: sprintProgress,
      certificate_eligible: certificateEligible,
    });
  } catch (err) {
    console.error('[AUTH] Profile fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load profile' });
  }
});

// Sync sprint progress
app.post('/api/user/progress', (req, res) => {
  if (!requireUser(req, res)) return;

  try {
    const { sprint_progress, onboarding_done } = req.body;
    const now = new Date().toISOString();

    if (onboarding_done !== undefined) {
      auth.stmts.updateOnboarding.run(onboarding_done ? 1 : 0, now, req.user.id);
    }

    if (sprint_progress && typeof sprint_progress === 'object') {
      // Validate shape
      // Validate and cap quizScores: max 7 keys, each value must be a number 0-100
      let safeScores = {};
      if (typeof sprint_progress.quizScores === 'object' && sprint_progress.quizScores !== null && !Array.isArray(sprint_progress.quizScores)) {
        const entries = Object.entries(sprint_progress.quizScores).slice(0, 7);
        for (const [k, v] of entries) {
          const key = String(k).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
          const val = Number(v);
          if (key && !isNaN(val) && val >= 0 && val <= 100) safeScores[key] = Math.round(val);
        }
      }
      const safe = {
        currentDay: Math.min(Math.max(parseInt(sprint_progress.currentDay) || 1, 1), 7),
        completed: Array.isArray(sprint_progress.completed) ? sprint_progress.completed.filter(n => typeof n === 'number' && n >= 1 && n <= 7).slice(0, 7) : [],
        quizScores: safeScores,
      };
      auth.stmts.updateProgress.run(JSON.stringify(safe), now, req.user.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Progress sync error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save progress' });
  }
});

// Update display name
app.post('/api/user/update-name', (req, res) => {
  if (!requireUser(req, res)) return;
  const name = sanitize(req.body.display_name || '');
  if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
  auth.stmts.updateUser.run(name, new Date().toISOString(), req.user.id);
  res.json({ success: true });
});

// Change password
app.post('/api/user/change-password', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const { current_password, new_password } = req.body;
    const user = auth.stmts.getUserById.get(req.user.id);

    // If user has a password, verify current
    if (user.password_hash) {
      const parts = user.password_hash.split(':');
      if (parts.length !== 2 || !current_password) {
        return res.status(400).json({ success: false, error: 'Current password is required' });
      }
      const valid = await auth.verifyPassword(current_password, parts[0], parts[1]);
      if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }
    if (new_password.length > 128) {
      return res.status(400).json({ success: false, error: 'Password too long' });
    }

    const { hash, salt } = await auth.hashPassword(new_password);
    auth.stmts.updatePassword.run(`${hash}:${salt}`, new Date().toISOString(), req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Password change error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// ── ANVIL Kids ──────────────────────────────────────────

// Load kids paths
const KIDS_PATHS_FILE = path.join(__dirname, 'kids-paths.json');
let kidsPathsData = { paths: [], quiz_questions: [] };
function loadKidsPaths() {
  try {
    if (fs.existsSync(KIDS_PATHS_FILE)) {
      kidsPathsData = JSON.parse(fs.readFileSync(KIDS_PATHS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[KIDS] Failed to load kids-paths.json:', err.message);
  }
}
loadKidsPaths();

// Stripe HTTP client (zero-dep, uses built-in https)
// Required env vars for paid subscriptions:
//   STRIPE_SECRET_KEY       — Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET   — Webhook signing secret (whsec_...)
//   STRIPE_PRICE_MONTHLY    — Price ID for $9.99/mo plan (price_...)
//   STRIPE_PRICE_ANNUAL     — Price ID for $79.99/yr plan (price_...)
// If none are set, kids subscription runs in trial-only mode (14-day free trial, no paid upgrade).
const https = require('https');
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || '';
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || '';
const STRIPE_CONFIGURED = !!(STRIPE_SECRET && STRIPE_WEBHOOK_SECRET && STRIPE_PRICE_MONTHLY);
if (STRIPE_CONFIGURED) {
  console.log('[KIDS] Stripe configured — paid subscriptions enabled');
} else {
  console.log('[KIDS] Stripe not configured — trial-only mode');
}

function stripeRequest(method, stripePath, body) {
  return new Promise((resolve, reject) => {
    if (!STRIPE_SECRET) return reject(new Error('Stripe not configured'));
    const encoded = body ? new URLSearchParams(body).toString() : '';
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: '/v1' + stripePath,
      method,
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    if (encoded) options.headers['Content-Length'] = Buffer.byteLength(encoded);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Stripe timeout')); });
    if (encoded) req.write(encoded);
    req.end();
  });
}

// Subscription middleware
function requireKidsSub(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const sub = stmts.getKidsSubByUser.get(req.user.id);
  if (!sub) return res.status(402).json({ error: 'Subscription required', trial_available: true });
  if (sub.status === 'trialing') {
    if (new Date(sub.trial_ends_at) < new Date()) {
      stmts.updateKidsSubStatus.run('expired', sub.id);
      return res.status(402).json({ error: 'Trial expired' });
    }
  } else if (sub.status !== 'active') {
    return res.status(402).json({ error: 'Subscription inactive' });
  }
  req.kidsSub = sub;
  next();
}

// Helper: verify parent owns child
function verifyParentChild(req, childId) {
  const child = stmts.getChildById.get(childId);
  if (!child || child.parent_user_id !== req.user.id) return null;
  return child;
}

// XP level calculation
function xpToLevel(xp) {
  if (xp < 100) return 1;
  if (xp < 250) return 2;
  if (xp < 500) return 3;
  if (xp < 800) return 4;
  return 5;
}

// Kids rate limiting middleware (all /api/kids/* except webhook)
app.use('/api/kids', (req, res, next) => {
  if (req.path === '/subscribe/webhook') return next();
  if (!kidsRateLimit(req)) {
    return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  }
  next();
});

// ── Kids: Children Management ───────────────────────────
app.post('/api/kids/children', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const { display_name, age_group, birth_year } = req.body;
    const name = sanitize(display_name || '');
    if (!name || name.length < 1) return res.status(400).json({ error: 'Display name required' });
    if (name.length > 50) return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
    if (!['explorer', 'builder'].includes(age_group)) return res.status(400).json({ error: 'age_group must be explorer or builder' });
    const year = birth_year ? parseInt(birth_year) : null;
    const currentYear = new Date().getFullYear();
    if (year && (year < 1990 || year > currentYear)) return res.status(400).json({ error: 'Invalid birth year' });
    // Limit to 5 children per parent
    const existing = stmts.getChildrenByParent.all(req.user.id);
    if (existing.length >= 5) return res.status(400).json({ error: 'Maximum 5 children per account' });
    const now = new Date().toISOString();
    const result = stmts.insertChild.run(req.user.id, name, age_group, year, now);
    res.json({ success: true, child: { id: result.lastInsertRowid, display_name: name, age_group, birth_year: year, created_at: now } });
  } catch (err) {
    console.error('[KIDS] Add child error:', err.message);
    res.status(500).json({ error: 'Failed to add child' });
  }
});

app.get('/api/kids/children', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const children = stmts.getChildrenByParent.all(req.user.id).map(c => ({
      id: c.id, display_name: c.display_name, age_group: c.age_group,
      birth_year: c.birth_year, created_at: c.created_at,
    }));
    res.json({ success: true, children });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load children' });
  }
});

app.put('/api/kids/children/:id', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const child = verifyParentChild(req, parseInt(req.params.id));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const name = sanitize(req.body.display_name || child.display_name);
    if (name.length > 50) return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
    const ag = ['explorer', 'builder'].includes(req.body.age_group) ? req.body.age_group : child.age_group;
    const year = req.body.birth_year !== undefined ? parseInt(req.body.birth_year) : child.birth_year;
    const currentYear = new Date().getFullYear();
    if (year && (year < 1990 || year > currentYear)) return res.status(400).json({ error: 'Invalid birth year' });
    stmts.updateChild.run(name, ag, year, child.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update child' });
  }
});

app.delete('/api/kids/children/:id', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const result = stmts.deleteChild.run(parseInt(req.params.id), req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Child not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete child' });
  }
});

// ── Kids: Subscription ──────────────────────────────────
app.post('/api/kids/subscribe/trial', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const existing = stmts.getKidsSubByUser.get(req.user.id);
    if (existing) return res.status(400).json({ error: 'Subscription already exists', status: existing.status });
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 86400000);
    stmts.insertKidsSub.run(req.user.id, null, null, 'trial', 'trialing', trialEnd.toISOString(), trialEnd.toISOString(), now.toISOString());
    res.json({ success: true, plan: 'trial', status: 'trialing', trial_ends_at: trialEnd.toISOString() });
  } catch (err) {
    console.error('[KIDS] Trial start error:', err.message);
    res.status(500).json({ error: 'Failed to start trial' });
  }
});

app.post('/api/kids/subscribe/checkout', async (req, res) => {
  if (!requireUser(req, res)) return;
  if (!STRIPE_CONFIGURED) return res.status(400).json({ error: 'Paid subscriptions not available. Free trial only.', trial_available: true });
  try {
    const { plan } = req.body;
    if (!['monthly', 'annual'].includes(plan)) return res.status(400).json({ error: 'Plan must be "monthly" or "annual"' });
    const priceId = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(400).json({ error: `${plan} plan not configured` });
    const origin = ALLOWED_ORIGINS[0] || `http://localhost:${PORT}`;
    const result = await stripeRequest('POST', '/checkout/sessions', {
      'mode': 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': `${origin}/kids/dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${origin}/kids/subscribe.html?canceled=1`,
      'client_reference_id': req.user.id,
      'customer_email': req.user.email,
    });
    if (result.status !== 200 || !result.data.url) {
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
    res.json({ success: true, url: result.data.url });
  } catch (err) {
    console.error('[KIDS] Checkout error:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

app.get('/api/kids/subscribe/status', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const sub = stmts.getKidsSubByUser.get(req.user.id);
    if (!sub) return res.json({ success: true, subscribed: false, trial_available: true, stripe_enabled: STRIPE_CONFIGURED });
    // Check trial expiry
    if (sub.status === 'trialing' && new Date(sub.trial_ends_at) < new Date()) {
      stmts.updateKidsSubStatus.run('expired', sub.id);
      sub.status = 'expired';
    }
    const children = stmts.getChildrenByParent.all(req.user.id);
    res.json({ success: true, subscribed: true, plan: sub.plan, status: sub.status, trial_ends_at: sub.trial_ends_at, current_period_end: sub.current_period_end, children_count: children.length, stripe_enabled: STRIPE_CONFIGURED });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

app.post('/api/kids/subscribe/cancel', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const sub = stmts.getKidsSubByUser.get(req.user.id);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (sub.stripe_sub_id && STRIPE_SECRET) {
      await stripeRequest('POST', `/subscriptions/${sub.stripe_sub_id}`, { cancel_at_period_end: 'true' });
    }
    stmts.updateKidsSubStatus.run('canceled', sub.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[KIDS] Cancel error:', err.message);
    res.status(500).json({ error: 'Cancel failed' });
  }
});

// Stripe webhook (raw body needed, signature verified)
app.post('/api/kids/subscribe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    // Fail-closed: reject all webhooks when secret is not configured
    if (!STRIPE_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Webhook signature verification not configured' });
    }

    const payload = req.body.toString ? req.body.toString() : JSON.stringify(req.body);

    // Verify Stripe webhook signature
    {
      const sig = req.headers['stripe-signature'] || '';
      if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
      const parts = sig.split(',').reduce((acc, p) => {
        const [k, v] = p.split('=');
        if (k === 't') acc.t = v;
        if (k === 'v1') acc.v1 = v;
        return acc;
      }, { t: '', v1: '' });
      if (!parts.t || !parts.v1) return res.status(400).json({ error: 'Invalid signature format' });
      const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
        .update(`${parts.t}.${payload}`)
        .digest('hex');
      if (!timingSafeCompare(expected, parts.v1)) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    const event = JSON.parse(payload);
    // Validate timestamp is within 5 minutes to prevent replay attacks
    {
      const sig = req.headers['stripe-signature'] || '';
      const tMatch = sig.split(',').find(p => p.startsWith('t='));
      if (tMatch) {
        const ts = parseInt(tMatch.split('=')[1]);
        if (Math.abs(Date.now() / 1000 - ts) > 300) {
          return res.status(400).json({ error: 'Webhook timestamp too old' });
        }
      }
    }
    const type = event.type;
    const obj = event.data?.object;
    if (!obj) return res.json({ received: true });

    if (type === 'checkout.session.completed' && obj.subscription && obj.client_reference_id) {
      // Initial subscription activation — client_reference_id is our user ID (UUID string)
      const userId = String(obj.client_reference_id).trim();
      if (userId) {
        const sub = stmts.getKidsSubByUser.get(userId);
        const plan = obj.metadata?.plan || 'monthly';
        const periodEnd = obj.expires_at ? new Date(obj.expires_at * 1000).toISOString() : new Date(Date.now() + 30 * 86400000).toISOString();
        if (sub) {
          stmts.updateKidsSubStripe.run(obj.customer, obj.subscription, plan, 'active', periodEnd, sub.id);
        } else {
          stmts.insertKidsSub.run(userId, obj.customer, obj.subscription, plan, 'active', null, periodEnd, new Date().toISOString());
        }
        console.log(`[KIDS] Subscription activated for user ${userId}`);
      }
    } else if (type === 'invoice.paid' && obj.subscription) {
      // Renewal — find by stripe subscription ID
      const row = stmts.getKidsSubByStripeId.get(obj.subscription);
      if (row) {
        const plan = obj.lines?.data?.[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
        const periodEnd = new Date((obj.lines?.data?.[0]?.period?.end || 0) * 1000).toISOString();
        stmts.updateKidsSubStripe.run(obj.customer, obj.subscription, plan, 'active', periodEnd, row.id);
      }
    } else if (type === 'customer.subscription.deleted') {
      const row = stmts.getKidsSubByStripeId.get(obj.id);
      if (row) stmts.updateKidsSubStatus.run('canceled', row.id);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[KIDS] Webhook error:', err.message);
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

// Referral
app.post('/api/kids/subscribe/referral', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    // Require active subscription to generate referral codes (prevent referral ring abuse)
    const sub = stmts.getKidsSubByUser.get(req.user.id);
    if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) {
      return res.status(402).json({ error: 'Active subscription required to generate referral codes' });
    }
    const existing = stmts.getKidsReferralsByUser.all(req.user.id);
    if (existing.length >= 10) return res.status(400).json({ error: 'Maximum 10 referral codes' });
    const code = crypto.randomBytes(6).toString('hex');
    stmts.insertKidsReferral.run(req.user.id, '', code, new Date().toISOString());
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate referral code' });
  }
});

app.post('/api/kids/subscribe/redeem', (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const code = sanitize(req.body.code || '');
    if (!code) return res.status(400).json({ error: 'Code required' });
    const ref = stmts.getKidsReferralByCode.get(code);
    if (!ref) return res.status(404).json({ error: 'Invalid referral code' });
    if (ref.redeemed_by) return res.status(400).json({ error: 'Code already redeemed' });
    if (ref.referrer_user_id === req.user.id) return res.status(400).json({ error: 'Cannot redeem your own code' });
    const redeemResult = stmts.redeemKidsReferral.run(req.user.id, new Date().toISOString(), code);
    if (redeemResult.changes === 0) return res.status(409).json({ error: 'Code already redeemed' });
    // Actually extend the redeemer's subscription by 30 days
    const sub = stmts.getKidsSubByUser.get(req.user.id);
    if (sub) {
      const currentEnd = sub.current_period_end ? new Date(sub.current_period_end) : new Date();
      const newEnd = new Date(Math.max(currentEnd.getTime(), Date.now()) + 30 * 86400000);
      stmts.updateKidsSubStripe.run(sub.stripe_customer_id, sub.stripe_sub_id, sub.plan, sub.status === 'expired' ? 'active' : sub.status, newEnd.toISOString(), sub.id);
    } else {
      // No subscription yet — create a 30-day trial equivalent
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 86400000);
      stmts.insertKidsSub.run(req.user.id, null, null, 'referral', 'active', null, end.toISOString(), now.toISOString());
    }
    // Also extend the referrer's subscription by 30 days
    const referrerSub = stmts.getKidsSubByUser.get(ref.referrer_user_id);
    if (referrerSub) {
      const refEnd = referrerSub.current_period_end ? new Date(referrerSub.current_period_end) : new Date();
      const newRefEnd = new Date(Math.max(refEnd.getTime(), Date.now()) + 30 * 86400000);
      stmts.updateKidsSubStripe.run(referrerSub.stripe_customer_id, referrerSub.stripe_sub_id, referrerSub.plan, referrerSub.status === 'expired' ? 'active' : referrerSub.status, newRefEnd.toISOString(), referrerSub.id);
    }
    res.json({ success: true, message: 'Referral redeemed — 1 free month applied to both accounts' });
  } catch (err) {
    res.status(500).json({ error: 'Redeem failed' });
  }
});

// ── Kids: Learning Paths ────────────────────────────────
app.get('/api/kids/paths', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ success: true, paths: kidsPathsData.paths || [], quiz_questions: kidsPathsData.quiz_questions || [] });
});

app.get('/api/kids/paths/:pathId', (req, res) => {
  const p = (kidsPathsData.paths || []).find(p => p.id === req.params.pathId);
  if (!p) return res.status(404).json({ error: 'Path not found' });
  res.json({ success: true, path: p });
});

// ── Kids: Progress (require subscription) ───────────────
app.post('/api/kids/progress/start', requireKidsSub, (req, res) => {
  try {
    const child_id = parseInt(req.body.child_id);
    const path_id = req.body.path_id;
    if (!Number.isInteger(child_id) || child_id <= 0) return res.status(400).json({ error: 'Valid child_id required' });
    const child = verifyParentChild(req, child_id);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const pathDef = (kidsPathsData.paths || []).find(p => p.id === path_id);
    if (!pathDef) return res.status(404).json({ error: 'Path not found' });
    const existing = stmts.getProgressByChildPath.get(child_id, path_id);
    if (existing) return res.status(400).json({ error: 'Path already started', progress: existing });
    const now = new Date().toISOString();
    stmts.insertKidsProgress.run(child_id, path_id, now, now);
    stmts.logKidsActivity.run(child_id, 'path_started', path_id, 0, now);
    res.json({ success: true });
  } catch (err) {
    console.error('[KIDS] Start progress error:', err.message);
    res.status(500).json({ error: 'Failed to start path' });
  }
});

app.get('/api/kids/progress/:childId', requireKidsSub, (req, res) => {
  try {
    const child = verifyParentChild(req, parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const progress = stmts.getProgressByChild.all(child.id);
    res.json({ success: true, progress });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load progress' });
  }
});

app.put('/api/kids/progress/:childId/:pathId', requireKidsSub, (req, res) => {
  try {
    const child = verifyParentChild(req, parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    // Sanitize pathId: alphanumeric + hyphens/underscores only, max 64 chars
    const pathId = String(req.params.pathId || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);
    if (!pathId) return res.status(400).json({ error: 'Invalid path ID' });
    const prog = stmts.getProgressByChildPath.get(child.id, pathId);
    if (!prog) return res.status(404).json({ error: 'Path not started' });
    // Derive max quest index from path definition (not hardcoded)
    const pathDef = (kidsPathsData.paths || []).find(p => p.id === pathId);
    const maxQuestIndex = pathDef ? pathDef.chapters.flatMap(c => c.quests).length - 1 : 19;
    // Fix: use Number.isNaN to handle explicit 0, prevent backwards progress
    const parsed = parseInt(req.body.quest_index);
    const requestedIndex = Number.isNaN(parsed) ? prog.quest_index : parsed;
    const questIndex = Math.max(prog.quest_index, Math.min(requestedIndex, maxQuestIndex));
    // Only award XP when quest_index actually advances (prevents XP farming)
    const advanced = questIndex > prog.quest_index;
    // XP is server-authoritative: use quest definition XP, ignore client value
    const questDef = pathDef?.chapters?.flatMap(c => c.quests)?.[questIndex];
    const xpAdd = advanced ? (questDef?.xp || 50) : 0;
    const newXp = prog.xp + xpAdd;
    const newLevel = xpToLevel(newXp);
    const now = new Date().toISOString();
    stmts.updateProgress.run(questIndex, newXp, newLevel, now, child.id, pathId);
    if (xpAdd > 0) stmts.logKidsActivity.run(child.id, 'quest_progress', `${pathId}:quest-${questIndex}`, xpAdd, now);
    res.json({ success: true, quest_index: questIndex, xp: newXp, level: newLevel });
  } catch (err) {
    console.error('[KIDS] Update progress error:', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

app.post('/api/kids/progress/:childId/:pathId/complete', requireKidsSub, (req, res) => {
  try {
    const child = verifyParentChild(req, parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    // Sanitize pathId
    const pathId = String(req.params.pathId || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);
    if (!pathId) return res.status(400).json({ error: 'Invalid path ID' });
    const prog = stmts.getProgressByChildPath.get(child.id, pathId);
    if (!prog) return res.status(404).json({ error: 'Path not started' });
    // Require all quests completed before path completion
    const pathDef = (kidsPathsData.paths || []).find(p => p.id === pathId);
    const totalQuests = pathDef ? pathDef.chapters.flatMap(c => c.quests).length : 20;
    if (prog.quest_index < totalQuests - 1) {
      return res.status(400).json({ error: `Must complete all ${totalQuests} quests before finishing path (currently on quest ${prog.quest_index + 1})` });
    }
    const now = new Date().toISOString();
    stmts.completeProgress.run(now, now, child.id, pathId);
    stmts.logKidsActivity.run(child.id, 'path_completed', pathId, 100, now);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete path' });
  }
});

// ── Kids: Artifacts ─────────────────────────────────────
app.post('/api/kids/artifacts', requireKidsSub, (req, res) => {
  try {
    const { path_id, quest_index, artifact_type, title, content } = req.body;
    const child_id = parseInt(req.body.child_id);
    if (!Number.isInteger(child_id) || child_id <= 0) return res.status(400).json({ error: 'Valid child_id required' });
    const child = verifyParentChild(req, child_id);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    // Cap artifacts per child to prevent DB bloat
    const existingCount = stmts.getArtifactsByChild.all(child_id).length;
    if (existingCount >= 100) return res.status(400).json({ error: 'Maximum 100 artifacts per child' });
    const cleanTitle = sanitize(title || '');
    if (!cleanTitle) return res.status(400).json({ error: 'Title required' });
    const VALID_ARTIFACT_TYPES = ['document', 'code', 'design', 'project', 'essay', 'report', 'plan'];
    const cleanType = VALID_ARTIFACT_TYPES.includes(artifact_type) ? artifact_type : 'document';
    // Validate path_id against known paths
    const knownPathIds = new Set((kidsPathsData.paths || []).map(p => p.id));
    const cleanPathId = sanitize(path_id || '');
    if (cleanPathId && !knownPathIds.has(cleanPathId)) return res.status(400).json({ error: 'Invalid path_id' });
    // Content is JSON string, cap at 50KB, sanitize on write for defense-in-depth
    const rawContent = typeof content === 'string' ? content.slice(0, 51200) : JSON.stringify(content || {}).slice(0, 51200);
    const cleanContent = rawContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const cleanQuestIndex = Math.max(0, Math.min(parseInt(quest_index) || 0, 19));
    const now = new Date().toISOString();
    const result = stmts.insertArtifact.run(child_id, cleanPathId, cleanQuestIndex, cleanType, cleanTitle, cleanContent, now);
    stmts.logKidsActivity.run(child_id, 'artifact_saved', cleanTitle, 0, now);
    res.json({ success: true, artifact_id: result.lastInsertRowid });
  } catch (err) {
    console.error('[KIDS] Save artifact error:', err.message);
    res.status(500).json({ error: 'Failed to save artifact' });
  }
});

app.get('/api/kids/artifacts/:childId', requireKidsSub, (req, res) => {
  try {
    const child = verifyParentChild(req, parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const artifacts = stmts.getArtifactsByChild.all(child.id);
    res.json({ success: true, artifacts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load artifacts' });
  }
});

app.put('/api/kids/artifacts/:id/publish', requireKidsSub, (req, res) => {
  try {
    const artifact = stmts.getArtifactWithParent.get(parseInt(req.params.id));
    if (!artifact || artifact.parent_user_id !== req.user.id) return res.status(404).json({ error: 'Artifact not found' });
    const newPublic = artifact.is_public ? 0 : 1;
    stmts.toggleArtifactPublic.run(newPublic, artifact.id, artifact.child_id);
    res.json({ success: true, is_public: !!newPublic });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle visibility' });
  }
});

// Public portfolio (no auth — rate limited by kids middleware above)
app.get('/api/kids/portfolio/:childId', (req, res) => {
  try {
    const child = stmts.getChildById.get(parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Not found' });
    // title/artifact_type already sanitized on save; content is raw JSON so sanitize on output
    const artifacts = stmts.getPublicArtifacts.all(child.id).map(a => ({
      id: a.id, path_id: a.path_id, quest_index: a.quest_index,
      artifact_type: a.artifact_type, title: a.title,
      content: typeof a.content === 'string'
        ? a.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        : '',
      created_at: a.created_at,
    }));
    const progress = stmts.getProgressByChild.all(child.id);
    res.json({
      success: true,
      child: { display_name: child.display_name, age_group: child.age_group },
      artifacts,
      completed_paths: progress.filter(p => p.completed_at).map(p => p.path_id),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

// ── Kids: Parent Dashboard ──────────────────────────────
app.get('/api/kids/dashboard', requireKidsSub, (req, res) => {
  try {
    const children = stmts.getChildrenByParent.all(req.user.id);
    const stats = children.map(c => {
      const progress = stmts.getProgressByChild.all(c.id);
      const artifacts = stmts.getArtifactsByChild.all(c.id);
      const totalXp = progress.reduce((sum, p) => sum + (p.xp || 0), 0);
      return {
        child: c,
        paths_started: progress.length,
        paths_completed: progress.filter(p => p.completed_at).length,
        total_xp: totalXp,
        level: xpToLevel(totalXp),
        artifacts_count: artifacts.length,
        last_active: progress.reduce((latest, p) => p.last_activity > latest ? p.last_activity : latest, ''),
      };
    });
    res.json({ success: true, children: stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

app.get('/api/kids/activity/:childId', requireKidsSub, (req, res) => {
  try {
    const child = verifyParentChild(req, parseInt(req.params.childId));
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const activity = stmts.getActivityByChild.all(child.id);
    res.json({ success: true, activity });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

app.get('/api/kids/activity', requireKidsSub, (req, res) => {
  try {
    const activity = stmts.getActivityByParent.all(req.user.id);
    res.json({ success: true, activity });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// Kids quiz → path recommendations
app.post('/api/kids/quiz-submit', (req, res) => {
  try {
    const { answers } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers array required' });
    const tags = answers.flat().filter(t => typeof t === 'string').map(t => t.toLowerCase());
    const paths = kidsPathsData.paths || [];
    const scored = paths.map(p => {
      const matchCount = (p.quiz_tags || []).filter(t => tags.includes(t)).length;
      return { id: p.id, name: p.name, age_group: p.age_group, tagline: p.tagline, icon: p.icon, score: matchCount };
    }).sort((a, b) => b.score - a.score);
    res.json({ success: true, recommended: scored.slice(0, 3), all: scored });
  } catch (err) {
    res.status(500).json({ error: 'Quiz processing failed' });
  }
});

// Explicit HTML page routes (before wildcard)
['/learn', '/certificate', '/admin', '/marketing', '/login', '/profile'].forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'site', route.slice(1) + '.html'));
  });
});

// Serve curriculum files (kids quest markdown)
app.use('/curriculum', express.static(path.join(__dirname, 'curriculum')));

// Serve static files from /site
app.use(express.static(path.join(__dirname, 'site')));

// Fallback to index.html for SPA-style routing
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'site', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({
      error: 'Not found',
      message: 'No site/index.html found. Deploy your landing page to the /site directory.'
    });
  }
});

// Global error handler — prevent stack traces in responses
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error('[ERROR] Unhandled:', err.message);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[ANVIL] Server running on port ${PORT} (${NODE_ENV})`);
  console.log(`[ANVIL] Static files: ${path.join(__dirname, 'site')}`);
  console.log(`[ANVIL] Database: ${DB_PATH}`);
  console.log(`[ANVIL] Health check: http://localhost:${PORT}/health`);

  // Scheduled auto-scan: Federal Register + NVD daily (free, no key), BLS on Mondays, O*NET keyword on Wednesdays
  setTimeout(() => {
    const sources = ['federal_register', 'nvd'];
    if (new Date().getDay() === 1) sources.push('bls');
    if (new Date().getDay() === 3) sources.push('onet_keyword');
    console.log('[DISCOVERY] Running scheduled scan...', sources);
    discovery.scan(sources, stmts).catch(err => console.error('[DISCOVERY] Scheduled scan error:', err.message));
  }, 60000);

  setInterval(() => {
    const sources = ['federal_register', 'nvd'];
    if (new Date().getDay() === 1) sources.push('bls');
    if (new Date().getDay() === 3) sources.push('onet_keyword');
    console.log('[DISCOVERY] Running scheduled scan...', sources);
    discovery.scan(sources, stmts).catch(err => console.error('[DISCOVERY] Scheduled scan error:', err.message));
  }, 24 * 60 * 60 * 1000);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[ANVIL] ${signal} received — shutting down gracefully...`);
  server.close(() => {
    try { db.close(); } catch (e) { /* already closed */ }
    console.log('[ANVIL] Server + database closed. Goodbye.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
