const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Admin emails
const ADMIN_EMAILS = ['sophie@fermatcommerce.com', 'rangaraj@fermatcommerce.com'];

// Domain whitelist
const ALLOWED_DOMAIN = 'fermatcommerce.com';

// Session configuration
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
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
    res.json({ loggedIn: true, email: req.user.email, name: req.user.displayName, isAdmin: ADMIN_EMAILS.includes(req.user.email) });
  } else {
    res.json({ loggedIn: false });
  }
});

// Ramp budget data - updated via POST /api/ramp-budget
let rampBudget = {
  limit: 1600,
  spent: 1558.59,
  remaining: 41.41,
  updatedAt: '2026-03-25'
};

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
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ALLOWED_KEYS = ['suggestions', 'votes', 'pastEvents', 'sfEvents', 'volunteerEvents', 'teamEvents', 'snacks'];

app.get('/api/store/:key', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    const fp = path.join(DATA_DIR, key + '.json');
    if (!fs.existsSync(fp)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/store/:key', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    const fp = path.join(DATA_DIR, key + '.json');
    fs.writeFileSync(fp, JSON.stringify(req.body.data, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/store', (req, res) => {
  try {
    const result = {};
    ALLOWED_KEYS.forEach(key => {
      const fp = path.join(DATA_DIR, key + '.json');
      result[key] = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
