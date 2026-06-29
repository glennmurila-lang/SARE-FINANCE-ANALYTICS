const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
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
const db      = Datastore.create({ filename: path.join(__dirname, 'data', 'users.db'),  autoload: true });
const deptDb  = Datastore.create({ filename: path.join(__dirname, 'data', 'depts.db'),  autoload: true });
const rolesDb = Datastore.create({ filename: path.join(__dirname, 'data', 'roles.db'),  autoload: true });

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
    <p class="text">You have been added to the SARE Analytics Intelligence Platform. Use the credentials below to sign in and start generating executive-grade insights from your financial reports.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Login URL</span><span class="cred-value">${APP_URL}</span></div>
      <div class="cred-row"><span class="cred-label">Email</span><span class="cred-value">${email}</span></div>
      <div class="cred-row"><span class="cred-label">Password</span><span class="cred-value">${password}</span></div>
      <div class="cred-row"><span class="cred-label">Role</span><span class="cred-value">${role}</span></div>
      <div class="cred-row"><span class="cred-label">Department</span><span class="cred-value">${department}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>
    <div class="notice">🔒 For security, please change your password immediately after your first login. Click the "🔑 Password" button in the sidebar once you are signed in.</div>`);
}

function passwordResetEmail(name, email, newPassword) {
  return emailBase(`
    <div class="greeting">Password reset — ${name}</div>
    <p class="text">Your SARE Analytics password has been reset by your administrator. Use the new password below to sign in.</p>
    <div class="cred-box">
      <div class="cred-row"><span class="cred-label">Login URL</span><span class="cred-value">${APP_URL}</span></div>
      <div class="cred-row"><span class="cred-label">Email</span><span class="cred-value">${email}</span></div>
      <div class="cred-row"><span class="cred-label">New password</span><span class="cred-value">${newPassword}</span></div>
    </div>
    <a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>
    <div class="notice">🔒 Please change your password immediately after signing in.</div>`);
}

function accountStatusEmail(name, active) {
  return emailBase(`
    <div class="greeting">Account ${active ? 'activated' : 'disabled'} — ${name}</div>
    <p class="text">Your SARE Analytics account has been <strong>${active ? 'activated' : 'disabled'}</strong> by your administrator.</p>
    ${active
      ? `<a href="${APP_URL}" class="btn">Sign in to SARE Analytics →</a>`
      : `<p class="text">If you believe this is an error, please contact your SARE administrator.</p>`
    }`);
}

async function sendEmail(to, subject, html) {
  if (!resend) { console.log(`[EMAIL SKIPPED - no API key] To: ${to} | Subject: ${subject}`); return { skipped: true }; }
  try {
    const result = await resend.emails.send({ from: `SARE Analytics <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
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
    // Send welcome email
    if (sendWelcomeEmail !== false) {
      await sendEmail(
        email,
        'Welcome to SARE Analytics — your login details',
        welcomeEmail(name, email, password, role||'Analyst', department||'Operations')
      );
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
      // Send password reset email
      await sendEmail(
        user.email,
        'Your SARE Analytics password has been reset',
        passwordResetEmail(user.name, user.email, password)
      );
    }
    // Send status change email if active status changed
    if (user && user.active !== active) {
      await sendEmail(
        user.email,
        `Your SARE Analytics account has been ${active?'activated':'disabled'}`,
        accountStatusEmail(user.name, active)
      );
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
app.post('/api/parse', auth, upload.array('files',10), (req,res) => {
  try {
    const results = [];
    for (const file of (req.files||[])) {
      let text = `FILE: ${file.originalname}\n`;
      if (file.originalname.endsWith('.csv')) { text += file.buffer.toString('utf8').slice(0,8000); }
      else {
        const wb = XLSX.read(file.buffer,{ type:'buffer' });
        wb.SheetNames.forEach(sn => { const rows=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1}); text+=`SHEET: ${sn}\n`; rows.slice(0,120).forEach(r=>{ text+=r.join('\t')+'\n'; }); });
      }
      results.push({ name:file.originalname, size:file.size, text:text.slice(0,6000) });
    }
    res.json({ files:results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Email test route (admin only) ─────────────────────────────────────────────
app.post('/api/admin/test-email', auth, adminOnly, async (req,res) => {
  try {
    const result = await sendEmail(req.user.email, 'SARE Analytics — email test', emailBase(`
      <div class="greeting">Email is working! ✅</div>
      <p class="text">Your SARE Analytics email system is configured correctly. Emails will now be sent automatically when you add users, reset passwords, or change account status.</p>`));
    res.json({ success:true, result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Anthropic AI proxy (secure server-side) ──────────────────────────────────
app.post('/api/analyse', auth, async (req,res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI service not configured. Add ANTHROPIC_API_KEY to environment variables.' });
    }
    const { prompt, maxTokens, expectJson } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens || 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    let text = (message.content||[]).map(b=>b.text||'').join('');
    
    // Sanitize text to fix common JSON breaking characters
    const sanitizeForJson = (str) => {
      if (!str) return str;
      // Remove/replace characters that break JSON parsing
      return str
        .replace(/\/g, '\\')           // escape backslashes first
        .replace(/[‘’']/g, "\'")  // smart single quotes -> escaped
        .replace(/[“”]/g, '\"')         // smart double quotes -> escaped  
        .replace(/[–—]/g, '-')           // em/en dashes -> hyphen
        .replace(/[…]/g, '...')               // ellipsis
        .replace(/[
