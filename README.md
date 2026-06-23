# SARE Analytics Intelligence Platform
### Wallet as a Service · Executive Reporting Suite

---

## What it does
A secure, hosted web application that transforms raw Excel/CSV financial reports into executive-grade intelligence:
- **SWOT Analysis** — tailored by role (CFO, CEO, Manager, Board, Auditor)
- **AI Key Insights** — Critical / Watch / Good severity system
- **Trend Charts** — Revenue, Wallets, Transactions, Compliance
- **Gap Checker** — Detects missing reports across all 42 standard WaaS categories
- **Report Builder** — 9 one-click executive reports + custom builder
- **Secure Login** — JWT authentication, invite-code registration, org-level access

---

## Demo credentials
| Role | Email | Password |
|------|-------|----------|
| Admin | admin@sare.co.ke | Sare@2024! |
| CFO | cfo@demo.com | Demo@1234 |
| CEO | ceo@demo.com | Demo@1234 |

**Invite code for new registrations:** `SARE2024`

---

## Run locally (30 seconds)
```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## Deploy to production

### Option 1: Render.com (FREE, recommended)
1. Push this folder to a GitHub repo
2. Go to https://render.com → New Web Service
3. Connect your repo
4. Set **Build command**: `npm install`
5. Set **Start command**: `node server.js`
6. Add environment variable: `JWT_SECRET=your-random-secret-here`
7. Deploy → you get a live HTTPS URL

### Option 2: Railway.app (FREE tier)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Option 3: Fly.io
```bash
npm install -g flyctl
fly launch
fly deploy
```

### Option 4: VPS / Ubuntu server
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Clone your repo
git clone YOUR_REPO_URL
cd sare-app
npm install

# Set environment variables
export JWT_SECRET=your-secure-random-secret
export PORT=3000

# Start with PM2 (auto-restart on crashes)
pm2 start server.js --name "sare-analytics"
pm2 save
pm2 startup

# Install nginx as reverse proxy (optional, for port 80)
sudo apt install nginx
# Configure nginx to proxy localhost:3000
```

### Option 5: Vercel (frontend-only mode)
The app works as a pure frontend without a server — just open `public/index.html` directly in any browser. All analysis runs through the Claude API directly from the browser.

---

## Environment variables
| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for JWT tokens | `sare-analytics-secret-key-2024-waas` |
| `PORT` | Server port | `3000` |

**Important:** Change `JWT_SECRET` to a random string in production:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Adding real users (production)
Replace the in-memory `users` array in `server.js` with a real database:
- **PostgreSQL** (recommended): use `pg` package
- **MongoDB**: use `mongoose`
- **SQLite** (simple): use `better-sqlite3`

---

## Security features
- Helmet.js (security headers)
- JWT tokens (8-hour expiry)
- bcrypt password hashing (10 rounds)
- Rate limiting (200 req/15min per IP)
- Invite-code-gated registration
- HTTPS enforced via hosting platform

---

## File structure
```
sare-app/
├── server.js          # Express backend (auth, file parse, API)
├── package.json       # Dependencies
├── README.md          # This file
└── public/
    └── index.html     # Complete frontend (login + full app)
```
