# ANVIL Government Contract Pipeline

Automated discovery, tracking, and application system for government workforce training contracts and WIOA ETPL (Eligible Training Provider List) applications.

## How It Works

```
                    GOVERNMENT SOURCES
                    ==================
        SAM.gov API          Grants.gov API        USASpending API
       (contracts)            (grants)           (competitive intel)
            |                    |                       |
            +--------------------+-----------------------+
                                 |
                         +-------v--------+
                         | bid-scanner.py |  <-- Scans all sources
                         |  (discovery)   |      Scores relevance 0-100
                         +-------+--------+      Filters by keywords,
                                 |               NAICS, geography, $$
                                 v
                    data/opportunities/scan-{date}.json
                                 |
                         +-------v--------+
                         | bid-tracker.py |  <-- Imports scan results
                         |  (pipeline)    |      Tracks lifecycle
                         +-------+--------+      Flags urgent deadlines
                                 |               Daily digest
                                 v
                      data/bid-tracker.json
                                 |
              +------------------+------------------+
              |                                     |
     +--------v-----------+              +----------v---------+
     | application-       |              | etpl-submitter.py  |
     | generator.py       |              |  (50-state ETPL)   |
     | (proposals)        |              +----------+---------+
     +--------+-----------+                         |
              |                                     v
              v                        data/etpl/etpl-tracker.json
  data/applications/                   data/etpl/applications/
  app-{id}-{type}-{date}.md           etpl-{state}-{date}.md
                                       data/etpl/followups/
  HUMAN REVIEWS & SUBMITS              followup-{state}-{n}-{date}.md
```

## Setup

```bash
# Install dependencies (just 2 packages)
pip install -r requirements.txt

# For SAM.gov scanning: get a free API key
# 1. Register at https://sam.gov
# 2. Go to Account Details > generate API key
# 3. Export it:
export SAM_GOV_API_KEY=your_key_here

# Grants.gov and USASpending require NO API keys
```

## Quick Start

```bash
# 1. Scan for opportunities
python bid-scanner.py

# 2. Import results into tracker and see digest
python bid-tracker.py

# 3. Generate an application for a promising opportunity
python application-generator.py --opportunity <ID>

# 4. Start the ETPL state-by-state campaign
python etpl-submitter.py --init
python etpl-submitter.py --priority
python etpl-submitter.py --generate CA
```

## Scripts

### bid-scanner.py -- Opportunity Discovery

Scans government procurement databases for workforce training opportunities relevant to ANVIL.

```bash
# Scan all sources
python bid-scanner.py

# SAM.gov only
python bid-scanner.py --source sam

# Grants.gov only (no API key needed)
python bid-scanner.py --source grants

# USASpending competitive intel
python bid-scanner.py --source spending

# Filter by state and time window
python bid-scanner.py --state CA --days 30

# Preview what would be queried
python bid-scanner.py --dry-run
```

**Sources:**
| Source | API Key | What It Finds |
|--------|---------|---------------|
| SAM.gov | Required (free) | Federal contract opportunities, RFPs, solicitations |
| Grants.gov | Not required | Federal grants, cooperative agreements |
| USASpending.gov | Not required | Who is winning contracts (competitive intel) |

**Scoring System (0-100):**
- Keyword match (30 pts): How many ANVIL keywords appear
- NAICS match (25 pts): Whether NAICS code matches our codes
- Dollar range (15 pts): Whether amount fits our capacity
- Geography (15 pts): Whether state is in priority list
- Deadline proximity (10 pts): Closer = higher urgency
- Set-aside match (5 pts): Small business set-asides

### bid-tracker.py -- Pipeline Management

Maintains a JSON database tracking every opportunity through its lifecycle.

```bash
# Import latest scan + show digest
python bid-tracker.py

# Import specific scan file
python bid-tracker.py --import scan-20260302.json

# Show daily digest
python bid-tracker.py --digest

# Email-formatted digest
python bid-tracker.py --email-digest

# List by status
python bid-tracker.py --status new
python bid-tracker.py --status preparing

# Update status
python bid-tracker.py --update abc123 --set-status reviewing --notes "Good fit"

# Urgent deadlines (within 14 days)
python bid-tracker.py --urgent

# Pipeline statistics
python bid-tracker.py --stats

# Export to CSV
python bid-tracker.py --export csv
```

**Status Lifecycle:**
```
new --> reviewing --> preparing --> submitted --> awarded
  |                                    |            |
  +--> watching                        +--> rejected
  +--> expired (auto, if deadline passes)
```

### application-generator.py -- Proposal Builder

Generates customized applications by merging ANVIL's WIOA documentation with opportunity-specific details.

```bash
# Full proposal from tracked opportunity
python application-generator.py --opportunity abc123

# Letter of interest (shorter)
python application-generator.py --opportunity abc123 --type letter-of-interest

# Capability statement (one page)
python application-generator.py --opportunity abc123 --type capability

# Manual opportunity (not in tracker)
python application-generator.py --manual \
  --title "CA Workforce Training RFP" \
  --agency "California EDD" \
  --amount 100000 \
  --state CA \
  --due-date 2026-04-15

# List available templates
python application-generator.py --list-templates
```

**Application Types:**
| Type | Length | Use Case |
|------|--------|----------|
| proposal | 2,500+ words | Full RFP response, grant applications |
| letter-of-interest | 500-800 words | Initial expressions, pre-RFP |
| capability | 300-400 words | One-pager for meetings, quick sends |

**What Gets Customized:**
- State and agency names
- Dollar amounts and participant counts
- Budget narrative scaled to opportunity size
- SOC codes from our reference
- Outcome targets from our framework
- Implementation timeline

**What Needs Human Review:**
- All [BRACKETED] fields (names, addresses, EIN, etc.)
- Budget numbers vs. solicitation requirements
- State-specific compliance requirements
- SOC code acceptance by specific state
- Contact information and signatures

### etpl-submitter.py -- 50-State ETPL Campaign

Tracks ETPL applications across all 50 states + DC, generates state-specific applications, and manages follow-up cadence.

```bash
# Initialize the state database
python etpl-submitter.py --init

# Show dashboard
python etpl-submitter.py

# Priority ranking (which states to apply to first)
python etpl-submitter.py --priority

# Generate state application
python etpl-submitter.py --generate CA
python etpl-submitter.py --generate TX

# Update status after submitting
python etpl-submitter.py --update CA --status applied --date 2026-03-15

# Check pending follow-ups
python etpl-submitter.py --followups

# Generate follow-up email
python etpl-submitter.py --generate-followup CA

# Record that follow-up was sent
python etpl-submitter.py --record-followup CA

# State details
python etpl-submitter.py --state-info CA

# All states list
python etpl-submitter.py --list
```

**Priority Scoring:**
States are ranked by a composite score considering:
- WIOA funding allocation (bigger budget = more opportunity)
- Market size (more participants available)
- Application difficulty (easier = faster win)
- Strategic relevance (AI/tech focus, displacement trends)

**Top 10 Priority States:**
1. California (massive market, #1 WIOA funding)
2. Texas (massive market, #2 WIOA funding)
3. New York (massive market, #3 WIOA funding)
4. Florida (large market, #4 WIOA funding)
5. Pennsylvania (large market, manufacturing displacement)
6. Ohio (large market, manufacturing + tech displacement)
7. Michigan (large market, auto industry AI displacement)
8. North Carolina (large market, growing tech sector)
9. Georgia (large market, Atlanta metro)
10. Illinois (large market, Chicago metro)

## Configuration

Edit `bid-config.json` to customize:

```json
{
  "naics_codes": { ... },       // Target NAICS codes
  "keywords": { ... },          // Search keywords (primary, secondary, exclude)
  "geography": { ... },         // Priority states
  "filters": { ... },           // Dollar ranges, date windows
  "scoring": { ... },           // Relevance scoring weights
  "sources": { ... },           // API endpoints and settings
  "anvil": { ... }              // ANVIL program details
}
```

## Data Directory Structure

```
data/
  opportunities/
    scan-20260302.json          # Daily scan results
  bid-tracker.json              # Master opportunity database
  applications/
    app-abc123-proposal-20260302.md
    app-def456-letter-of-interest-20260302.md
  etpl/
    etpl-tracker.json           # 50-state ETPL database
    applications/
      etpl-CA-20260302.md       # State-specific ETPL apps
      etpl-TX-20260302.md
    followups/
      followup-CA-1-20260315.md # Follow-up email drafts
  digests/
    digest-20260302.txt         # Daily digests
```

## API Reference

### SAM.gov (System for Award Management)
- **Endpoint:** `https://api.sam.gov/opportunities/v2/search`
- **Auth:** API key (free, register at sam.gov)
- **Docs:** https://open.gsa.gov/api/get-opportunities-public-api/
- **Rate limit:** ~1000 requests/day
- **Key params:** `postedFrom`, `postedTo`, `ncode` (NAICS), `title`, `state`, `status`

### Grants.gov
- **Endpoint:** `POST https://api.grants.gov/v1/api/search2`
- **Auth:** None required
- **Docs:** https://grants.gov/api/api-guide
- **Key params:** `keyword`, `oppStatuses`, `fundingCategories`, `agencies`

### USASpending.gov
- **Endpoint:** `POST https://api.usaspending.gov/api/v2/search/spending_by_award/`
- **Auth:** None required
- **Docs:** https://api.usaspending.gov/
- **Key params:** `keywords`, `time_period`, `award_type_codes`

## The Competitive Edge

Most WIOA training providers:
- Manually check 1-2 websites weekly
- Track opportunities in spreadsheets or email
- Write applications from scratch each time
- Apply to their home state only
- Miss deadlines because they forgot to check

ANVIL's automated pipeline:
- Scans 3+ federal databases daily
- Scores and ranks every opportunity automatically
- Maintains a persistent pipeline with status tracking
- Generates applications from pre-built templates in minutes
- Tracks all 50 states simultaneously
- Flags urgent deadlines automatically
- Creates follow-up cadence for ETPL applications

**Result:** One person can manage 100+ opportunities across all 50 states, vs. 5-10 manually.

## Important Notes

- **Human review required** before ANY submission. These scripts generate drafts, not final submissions.
- **SAM.gov API key** is free but required. Register at sam.gov.
- **Grants.gov and USASpending** require no API keys.
- **State ETPL contacts** change frequently. Verify before contacting.
- **Rate limiting** is built into all scripts (1 request/second default).
- All scripts use **respectful User-Agent headers**.
- This is **legal and ethical** -- we are searching public government procurement data.
- Scripts are designed to **gracefully degrade** if any source is unavailable.
