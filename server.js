import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDb } from './src/db.js';
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import userRoutes from './src/routes/user.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Load .env manually (no dotenv dependency)
import { readFileSync } from 'fs';
try {
  const env = readFileSync(join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length && !process.env[key.trim()]) process.env[key.trim()] = val.join('=').trim();
  });
} catch (e) {}

initDb();

if (isProd) app.set('trust proxy', 1);

const SQLiteStore = connectSqlite3(session);

app.use(express.json({ limit: '100mb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: isProd,
    sameSite: 'lax',
  }
}));

app.use(express.static(join(__dirname, 'public')));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);

// SPA fallback — serve login for unauthenticated, redirect based on role
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  if (req.session.isAdmin) return res.redirect('/admin.html');
  res.redirect('/viewer.html');
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
