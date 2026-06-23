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
const fs = require('fs');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sare-analytics-secret-key-2024-waas';
const PORT = process.env.PORT || 3000;

// ── Databases ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db       = Datastore.create({ filename: path.join(__dirname, 'data', 'users.db'),       autoload: true });
const deptDb   = Datastore.create({ filename: path.join(__dirname, 'data', 'depts.db'),       autoload: true });
const rolesDb  = Datastore.create({ filename: path.join(__dirname, 'data', 'roles.db'),       autoload: true });

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  // Admin user
  if (await db.count({}) === 0) {
    await db.insert({ name:'SARE Admin', email:'admin@sare.africa', password:bcrypt.hashSync('@Sare 2026!',10), role:'admin', department:'Executive', accessLevel:'executive', org:'SARE Analytics', active:true, createdAt:new Date() });
    console.log('Admin seeded');
  }
  // Default departments
  if (await deptDb.count({}) === 0) {
    const depts = ['Executive','Finance','Operations','Compliance','Board'];
    for (const name of depts) await deptDb.insert({ name, description: name+' Department', color: {Executive:'#1B6FE4',Finance:'#0DAF6A',Operations:'#D97706',Compliance:'#E53E3E',Board:'#534AB7'}[name]||'#6B7280', createdAt:new Date() });
    console.log('Default departments seeded');
  }
  // Default roles
  if (await rolesDb.count({}) === 0) {
    const roles = [
      { name:'Admin',            accessLevel:'executive', canSeeAllDepts:true,  description:'Full platform access' },
      { name:'CEO',              accessLevel:'executive', canSeeAllDepts:true,  description:'All departments, executive view' },
      { name:'CFO',              accessLevel:'executive', canSeeAllDepts:true,  description:'All departments, financial focus' },
      { name:'Board Member',     accessLevel:'executive', canSeeAllDepts:true,  description:'Read-only executive summaries' },
      { name:'Department Head',  accessLevel:'senior',    canSeeAllDepts:false, description:'Own department full access' },
      { name:'Senior Manager',   accessLevel:'senior',    canSeeAllDepts:false, description:'Own department full access' },
      { name:'Manager',          accessLevel:'manager',   canSeeAllDepts:false, description:'Own department, no financials' },
      { name:'Senior Analyst',   accessLevel:'analyst',   canSeeAllDepts:false, description:'Own department reports only' },
      { name:'Analyst',          accessLevel:'analyst',   canSeeAllDepts:false, description:'Own department reports only' },
      { name:'Auditor',          accessLevel:'senior',    canSeeAllDepts:true,  description:'Read-only all departments' },
    ];
    for (const r of roles) await rolesDb.insert({ ...r, createdAt:new Date() });
    console.log('Default roles seeded');
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
    const user = await db.insert({ name, email:email.toLowerCase(), password:bcrypt.hashSync(password,10), role:'Analyst', department:'Operations', accessLevel:'analyst', org:org||'My Organisation', active:true, createdAt:new Date() });
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
  try {
    await deptDb.update({ _id:req.params.id }, { $set:{ name:req.body.name, description:req.body.description, color:req.body.color } });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/departments/:id', auth, adminOnly, async (req,res) => {
  try {
    const dept = await deptDb.findOne({ _id:req.params.id });
    if (!dept) return res.status(404).json({ error:'Department not found' });
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
  try {
    await rolesDb.update({ _id:req.params.id }, { $set:{ name:req.body.name, accessLevel:req.body.accessLevel, canSeeAllDepts:req.body.canSeeAllDepts, description:req.body.description } });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/roles/:id', auth, adminOnly, async (req,res) => {
  try {
    const role = await rolesDb.findOne({ _id:req.params.id });
    if (!role) return res.status(404).json({ error:'Role not found' });
    const inUse = await db.count({ role:role.name });
    if (inUse > 0) return res.status(400).json({ error:`Cannot delete — ${inUse} user(s) have this role` });
    await rolesDb.remove({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Users (admin) ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req,res) => {
  try { res.json((await db.find({},{ password:0 })).map(u=>({ ...u, id:u._id }))); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/users', auth, adminOnly, async (req,res) => {
  try {
    const { name, email, password, role, department, accessLevel, org } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error:'Name, email, password required' });
    if (await db.findOne({ email:{ $regex:new RegExp(`^${email}$`,'i') } }))
      return res.status(409).json({ error:'Email already exists' });
    const roleDoc = await rolesDb.findOne({ name:role });
    const user = await db.insert({ name, email:email.toLowerCase(), password:bcrypt.hashSync(password,10), role:role||'Analyst', department:department||'Operations', accessLevel:accessLevel||(roleDoc?.accessLevel)||'analyst', org:org||'SARE Analytics', active:true, createdAt:new Date() });
    res.json({ ...user, id:user._id, password:undefined });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req,res) => {
  try {
    const { name, email, role, department, accessLevel, org, active, password } = req.body;
    const update = { name, email:email?.toLowerCase(), role, department, accessLevel, org, active };
    if (password && password.length >= 8) update.password = bcrypt.hashSync(password,10);
    await db.update({ _id:req.params.id }, { $set:update });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req,res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error:"Can't delete yourself" });
    await db.remove({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Department members (non-admin can see own dept) ───────────────────────────
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

app.get('/api/health', (req,res) => res.json({ status:'ok', version:'3.0.0', service:'SARE Analytics Intelligence' }));
app.get('/{*path}', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`SARE Analytics v3 running on http://localhost:${PORT}`));
