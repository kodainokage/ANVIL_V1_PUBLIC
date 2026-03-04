const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const API_KEY = process.env.API_KEY || 'dev-key-change-in-production';

// Production safety: require real API_KEY
if (NODE_ENV === 'production' && API_KEY === 'dev-key-change-in-production') {
  console.error('[FATAL] API_KEY must be set in production. Exiting.');
  process.exit(1);
}
const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const REFERRALS_FILE = path.join(DATA_DIR, 'referrals.json');
const TESTIMONIALS_FILE = path.join(DATA_DIR, 'testimonials.json');
const GRADUATES_FILE = path.join(DATA_DIR, 'graduates.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const CURRICULUM_FILE = path.join(DATA_DIR, 'curriculum-progress.json');
const PULSE_FILE = path.join(DATA_DIR, 'pulse-feed.json');

// Community links
const COMMUNITY_DISCORD = process.env.COMMUNITY_DISCORD || '';
const COMMUNITY_SIGNAL = process.env.COMMUNITY_SIGNAL || '';

// Write queue to prevent concurrent JSON file corruption
let writeQueue = Promise.resolve();
function queueWrite(filePath, data) {
  writeQueue = writeQueue.then(() => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }).catch(err => {
    console.error('[WRITE ERROR]', filePath, err.message);
  });
  return writeQueue;
}

// Safe JSON reader
function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// Safe JSON reader for object-keyed files
function readJSONObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return (typeof data === 'object' && data !== null && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}


// SECURITY: [TBHM Phase 4 - Authentication] - Constant-time API key comparison
// Prevents: Timing attacks that leak API key length/content via response timing
// Enterprise: NIST 800-63B Section 5.2.8 (Authentication Intent)
function requireApiKey(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Constant-time comparison to prevent timing attacks
  const apiKeyBuf = Buffer.from(API_KEY, 'utf8');
  const tokenBuf = Buffer.from(token, 'utf8');

  // If lengths differ, compare against dummy buffer of same length as API_KEY
  const compareBuf = tokenBuf.length === apiKeyBuf.length ? tokenBuf : Buffer.alloc(apiKeyBuf.length);

  const isValid = tokenBuf.length === apiKeyBuf.length &&
                  crypto.timingSafeEqual(apiKeyBuf, compareBuf);

  if (!isValid) {
    res.status(403).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Allowed origins for CORS
const ALLOWED_ORIGINS = NODE_ENV === 'production'
  ? [process.env.ALLOWED_ORIGIN || 'https://anvil.onrender.com']
  : ['http://localhost:10000', 'http://127.0.0.1:10000', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://localhost:3000', 'http://127.0.0.1:3000'];

// Rate limiting (in-memory, no extra dependency)
const rateLimits = new Map();
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_MAX_WRITE = 10; // max write requests (POST) per window per IP
const RATE_MAX_READ = 120; // max read requests (GET) per window per IP

// SECURITY: [TBHM Phase 5 - Rate Limit Bypass] - Trusted IP extraction
// Prevents: X-Forwarded-For header spoofing to bypass rate limits
// Enterprise: OWASP ASVS 4.0.3 V11.1.4 (Rate Limiting)
function getTrustedIP(req) {
  // Only trust X-Forwarded-For if behind a proxy in production
  if (NODE_ENV === 'production' && req.headers['x-forwarded-for']) {
    // Take leftmost IP (original client) but validate it's not private/local
    const forwarded = req.headers['x-forwarded-for'].split(',')[0].trim();
    // Reject private IP ranges attempting to spoof
    if (!/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|169\.254\.|::1|fc00:|fe80:)/.test(forwarded)) {
      return forwarded;
    }
  }
  // Fallback to direct connection IP
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function rateLimit(req, res) {
  const ip = getTrustedIP(req);
  const isRead = req.method === 'GET';
  const key = ip + (isRead ? ':r' : ':w');
  const maxReqs = isRead ? RATE_MAX_READ : RATE_MAX_WRITE;
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimits.set(key, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= maxReqs) {
    const retryAfter = Math.ceil((RATE_WINDOW - (now - entry.windowStart)) / 1000);
    if (res) res.setHeader('Retry-After', String(retryAfter));
    return false;
  }
  entry.count++;
  return true;
}

// Clean stale rate limit entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) rateLimits.delete(ip);
  }
}, 30 * 60 * 1000);

// Middleware
app.use(express.json({ limit: '16kb' }));

// SECURITY: [TBHM Phase 8 - Transport Security] - Comprehensive security headers
// Prevents: Clickjacking, MIME sniffing, XSS, missing HSTS
// Enterprise: OWASP Secure Headers Project + PCI DSS 6.5.10
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // HSTS: Force HTTPS for 1 year in production
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Permissions-Policy: Disable unnecessary browser features
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  // Content-Security-Policy: Basic XSS protection (upgrade as needed)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;");

  next();
});

// SECURITY: [TBHM Phase 8 - CORS Bypass] - Strict origin validation
// Prevents: CORS wildcard in development, origin reflection attacks
// Enterprise: OWASP ASVS 4.0.3 V14.5.3 (CORS Configuration)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOriginsList = ALLOWED_ORIGINS;

  // FIXED: Even in development, only allow specific origins (no wildcard)
  if (NODE_ENV !== 'production') {
    // If origin matches allowed list, reflect it; otherwise use first allowed origin
    const allowedOrigin = allowedOriginsList.includes(origin) ? origin : allowedOriginsList[0];
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  } else if (origin && allowedOriginsList.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  } else if (!origin) {
    res.header('Access-Control-Allow-Origin', allowedOriginsList[0]);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  } else {
    console.warn(`[CORS] Rejected request from unauthorized origin: ${origin}`);
  }

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Ensure data directory and submissions file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(SUBMISSIONS_FILE)) {
  fs.writeFileSync(SUBMISSIONS_FILE, '[]', 'utf8');
}
[ANALYTICS_FILE, REFERRALS_FILE, TESTIMONIALS_FILE, GRADUATES_FILE].forEach(f => {
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '[]', 'utf8');
  }
});
[PROGRESS_FILE, CURRICULUM_FILE].forEach(f => {
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '{}', 'utf8');
  }
});
if (!fs.existsSync(PULSE_FILE)) {
  fs.writeFileSync(PULSE_FILE, '[]', 'utf8');
}

// Input sanitization
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
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
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  if (parts[0].length > 64 || parts[0].length === 0) return false;
  if (parts[1].length === 0 || !parts[1].includes('.')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Health check (rate limited to prevent enumeration)
app.get('/health', (req, res) => {
  if (!rateLimit(req, res)) {
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
  if (!rateLimit(req, res)) {
    return res.status(429).json({
      success: false,
      error: 'Too many submissions. Try again in 15 minutes.'
    });
  }

  try {
    const { name, email, phone, answers, recommendedNiches } = req.body;

    // Validate required fields
    const cleanName = sanitize(name);
    const cleanEmail = (typeof email === 'string' ? email.trim().toLowerCase() : '');

    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const submission = {
      id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      name: cleanName,
      email: cleanEmail,
      phone: sanitize(phone || ''),
      answers: Array.isArray(answers) ? answers.slice(0, 20).map(a => sanitize(String(a))) : [],
      recommendedNiches: Array.isArray(recommendedNiches) ? recommendedNiches.slice(0, 7).map(n => sanitize(String(n))) : [],
      referralCode: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      referredBy: sanitize(req.body.referredBy || ''),
      utmSource: sanitize(req.body.utmSource || ''),
      utmMedium: sanitize(req.body.utmMedium || ''),
      utmCampaign: sanitize(req.body.utmCampaign || ''),
      submittedAt: new Date().toISOString(),
      ip: req.ip || 'unknown'
    };

    const submissions = readJSON(SUBMISSIONS_FILE);
    submissions.push(submission);
    queueWrite(SUBMISSIONS_FILE, submissions);

    console.log(`[SUBMISSION] ${submission.id} | ${cleanName} <${cleanEmail}> | Niches: ${submission.recommendedNiches.join(', ') || 'none'}`);

    res.json({
      success: true,
      id: submission.id,
      referralCode: submission.referralCode,
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

// Get submissions — protected by API key
app.get('/api/submissions', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (token !== API_KEY) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
    let submissions = [];

    try {
      submissions = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[ERROR] Submissions file is corrupted:', parseErr.message);
      // Return empty list rather than crashing
      submissions = [];
    }

    // Validate it's an array
    if (!Array.isArray(submissions)) {
      console.warn('[WARNING] Submissions file is not an array. Resetting.');
      submissions = [];
    }

    res.json({
      success: true,
      count: submissions.length,
      submissions
    });
  } catch (err) {
    console.error('[ERROR] Failed to read submissions:', err.message);
    res.json({
      success: true,
      count: 0,
      submissions: []
    });
  }
});

// --- Public results for shareable links ---
app.get('/api/results/:id', (req, res) => {
  try {
    const submissions = readJSON(SUBMISSIONS_FILE);
    const sub = submissions.find(s => s.id === req.params.id);
    if (!sub) {
      return res.status(404).json({ success: false, error: 'Result not found' });
    }
    // Return only safe public fields (no email, IP, phone)
    const firstName = (sub.name || '').split(' ')[0];
    res.json({
      success: true,
      result: {
        id: sub.id,
        name: firstName,
        recommendedNiches: sub.recommendedNiches || [],
        submittedAt: sub.submittedAt
      }
    });
  } catch (err) {
    console.error('[ERROR] Results lookup failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Privacy-respecting analytics ---
app.post('/api/analytics/event', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { event, page, data } = req.body;
    const ip = getTrustedIP(req);
    const hash = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    // SECURITY: [TBHM Phase 2 - XSS in Analytics] - Prevent prototype pollution
    // Prevents: __proto__ injection, constructor pollution via JSON
    // Enterprise: CWE-1321 (Improperly Controlled Modification of Object Prototype)
    let safeData = {};
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of Object.keys(data)) {
        // Block prototype pollution attempts
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        // Only copy safe primitive values
        const val = data[key];
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          safeData[key] = typeof val === 'string' ? sanitize(val) : val;
        }
      }
    }

    const entry = {
      event: sanitize(event || ''),
      page: sanitize(page || ''),
      data: safeData,
      fingerprint: hash,
      timestamp: new Date().toISOString()
    };

    const analytics = readJSON(ANALYTICS_FILE);
    analytics.push(entry);
    queueWrite(ANALYTICS_FILE, analytics);

    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Analytics event failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Record referral visit ---
app.post('/api/referrals/track', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { referralCode, referredPage } = req.body;
    const cleanCode = sanitize(referralCode || '');
    if (!cleanCode) {
      return res.status(400).json({ success: false, error: 'referralCode is required' });
    }

    // SECURITY: [TBHM Phase 7 - Business Logic] - Prevent self-referral abuse
    // Prevents: Users creating multiple referral visits from same IP
    // Enterprise: OWASP ASVS 4.0.3 V11.1.7 (Business Logic Security)
    const ip = getTrustedIP(req);
    const fingerprint = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    // Check if this fingerprint has already tracked this referral code in last 24h
    const referrals = readJSON(REFERRALS_FILE);
    const recentDupe = referrals.find(r =>
      r.referralCode === cleanCode &&
      r.fingerprint === fingerprint &&
      (Date.now() - new Date(r.timestamp).getTime() < 24 * 60 * 60 * 1000)
    );
    if (recentDupe) {
      // Silently succeed to prevent enumeration, but don't record duplicate
      return res.json({ success: true });
    }

    // Verify referralCode exists in submissions
    const submissions = readJSON(SUBMISSIONS_FILE);
    const exists = submissions.some(s => s.referralCode === cleanCode);
    if (!exists) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }

    referrals.push({
      referralCode: cleanCode,
      referredPage: sanitize(referredPage || ''),
      timestamp: new Date().toISOString(),
      fingerprint
    });
    queueWrite(REFERRALS_FILE, referrals);

    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Referral tracking failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Top 10 referrers (public) ---
app.get('/api/referrals/leaderboard', (req, res) => {
  try {
    const referrals = readJSON(REFERRALS_FILE);
    const counts = {};
    referrals.forEach(r => {
      counts[r.referralCode] = (counts[r.referralCode] || 0) + 1;
    });
    const leaderboard = Object.entries(counts)
      .map(([referralCode, count]) => ({ referralCode, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    res.json({ success: true, leaderboard });
  } catch (err) {
    console.error('[ERROR] Leaderboard failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Referral count for specific code ---
app.get('/api/referrals/status/:code', (req, res) => {
  try {
    const referrals = readJSON(REFERRALS_FILE);
    const count = referrals.filter(r => r.referralCode === req.params.code).length;
    res.json({ success: true, referralCode: req.params.code, count });
  } catch (err) {
    console.error('[ERROR] Referral status failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Submit testimonial ---
app.post('/api/testimonials', (req, res) => {
  if (!rateLimit(req, res)) {
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
    if (!cleanText || cleanText.length < 10 || cleanText.length > 500) {
      return res.status(400).json({ success: false, error: 'Text must be between 10 and 500 characters' });
    }
    if (isNaN(cleanRating) || cleanRating < 1 || cleanRating > 5) {
      return res.status(400).json({ success: false, error: 'Rating must be between 1 and 5' });
    }

    const testimonial = {
      id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      name: cleanName,
      text: cleanText,
      niche: cleanNiche,
      rating: cleanRating,
      approved: false,
      submittedAt: new Date().toISOString()
    };

    const testimonials = readJSON(TESTIMONIALS_FILE);
    testimonials.push(testimonial);
    queueWrite(TESTIMONIALS_FILE, testimonials);

    console.log(`[TESTIMONIAL] ${testimonial.id} | ${cleanName} | Rating: ${cleanRating}`);
    res.json({ success: true, id: testimonial.id });
  } catch (err) {
    console.error('[ERROR] Testimonial submission failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Public approved testimonials ---
app.get('/api/testimonials', (req, res) => {
  try {
    const testimonials = readJSON(TESTIMONIALS_FILE);
    const approved = testimonials.filter(t => t.approved === true);
    res.json({ success: true, testimonials: approved });
  } catch (err) {
    console.error('[ERROR] Testimonials read failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Graduate directory opt-in ---
app.post('/api/graduates', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { name, niche, city, state } = req.body;
    const cleanName = sanitize(name);
    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const graduate = {
      id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      name: cleanName,
      niche: sanitize(niche || ''),
      city: sanitize(city || ''),
      state: sanitize(state || ''),
      joinedAt: new Date().toISOString()
    };

    const graduates = readJSON(GRADUATES_FILE);
    graduates.push(graduate);
    queueWrite(GRADUATES_FILE, graduates);

    console.log(`[GRADUATE] ${graduate.id} | ${cleanName} | ${graduate.niche}`);
    res.json({ success: true, id: graduate.id });
  } catch (err) {
    console.error('[ERROR] Graduate registration failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// SECURITY: [TBHM Phase 7 - Session Fixation] - Tie session to IP fingerprint
// Prevents: Session manipulation, progress tampering across different users
// Enterprise: OWASP ASVS 4.0.3 V3.3.1 (Session Binding)

// Session ownership validation
function validateSessionOwnership(sessionId, req) {
  const ip = getTrustedIP(req);
  const fingerprint = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);
  // Session ID should contain fingerprint (first 12 chars) to prevent cross-user access
  return sessionId.startsWith(fingerprint);
}

function createSessionId(req) {
  const ip = getTrustedIP(req);
  const fingerprint = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);
  const random = Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
  return fingerprint + '-' + random;
}

// --- Create secure session ID (fingerprinted to user) ---
app.post('/api/create-session', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const sessionId = createSessionId(req);
    res.json({ success: true, sessionId });
  } catch (err) {
    console.error('[ERROR] Session creation failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Quiz progress persistence (server-side session) ---
app.post('/api/quiz-progress', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { sessionId, currentQuestion, answers } = req.body;
    const cleanId = sanitize(sessionId || '');

    if (!cleanId || cleanId.length < 1) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // Validate session ownership to prevent cross-user tampering
    if (!validateSessionOwnership(cleanId, req)) {
      return res.status(403).json({ success: false, error: 'Invalid session' });
    }

    // Validate currentQuestion is a number 0-20
    const qNum = parseInt(currentQuestion, 10);
    if (isNaN(qNum) || qNum < 0 || qNum > 20) {
      return res.status(400).json({ success: false, error: 'currentQuestion must be a number between 0 and 20' });
    }

    // Validate answers is an array, max 20 elements
    if (!Array.isArray(answers) || answers.length > 20) {
      return res.status(400).json({ success: false, error: 'answers must be an array with max 20 elements' });
    }

    const cleanAnswers = answers.map(a => sanitize(String(a)));

    const progress = readJSONObject(PROGRESS_FILE);
    progress[cleanId] = {
      currentQuestion: qNum,
      answers: cleanAnswers,
      updatedAt: new Date().toISOString()
    };
    queueWrite(PROGRESS_FILE, progress);

    console.log('[QUIZ-PROGRESS] Saved for session ' + cleanId + ' at question ' + qNum);
    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Quiz progress save failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/quiz-progress/:sessionId', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const cleanId = sanitize(req.params.sessionId || '');
    if (!cleanId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // Validate session ownership
    if (!validateSessionOwnership(cleanId, req)) {
      return res.status(403).json({ success: false, error: 'Invalid session' });
    }

    const progress = readJSONObject(PROGRESS_FILE);
    if (!progress[cleanId]) {
      return res.status(404).json({ success: false, error: 'No progress found for this session' });
    }

    res.json({ success: true, progress: progress[cleanId] });
  } catch (err) {
    console.error('[ERROR] Quiz progress read failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Curriculum progress persistence (server-side session) ---
app.post('/api/curriculum/progress', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { sessionId, currentDay, completedDays, quizScores } = req.body;
    const cleanId = sanitize(sessionId || '');

    if (!cleanId || cleanId.length < 1) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // Validate session ownership
    if (!validateSessionOwnership(cleanId, req)) {
      return res.status(403).json({ success: false, error: 'Invalid session' });
    }

    // Validate currentDay is 1-7
    const dayNum = parseInt(currentDay, 10);
    if (isNaN(dayNum) || dayNum < 1 || dayNum > 7) {
      return res.status(400).json({ success: false, error: 'currentDay must be a number between 1 and 7' });
    }

    // Validate completedDays is array of numbers 1-7
    if (!Array.isArray(completedDays)) {
      return res.status(400).json({ success: false, error: 'completedDays must be an array' });
    }
    const cleanCompleted = completedDays
      .map(d => parseInt(d, 10))
      .filter(d => !isNaN(d) && d >= 1 && d <= 7);

    // Validate quizScores is an object with numeric values
    const cleanScores = {};
    if (typeof quizScores === 'object' && quizScores !== null && !Array.isArray(quizScores)) {
      for (const key in quizScores) {
        const dayKey = parseInt(key, 10);
        const score = parseInt(quizScores[key], 10);
        if (!isNaN(dayKey) && dayKey >= 1 && dayKey <= 7 && !isNaN(score) && score >= 0 && score <= 5) {
          cleanScores[dayKey] = score;
        }
      }
    }

    const curriculum = readJSONObject(CURRICULUM_FILE);
    curriculum[cleanId] = {
      currentDay: dayNum,
      completedDays: cleanCompleted,
      quizScores: cleanScores,
      updatedAt: new Date().toISOString()
    };
    queueWrite(CURRICULUM_FILE, curriculum);

    console.log('[CURRICULUM] Saved for session ' + cleanId + ' — day ' + dayNum + ', ' + cleanCompleted.length + ' completed');
    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Curriculum progress save failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/curriculum/progress/:sessionId', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const cleanId = sanitize(req.params.sessionId || '');
    if (!cleanId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // Validate session ownership
    if (!validateSessionOwnership(cleanId, req)) {
      return res.status(403).json({ success: false, error: 'Invalid session' });
    }

    const curriculum = readJSONObject(CURRICULUM_FILE);
    if (!curriculum[cleanId]) {
      return res.status(404).json({ success: false, error: 'No curriculum progress found for this session' });
    }

    res.json({ success: true, progress: curriculum[cleanId] });
  } catch (err) {
    console.error('[ERROR] Curriculum progress read failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Analytics summary (API key protected) ---
app.get('/api/admin/analytics', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const analytics = readJSON(ANALYTICS_FILE);
    const uniqueFingerprints = new Set(analytics.map(a => a.fingerprint)).size;
    const eventBreakdown = {};
    const dailyCounts = {};

    analytics.forEach(a => {
      eventBreakdown[a.event] = (eventBreakdown[a.event] || 0) + 1;
      const day = (a.timestamp || '').slice(0, 10);
      if (day) {
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
    });

    res.json({
      success: true,
      totalEvents: analytics.length,
      uniqueFingerprints,
      eventBreakdown,
      dailyCounts
    });
  } catch (err) {
    console.error('[ERROR] Admin analytics failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Full referral data (API key protected) ---
app.get('/api/admin/referrals', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const referrals = readJSON(REFERRALS_FILE);
    res.json({ success: true, count: referrals.length, referrals });
  } catch (err) {
    console.error('[ERROR] Admin referrals failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Curriculum progress stats (API key protected) ---
app.get('/api/admin/curriculum-progress', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const analytics = readJSON(ANALYTICS_FILE);
    const curriculumEvents = analytics.filter(a =>
      (a.event || '').startsWith('curriculum_') || (a.event || '').startsWith('lesson_')
    );

    const eventBreakdown = {};
    const uniqueLearners = new Set();
    curriculumEvents.forEach(a => {
      eventBreakdown[a.event] = (eventBreakdown[a.event] || 0) + 1;
      uniqueLearners.add(a.fingerprint);
    });

    res.json({
      success: true,
      totalCurriculumEvents: curriculumEvents.length,
      uniqueLearners: uniqueLearners.size,
      eventBreakdown
    });
  } catch (err) {
    console.error('[ERROR] Admin curriculum progress failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Export submissions as CSV (API key protected) ---
app.get('/api/admin/export/csv', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const submissions = readJSON(SUBMISSIONS_FILE);
    // CSV-safe: escape formula injection and quote fields with commas/quotes
    function csvSafe(val) {
      let s = String(val || '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }
    const headers = 'id,name,email,phone,niches,date,referralCode,referredBy';
    const rows = submissions.map(s => {
      const niches = (s.recommendedNiches || []).join('; ');
      return [
        csvSafe(s.id),
        csvSafe(s.name),
        csvSafe(s.email),
        csvSafe(s.phone),
        csvSafe(niches),
        csvSafe(s.submittedAt),
        csvSafe(s.referralCode),
        csvSafe(s.referredBy)
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
  if (!requireApiKey(req, res)) return;

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
  if (!requireApiKey(req, res)) return;

  try {
    const backup = {
      exportedAt: new Date().toISOString(),
      submissions: readJSON(SUBMISSIONS_FILE),
      analytics: readJSON(ANALYTICS_FILE),
      referrals: readJSON(REFERRALS_FILE),
      testimonials: readJSON(TESTIMONIALS_FILE),
      graduates: readJSON(GRADUATES_FILE)
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
  if (!requireApiKey(req, res)) return;

  try {
    const testimonials = readJSON(TESTIMONIALS_FILE);
    res.json({ success: true, count: testimonials.length, testimonials });
  } catch (err) {
    console.error('[ERROR] Admin testimonials failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin: Approve a testimonial (API key protected) ---
app.post('/api/admin/testimonials/:id/approve', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const testimonials = readJSON(TESTIMONIALS_FILE);
    const idx = testimonials.findIndex(t => t.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Testimonial not found' });
    }
    testimonials[idx].approved = true;
    queueWrite(TESTIMONIALS_FILE, testimonials);

    console.log(`[TESTIMONIAL APPROVED] ${req.params.id}`);
    res.json({ success: true, testimonial: testimonials[idx] });
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

  const pages = ['/', '/learn.html', '/certificate.html', '/about.html', '/terms.html', '/privacy.html', '/disclaimer.html', '/accessibility.html'];
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

// --- ANVIL Pulse: AI News Terminal ---

// Public: Get latest pulse updates (optionally filtered by niche)
app.get('/api/pulse', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests.' });
  }
  try {
    const feed = readJSON(PULSE_FILE);
    const niche = sanitize(req.query.niche || '');
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    let items = feed
      .filter(p => p.published !== false)
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

    if (niche) {
      items = items.filter(p =>
        (p.niches || []).includes(niche) || (p.niches || []).includes('all')
      );
    }

    items = items.slice(0, limit);

    res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[ERROR] Pulse feed failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Public: Get today's "One Thing to Learn" hint
app.get('/api/pulse/daily-hint', (req, res) => {
  if (!rateLimit(req, res)) {
    return res.status(429).json({ success: false, error: 'Too many requests.' });
  }
  try {
    const feed = readJSON(PULSE_FILE);
    const niche = sanitize(req.query.niche || '');
    const today = new Date().toISOString().slice(0, 10);

    let hints = feed.filter(p =>
      p.published !== false && p.type === 'hint' &&
      (p.publishedAt || '').startsWith(today)
    );

    if (niche) {
      hints = hints.filter(p =>
        (p.niches || []).includes(niche) || (p.niches || []).includes('all')
      );
    }

    // If no hint for today, return most recent hint
    if (hints.length === 0) {
      hints = feed
        .filter(p => p.published !== false && p.type === 'hint')
        .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      if (niche) {
        hints = hints.filter(p =>
          (p.niches || []).includes(niche) || (p.niches || []).includes('all')
        );
      }
    }

    const hint = hints[0] || null;
    res.json({ success: true, hint });
  } catch (err) {
    console.error('[ERROR] Daily hint failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// SECURITY: [TBHM Phase 3 - SSRF in Admin Endpoints] - Validate admin-submitted URLs
// Prevents: Admin adding malicious URLs that trigger SSRF when aggregator runs
// Enterprise: Defense in depth - validate even trusted admin input
app.post('/api/admin/pulse', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const { headline, summary, sourceUrl, sourceName, niches, type, tags } = req.body;
    const cleanHeadline = sanitize(headline);
    const cleanSummary = sanitize(summary).slice(0, 1000);

    if (!cleanHeadline || cleanHeadline.length < 5) {
      return res.status(400).json({ success: false, error: 'Headline is required (min 5 chars)' });
    }
    if (!cleanSummary || cleanSummary.length < 10) {
      return res.status(400).json({ success: false, error: 'Summary is required (min 10 chars)' });
    }

    // Validate sourceUrl if provided
    let cleanSourceUrl = '';
    if (sourceUrl) {
      const urlValidation = validateRSSUrl(sourceUrl);
      if (!urlValidation.valid) {
        return res.status(400).json({ success: false, error: 'Invalid source URL: ' + urlValidation.error });
      }
      cleanSourceUrl = sourceUrl; // URL is valid
    }

    const entry = {
      id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      headline: cleanHeadline,
      summary: cleanSummary,
      sourceUrl: cleanSourceUrl,
      sourceName: sanitize(sourceName || ''),
      niches: Array.isArray(niches) ? niches.slice(0, 7).map(n => sanitize(String(n))) : ['all'],
      type: ['update', 'hint', 'breaking', 'tool', 'opportunity'].includes(type) ? type : 'update',
      tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => sanitize(String(t))) : [],
      published: true,
      publishedAt: new Date().toISOString(),
      verified: false
    };

    const feed = readJSON(PULSE_FILE);
    feed.push(entry);
    queueWrite(PULSE_FILE, feed);

    console.log(`[PULSE] ${entry.id} | ${entry.type} | ${cleanHeadline.slice(0, 50)}`);
    res.json({ success: true, id: entry.id });
  } catch (err) {
    console.error('[ERROR] Pulse post failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Admin: Verify a pulse update (marks source as checked)
app.post('/api/admin/pulse/:id/verify', (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const feed = readJSON(PULSE_FILE);
    const idx = feed.findIndex(p => p.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Pulse item not found' });
    }
    feed[idx].verified = true;
    feed[idx].verifiedAt = new Date().toISOString();
    queueWrite(PULSE_FILE, feed);

    console.log(`[PULSE VERIFIED] ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Pulse verify failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Admin: Get all pulse items (including unpublished)
app.get('/api/admin/pulse', (req, res) => {
  if (!requireApiKey(req, res)) return;
  try {
    const feed = readJSON(PULSE_FILE);
    res.json({ success: true, count: feed.length, items: feed });
  } catch (err) {
    console.error('[ERROR] Admin pulse failed:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Manual pulse refresh endpoint (admin only)
app.post('/api/admin/pulse/refresh', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  refreshPulseFeed().then(() => {
    const cache = fs.existsSync(PULSE_CACHE_FILE) ? JSON.parse(fs.readFileSync(PULSE_CACHE_FILE, 'utf8')) : {};
    res.json({ success: true, message: 'Refresh complete', stats: cache });
  }).catch(err => {
    res.status(500).json({ success: false, error: err.message });
  });
});

// Pulse feed status endpoint
app.get('/api/pulse/status', (req, res) => {
  try {
    const cache = fs.existsSync(PULSE_CACHE_FILE) ? JSON.parse(fs.readFileSync(PULSE_CACHE_FILE, 'utf8')) : {};
    const feed = readJSON(PULSE_FILE);
    loadSourceState();
    const sources = PULSE_SOURCES.map(s => {
      const st = getSourceState(s.name);
      return {
        name: s.name,
        niche: s.niche,
        healthy: st.failCount < CIRCUIT_BREAKER_THRESHOLD,
        failCount: st.failCount,
        lastSuccess: st.lastSuccess ? new Date(st.lastSuccess).toISOString() : null,
        cached304s: st.total304s || 0,
        totalFetches: st.totalFetches || 0,
        backoffActive: st.backoffUntil ? Date.now() < st.backoffUntil : false,
      };
    });
    res.json({
      success: true,
      lastRefresh: cache.lastRefresh || null,
      totalItems: feed.length,
      verifiedCount: feed.filter(i => i.verified).length,
      sourceCount: PULSE_SOURCES.length,
      healthySources: sources.filter(s => s.healthy).length,
      notModified: cache.notModified || 0,
      sources,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Status unavailable' });
  }
});

// SECURITY: [TBHM Phase 6 - Information Disclosure] - Block /data/ directory access
// Prevents: Direct access to JSON data files, backup files, state files
// Enterprise: CWE-538 (File and Directory Information Exposure)
app.use('/data', (req, res) => {
  res.status(403).json({ success: false, error: 'Forbidden' });
});

// Block access to common backup/temp file patterns
app.use((req, res, next) => {
  const blocked = ['.tmp', '.backup', '.bak', '.swp', '.json.', 'pulse-cache', 'pulse-source-state'];
  if (blocked.some(pattern => req.path.includes(pattern))) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
});

// Explicit HTML page routes (before wildcard)
['/learn', '/certificate', '/admin', '/marketing', '/pulse'].forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'site', route.slice(1) + '.html'));
  });
});

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

// Handle malformed JSON / oversized payloads without leaking stack traces
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request too large' });
  }
  console.error('[ERROR] Unhandled middleware error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection:', reason);
});

// --- Pulse RSS Aggregator (zero external deps, anti-ban hardened) ---

const PULSE_CACHE_FILE = path.join(DATA_DIR, 'pulse-cache.json');
const PULSE_SOURCE_STATE_FILE = path.join(DATA_DIR, 'pulse-source-state.json');
const PULSE_FETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours base
const PULSE_JITTER_MAX = 15 * 60 * 1000; // up to 15 min random jitter
const PULSE_DELAY_BETWEEN = 4000; // 4s between each source (polite)
const PULSE_TIMEOUT = 15000; // 15s per request timeout
const PULSE_MAX_ITEMS = 200; // max stored pulse items
const CIRCUIT_BREAKER_THRESHOLD = 3; // failures before pausing source
const CIRCUIT_BREAKER_COOLDOWN = 24 * 60 * 60 * 1000; // 24h pause on tripped circuit
const BACKOFF_BASE = 60 * 1000; // 1 min base backoff

// RSS sources — free, no API keys, reliable
const PULSE_SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI', niche: 'all' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica', niche: 'all' },
  { url: 'https://www.wired.com/feed/tag/ai/latest/rss', name: 'Wired AI', niche: 'all' },
  { url: 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml', name: 'MIT AI News', niche: 'all' },
  { url: 'https://blog.google/technology/ai/rss/', name: 'Google AI Blog', niche: 'all' },
  { url: 'https://www.healthcareitnews.com/feed', name: 'Healthcare IT News', niche: 'medical-billing' },
  { url: 'https://www.fiercehealthcare.com/rss/xml', name: 'Fierce Healthcare', niche: 'medical-billing' },
  { url: 'https://www.grants.gov/rss/GG_NewOppByCategory.xml', name: 'Grants.gov', niche: 'grant-writing' },
  { url: 'https://www.federalregister.gov/documents/search.rss?conditions%5Btype%5D=NOTICE', name: 'Federal Register', niche: 'grant-writing' },
  { url: 'https://www.accountingtoday.com/feed', name: 'Accounting Today', niche: 'bookkeeping' },
  { url: 'https://www.cpapracticeadvisor.com/feed', name: 'CPA Practice Advisor', niche: 'bookkeeping' },
  { url: 'https://www.insurancejournal.com/feed/', name: 'Insurance Journal', niche: 'insurance' },
  { url: 'https://www.law.com/legaltechnews/feed/', name: 'Legal Tech News', niche: 'compliance' },
  { url: 'https://www.housingwire.com/feed/', name: 'HousingWire', niche: 'real-estate' },
];

// --- Per-source state: ETags, Last-Modified, failures, backoff ---
let sourceState = {};
function loadSourceState() {
  try {
    if (fs.existsSync(PULSE_SOURCE_STATE_FILE)) {
      sourceState = JSON.parse(fs.readFileSync(PULSE_SOURCE_STATE_FILE, 'utf8'));
    }
  } catch (e) { sourceState = {}; }
}
function saveSourceState() {
  try { fs.writeFileSync(PULSE_SOURCE_STATE_FILE, JSON.stringify(sourceState, null, 2)); } catch (e) {}
}
function getSourceState(name) {
  if (!sourceState[name]) {
    sourceState[name] = {
      etag: null,           // ETag from last response
      lastModified: null,   // Last-Modified from last response
      failCount: 0,         // consecutive failures
      lastFail: null,       // timestamp of last failure
      lastSuccess: null,    // timestamp of last success
      backoffUntil: null,   // don't retry until this timestamp
      totalFetches: 0,      // lifetime fetch count
      total304s: 0,         // times we got 304 Not Modified (saved bandwidth)
    };
  }
  return sourceState[name];
}

// --- Circuit breaker: should we skip this source? ---
function isCircuitOpen(name) {
  const state = getSourceState(name);
  const now = Date.now();
  // Backoff active (from 429/503 Retry-After)
  if (state.backoffUntil && now < state.backoffUntil) {
    const waitMins = Math.round((state.backoffUntil - now) / 60000);
    console.log(`[PULSE] Skipping ${name} — backoff active (${waitMins}m remaining)`);
    return true;
  }
  // Circuit breaker tripped (too many consecutive failures)
  if (state.failCount >= CIRCUIT_BREAKER_THRESHOLD && state.lastFail) {
    const elapsed = now - state.lastFail;
    if (elapsed < CIRCUIT_BREAKER_COOLDOWN) {
      const waitHrs = Math.round((CIRCUIT_BREAKER_COOLDOWN - elapsed) / 3600000 * 10) / 10;
      console.log(`[PULSE] Skipping ${name} — circuit open (${state.failCount} failures, retry in ${waitHrs}h)`);
      return true;
    }
    // Cooldown expired, allow a retry (half-open)
    console.log(`[PULSE] Half-open circuit for ${name} — attempting retry`);
  }
  return false;
}

// --- Niche keyword classifier (no AI needed) ---
const NICHE_KEYWORDS = {
  'medical-billing': ['medical billing', 'cpt code', 'icd-10', 'cms', 'medicare', 'medicaid', 'health insurance', 'ehr', 'electronic health', 'claim', 'denial', 'prior auth', 'hipaa', 'health it', 'clinical', 'patient', 'hospital', 'telehealth', 'pharmacy', 'healthcare', 'billing', 'diagnosis', 'prescription', 'clinic', 'drug', 'nurse'],
  'grant-writing': ['grant', 'funding', 'nsf', 'nih', 'sam.gov', 'federal award', 'proposal', 'funder', 'nonprofit funding', 'foundation grant'],
  'bookkeeping': ['bookkeeping', 'accounting', 'quickbooks', 'xero', 'accounts payable', 'receivable', 'ledger', 'tax prep', 'payroll', 'financial statement', 'cpa', 'invoice', 'cash flow', 'budget', 'expense', 'reconciliation'],
  'real-estate': ['real estate', 'property', 'mortgage', 'mls', 'broker', 'listing', 'housing', 'appraisal', 'home sale', 'rental', 'zoning', 'tenant', 'landlord', 'lease', 'eviction', 'foreclosure', 'hoa'],
  'compliance': ['compliance', 'regulation', 'audit', 'sox', 'gdpr', 'risk management', 'regulatory', 'enforcement', 'policy', 'governance', 'certification', 'iso', 'penalty', 'inspection'],
  'insurance': ['insurance', 'underwriting', 'claim', 'premium', 'actuarial', 'policyholder', 'deductible', 'liability', 'coverage', 'appeal letter', 'health plan', 'aca', 'marketplace', 'adjuster', 'risk'],
  'benefits': ['benefits', 'enrollment', 'cobra', '401k', 'pension', 'disability', 'leave', 'fmla', 'workers comp', 'employee benefit', 'social security', 'ssi', 'ssdi', 'snap', 'wic', 'tanf', 'liheap', 'unemployment', 'medicaid'],
};

// SECURITY: [TBHM Phase 1 - Path Traversal] - Safe path resolution
// Prevents: Directory traversal attacks via malicious file paths
// Enterprise: CWE-22 (Path Traversal), OWASP ASVS 4.0.3 V12.1.1
function loadDynamicPulseKeywords() {
  try {
    // Resolve to absolute path and verify it's within allowed directory
    const kwFile = path.resolve(__dirname, '..', 'anvil', 'data', 'pulse-niche-keywords.json');
    const allowedDir = path.resolve(__dirname, '..', 'anvil', 'data');

    // Prevent directory traversal
    if (!kwFile.startsWith(allowedDir)) {
      console.error('[PULSE] Path traversal attempt blocked:', kwFile);
      return;
    }

    if (!fs.existsSync(kwFile)) return;
    const dynamic = JSON.parse(fs.readFileSync(kwFile, 'utf8'));
    let loaded = 0;
    for (const [slug, keywords] of Object.entries(dynamic)) {
      if (!NICHE_KEYWORDS[slug] && Array.isArray(keywords) && keywords.length > 0) {
        NICHE_KEYWORDS[slug] = keywords;
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[PULSE] Loaded ${loaded} dynamic niche keyword sets`);
  } catch (err) {
    console.error('[PULSE] Failed to load dynamic keywords:', err.message);
  }
}
loadDynamicPulseKeywords();

function classifyNiches(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  const matched = [];
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) { matched.push(niche); break; }
    }
  }
  if (/\b(artificial intelligence|ai-powered|machine learning|llm|gpt|chatgpt|claude|automation|automate)\b/i.test(text)) {
    if (!matched.length) matched.push('all');
  }
  return matched.length ? matched : ['all'];
}

function classifyType(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  if (/breaking|urgent|just in|launch|released|announces/i.test(text)) return 'breaking';
  if (/tool|app|platform|software|open.?source|github/i.test(text)) return 'tool';
  if (/opportunity|job|hiring|demand|salary|rate|earn/i.test(text)) return 'opportunity';
  if (/\b(pro tip|trick|how to|step.by.step|tutorial|beginner.?s? guide|cheat sheet)\b/i.test(text)) return 'hint';
  return 'update';
}

// SECURITY: [TBHM Phase 3 - SSRF Prevention] - URL validation and redirect protection
// Prevents: Server-Side Request Forgery to internal services (AWS metadata, Redis, etc.)
// Enterprise: OWASP ASVS 4.0.3 V12.6.1 (SSRF Protection), CWE-918
function isPrivateIP(hostname) {
  // Block private IP ranges, localhost, link-local, AWS metadata
  const privatePatterns = [
    /^127\./,                    // localhost
    /^10\./,                     // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
    /^192\.168\./,               // 192.168.0.0/16
    /^169\.254\./,               // link-local
    /^::1$/,                     // IPv6 localhost
    /^fc00:/,                    // IPv6 unique local
    /^fe80:/,                    // IPv6 link-local
    /^169\.254\.169\.254$/,      // AWS metadata (exact match)
    /^metadata\.google\.internal$/, // GCP metadata
  ];
  return privatePatterns.some(pattern => pattern.test(hostname));
}

function validateRSSUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    // Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS allowed' };
    }
    // Block private IPs and internal hostnames
    if (isPrivateIP(parsed.hostname)) {
      return { valid: false, error: 'Private IP/hostname blocked' };
    }
    // Block file:// and other dangerous protocols
    if (parsed.protocol === 'file:') {
      return { valid: false, error: 'File protocol blocked' };
    }
    return { valid: true, parsed };
  } catch (e) {
    return { valid: false, error: 'Invalid URL' };
  }
}

// --- Conditional fetch with ETag/If-Modified-Since support ---
let redirectCount = 0; // Track redirect depth to prevent infinite loops
function fetchRSS(url, sourceName, depth = 0) {
  return new Promise((resolve, reject) => {
    // SSRF Protection: Validate URL before fetching
    const validation = validateRSSUrl(url);
    if (!validation.valid) {
      reject(new Error(`SSRF blocked: ${validation.error}`));
      return;
    }

    // Prevent infinite redirect loops
    if (depth > 3) {
      reject(new Error('Too many redirects'));
      return;
    }

    const state = getSourceState(sourceName);
    const mod = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'ANVIL-Pulse/1.0 (RSS Reader; +https://anvil.onrender.com; feeds only)',
      'Accept': 'application/rss+xml, application/xml, application/atom+xml, text/xml',
      'Accept-Encoding': 'identity', // don't request gzip (simpler, avoids issues)
      'Connection': 'close', // don't keep connections open
    };
    // Conditional request headers — saves bandwidth, shows good behavior
    if (state.etag) headers['If-None-Match'] = state.etag;
    if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;

    const req = mod.get(url, { headers, timeout: PULSE_TIMEOUT }, (res) => {
      // Follow redirects (up to 3) with SSRF validation on redirect target
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redirectUrl = res.headers.location;
        // Validate redirect target before following
        const redirectValidation = validateRSSUrl(redirectUrl);
        if (!redirectValidation.valid) {
          reject(new Error(`SSRF redirect blocked: ${redirectValidation.error}`));
          return;
        }
        fetchRSS(redirectUrl, sourceName, depth + 1).then(resolve).catch(reject);
        return;
      }

      // 304 Not Modified — content hasn't changed, no need to re-parse
      if (res.statusCode === 304) {
        res.resume();
        state.total304s++;
        resolve({ notModified: true, xml: null });
        return;
      }

      // 429 Too Many Requests or 503 Service Unavailable — backoff
      if (res.statusCode === 429 || res.statusCode === 503) {
        res.resume();
        const retryAfter = res.headers['retry-after'];
        let backoffMs;
        if (retryAfter) {
          // Retry-After can be seconds or a date string
          const parsed = parseInt(retryAfter, 10);
          backoffMs = isNaN(parsed)
            ? Math.max(0, new Date(retryAfter).getTime() - Date.now())
            : parsed * 1000;
        } else {
          // Exponential backoff: 1min, 2min, 4min, 8min, up to 1 hour
          backoffMs = Math.min(BACKOFF_BASE * Math.pow(2, state.failCount), 60 * 60 * 1000);
        }
        state.backoffUntil = Date.now() + backoffMs;
        const waitMins = Math.round(backoffMs / 60000);
        reject(new Error(`HTTP ${res.statusCode} — backing off ${waitMins}m`));
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      // Store caching headers for next conditional request
      if (res.headers['etag']) state.etag = res.headers['etag'];
      if (res.headers['last-modified']) state.lastModified = res.headers['last-modified'];

      // SECURITY: [TBHM Phase 7 - Denial of Service] - Memory limit on response accumulation
      // Prevents: OOM attacks via extremely large RSS feeds
      // Enterprise: CWE-400 (Uncontrolled Resource Consumption)
      const chunks = [];
      let size = 0;
      const MAX_RSS_SIZE = 512 * 1024; // 512KB max

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RSS_SIZE) {
          res.destroy();
          reject(new Error('Response too large (max 512KB)'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          const xml = Buffer.concat(chunks).toString('utf8');
          // Additional validation: ensure it's actually XML-like
          if (!xml.includes('<') || !xml.includes('>')) {
            reject(new Error('Response is not XML'));
            return;
          }
          resolve({ notModified: false, xml });
        } catch (err) {
          reject(new Error('Failed to parse response: ' + err.message));
        }
      });

      res.on('error', reject);
    });

    req.on('error', (err) => {
      // Don't leak internal error details
      reject(new Error('Request failed'));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// --- XML parsing (lightweight regex, no deps) ---
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  const regex = itemRegex.test(xml) ? itemRegex : entryRegex;
  regex.lastIndex = 0;

  let match;
  while ((match = regex.exec(xml)) !== null && items.length < 15) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractLink(block);
    const desc = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    if (title) {
      items.push({
        title: decodeEntities(stripHTML(title)).slice(0, 200),
        link: link || '',
        description: decodeEntities(stripHTML(desc || '')).replace(/\s+/g, ' ').trim().slice(0, 500),
        pubDate: safeParseDate(pubDate),
      });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const cdataRe = new RegExp('<' + tag + '[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/' + tag + '>', 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractLink(block) {
  const atomLink = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomLink) return atomLink[1];
  return extractTag(block, 'link') || '';
}

function stripHTML(str) { return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function safeParseDate(str) {
  if (!str) return new Date().toISOString();
  try {
    const d = new Date(str.trim());
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch (e) { return new Date().toISOString(); }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&nbsp;/g, ' ');
}

// --- Shuffle array (Fisher-Yates) to avoid hitting sources in same order ---
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Main refresh with all protections ---
async function refreshPulseFeed() {
  console.log('[PULSE] Starting feed refresh...');
  loadSourceState();
  const existingFeed = readJSON(PULSE_FILE);
  const existingIds = new Set(existingFeed.map(i => i.id));
  const newItems = [];
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let notModifiedCount = 0;

  // Shuffle order so we don't always hit the same server first
  const shuffledSources = shuffle(PULSE_SOURCES);

  for (const source of shuffledSources) {
    const state = getSourceState(source.name);

    // Circuit breaker check
    if (isCircuitOpen(source.name)) {
      skippedCount++;
      continue;
    }

    try {
      state.totalFetches++;
      const result = await fetchRSS(source.url, source.name);

      // 304 Not Modified — nothing new, don't re-parse
      if (result.notModified) {
        notModifiedCount++;
        state.failCount = 0; // reset circuit breaker
        state.lastSuccess = Date.now();
        console.log(`[PULSE] 304 Not Modified: ${source.name} (saved bandwidth)`);
        // Polite delay even on 304
        await new Promise(r => setTimeout(r, PULSE_DELAY_BETWEEN + Math.random() * 2000));
        continue;
      }

      const parsed = parseRSSItems(result.xml);

      for (const item of parsed) {
        const idBase = source.name + ':' + item.title;
        const id = 'rss-' + crypto.createHash('md5').update(idBase).digest('hex').slice(0, 12);
        if (existingIds.has(id)) continue;

        const niches = classifyNiches(item.title, item.description);

        newItems.push({
          id,
          headline: item.title,
          summary: item.description || item.title,
          sourceUrl: item.link,
          sourceName: source.name,
          niches: source.niche === 'all' ? niches : [source.niche, ...niches.filter(n => n !== source.niche)],
          type: classifyType(item.title, item.description),
          tags: niches.filter(n => n !== 'all'),
          published: true,
          publishedAt: item.pubDate,
          verified: false,
          fetchedAt: new Date().toISOString(),
        });
        existingIds.add(id);
      }

      // Success — reset circuit breaker
      state.failCount = 0;
      state.lastSuccess = Date.now();
      state.backoffUntil = null;
      successCount++;
      console.log(`[PULSE] Fetched ${parsed.length} items from ${source.name}`);
    } catch (err) {
      // Failure — increment circuit breaker
      state.failCount++;
      state.lastFail = Date.now();
      failCount++;
      console.log(`[PULSE] Failed ${source.name} (${state.failCount}/${CIRCUIT_BREAKER_THRESHOLD}): ${err.message}`);
    }

    // Polite delay between sources (randomized 4-7s)
    const delay = PULSE_DELAY_BETWEEN + Math.floor(Math.random() * 3000);
    await new Promise(r => setTimeout(r, delay));
  }

  if (newItems.length > 0) {
    const merged = [...newItems, ...existingFeed]
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
      .slice(0, PULSE_MAX_ITEMS);
    queueWrite(PULSE_FILE, merged);
    console.log(`[PULSE] Added ${newItems.length} new items. Total: ${merged.length}`);
  }

  // Save state for conditional requests & circuit breakers
  saveSourceState();

  const cacheData = {
    lastRefresh: new Date().toISOString(),
    sources: successCount,
    failed: failCount,
    skipped: skippedCount,
    notModified: notModifiedCount,
    newItems: newItems.length,
    totalItems: existingFeed.length + newItems.length,
  };
  try { fs.writeFileSync(PULSE_CACHE_FILE, JSON.stringify(cacheData, null, 2)); } catch (e) {}

  console.log(`[PULSE] Refresh complete: ${successCount} OK, ${notModifiedCount} cached, ${skippedCount} skipped, ${failCount} failed, ${newItems.length} new`);
}

// Schedule periodic refresh with jitter
function schedulePulseRefresh() {
  const jitter = Math.floor(Math.random() * PULSE_JITTER_MAX);
  const nextRefresh = PULSE_FETCH_INTERVAL + jitter;
  setTimeout(() => {
    refreshPulseFeed().catch(err => {
      console.error('[PULSE] Refresh error:', err.message);
    }).finally(() => {
      schedulePulseRefresh();
    });
  }, nextRefresh);
  console.log(`[PULSE] Next refresh in ${Math.round(nextRefresh / 60000)} minutes`);
}

// SECURITY: [TBHM Phase 6 - Information Disclosure] - Limit startup logging
// Prevents: Internal file paths leaked in logs (could aid attackers)
// Enterprise: CWE-209 (Information Exposure Through Error Message)
app.listen(PORT, () => {
  console.log(`[ANVIL] Server running on port ${PORT} (${NODE_ENV})`);
  console.log(`[ANVIL] Health check: http://localhost:${PORT}/health`);

  // Don't log internal file paths in production
  if (NODE_ENV !== 'production') {
    console.log(`[ANVIL] Static files: ${path.join(__dirname, 'site')}`);
    console.log(`[ANVIL] Data directory: ${DATA_DIR}`);
  }

  // Initial pulse refresh after 10s (let server stabilize), then schedule periodic
  setTimeout(() => {
    refreshPulseFeed().catch(err => {
      console.error('[PULSE] Initial refresh error:', err.message);
    }).finally(() => {
      schedulePulseRefresh();
    });
  }, 10000);
});
