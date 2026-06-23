const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Datastore = require('nedb-promises');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sare-analytics-secret-key-2024-waas';
const PORT = process.env.PORT || 3000;

// ── Database setup ────────────────────────────────────────────────────────────
const db = Datastore.create({ filename: path.join(__dirname, 'data', 'users.db'), autoload: true });

// Ensure data directory exists
const fs = require('fs');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Seed admin account if DB is empty
async function seedUsers() {
  const count = await db.count({});
  if (count === 0) {
    await db.insert({
      name: 'SARE Admin',
      email: 'admin@sare.africa',
      password: bcrypt.hashSync('@Sare 2026!', 10),
      role: 'admin',
      org: 'SARE Analytics',
      active: true,
      createdAt: new Date()
    });
    console.log('Admin account created');
  }
}
seedUsers();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.active)
      return res.status(403).json({ error: 'Account disabled. Contact your admin.' });
    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name, role: user.role, org: user.org },
      JWT_SECRET, { expiresIn: '8h' }
    );
    await db.update({ _id: user._id }, { $set: { lastLogin: new Date() } });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, org: user.org } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, org, inviteCode } = req.body;
    if (inviteCode !== (process.env.INVITE_CODE || 'SARE2024'))
      return res.status(403).json({ error: 'Invalid invite code. Contact your SARE admin.' });
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await db.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const user = await db.insert({
      name, email: email.toLowerCase(), password: bcrypt.hashSync(password, 10),
      role: 'analyst', org: org || 'My Organisation', active: true, createdAt: new Date()
    });
    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name, role: user.role, org: user.org },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, org: user.org } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

// ── Password change ───────────────────────────────────────────────────────────
app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await db.findOne({ _id: req.user.id });
    if (!user || !bcrypt.compareSync(currentPassword, user.password))
      return res.status(401).json({ error: 'Current password is incorrect' });
    await db.update({ _id: req.user.id }, { $set: { password: bcrypt.hashSync(newPassword, 10) } });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: user management ────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await db.find({}, { password: 0 });
    res.json(users.map(u => ({ ...u, id: u._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, org } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
    const existing = await db.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
    if (existing) return res.status(409).json({ error: 'Email already exists' });
    const user = await db.insert({
      name, email: email.toLowerCase(), password: bcrypt.hashSync(password, 10),
      role: role || 'analyst', org: org || 'My Organisation', active: true, createdAt: new Date()
    });
    res.json({ ...user, id: user._id, password: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, role, org, active, password } = req.body;
    const update = { name, email: email?.toLowerCase(), role, org, active };
    if (password && password.length >= 8) update.password = bcrypt.hashSync(password, 10);
    await db.update({ _id: req.params.id }, { $set: update });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
    await db.remove({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File parse ────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', service: 'SARE Analytics Intelligence' }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`SARE Analytics v2 running on http://localhost:${PORT}`));
