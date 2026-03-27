const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Admin emails
const ADMIN_EMAILS = ['sophie@fermatcommerce.com', 'rangaraj@fermatcommerce.com', 'emily@fermatcommerce.com'];

// Domain whitelist
const ALLOWED_DOMAIN = 'fermatcommerce.com';

// Session configuration
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  store: process.env.RAILWAY_VOLUME_MOUNT_PATH ? new FileStore({ path: path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions'), ttl: 604800, retries: 1 }) : undefined,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  }
}));

// JSON middleware
app.use(express.json());

// Passport configuration
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails[0].value;
  const domain = email.split('@')[1];

  // Check if email domain is allowed
  if (domain !== ALLOWED_DOMAIN) {
    return done(null, false, { message: 'Email domain not allowed' });
  }

  // Check if user is admin
  const isAdmin = ADMIN_EMAILS.includes(email);

  const user = {
    id: profile.id,
    email: email,
    name: profile.displayName,
    picture: profile.photos[0]?.value,
    isAdmin: isAdmin
  };

  done(null, user);
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

app.use(passport.initialize());
app.use(passport.session());
// Authentication routes
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).send('Logout failed');
    }
    res.redirect('/');
  });
});

// Middleware to check if user is authenticated
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// Middleware to check if user is admin
function ensureAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.isAdmin) {
    return next();
  }
  res.status(403).json({ error: 'Admin access required' });
}

// API Routes
app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    res.json({ loggedIn: true, email: req.user.email, name: req.user.name || (req.user.email.split('@')[0].charAt(0).toUpperCase() + req.user.email.split('@')[0].slice(1)), isAdmin: ADMIN_EMAILS.includes(req.user.email) });
  } else {
    res.json({ loggedIn: false });
  }
});

// Ramp budget data - loaded from file after DATA_DIR is defined below
let rampBudget = { limit: 1600, spent: 1591.08, remaining: 8.92, updatedAt: '2026-03-25' };

// GET current budget
app.get('/api/ramp-budget', (req, res) => {
  res.json(rampBudget);
});

// POST to update budget (requires secret key)
app.post('/api/ramp-budget', express.json(), (req, res) => {
  const key = req.headers['x-api-key'] || req.body.key;
  if (key !== (process.env.RAMP_UPDATE_KEY || 'fppc-update-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { limit, spent, remaining } = req.body;
  if (spent !== undefined) rampBudget.spent = Number(spent);
  if (limit !== undefined) rampBudget.limit = Number(limit);
  if (remaining !== undefined) rampBudget.remaining = Number(remaining);
  rampBudget.updatedAt = new Date().toISOString().split('T')[0];
  saveRampBudget(rampBudget);
  res.json(rampBudget);
});

app.get('/api/user', ensureAuth, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.user.name,
    picture: req.user.picture,
    isAdmin: req.user.isAdmin
  });
});
app.get('/api/events', ensureAuth, (req, res) => {
  try {
    const eventsPath = path.join(__dirname, 'events.json');

    if (!fs.existsSync(eventsPath)) {
      return res.json({ current: [], archive: [] });
    }

    const eventsData = fs.readFileSync(eventsPath, 'utf8');
    const events = JSON.parse(eventsData);

    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];

    // Split events into current and archive based on dateSort field
    const current = [];
    const archive = [];

    events.forEach(event => {
      if (event.dateSort && event.dateSort >= todayString) {
        current.push(event);
      } else {
        archive.push(event);
      }
    });

    res.json({ current, archive });
  } catch (error) {
    console.error('Error reading events.json:', error);
    res.status(500).json({ error: 'Failed to read events' });
  }
});

app.post('/api/events/refresh', ensureAdmin, (req, res) => {
  // Placeholder for future event refresh functionality
  res.json({ message: 'Event refresh triggered' });
});


// ── Shared data store (replaces all localStorage) ──
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data') : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Ramp budget file persistence
const RAMP_FILE = path.join(DATA_DIR, 'ramp-budget.json');
function loadRampBudget() {
  try {
    if (fs.existsSync(RAMP_FILE)) return JSON.parse(fs.readFileSync(RAMP_FILE, 'utf8'));
  } catch (e) { console.error('Error loading ramp budget:', e); }
  return null;
}
function saveRampBudget(data) {
  try { fs.writeFileSync(RAMP_FILE, JSON.stringify(data)); } catch (e) { console.error('Error saving ramp budget:', e); }
}
// Load persisted budget if available
const savedBudget = loadRampBudget();
if (savedBudget) rampBudget = savedBudget;

const ALLOWED_KEYS = ['suggestions', 'votes', 'pastEvents', 'sfEvents', 'volunteerEvents', 'teamEvents', 'snacks', 'quotes'];

app.get('/api/store/:key', ensureAuth, (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    const fp = path.join(DATA_DIR, key + '.json');
    if (!fs.existsSync(fp)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/store/:key', ensureAuth, (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    const fp = path.join(DATA_DIR, key + '.json');
    fs.writeFileSync(fp, JSON.stringify(req.body.data, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/store', ensureAuth, (req, res) => {
  try {
    const result = {};
    ALLOWED_KEYS.forEach(key => {
      const fp = path.join(DATA_DIR, key + '.json');
      result[key] = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Public endpoint for ticker quotes (no auth needed)
app.get('/api/quotes', (req, res) => {
  try {
    const fp = path.join(DATA_DIR, 'quotes.json');
    if (!fs.existsSync(fp)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public FPPC votes endpoint (no auth, read-only) ──
app.get('/api/fppc-votes', (req, res) => {
  try {
    // Load all event arrays from data files (or fall back to empty)
    const loadJSON = (name) => {
      const fp = path.join(DATA_DIR, name + '.json');
      try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null; } catch(e) { return null; }
    };

    // Load curated event arrays — try server-persisted data first, but we need the
    // hardcoded arrays from index.html as fallback.  Since we can't require() an HTML
    // file, we read from the data store (the dashboard saves them via /api/store/:key).
    const sfEvents = loadJSON('sfEvents') || [];
    const volunteerEvents = loadJSON('volunteerEvents') || [];
    const teamEvents = loadJSON('teamEvents') || [];
    const suggestions = loadJSON('suggestions') || [];
    const votes = loadJSON('votes') || {};

    const events = [];

    // Helper to add events from an array
    const addEvents = (arr, sourceType) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(e => {
        if (!e || !e.id) return;
        const voteEntry = votes[e.id];
        const voters = (voteEntry && Array.isArray(voteEntry.voters)) ? voteEntry.voters : [];
        events.push({
          id: e.id,
          title: e.title,
          date: e.date || '',
          location: e.location || '',
          type: e.type || sourceType || 'social',
          votes: voters.length,
          voters: voters
        });
      });
    };

    addEvents(sfEvents, 'social');
    addEvents(volunteerEvents, 'volunteer');
    addEvents(teamEvents, 'team');

    // Approved suggestions
    if (Array.isArray(suggestions)) {
      suggestions.filter(s => s && s.approved).forEach(s => {
        if (!s.id) return;
        const voteEntry = votes[s.id];
        const voters = (voteEntry && Array.isArray(voteEntry.voters)) ? voteEntry.voters : [];
        events.push({
          id: s.id,
          title: s.title,
          date: s.date || '',
          location: s.location || '',
          type: s.type || s.category || 'social',
          votes: voters.length,
          voters: voters
        });
      });
    }

    // Sort by votes descending
    events.sort((a, b) => b.votes - a.votes);

    res.json({
      events,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('Error in /api/fppc-votes:', e);
    res.status(500).json({ error: 'Failed to load FPPC votes' });
  }
});

// ── Auth gate: require login for all pages ──
app.use((req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.send(`<!DOCTYPE html><html><head><title>FPPC Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#F5F1EA;color:#294339;display:flex;justify-content:center;align-items:center;min-height:100vh}.login{text-align:center;padding:48px;background:#FFFFFF;border-radius:16px;box-shadow:0 4px 24px rgba(41,67,57,.12);max-width:400px;border:1px solid #D1CFC1}h1{font-size:28px;margin-bottom:8px;color:#294339}p{color:#7A8076;margin-bottom:32px;font-size:14px}a{display:inline-block;padding:14px 32px;background:#294339;color:#fff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:500;transition:background .2s}a:hover{background:#566146}</style></head><body><div class="login"><h1>FPPC Dashboard</h1><p>Sign in with your Fermat Commerce account</p><a href="/auth/google">Sign in with Google</a></div></body></html>`);
});

// Static file serving
app.use(express.static(__dirname));

// Catch-all route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Startup check — fail loudly if index.html is missing
const indexPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('FATAL: index.html not found at', indexPath);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Retrigger deploy
