const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { jsonrepair } = require('jsonrepair');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Datastore = require('nedb-promises');
const { Resend } = require('resend');
const fs = require('fs');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sare-analytics-secret-key-2024-waas';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@sare.africa';
const APP_URL = process.env.APP_URL || 'https://sare-finance-analytics.onrender.com';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ── Databases ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db          = Datastore.create({ filename: path.join(__dirname, 'data', 'users.db'),        autoload: true });
const deptDb      = Datastore.create({ filename: path.join(__dirname, 'data', 'depts.db'),        autoload: true });
const rolesDb     = Datastore.create({ filename: path.join(__dirname, 'data', 'roles.db'),        autoload: true });
const historyDb   = Datastore.create({ filename: path.join(__dirname, 'data', 'history.db'),      autoload: true });
const notesDb     = Datastore.create({ filename: path.join(__dirname, 'data', 'notes.db'),        autoload: true });
const schedulesDb = Datastore.create({ filename: path.join(__dirname, 'data', 'schedules.db'),    autoload: true });
const submissionsDb = Datastore.create({ filename: path.join(__dirname, 'data', 'submissions.db'),autoload: true });
const connectedReportsDb = Datastore.create({ filename: path.join(__dirname, 'data', 'connected-reports.db'), autoload: true });

// ── Helper: robust JSON parse with auto-repair ────────────────────────────────
function parseAIJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('No JSON object found in AI response');
  }
  const jsonStr = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    const repaired = jsonrepair(jsonStr);
    return JSON.parse(repaired);
  }
}

// ── Deterministic response cache ──────────────────────────────────────────────
// Same input data + same prompt = same cached output. Prevents inconsistent
// numbers when the same report is analysed twice by different people.
const crypto = require('crypto');
const aiCacheDb = Datastore.create({ filename: path.join(__dirname, 'data', 'ai_cache.db'), autoload: true });

function hashPrompt(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function getCachedOrCall(cacheKey, callFn) {
  // Check cache first (valid for 24 hours - data doesn't change, but allows refresh if needed)
  const cached = await aiCacheDb.findOne({ key: cacheKey });
  if (cached && (Date.now() - new Date(cached.createdAt).getTime()) < 24*60*60*1000) {
    console.log('[CACHE HIT]', cacheKey.slice(0,12));
    return { ...cached.result, fromCache: true };
  }
  const result = await callFn();
  await aiCacheDb.update({ key: cacheKey }, { $set: { key: cacheKey, result, createdAt: new Date() } }, { upsert: true });
  return result;
}

// ── Email templates ───────────────────────────────────────────────────────────
function emailBase(bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:Inter,Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
    .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
    .header{background:#0B1929;padding:28px 32px;display:flex;align-items:center;gap:12px}
    .logo{width:40px;height:40px;background:#1B6FE4;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:700;text-align:center;line-height:40px}
    .brand{color:#fff;font-size:16px;font-weight:700}
    .brand-sub{color:rgba(255,255,255,0.5);font-size:11px;margin-top:2px}
    .body{padding:32px}
    .greeting{font-size:22px;font-weight:700;color:#0B1929;margin-bottom:8px}
    .text{font-size:14px;color:#6B7280;line-height:1.7;margin-bottom:20px}
    .cred-box{background:#F0F7FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px 20px;margin:20px 0}
    .cred-row{display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #DBEAFE}
    .cred-row:last-child{border:none}
    .cred-label{color:#6B7280;font-weight:600}
    .cred-value{color:#0B1929;font-weight:700;font-family:monospace}
    .btn{display:block;width:fit-content;margin:24px auto;padding:13px 32px;background:#1B6FE4;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;text-align:center}
    .notice{background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:12px 16px;font-size:12px;color:#92400E;margin-top:16px}
    .footer{background:#F9FAFB;padding:20px 32px;font-size:11px;color:#9CA3AF;text-align:center;border-top:1px solid #E5E7EB}
  </style></head><body>
  <div class="wrap">
    <div class="header">
      <div class="logo">S</div>
      <div><div class="brand">SARE Analytics</div><div class="brand-sub">Make Cents Make Sense</div></div>
    </div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">SARE Analytics Intelligence Platform &nbsp;·&nbsp; Make Cents Make Sense<br>This is an automated message — please do not reply to this email.</div>
  </div></body></html>`;
}

function welcomeEmail(name, email, password, role, department) {
  return emailBase(`
    <div class="greeting">Welcome to SARE Analytics, ${name}! 👋</div>
    <p class="text">You have been added to the SARE Analytics Intelligence Platform. Use the credentials below to sign in and start generating executive-grade insights from your business reports.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Login URL</span><span class="cred-value">${APP_URL}</span></div>
      <div class="cred-row"><span class="cred-label">Email</span><span class="cred-value">${email}</span></div>
      <div class="cred-row"><span class="cred-label">Password</span><span class="cred-value">${password}</span></div>
      <div class="cred-row"><span class="cred-label">Role</span><span class="cred-value">${role}</span></div>
      <div class="cred-row"><span class="cred-label">Department</span><span class="cred-value">${department}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>
    <div class="notice">🔒 For security, please change your password immediately after your first login.</div>`);
}

function passwordResetEmail(name, email, newPassword) {
  return emailBase(`
    <div class="greeting">Password reset — ${name}</div>
    <p class="text">Your SARE Analytics password has been reset by your administrator.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Login URL</span><span class="cred-value">${APP_URL}</span></div>
      <div class="cred-row"><span class="cred-label">Email</span><span class="cred-value">${email}</span></div>
      <div class="cred-row"><span class="cred-label">New password</span><span class="cred-value">${newPassword}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>`);
}

function forgotPasswordEmail(name, email, newPassword) {
  return emailBase(`
    <div class="greeting">Password reset requested — ${name}</div>
    <p class="text">We received a request to reset the password for your SARE Analytics account. A new temporary password has been generated below.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Login URL</span><span class="cred-value">${APP_URL}</span></div>
      <div class="cred-row"><span class="cred-label">Email</span><span class="cred-value">${email}</span></div>
      <div class="cred-row"><span class="cred-label">New password</span><span class="cred-value">${newPassword}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>
    <div class="notice">🔒 For security, please change this password immediately after signing in. If you did not request this reset, contact your administrator right away.</div>`);
}

function accountStatusEmail(name, active) {
  return emailBase(`
    <div class="greeting">Account ${active ? 'activated' : 'disabled'} — ${name}</div>
    <p class="text">Your SARE Analytics account has been <strong>${active ? 'activated' : 'disabled'}</strong> by your administrator.</p>
    ${active ? `<a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>` : ''}`);
}

function scheduleNotificationEmail(ownerName, title, description, dueDate, reportType, scheduleId) {
  const due = dueDate.toLocaleDateString('en-GB', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  const typeLabels = { financial:'Financial Report', management:'Management Accounts', board:'Board Report', audit:'Audit Report', dashboard:'Dashboard Report', investor:'Investor Brief' };
  return emailBase(`
    <div class="greeting">Report submission required 📋</div>
    <p class="text">Hi ${ownerName}, you have been assigned as the report owner for the following report. Please submit it by the due date.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Report</span><span class="cred-value">${title}</span></div>
      <div class="cred-row"><span class="cred-label">Type</span><span class="cred-value">${typeLabels[reportType]||reportType}</span></div>
      <div class="cred-row"><span class="cred-label">Due date</span><span class="cred-value">${due}</span></div>
      ${description ? `<div class="cred-row"><span class="cred-label">Description</span><span class="cred-value">${description}</span></div>` : ''}
    </div>
    <a href="${APP_URL}" class="btn">Log in to submit your report →</a>
    <div class="notice">📎 Log in to SARE Analytics, go to "My Reports", and upload your Excel or CSV file.</div>`);
}

function submissionNotificationEmail(reviewerName, reportTitle, submitterName, submissionId, reportType) {
  const typeLabels = { financial:'Financial Report', management:'Management Accounts', board:'Board Report', audit:'Audit Report', dashboard:'Dashboard Report', investor:'Investor Brief' };
  return emailBase(`
    <div class="greeting">Report submitted — insights ready 📊</div>
    <p class="text">Hi ${reviewerName}, <strong>${submitterName}</strong> has submitted the <strong>${reportTitle}</strong>. SARE Analytics has automatically generated insights.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Report</span><span class="cred-value">${reportTitle}</span></div>
      <div class="cred-row"><span class="cred-label">Submitted by</span><span class="cred-value">${submitterName}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">View insights in SARE Analytics →</a>`);
}

async function sendEmail(to, subject, html) {
  if (!resend) { console.log(`[EMAIL SKIPPED] To: ${to} | Subject: ${subject}`); return { skipped: true }; }
  try {
    const result = await resend.emails.send({ from: `SARE Analytics <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[EMAIL SENT] To: ${to}`);
    return result;
  } catch(e) { console.error(`[EMAIL FAILED] ${e.message}`); return { error: e.message }; }
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  if (await db.count({}) === 0) {
    await db.insert({ name:'SARE Admin', email:'admin@sare.africa', password:bcrypt.hashSync('@Sare 2026!',10), role:'admin', department:'Executive', accessLevel:'executive', org:'SARE Analytics', active:true, createdAt:new Date() });
    console.log('Admin seeded');
  }
  if (await deptDb.count({}) === 0) {
    const depts = [
      { name:'Executive', description:'Executive leadership team', color:'#1B6FE4' },
      { name:'Finance', description:'Finance and accounting team', color:'#0DAF6A' },
      { name:'Operations', description:'Operations and logistics team', color:'#D97706' },
      { name:'Compliance', description:'Compliance and risk team', color:'#E53E3E' },
      { name:'Board', description:'Board of directors', color:'#534AB7' },
    ];
    for (const d of depts) await deptDb.insert({ ...d, createdAt:new Date() });
    console.log('Departments seeded');
  }
  if (await rolesDb.count({}) === 0) {
    const roles = [
      { name:'Admin',           accessLevel:'executive', canSeeAllDepts:true,  description:'Full platform access' },
      { name:'CEO',             accessLevel:'executive', canSeeAllDepts:true,  description:'All departments, executive view' },
      { name:'CFO',             accessLevel:'executive', canSeeAllDepts:true,  description:'All departments, financial focus' },
      { name:'Board Member',    accessLevel:'executive', canSeeAllDepts:true,  description:'Read-only executive summaries' },
      { name:'Department Head', accessLevel:'senior',    canSeeAllDepts:false, description:'Own department full access' },
      { name:'Senior Manager',  accessLevel:'senior',    canSeeAllDepts:false, description:'Own department full access' },
      { name:'Manager',         accessLevel:'manager',   canSeeAllDepts:false, description:'Own department summary view' },
      { name:'Senior Analyst',  accessLevel:'analyst',   canSeeAllDepts:false, description:'Own department reports only' },
      { name:'Analyst',         accessLevel:'analyst',   canSeeAllDepts:false, description:'Own department reports only' },
      { name:'Auditor',         accessLevel:'senior',    canSeeAllDepts:true,  description:'Read-only all departments' },
    ];
    for (const r of roles) await rolesDb.insert({ ...r, createdAt:new Date() });
    console.log('Roles seeded');
  }
}
seed();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy:false }));
app.use(cors());
app.use(express.json({ limit:'50mb' }));
app.use(express.static(path.join(__dirname,'public')));
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:300 }));
const forgotPasswordLimiter = rateLimit({ windowMs:15*60*1000, max:5, standardHeaders:true, legacyHeaders:false, message:{ error:'Too many reset requests. Please try again later.' } });

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error:'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Invalid or expired token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin access required' });
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req,res) => {
  try {
    const { email, password } = req.body;
    const user = await db.findOne({ email:{ $regex:new RegExp(`^${email}$`,'i') } });
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error:'Invalid email or password' });
    if (!user.active)
      return res.status(403).json({ error:'Account disabled. Contact your admin.' });
    const token = jwt.sign(
      { id:user._id, email:user.email, name:user.name, role:user.role, department:user.department, accessLevel:user.accessLevel, org:user.org },
      JWT_SECRET, { expiresIn:'8h' }
    );
    await db.update({ _id:user._id }, { $set:{ lastLogin:new Date() } });
    res.json({ token, user:{ id:user._id, name:user.name, email:user.email, role:user.role, department:user.department, accessLevel:user.accessLevel, org:user.org } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/auth/register', async (req,res) => {
  try {
    const { name, email, password, org, inviteCode } = req.body;
    if (inviteCode !== (process.env.INVITE_CODE||'SARE2024'))
      return res.status(403).json({ error:'Invalid invite code. Contact your SARE admin.' });
    if (!name||!email||!password) return res.status(400).json({ error:'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error:'Password must be at least 8 characters' });
    const existing = await db.findOne({ email:{ $regex:new RegExp(`^${email}$`,'i') } });
    if (existing) return res.status(409).json({ error:'Email already registered' });
    const user = await db.insert({ name, email:email.toLowerCase(), password:bcrypt.hashSync(password,10), role:'Analyst', department:'Operations', accessLevel:'analyst', org:org||'SARE Analytics', active:true, createdAt:new Date() });
    const token = jwt.sign({ id:user._id, email:user.email, name:user.name, role:user.role, department:user.department, accessLevel:user.accessLevel, org:user.org }, JWT_SECRET, { expiresIn:'8h' });
    res.json({ token, user:{ id:user._id, name:user.name, email:user.email, role:user.role, department:user.department, accessLevel:user.accessLevel, org:user.org } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Forgot password (self-service) ────────────────────────────────────────────
// Generates a fresh temporary password, emails it, and invalidates the old one.
// Always returns a generic success message so we never reveal whether an email
// address is registered (prevents account enumeration).
function generateTempPassword() {
  // 12 chars, mixed case + digits, no ambiguous-looking characters
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) pass += alphabet[bytes[i] % alphabet.length];
  return pass;
}

app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const genericResponse = { success: true, message: 'If that email address is registered, a password reset has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await db.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
    if (!user || !user.active) {
      // Do not reveal whether the account exists or is disabled
      return res.json(genericResponse);
    }
    const newPassword = generateTempPassword();
    await db.update({ _id: user._id }, { $set: { password: bcrypt.hashSync(newPassword, 10), mustChangePassword: true } });
    await sendEmail(user.email, 'Your SARE Analytics password has been reset', forgotPasswordEmail(user.name, user.email, newPassword));
    res.json(genericResponse);
  } catch (e) {
    console.error('forgot-password error:', e.message);
    // Still return the generic response — don't leak error details to the client
    res.json(genericResponse);
  }
});

app.get('/api/auth/me', auth, (req,res) => res.json(req.user));

app.post('/api/auth/change-password', auth, async (req,res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (newPassword.length < 8) return res.status(400).json({ error:'New password must be at least 8 characters' });
    const user = await db.findOne({ _id:req.user.id });
    if (!user || !bcrypt.compareSync(currentPassword, user.password))
      return res.status(401).json({ error:'Current password is incorrect' });
    await db.update({ _id:req.user.id }, { $set:{ password:bcrypt.hashSync(newPassword,10) } });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Departments ───────────────────────────────────────────────────────────────
app.get('/api/departments', auth, async (req,res) => {
  try { res.json(await deptDb.find({})); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/departments', auth, adminOnly, async (req,res) => {
  try {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error:'Department name required' });
    if (await deptDb.findOne({ name:{ $regex:new RegExp(`^${name}$`,'i') } }))
      return res.status(409).json({ error:'Department already exists' });
    res.json(await deptDb.insert({ name, description:description||name+' Department', color:color||'#6B7280', createdAt:new Date() }));
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.put('/api/departments/:id', auth, adminOnly, async (req,res) => {
  try { await deptDb.update({ _id:req.params.id }, { $set:{ name:req.body.name, description:req.body.description, color:req.body.color } }); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.delete('/api/departments/:id', auth, adminOnly, async (req,res) => {
  try {
    const dept = await deptDb.findOne({ _id:req.params.id });
    if (!dept) return res.status(404).json({ error:'Not found' });
    const inUse = await db.count({ department:dept.name });
    if (inUse > 0) return res.status(400).json({ error:`Cannot delete — ${inUse} user(s) are in this department` });
    await deptDb.remove({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────
app.get('/api/roles', auth, async (req,res) => {
  try { res.json(await rolesDb.find({})); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/roles', auth, adminOnly, async (req,res) => {
  try {
    const { name, accessLevel, canSeeAllDepts, description } = req.body;
    if (!name) return res.status(400).json({ error:'Role name required' });
    if (await rolesDb.findOne({ name:{ $regex:new RegExp(`^${name}$`,'i') } }))
      return res.status(409).json({ error:'Role already exists' });
    res.json(await rolesDb.insert({ name, accessLevel:accessLevel||'analyst', canSeeAllDepts:!!canSeeAllDepts, description:description||'', createdAt:new Date() }));
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.put('/api/roles/:id', auth, adminOnly, async (req,res) => {
  try { await rolesDb.update({ _id:req.params.id }, { $set:{ name:req.body.name, accessLevel:req.body.accessLevel, canSeeAllDepts:req.body.canSeeAllDepts, description:req.body.description } }); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.delete('/api/roles/:id', auth, adminOnly, async (req,res) => {
  try {
    const role = await rolesDb.findOne({ _id:req.params.id });
    if (!role) return res.status(404).json({ error:'Not found' });
    const inUse = await db.count({ role:role.name });
    if (inUse > 0) return res.status(400).json({ error:`Cannot delete — ${inUse} user(s) have this role` });
    await rolesDb.remove({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req,res) => {
  try { res.json((await db.find({},{ password:0 })).map(u=>({ ...u, id:u._id }))); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/users', auth, adminOnly, async (req,res) => {
  try {
    const { name, email, password, role, department, accessLevel, org, sendWelcomeEmail } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error:'Name, email, password required' });
    if (await db.findOne({ email:{ $regex:new RegExp(`^${email}$`,'i') } }))
      return res.status(409).json({ error:'Email already exists' });
    const roleDoc = await rolesDb.findOne({ name:role });
    const user = await db.insert({
      name, email:email.toLowerCase(), password:bcrypt.hashSync(password,10),
      role:role||'Analyst', department:department||'Operations',
      accessLevel:accessLevel||(roleDoc?.accessLevel)||'analyst',
      org:org||'SARE Analytics', active:true, createdAt:new Date()
    });
    if (sendWelcomeEmail !== false) {
      await sendEmail(email, 'Welcome to SARE Analytics — your login details', welcomeEmail(name, email, password, role||'Analyst', department||'Operations'));
    }
    res.json({ ...user, id:user._id, password:undefined, emailSent:!!resend });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req,res) => {
  try {
    const { name, email, role, department, accessLevel, org, active, password } = req.body;
    const user = await db.findOne({ _id:req.params.id }, { password:0 });
    const update = { name, email:email?.toLowerCase(), role, department, accessLevel, org, active };
    if (password && password.length >= 8) {
      update.password = bcrypt.hashSync(password,10);
      await sendEmail(user.email, 'Your SARE Analytics password has been reset', passwordResetEmail(user.name, user.email, password));
    }
    if (user && user.active !== active) {
      await sendEmail(user.email, `Your SARE Analytics account has been ${active?'activated':'disabled'}`, accountStatusEmail(user.name, active));
    }
    await db.update({ _id:req.params.id }, { $set:update });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req,res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error:"Cannot delete your own account" });
    await db.remove({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/dept/members', auth, async (req,res) => {
  try {
    const isExec = req.user.accessLevel === 'executive' || req.user.role === 'admin';
    const query = isExec ? {} : { department:req.user.department };
    const users = await db.find(query, { password:0 });
    res.json(users.map(u=>({ id:u._id, name:u.name, email:u.email, role:u.role, department:u.department, accessLevel:u.accessLevel, active:u.active, lastLogin:u.lastLogin })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── File parse ────────────────────────────────────────────────────────────────
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:20*1024*1024 } });
// ── Shared: parse an xlsx/xls/csv buffer into the same tab-delimited text format used everywhere else ──
function parseWorkbookBuffer(buffer, filename) {
  let text = `FILE: ${filename}\n`;
  if (filename.toLowerCase().endsWith('.csv')) {
    text += buffer.toString('utf8').slice(0, 8000);
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    wb.SheetNames.forEach(sn => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
      text += `SHEET: ${sn}\n`;
      rows.slice(0, 120).forEach(r => { text += r.join('\t') + '\n'; });
    });
  }
  return text.slice(0, 6000);
}

app.post('/api/parse', auth, upload.array('files',10), (req,res) => {
  try {
    const results = [];
    for (const file of (req.files||[])) {
      const text = parseWorkbookBuffer(file.buffer, file.originalname);
      results.push({ name:file.originalname, size:file.size, text });
    }
    res.json({ files:results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── AI proxy with robust JSON parsing ──────────────────────────────────────────
app.post('/api/analyse', auth, async (req,res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI service not configured. Add ANTHROPIC_API_KEY to environment variables.' });
    }
    const { prompt, maxTokens, expectJson, skipCache } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const consistencyInstruction = '\n\nCRITICAL ACCURACY RULES: (1) The data includes PRE-COMPUTED FACTS with pre-calculated totals — use these numbers directly and exactly, do not re-derive them. (2) Never estimate, invent, or round creatively. Every figure you state must come directly from the PRE-COMPUTED FACTS or a named raw data row. (3) Two users asking the same question about the same file must get the same answer — consistency is mandatory. (4) If a figure is not in the pre-computed facts, identify the exact rows you are summing and show the arithmetic.';
    const fullPrompt = prompt + consistencyInstruction;
    const cacheKey = hashPrompt(fullPrompt + '|' + (maxTokens||1500) + '|' + (expectJson?'json':'text'));

    const callFn = async () => {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens || 1500,
        temperature: 0,
        messages: [{ role: 'user', content: fullPrompt }]
      });
      const text = (message.content||[]).map(b=>b.text||'').join('');
      if (expectJson) {
        try {
          const parsed = parseAIJson(text);
          return { text, parsed, success: true };
        } catch(parseErr) {
          return { text, parseError: parseErr.message };
        }
      }
      return { text, usage: message.usage };
    };

    const result = skipCache ? await callFn() : await getCachedOrCall(cacheKey, callFn);
    res.json(result);
  } catch(e) {
    console.error('Analyse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Shared: analyse report text with the AI, used by manual submissions AND connected-workbook auto-runs ──
async function analyseReportData({ title, submitter, department, role, data, skipCache }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('AI service not configured. Add ANTHROPIC_API_KEY to Render environment variables.');
  }
  const prompt = `You are an elite business intelligence analyst. Analyse this ${department} business report and respond with ONLY a JSON object. No markdown, no explanation, just the JSON.

Report: ${title}
Submitted by: ${submitter}
Department: ${department}
Data:
${data}

CRITICAL ACCURACY RULES:
1. Base every number strictly on the data provided above - never estimate or invent figures
2. If you calculate a total, sum the exact raw figures shown - do not round creatively
3. Be literal and consistent - the same data should always produce the same numbers
4. If a figure cannot be determined from the data, say "Not available" rather than guessing

DO NOT ASSUME BUSINESS TYPE: Do not assume this is a wallet, fintech, or payments business unless the data itself contains wallet balances, transaction settlement, or e-money compliance figures. Base the summary, KPIs, SWOT, insights and recommendations entirely on what is actually present in the data — describe the business in whatever terms actually apply (FMCG, retail, manufacturing, services, wallet, etc.) rather than defaulting to wallet/fintech language.

KPI CARDS MUST BE SHORT (they render as small dashboard tiles): "value" is ONLY the headline number (e.g. "KES 660.7M", "155 SKUs", "39.8%" — round large currency to 1 decimal with M/K suffixes, never a raw 9-digit number, never an explanatory clause in parentheses). "delta" is ONLY a short change indicator, max ~4 words (e.g. "+12.3%", "N/A", "-2.6pts") — never a full sentence. Put any nuance or explanation in insights/SWOT instead.

ANALYSIS DEPTH REQUIRED: Each insight must be a 2-3 sentence deep-dive that states the finding with exact figures, explains why it matters, and notes the business impact. Avoid generic statements - be specific to this data.

Return this exact JSON structure with real values based on the data:
{"role":"${role}","summary":"A detailed 3-sentence summary of the overall position, the most important finding, and what needs attention","kpis":[{"label":"Metric name from data","value":"KES X or relevant unit","delta":"+/-X%","positive":true},{"label":"Metric 2","value":"value","delta":"+/-X%","positive":false},{"label":"Metric 3","value":"value","delta":"+/-X%","positive":true},{"label":"Metric 4","value":"value","delta":"+/-X%","positive":false}],"swot":{"strengths":["Specific strength with the exact figure that proves it","Second strength with evidence"],"weaknesses":["Specific weakness with the exact figure and why it matters","Second weakness with evidence and impact"],"opportunities":["Specific opportunity, quantified where possible","Second opportunity with rationale"],"threats":["Specific threat with magnitude/likelihood","Second threat with context"]},"insights":[{"title":"Specific finding title naming the actual issue","body":"2-3 sentence deep-dive with exact figures, cause, and business impact","type":"warning","badge":"Watch"},{"title":"Second specific finding","body":"2-3 sentence deep-dive with figures, cause, and impact","type":"danger","badge":"Critical"},{"title":"Third specific finding","body":"2-3 sentence deep-dive with figures, cause, and impact","type":"info","badge":"Info"}],"recommendations":["Specific actionable recommendation with timeframe and expected outcome","Second recommendation with timeframe","Third recommendation with timeframe and owner"]}`;

  const cacheKey = hashPrompt(prompt + '|submission|' + role);

  const callFn = async () => {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = (message.content || []).map(b => b.text || '').join('');
    let result;
    try {
      result = parseAIJson(text);
    } catch(parseErr) {
      throw new Error('AI response could not be parsed: ' + parseErr.message);
    }
    if (!result.trends) {
      result.trends = {
        revenue: { labels: ['Jan','Feb','Mar','Apr','May','Jun'], data: [0,0,0,0,0,0], growth: '-', topProduct: '-' },
        wallets: { labels: ['Jan','Feb','Mar','Apr','May','Jun'], active: [0,0,0,0,0,0], dormant: [0,0,0,0,0,0] },
        transactions: { labels: ['Jan','Feb','Mar','Apr','May','Jun'], success: [0,0,0,0,0,0], failed: [0,0,0,0,0,0], pending: [0,0,0,0,0,0] },
        compliance: { labels: ['Jan','Feb','Mar','Apr','May','Jun'], highValue: [0,0,0,0,0,0], dormantFlags: [0,0,0,0,0,0] }
      };
    }
    if (!result.gapChecker) result.gapChecker = { present: [], missing: [], warning: [] };
    if (!result.standardChecklist) result.standardChecklist = [];
    return { result, success: true };
  };

  return skipCache ? await callFn() : await getCachedOrCall(cacheKey, callFn);
}

// ── Dedicated submission analysis (Haiku model, robust parsing) ───────────────
app.post('/api/analyse-submission', auth, async (req, res) => {
  try {
    const { title, submitter, department, role, data, skipCache } = req.body;
    const finalResult = await analyseReportData({ title, submitter, department, role, data, skipCache });
    res.json(finalResult);
  } catch(e) {
    console.error('analyse-submission error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Download submitted report file ────────────────────────────────────────────
app.get('/api/submissions/:id/download', auth, async (req,res) => {
  try {
    const sub = await submissionsDb.findOne({ _id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    if (!sub.fileBuffer) return res.status(404).json({ error: 'File not stored — please resubmit' });
    res.setHeader('Content-Disposition', `attachment; filename="${sub.filename||'report.xlsx'}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(sub.fileBuffer, 'base64'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Email test ──────────────────────────────────────────────────────────────
app.post('/api/admin/test-email', auth, adminOnly, async (req,res) => {
  try {
    const result = await sendEmail(req.user.email, 'SARE Analytics — email test', emailBase(`
      <div class="greeting">Email is working! ✅</div>
      <p class="text">Your SARE Analytics email system is configured correctly.</p>`));
    res.json({ success:true, result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Report History ────────────────────────────────────────────────────────────
app.post('/api/history', auth, async (req,res) => {
  try {
    const { role, perspective, filename, summary, kpis, swot, insights, recommendations, trends, gapChecker, rawData, visibility, sharedWith, files } = req.body;
    // files: [{ name, mime, data }] — data is base64-encoded file content from the browser.
    // Stored so the person can always redownload exactly what they originally uploaded.
    const attachments = (Array.isArray(files) ? files : [])
      .filter(f => f && f.data)
      .map(f => ({ filename: f.name || 'file', mime: f.mime || 'application/octet-stream', data: f.data }));
    const record = await historyDb.insert({
      userId: req.user.id, userName: req.user.name,
      department: req.user.department, org: req.user.org,
      role, perspective, filename, summary, kpis, swot, insights,
      recommendations, trends, gapChecker, rawData, attachments,
      visibility: visibility || 'private',  // private | department | organisation | shared
      sharedWith: sharedWith || [],          // array of user IDs if visibility is 'shared'
      createdAt: new Date()
    });
    res.json({ id: record._id, success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Strip base64 attachment payloads down to lightweight metadata for list/detail views —
// the actual bytes are only ever sent by the dedicated download endpoint below.
function attachmentMeta(record) {
  const attachments = (record.attachments || []).map((a, i) => ({
    index: i, filename: a.filename, mime: a.mime,
    size: a.data ? Buffer.byteLength(a.data, 'base64') : 0
  }));
  return { ...record, attachments };
}

app.get('/api/history', auth, async (req,res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const allRecords = await historyDb.find({}).sort({ createdAt: -1 });

    // Apply visibility filtering
    const visible = allRecords.filter(r => {
      if (isAdmin) return true; // admin sees everything
      if (r.userId === req.user.id) return true; // always see your own
      const vis = r.visibility || 'department'; // legacy records default to department
      if (vis === 'private') return false; // private = owner only
      if (vis === 'organisation') return true; // everyone with access sees org-wide
      if (vis === 'department') return r.department === req.user.department;
      if (vis === 'shared') return (r.sharedWith||[]).includes(req.user.id);
      return false;
    });

    res.json(visible.map(r => attachmentMeta({ ...r, id: r._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:id', auth, async (req,res) => {
  try {
    const record = await historyDb.findOne({ _id: req.params.id });
    if (!record) return res.status(404).json({ error: 'Not found' });
    // Check access permission
    const isAdmin = req.user.role === 'admin';
    const isOwner = record.userId === req.user.id;
    const vis = record.visibility || 'department';
    const canSee = isAdmin || isOwner ||
      (vis === 'organisation') ||
      (vis === 'department' && record.department === req.user.department) ||
      (vis === 'shared' && (record.sharedWith||[]).includes(req.user.id));
    if (!canSee) return res.status(403).json({ error: 'You do not have permission to view this analysis' });
    res.json(attachmentMeta({ ...record, id: record._id }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Download the original file(s) attached to a saved analysis ────────────────
app.get('/api/history/:id/download/:index', auth, async (req,res) => {
  try {
    const record = await historyDb.findOne({ _id: req.params.id });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const isAdmin = req.user.role === 'admin';
    const isOwner = record.userId === req.user.id;
    const vis = record.visibility || 'department';
    const canSee = isAdmin || isOwner ||
      (vis === 'organisation') ||
      (vis === 'department' && record.department === req.user.department) ||
      (vis === 'shared' && (record.sharedWith||[]).includes(req.user.id));
    if (!canSee) return res.status(403).json({ error: 'You do not have permission to download this file' });
    const idx = parseInt(req.params.index, 10);
    const attachment = (record.attachments || [])[idx];
    if (!attachment || !attachment.data) return res.status(404).json({ error: 'File not available — it may not have been saved with this analysis' });
    res.setHeader('Content-Disposition', `attachment; filename="${(attachment.filename||'report').replace(/"/g,'')}"`);
    res.setHeader('Content-Type', attachment.mime || 'application/octet-stream');
    res.send(Buffer.from(attachment.data, 'base64'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history/:id', auth, async (req,res) => {
  try {
    const record = await historyDb.findOne({ _id: req.params.id });
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (record.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the owner or an admin can delete this analysis' });
    }
    await historyDb.remove({ _id: req.params.id });
    await notesDb.remove({ historyId: req.params.id }, { multi: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:id/notes', auth, async (req,res) => {
  try { res.json(await notesDb.find({ historyId: req.params.id }).sort({ createdAt: 1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/history/:id/notes', auth, async (req,res) => {
  try {
    const note = await notesDb.insert({ historyId: req.params.id, userId: req.user.id, userName: req.user.name, text: req.body.text, createdAt: new Date() });
    res.json(note);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/history/:id/visibility', auth, async (req,res) => {
  try {
    const record = await historyDb.findOne({ _id: req.params.id });
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (record.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the owner can change visibility' });
    }
    const { visibility, sharedWith } = req.body;
    await historyDb.update({ _id: req.params.id }, { $set: { visibility, sharedWith: sharedWith||[] } });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/compare/:id1/:id2', auth, async (req,res) => {
  try {
    const [a, b] = await Promise.all([historyDb.findOne({ _id: req.params.id1 }), historyDb.findOne({ _id: req.params.id2 })]);
    if (!a || !b) return res.status(404).json({ error: 'One or both records not found' });
    res.json({ a: { ...a, id: a._id }, b: { ...b, id: b._id } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Schedule CRUD ─────────────────────────────────────────────────────────────
app.get('/api/schedules', auth, async (req,res) => {
  try {
    const isExec = ['executive'].includes(req.user.accessLevel) || req.user.role === 'admin';
    let query = {};
    if (!isExec) {
      query = { $or: [{ ownerId: req.user.id }, { reviewerIds: req.user.id }, { department: req.user.department }] };
    }
    const schedules = await schedulesDb.find(query).sort({ nextDue: 1 });
    res.json(schedules.map(s => ({ ...s, id: s._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedules', auth, async (req,res) => {
  try {
    const allowed = ['executive','senior','manager'].includes(req.user.accessLevel) || req.user.role === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Senior role or above required to create schedules' });
    const { title, description, reportType, frequency, firstDueDate, ownerId, ownerName, ownerEmail, reviewerIds, department, perspective } = req.body;
    if (!title || !firstDueDate || !ownerId) return res.status(400).json({ error: 'Title, due date and owner required' });
    const schedule = await schedulesDb.insert({
      title, description: description||'', reportType: reportType||'financial',
      frequency, firstDueDate: new Date(firstDueDate),
      nextDue: new Date(firstDueDate),
      ownerId, ownerName, ownerEmail,
      reviewerIds: reviewerIds||[], department: department||req.user.department,
      perspective: perspective||'cfo',
      createdBy: req.user.id, createdByName: req.user.name,
      active: true, createdAt: new Date()
    });
    await sendEmail(ownerEmail,
      `Action required: ${title} is due ${new Date(firstDueDate).toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})}`,
      scheduleNotificationEmail(ownerName, title, description||'', new Date(firstDueDate), reportType||'financial', schedule._id)
    );
    res.json({ ...schedule, id: schedule._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/schedules/:id', auth, async (req,res) => {
  try {
    const { title, description, reportType, frequency, nextDue, ownerId, ownerName, ownerEmail, reviewerIds, department, perspective, active } = req.body;
    await schedulesDb.update({ _id: req.params.id }, { $set: { title, description, reportType, frequency, nextDue: nextDue ? new Date(nextDue) : undefined, ownerId, ownerName, ownerEmail, reviewerIds, department, perspective, active } });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedules/:id', auth, async (req,res) => {
  try {
    await schedulesDb.remove({ _id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Submissions ───────────────────────────────────────────────────────────────
app.get('/api/submissions', auth, async (req,res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const allSubs = await submissionsDb.find({}).sort({ createdAt: -1 });
    if (isAdmin) return res.json(allSubs.map(s => ({ ...s, id: s._id, fileBuffer: undefined, reportText: undefined })));

    // Get schedules to check reviewer status
    const schedules = await schedulesDb.find({});
    const scheduleMap = {};
    schedules.forEach(sc => { scheduleMap[sc._id] = sc; });

    const visible = allSubs.filter(s => {
      if (s.submittedById === req.user.id) return true; // own submissions
      const schedule = scheduleMap[s.scheduleId];
      if (!schedule) return false;
      const isReviewer = (schedule.reviewerIds||[]).includes(req.user.id);
      const isExec = req.user.accessLevel === 'executive';
      return isReviewer || isExec;
    });

    res.json(visible.map(s => ({ ...s, id: s._id, fileBuffer: undefined, reportText: undefined })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/submissions/pending', auth, async (req,res) => {
  try {
    const mySchedules = await schedulesDb.find({ ownerId: req.user.id, active: true });
    const now = new Date();
    const pending = mySchedules.filter(s => new Date(s.nextDue) <= new Date(now.getTime() + 3*24*60*60*1000));
    res.json(pending.map(s => ({ ...s, id: s._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/submissions', auth, upload.single('report'), async (req,res) => {
  try {
    const { scheduleId, notes } = req.body;
    const schedule = await schedulesDb.findOne({ _id: scheduleId });
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    let reportText = '';
    if (req.file) {
      if (req.file.originalname.endsWith('.csv')) {
        reportText = req.file.buffer.toString('utf8').slice(0, 35000);
      } else {
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        wb.SheetNames.forEach(sn => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
          reportText += `SHEET: ${sn} (${rows.length} rows)\n`;
          rows.forEach(r => { reportText += r.join('\t') + '\n'; });
        });
        if (reportText.length > 35000) {
          reportText = reportText.slice(0, 35000) + '\n[NOTE: file truncated — very large file]';
        }
      }
    }
    const submission = await submissionsDb.insert({
      scheduleId, scheduleTitle: schedule.title,
      submittedById: req.user.id, submittedByName: req.user.name,
      department: req.user.department,
      filename: req.file?.originalname || 'Manual submission',
      fileBuffer: req.file ? req.file.buffer.toString('base64') : null,
      fileMime: req.file?.mimetype || null,
      notes: notes||'', reportText,
      status: 'submitted', createdAt: new Date()
    });
    const nextDue = calcNextDue(schedule.frequency, new Date(schedule.nextDue));
    await schedulesDb.update({ _id: scheduleId }, { $set: { nextDue, lastSubmitted: new Date() } });

    // ── Auto-analysis: run in background immediately after submission ──────────
    setImmediate(async () => {
      try {
        const cleanData = reportText.replace(/['"\\]/g, ' ').replace(/[^a-zA-Z0-9\s.,;:()+\-/%@=]/g, ' ').replace(/\s+/g, ' ');
        const role = schedule.perspective || 'cfo';
        const prompt = `You are an elite business intelligence analyst. Analyse this ${req.user.department} business report and respond with ONLY a JSON object. No markdown, no explanation, just the JSON.\n\nReport: ${schedule.title}\nSubmitted by: ${req.user.name}\nDepartment: ${req.user.department}\nData:\n${cleanData}\n\nCRITICAL ACCURACY RULES:\n1. Base every number strictly on the data provided above - never estimate or invent figures\n2. If you calculate a total, sum the exact raw figures shown - do not round creatively\n3. Be literal and consistent - the same data should always produce the same numbers\n4. If a figure cannot be determined from the data, say "Not available" rather than guessing\n\nDO NOT ASSUME BUSINESS TYPE: Do not assume this is a wallet, fintech, or payments business unless the data itself contains wallet balances, transaction settlement, or e-money compliance figures. Describe the business in whatever terms actually apply based on the data (FMCG, retail, manufacturing, services, wallet, etc.) — never default to wallet/fintech language that has no basis in the data.\n\nKPI CARDS MUST BE SHORT (they render as small dashboard tiles): "value" is ONLY the headline number (e.g. "KES 660.7M", "155 SKUs", "39.8%" — round large currency to 1 decimal with M/K suffixes, never a raw 9-digit number, never an explanatory clause in parentheses). "delta" is ONLY a short change indicator, max ~4 words (e.g. "+12.3%", "N/A", "-2.6pts") — never a full sentence. Put any nuance or explanation in insights/SWOT instead.\n\nANALYSIS DEPTH REQUIRED: Each insight must be a 2-3 sentence deep-dive that states the finding with exact figures, explains why it matters, and notes the business impact.\n\nReturn this exact JSON structure:\n{"role":"${role}","summary":"3-sentence summary of overall position, key finding, and what needs attention","kpis":[{"label":"Metric from data","value":"KES X","delta":"+/-X%","positive":true},{"label":"Metric 2","value":"value","delta":"+/-X%","positive":false},{"label":"Metric 3","value":"value","delta":"+/-X%","positive":true},{"label":"Metric 4","value":"value","delta":"+/-X%","positive":false}],"swot":{"strengths":["Specific strength with exact figure"],"weaknesses":["Specific weakness with exact figure and impact"],"opportunities":["Specific opportunity, quantified"],"threats":["Specific threat with magnitude"]},"insights":[{"title":"Specific finding","body":"2-3 sentence deep-dive with exact figures, cause, and business impact","type":"warning","badge":"Watch"},{"title":"Second finding","body":"2-3 sentence deep-dive","type":"danger","badge":"Critical"},{"title":"Third finding","body":"2-3 sentence deep-dive","type":"info","badge":"Info"}],"recommendations":["Specific actionable recommendation with timeframe","Second recommendation with timeframe","Third recommendation with timeframe and owner"]}`;
        const cacheKey = hashPrompt(prompt + '|autoanalysis|' + role);
        const callFn = async () => {
          const message = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }]
          });
          const text = (message.content || []).map(b => b.text || '').join('');
          const result = parseAIJson(text);
          if (!result.trends) result.trends = { revenue:{labels:[],data:[],growth:'-',topProduct:'-'}, wallets:{labels:[],active:[],dormant:[]}, transactions:{labels:[],success:[],failed:[],pending:[]}, compliance:{labels:[],highValue:[],dormantFlags:[]} };
          if (!result.gapChecker) result.gapChecker = { present:[], missing:[], warning:[] };
          if (!result.standardChecklist) result.standardChecklist = [];
          return { result, success: true };
        };
        const analysis = await getCachedOrCall(cacheKey, callFn);
        await submissionsDb.update({ _id: submission._id }, { $set: { autoAnalysis: analysis.result, autoAnalysedAt: new Date() } });
        console.log('Auto-analysis complete for submission:', submission._id);
      } catch(e) {
        console.error('Auto-analysis failed for submission', submission._id, ':', e.message);
        await submissionsDb.update({ _id: submission._id }, { $set: { autoAnalysis: null, autoAnalysisError: e.message } });
      }
    });
    const reviewerUsers = await db.find({ _id: { $in: schedule.reviewerIds||[] } });
    for (const reviewer of reviewerUsers) {
      await sendEmail(reviewer.email,
        `Report submitted: ${schedule.title} — insights ready`,
        submissionNotificationEmail(reviewer.name, schedule.title, req.user.name, submission._id, schedule.reportType)
      );
    }
    res.json({ ...submission, id: submission._id, reportText: undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/submissions/:id', auth, async (req,res) => {
  try {
    const sub = await submissionsDb.findOne({ _id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const isAdmin = req.user.role === 'admin';
    const isOwner = sub.submittedById === req.user.id;
    if (!isAdmin && !isOwner) {
      const schedule = await schedulesDb.findOne({ _id: sub.scheduleId });
      const isReviewer = schedule && (schedule.reviewerIds||[]).includes(req.user.id);
      const isExec = req.user.accessLevel === 'executive';
      if (!isReviewer && !isExec) return res.status(403).json({ error: 'You do not have permission to view this submission' });
    }
    res.json({ ...sub, id: sub._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get auto-analysis for a submission ────────────────────────────────────────
app.get('/api/submissions/:id/analysis', auth, async (req,res) => {
  try {
    const sub = await submissionsDb.findOne({ _id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const isAdmin = req.user.role === 'admin';
    const isOwner = sub.submittedById === req.user.id;
    if (!isAdmin && !isOwner) {
      const schedule = await schedulesDb.findOne({ _id: sub.scheduleId });
      const isReviewer = schedule && (schedule.reviewerIds||[]).includes(req.user.id);
      const isExec = req.user.accessLevel === 'executive';
      if (!isReviewer && !isExec) return res.status(403).json({ error: 'Forbidden' });
    }
    if (sub.autoAnalysis) {
      return res.json({ ready: true, analysis: sub.autoAnalysis, analysedAt: sub.autoAnalysedAt });
    }
    if (sub.autoAnalysisError) {
      return res.json({ ready: false, error: sub.autoAnalysisError });
    }
    res.json({ ready: false, status: 'processing' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedules/:id/remind', auth, async (req,res) => {
  try {
    const schedule = await schedulesDb.findOne({ _id: req.params.id });
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    await sendEmail(schedule.ownerEmail,
      `Reminder: ${schedule.title} is due ${new Date(schedule.nextDue).toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})}`,
      scheduleNotificationEmail(schedule.ownerName, schedule.title, schedule.description, new Date(schedule.nextDue), schedule.reportType, schedule._id)
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function calcNextDue(frequency, from) {
  const d = new Date(from);
  switch(frequency) {
    case 'daily':     d.setDate(d.getDate() + 1); break;
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annually':  d.setFullYear(d.getFullYear() + 1); break;
    default:          d.setMonth(d.getMonth() + 1);
  }
  return d;
}

async function checkDueReminders() {
  try {
    const now = new Date();
    const todayKey = now.toISOString().slice(0,10); // YYYY-MM-DD
    const in3days = new Date(now.getTime() + 3*24*60*60*1000);
    const dueSoon = await schedulesDb.find({ active: true, nextDue: { $lte: in3days } });
    for (const s of dueSoon) {
      const daysUntil = Math.ceil((new Date(s.nextDue) - now) / (1000*60*60*24));
      if ([3,1,0].includes(daysUntil)) {
        // Prevent duplicate sends - only send once per day per schedule
        const lastReminderKey = s.lastReminderKey || '';
        const todayReminderKey = todayKey + '-' + daysUntil;
        if (lastReminderKey === todayReminderKey) continue; // already sent today for this exact day-count

        await sendEmail(s.ownerEmail,
          `${daysUntil === 0 ? 'DUE TODAY' : `Due in ${daysUntil} day${daysUntil>1?'s':''}`}: ${s.title}`,
          scheduleNotificationEmail(s.ownerName, s.title, s.description, new Date(s.nextDue), s.reportType, s._id)
        );
        await schedulesDb.update({ _id: s._id }, { $set: { lastReminderKey: todayReminderKey, lastReminderSent: now } });
      }
    }
  } catch(e) { console.error('Reminder check error:', e.message); }
}
// Run once 30 seconds after server start (not immediately, to avoid restart-loop spam), then every 6 hours
setTimeout(checkDueReminders, 30000);
setInterval(checkDueReminders, 6*60*60*1000);

// ── Connected Reports (auto-refreshed workbooks) ───────────────────────────────
// A "connected report" is a public/direct-download URL to a workbook (Google Sheets
// export link, OneDrive/SharePoint direct link, Dropbox raw link, etc). Every day at
// the configured time, the server fetches the latest version, parses it, runs it
// through the same AI analysis as a manual upload, and saves the result to History
// so it can be viewed like any other report — no one needs to manually re-upload it.

app.post('/api/connected-reports', auth, async (req,res) => {
  try {
    const { name, url, role, fetchTime, department } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must be a direct http(s) link to the workbook' });
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(fetchTime||'')) return res.status(400).json({ error: 'fetchTime must be in 24-hour HH:mm format, e.g. 07:00' });
    const conn = await connectedReportsDb.insert({
      userId: req.user.id, userName: req.user.name, org: req.user.org,
      department: department || req.user.department,
      name, url, role: role || 'cfo', fetchTime,
      active: true, lastRunDate: null, lastRunAt: null, lastStatus: null, lastError: null, lastHistoryId: null,
      createdAt: new Date()
    });
    res.json({ ...conn, id: conn._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/connected-reports', auth, async (req,res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const all = await connectedReportsDb.find({}).sort({ createdAt: -1 });
    const visible = isAdmin ? all : all.filter(c => c.userId === req.user.id || c.department === req.user.department);
    res.json(visible.map(c => ({ ...c, id: c._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/connected-reports/:id', auth, async (req,res) => {
  try {
    const conn = await connectedReportsDb.findOne({ _id: req.params.id });
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not permitted' });
    const { name, url, role, fetchTime, active } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (url !== undefined) update.url = url;
    if (role !== undefined) update.role = role;
    if (fetchTime !== undefined) {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(fetchTime)) return res.status(400).json({ error: 'fetchTime must be in 24-hour HH:mm format' });
      update.fetchTime = fetchTime;
    }
    if (active !== undefined) update.active = !!active;
    await connectedReportsDb.update({ _id: req.params.id }, { $set: update });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/connected-reports/:id', auth, async (req,res) => {
  try {
    const conn = await connectedReportsDb.findOne({ _id: req.params.id });
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not permitted' });
    await connectedReportsDb.remove({ _id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fetches the workbook, parses it, runs AI analysis, and saves to History.
// Shared by both the daily scheduler and the manual "Run now" button.
async function runConnectedReport(conn) {
  const runDate = new Date().toISOString().slice(0,10);
  try {
    const resp = await fetch(conn.url);
    if (!resp.ok) throw new Error(`Could not download the workbook (HTTP ${resp.status}). Check the link is still public and direct-download.`);
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // Guess a filename/extension from the URL or Content-Type, defaulting to xlsx
    let filename = 'workbook.xlsx';
    try {
      const urlPath = new URL(conn.url).pathname;
      const base = urlPath.split('/').pop();
      if (base && base.includes('.')) filename = base;
    } catch {}
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('csv') && !filename.toLowerCase().endsWith('.csv')) filename = filename.replace(/\.[^.]+$/, '') + '.csv';

    const text = parseWorkbookBuffer(buffer, filename);
    const { result } = await analyseReportData({
      title: conn.name, submitter: conn.userName + ' (auto-connected)', department: conn.department, role: conn.role, data: text, skipCache: true
    });

    const historyRecord = await historyDb.insert({
      userId: conn.userId, userName: conn.userName, department: conn.department, org: conn.org,
      role: result.role, perspective: conn.role, filename: conn.name + ' (auto-refresh ' + runDate + ')',
      summary: result.summary, kpis: result.kpis, swot: result.swot, insights: result.insights,
      recommendations: result.recommendations, trends: result.trends, gapChecker: result.gapChecker,
      standardChecklist: result.standardChecklist, attachments: [],
      visibility: 'department', sharedWith: [],
      sourceType: 'connected', connectionId: conn._id,
      createdAt: new Date()
    });

    await connectedReportsDb.update({ _id: conn._id }, { $set: {
      lastRunDate: runDate, lastRunAt: new Date(), lastStatus: 'success', lastError: null, lastHistoryId: historyRecord._id
    }});
    return { success: true, historyId: historyRecord._id };
  } catch(e) {
    console.error('Connected report run failed:', conn.name, e.message);
    await connectedReportsDb.update({ _id: conn._id }, { $set: {
      lastRunDate: runDate, lastRunAt: new Date(), lastStatus: 'error', lastError: e.message
    }});
    return { success: false, error: e.message };
  }
}

// Manual "Run now" — lets you test a connection or force a refresh without waiting for the scheduled time
app.post('/api/connected-reports/:id/run-now', auth, async (req,res) => {
  try {
    const conn = await connectedReportsDb.findOne({ _id: req.params.id });
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not permitted' });
    const outcome = await runConnectedReport(conn);
    if (!outcome.success) return res.status(500).json({ error: outcome.error });
    res.json(outcome);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Past auto-generated runs for a given connection (so you can view the history of a specific workbook)
app.get('/api/connected-reports/:id/runs', auth, async (req,res) => {
  try {
    const conn = await connectedReportsDb.findOne({ _id: req.params.id });
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.userId !== req.user.id && req.user.role !== 'admin' && conn.department !== req.user.department) return res.status(403).json({ error: 'Not permitted' });
    const runs = await historyDb.find({ connectionId: req.params.id }).sort({ createdAt: -1 });
    res.json(runs.map(r => ({ id: r._id, filename: r.filename, createdAt: r.createdAt, summary: r.summary })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Checks every minute for connections whose fetchTime matches the current server time (HH:mm)
// and that haven't already run today. NOTE: fetchTime is interpreted in the server's local
// timezone (whatever Render/your host is set to — typically UTC) — factor that in when picking a time.
async function checkConnectedReportsDue() {
  try {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const currentHHmm = `${hh}:${mm}`;
    const todayKey = now.toISOString().slice(0,10);
    const due = await connectedReportsDb.find({ active: true, fetchTime: currentHHmm });
    for (const conn of due) {
      if (conn.lastRunDate === todayKey) continue; // already ran today, skip
      // Mark immediately to avoid double-firing if this tick overlaps a slow run
      await connectedReportsDb.update({ _id: conn._id }, { $set: { lastRunDate: todayKey } });
      runConnectedReport(conn); // fire and forget — errors are captured inside runConnectedReport
    }
  } catch(e) { console.error('Connected reports scheduler error:', e.message); }
}
setInterval(checkConnectedReportsDue, 60*1000);

app.get('/api/health', (req,res) => res.json({ status:'ok', version:'9.0.0', emailEnabled:!!resend, aiEnabled:!!process.env.ANTHROPIC_API_KEY, features:['history','scheduling','query','jsonrepair'] }));
app.get('/{*path}', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`SARE Analytics v8 running on http://localhost:${PORT}`));
