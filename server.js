const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sare-analytics-secret-key-2024-waas';
const PORT = process.env.PORT || 3000;

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests' } });
app.use('/api/', limiter);

// ── In-memory user store (replace with DB in production) ────────────────────
const users = [
  { id: 1, name: 'Admin User', email: 'admin@sare.co.ke', password: bcrypt.hashSync('Sare@2024!', 10), role: 'admin', org: 'SARE Analytics' },
  { id: 2, name: 'CFO Demo', email: 'cfo@demo.com', password: bcrypt.hashSync('Demo@1234', 10), role: 'cfo', org: 'Demo Organisation' },
  { id: 3, name: 'CEO Demo', email: 'ceo@demo.com', password: bcrypt.hashSync('Demo@1234', 10), role: 'ceo', org: 'Demo Organisation' },
];
let nextUserId = 4;
const sessions = {};

// ── File upload ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, org: user.org }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, org: user.org } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, org, inviteCode } = req.body;
  if (inviteCode !== 'SARE2024') return res.status(403).json({ error: 'Invalid invite code' });
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });
  const hashed = bcrypt.hashSync(password, 10);
  const user = { id: nextUserId++, name, email, password: hashed, role: 'analyst', org: org || 'My Organisation' };
  users.push(user);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, org: user.org }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, org: user.org } });
});

app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

// ── File parse route ─────────────────────────────────────────────────────────
app.post('/api/parse', auth, upload.array('files', 10), (req, res) => {
  try {
    const results = [];
    for (const file of (req.files || [])) {
      let text = `FILE: ${file.originalname}\n`;
      if (file.originalname.endsWith('.csv')) {
        text += file.buffer.toString('utf8').slice(0, 8000);
      } else {
        const wb = XLSX.read(file.buffer, { type: 'buffer' });
        wb.SheetNames.forEach(sn => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
          text += `SHEET: ${sn}\n`;
          rows.slice(0, 120).forEach(r => { text += r.join('\t') + '\n'; });
        });
      }
      results.push({ name: file.originalname, size: file.size, text: text.slice(0, 6000) });
    }
    res.json({ files: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', service: 'SARE Analytics Intelligence' }));

// ── Serve frontend for all other routes ─────────────────────────────────────
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`SARE Analytics running on http://localhost:${PORT}`));
module.exports = app;
