const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Allowed domain - only @fermatcommerce.com Google Workspace accounts
// ---------------------------------------------------------------------------
const ALLOWED_DOMAIN = 'fermatcommerce.com';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
app.set('trust proxy', 1); // trust Railway's reverse proxy
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax',
    },
  })
);

// ---------------------------------------------------------------------------
// Passport - Google OAuth 2.0
// ---------------------------------------------------------------------------
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const callbackPath = '/auth/google/callback';

function getCallbackURL(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}${callbackPath}`;
  }
  return `${req.protocol}://${req.get('host')}${callbackPath}`;
}

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: callbackPath, // relative - resolved per-request below
      passReqToCallback: true,
    },
    (req, accessToken, refreshToken, profile, done) => {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || '';
      const domain = email.split('@')[1];

      if (domain !== ALLOWED_DOMAIN) {
        return done(null, false, {
          message: `Only @${ALLOWED_DOMAIN} accounts are allowed.`,
        });
      }

      return done(null, {
        id: profile.id,
        name: profile.displayName,
        email,
        avatar: profile.photos && profile.photos[0] && profile.photos[0].value,
      });
    }
  )
);

app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get('/auth/google', (req, res, next) => {
  const callbackURL = getCallbackURL(req);
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    hd: ALLOWED_DOMAIN, // hint to Google to only show fermatcommerce.com accounts
    callbackURL,
  })(req, res, next);
});

app.get(
  callbackPath,
  (req, res, next) => {
    const callbackURL = getCallbackURL(req);
    passport.authenticate('google', {
      failureRedirect: '/auth/denied',
      callbackURL,
    })(req, res, next);
  },
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/denied', (req, res) => {
  res.status(403).send(`
    <html>
      <head><title>Access Denied</title>
        <style>
          body { font-family: 'Hanken Grotesk', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #F5F1E8; color: #294339; }
          .card { text-align: center; max-width: 420px; padding: 48px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
          h1 { font-size: 24px; margin: 0 0 12px; }
          p { color: #666; line-height: 1.6; }
          a { color: #294339; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Access Denied</h1>
          <p>The FPPC Dashboard is only available to <strong>@fermatcommerce.com</strong> accounts.</p>
          <p style="margin-top:20px;"><a href="/auth/google">Try again with a different account &rarr;</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// Auth middleware - everything below this requires login
// ---------------------------------------------------------------------------
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.send(`
    <html>
      <head><title>FPPC Dashboard - Sign In</title>
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Hanken Grotesk', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #F5F1E8; color: #294339; margin: 0; }
          .card { text-align: center; max-width: 420px; padding: 48px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
          h1 { font-family: 'DM Serif Display', serif; font-size: 28px; margin: 0 0 4px; }
          .subtitle { color: #888; font-size: 14px; margin: 0 0 32px; }
          .btn { display: inline-flex; align-items: center; gap: 10px; padding: 14px 28px; background: #294339; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; transition: background 0.15s; }
          .btn:hover { background: #355549; }
          .note { color: #999; font-size: 12px; margin-top: 24px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size:48px;margin-bottom:16px;">&#127881;</div>
          <h1>FPPC Dashboard</h1>
          <p class="subtitle">Fermat Party Planning Committee</p>
          <a class="btn" href="/auth/google">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/><path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.166 6.656 3.58 9 3.58Z" fill="#EA4335"/></svg>
            Sign in with Google
          </a>
          <p class="note">Restricted to @fermatcommerce.com accounts</p>
        </div>
      </body>
    </html>
  `);
}

app.use(ensureAuth);

// ---------------------------------------------------------------------------
// Serve the dashboard (behind auth)
// ---------------------------------------------------------------------------
app.use(express.static(__dirname));

// Catch-all - serve index.html for any route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`FPPC Dashboard running on port ${PORT}`);
});
