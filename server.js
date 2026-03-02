const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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


// API key auth helper
function requireApiKey(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== API_KEY) {
    res.status(403).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Allowed origins for CORS
const ALLOWED_ORIGINS = NODE_ENV === 'production'
  ? [process.env.ALLOWED_ORIGIN || 'https://anvil.onrender.com']
  : ['http://localhost:10000', 'http://127.0.0.1:10000'];

// Rate limiting (in-memory, no extra dependency)
const rateLimits = new Map();
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 10; // max submissions per window per IP

function rateLimit(req) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_MAX) return false;
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

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
  if (!rateLimit(req)) {
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
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: cleanName,
      email: cleanEmail,
      phone: sanitize(phone || ''),
      answers: Array.isArray(answers) ? answers.slice(0, 20).map(a => sanitize(String(a))) : [],
      recommendedNiches: Array.isArray(recommendedNiches) ? recommendedNiches.slice(0, 7).map(n => sanitize(String(n))) : [],
      referralCode: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      referredBy: sanitize(req.body.referredBy || ''),
      utmSource: sanitize(req.body.utmSource || ''),
      utmMedium: sanitize(req.body.utmMedium || ''),
      utmCampaign: sanitize(req.body.utmCampaign || ''),
      submittedAt: new Date().toISOString(),
      ip: req.ip || 'unknown'
    };

    // Append-safe write: read, append, write with error handling
    let submissions = [];
    try {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
      submissions = JSON.parse(raw);
      if (!Array.isArray(submissions)) submissions = [];
    } catch (e) {
      submissions = [];
    }

    submissions.push(submission);
    const tmpFile = SUBMISSIONS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(submissions, null, 2), 'utf8');
    fs.renameSync(tmpFile, SUBMISSIONS_FILE);

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
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { event, page, data } = req.body;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const hash = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    const entry = {
      event: sanitize(event || ''),
      page: sanitize(page || ''),
      data: typeof data === 'object' && data !== null ? JSON.parse(JSON.stringify(data)) : {},
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
    const submissions = readJSON(SUBMISSIONS_FILE);
    const exists = submissions.some(s => s.referralCode === cleanCode);
    if (!exists) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const fingerprint = crypto.createHash('sha256').update(API_KEY + ip).digest('hex').slice(0, 12);

    const referrals = readJSON(REFERRALS_FILE);
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
    if (!cleanText || cleanText.length < 10 || cleanText.length > 500) {
      return res.status(400).json({ success: false, error: 'Text must be between 10 and 500 characters' });
    }
    if (isNaN(cleanRating) || cleanRating < 1 || cleanRating > 5) {
      return res.status(400).json({ success: false, error: 'Rating must be between 1 and 5' });
    }

    const testimonial = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
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
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { name, niche, city, state } = req.body;
    const cleanName = sanitize(name);
    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const graduate = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
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

// --- Quiz progress persistence (server-side session) ---
app.post('/api/quiz-progress', (req, res) => {
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { sessionId, currentQuestion, answers } = req.body;
    const cleanId = sanitize(sessionId || '');

    if (!cleanId || cleanId.length < 1) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
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
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const cleanId = sanitize(req.params.sessionId || '');
    if (!cleanId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
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
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const { sessionId, currentDay, completedDays, quizScores } = req.body;
    const cleanId = sanitize(sessionId || '');

    if (!cleanId || cleanId.length < 1) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
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
  if (!rateLimit(req)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again in 15 minutes.' });
  }

  try {
    const cleanId = sanitize(req.params.sessionId || '');
    if (!cleanId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
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
    const headers = 'id,name,email,phone,niches,date,referralCode,referredBy';
    const rows = submissions.map(s => {
      const niches = (s.recommendedNiches || []).join('; ');
      return [
        s.id || '',
        (s.name || '').replace(/,/g, ' '),
        (s.email || '').replace(/,/g, ' '),
        (s.phone || '').replace(/,/g, ' '),
        niches.replace(/,/g, '; '),
        s.submittedAt || '',
        s.referralCode || '',
        (s.referredBy || '').replace(/,/g, ' ')
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

// Explicit HTML page routes (before wildcard)
['/learn', '/certificate', '/admin', '/marketing'].forEach(route => {
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

app.listen(PORT, () => {
  console.log(`[ANVIL] Server running on port ${PORT} (${NODE_ENV})`);
  console.log(`[ANVIL] Static files: ${path.join(__dirname, 'site')}`);
  console.log(`[ANVIL] Submissions: ${SUBMISSIONS_FILE}`);
  console.log(`[ANVIL] Health check: http://localhost:${PORT}/health`);
});
