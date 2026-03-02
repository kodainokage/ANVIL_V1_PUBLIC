# ANVIL

**AI took your job. Now put AI in YOUR hands.**

ANVIL trains people who lost their jobs to AI. In 7 days, they learn to use AI tools to start earning money helping their neighbors -- finding unclaimed benefits, fighting overcharged medical bills, keeping small businesses out of compliance trouble.

Not a bootcamp. Not a resume workshop. A sprint that ends with real clients and real income.

---

## The Problem

AI is eliminating millions of jobs -- call centers, data entry, admin, customer service. The standard advice is "learn to code" or "go back to school for 6 months." That doesn't work when rent is due next month.

## What ANVIL Actually Does

We train displaced workers in 3 niches where AI does the heavy lifting but humans are still legally and ethically required:

**Benefits Navigation** -- Help people find SSDI, SNAP, Medicaid, tax credits they're missing. AI researches eligibility, you verify and file. Americans leave $140B in unclaimed benefits on the table every year.

**Medical Billing Advocacy** -- Audit hospital bills for errors (80% have them). AI flags the overcharges, you call the provider and negotiate. Average savings: $3,200 per client.

**Small Business Compliance** -- Keep shops and restaurants legal. AI tracks permits, licenses, deadlines. You file the paperwork and explain it in plain English. $12B in avoidable penalties per year.

The training is 7 days. It's free for participants. Graduates start getting clients within 2 weeks.

---

## Run It Yourself

```bash
git clone https://github.com/kodainokage/ANVIL_V1_PUBLIC.git
cd ANVIL_V1_PUBLIC
npm install
npm start
```

Open `http://localhost:10000`. Done.

**Requirements:** Node.js 18+. That's it. One dependency (Express). No database. No build step. No Docker. No env vars needed to start.

### Deploy for $0

Fork this repo, connect it to [Render.com](https://render.com), and the included `render.yaml` handles everything. Free tier. Set an `API_KEY` env var for your admin dashboard and you're live.

Works on any Node.js host -- Railway, Fly.io, Heroku, DigitalOcean, whatever you have.

---

## What's In The Box

```
server.js                 -- The entire backend. One file. 812 lines.
package.json              -- One dependency: express.
render.yaml               -- One-click deploy config.

site/
  index.html              -- Landing page with 8-question career quiz
  learn.html              -- Curriculum viewer (text-to-speech built in)
  certificate.html        -- Generates certs for graduates
  admin.html              -- Dashboard: submissions, analytics, exports
  marketing.html          -- Marketing ops dashboard
  about.html              -- About page
  terms/privacy/          -- Legal pages (CCPA compliant)
  disclaimer.html         -- Required disclaimers
  accessibility.html      -- WCAG 2.1 AA statement
  sw.js + manifest.json   -- PWA support (installable, works offline)

curriculum/
  sprint-7day.md          -- The full training program, day by day

playbooks/                -- Guides graduates actually use with clients
  benefits-navigation.md
  medical-billing.md
  small-biz-compliance.md

templates/                -- Fill-in-the-blank deliverables for client work
  benefits-report-template.md
  medical-bill-audit-template.md
  compliance-package-template.md

docs/                     -- Pitch decks, walkthroughs, onboarding guides
wioa/                     -- Everything for WIOA/ETPL government approval
scripts/                  -- Python tools: bid scanner, ETPL automation
tests/                    -- Security audit + deployment readiness checks
data/                     -- Runtime storage (auto-created, gitignored)
```

---

## For Workforce Boards & Government Partners

ANVIL is built to align with WIOA (Workforce Innovation and Opportunity Act). The `wioa/` folder contains ready-to-submit documents:

- ETPL application template
- Program description for state reviewers
- Budget narrative with cost justification
- Outcomes tracking methodology
- Compliance checklist
- SOC codes (21-1093, 43-4061, 21-1094, 13-2011, 43-3011, 43-9041, 13-1041, 13-1199, 43-4199)
- Partnership agreement templates

If you run a workforce development board and want to pilot this, reach out: **partnerships@getanvil.co**

---

## For Nonprofits, Libraries & Community Orgs

You can host a free 2-hour intro workshop. We provide the materials. You provide the room and help spread the word. Typical turnout is 20-30 people, half enroll in the full 7-day program.

No cost to your org. The full breakdown is in `docs/onboarding-guide.md`.

---

## For Developers & Agents

If you're working on this codebase, here's what you need to know:

**Backend:** `server.js` is the entire API. Read it first. It handles quiz submissions, analytics, referrals, testimonials, a graduate directory, admin CRUD, CSV export, backups, and a content calendar endpoint. All in one file, all with built-in rate limiting, input sanitization, and security headers.

**Frontend:** Plain HTML + vanilla JS. No React. No build tools. Edit and refresh. Every page is self-contained.

**Data:** JSON files in `data/` (auto-created on boot). No database to provision. Migrate to Postgres if you hit 1,000+ submissions.

**Security:** Rate limiting (10 req/15min/IP), XSS sanitization, CORS lockdown, API key auth on admin routes, atomic file writes. Full audit in `tests/HARDENING-AUDIT.md`.

**Rules if you're contributing:**
- Don't split `server.js` until it hits 2,000 lines. Single-file is intentional.
- Don't add npm dependencies without a damn good reason. 1 dep is a feature.
- All input goes through `sanitize()`. All admin routes go through `requireApiKey()`.
- No frontend frameworks. No CSS preprocessors. No build steps.

### API Quick Reference

**Public endpoints** (no auth):

| Method | Route | What it does |
|--------|-------|-------------|
| GET | `/health` | Health check |
| POST | `/api/quiz-submit` | Submit career quiz |
| GET | `/api/results/:id` | Get quiz results (public-safe fields only) |
| POST | `/api/analytics/event` | Log analytics (hashed fingerprint, no PII) |
| POST | `/api/referrals/track` | Track a referral visit |
| GET | `/api/referrals/leaderboard` | Top 10 referrers |
| GET | `/api/referrals/status/:code` | Referral count |
| POST | `/api/testimonials` | Submit testimonial |
| GET | `/api/testimonials` | Approved testimonials |
| POST | `/api/graduates` | Join graduate directory |

**Admin endpoints** (require `Authorization: Bearer <API_KEY>`):

| Method | Route | What it does |
|--------|-------|-------------|
| GET | `/api/submissions` | All quiz submissions |
| GET | `/api/admin/analytics` | Analytics summary |
| GET | `/api/admin/referrals` | Full referral data |
| GET | `/api/admin/curriculum-progress` | Learning progress stats |
| GET | `/api/admin/testimonials` | All testimonials (inc. pending) |
| POST | `/api/admin/testimonials/:id/approve` | Approve a testimonial |
| GET | `/api/admin/export/csv` | Download submissions as CSV |
| GET | `/api/content-calendar` | Content calendar as JSON |
| POST | `/api/admin/backup` | Full data backup download |

---

## Fork It

If you want to run your own version:

1. Update the HTML in `site/` with your brand and contact info
2. Swap `render.yaml` to point at your repo
3. Customize `curriculum/sprint-7day.md` for your niches
4. Fill in `wioa/` docs with your org's details
5. Set `API_KEY` and `ALLOWED_ORIGIN` in your deploy environment

MIT licensed. Take it, build on it, run it for your community.

---

## Contact

**hello@getanvil.co** -- General
**partnerships@getanvil.co** -- Workforce boards, employers, community orgs
