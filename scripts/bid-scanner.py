#!/usr/bin/env python3
"""
ANVIL Bid Scanner -- Automated Government Contract/Grant Discovery

Scans SAM.gov, Grants.gov, and USASpending.gov for workforce development
opportunities relevant to ANVIL's WIOA training programs.

Usage:
    python bid-scanner.py                    # Scan all enabled sources
    python bid-scanner.py --source sam       # SAM.gov only
    python bid-scanner.py --source grants    # Grants.gov only
    python bid-scanner.py --source spending  # USASpending.gov only
    python bid-scanner.py --days 30          # Override due date window
    python bid-scanner.py --state CA         # Filter by state
    python bid-scanner.py --dry-run          # Show what would be queried

Output: data/opportunities/scan-{date}.json
"""

import argparse
import json
import os
import sys
import time
import hashlib
from datetime import datetime, timedelta
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' package required. Run: pip install requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
CONFIG_PATH = SCRIPT_DIR / "bid-config.json"
OUTPUT_DIR = PROJECT_DIR / "data" / "opportunities"
TRACKER_PATH = PROJECT_DIR / "data" / "bid-tracker.json"

USER_AGENT = "ANVIL-BidScanner/1.0 (workforce training provider; hello@getanvil.co)"
REQUEST_TIMEOUT = 30  # seconds

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_config():
    """Load bid-config.json, exit with clear message if missing."""
    if not CONFIG_PATH.exists():
        print(f"ERROR: Config file not found at {CONFIG_PATH}")
        print("Run from the anvil/scripts/ directory or create bid-config.json")
        sys.exit(1)
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


def rate_limit(seconds=1.0):
    """Sleep to respect rate limits."""
    time.sleep(seconds)


def generate_opportunity_id(source, title, notice_id=""):
    """Generate a stable hash ID for deduplication."""
    raw = f"{source}:{notice_id or title}".lower().strip()
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def score_opportunity(opp, config):
    """
    Score an opportunity 0-100 based on relevance to ANVIL.

    Factors:
    - keyword_match (0-30): How many of our keywords appear in title/description
    - naics_match (0-25): Whether NAICS code matches our target codes
    - dollar_range_fit (0-15): Whether amount is in our preferred range
    - geography_priority (0-15): Whether state is in our priority list
    - deadline_proximity (0-10): Closer deadlines score higher (urgency)
    - set_aside_match (0-5): Whether set-aside type matches our eligibility
    """
    weights = config.get("scoring", {}).get("weights", {})
    score = 0.0

    title_desc = (opp.get("title", "") + " " + opp.get("description", "")).lower()

    # Keyword match (0-30)
    kw_weight = weights.get("keyword_match", 30)
    primary_kw = config.get("keywords", {}).get("primary", [])
    secondary_kw = config.get("keywords", {}).get("secondary", [])
    exclude_kw = config.get("keywords", {}).get("exclude", [])

    # Check for exclusions first
    for ekw in exclude_kw:
        if ekw.lower() in title_desc:
            return 0  # Hard exclude

    primary_hits = sum(1 for kw in primary_kw if kw.lower() in title_desc)
    secondary_hits = sum(1 for kw in secondary_kw if kw.lower() in title_desc)
    total_kw = len(primary_kw) + len(secondary_kw)
    if total_kw > 0:
        # Primary keywords weighted 2x
        kw_score = ((primary_hits * 2) + secondary_hits) / (len(primary_kw) * 2 + len(secondary_kw))
        score += min(kw_score * kw_weight, kw_weight)

    # NAICS match (0-25)
    naics_weight = weights.get("naics_match", 25)
    opp_naics = str(opp.get("naics_code", ""))
    primary_naics = [n["code"] for n in config.get("naics_codes", {}).get("primary", [])]
    secondary_naics = [n["code"] for n in config.get("naics_codes", {}).get("secondary", [])]

    if opp_naics in primary_naics:
        score += naics_weight
    elif opp_naics in secondary_naics:
        score += naics_weight * 0.6
    elif opp_naics and any(opp_naics.startswith(n[:4]) for n in primary_naics):
        score += naics_weight * 0.3

    # Dollar range fit (0-15)
    dollar_weight = weights.get("dollar_range_fit", 15)
    amount = opp.get("dollar_amount")
    if amount and amount > 0:
        filters = config.get("filters", {}).get("dollar_amount", {})
        pmin = filters.get("preferred_min", 25000)
        pmax = filters.get("preferred_max", 250000)
        abs_min = filters.get("min", 10000)
        abs_max = filters.get("max", 500000)

        if pmin <= amount <= pmax:
            score += dollar_weight
        elif abs_min <= amount <= abs_max:
            score += dollar_weight * 0.5
        # Outside range gets 0

    # Geography priority (0-15)
    geo_weight = weights.get("geography_priority", 15)
    opp_state = opp.get("state", "").upper()
    priority_states = [s["state"] for s in config.get("geography", {}).get("priority_states", [])]

    if opp_state in priority_states:
        rank = priority_states.index(opp_state)
        # Top state gets full weight, 10th gets 50%
        geo_score = 1.0 - (rank * 0.05)
        score += geo_weight * geo_score
    elif opp_state:
        score += geo_weight * 0.2  # Non-priority but has a state

    # Deadline proximity (0-10)
    deadline_weight = weights.get("deadline_proximity", 10)
    due_date_str = opp.get("due_date", "")
    if due_date_str:
        try:
            due_date = datetime.strptime(due_date_str, "%Y-%m-%d")
            days_until = (due_date - datetime.now()).days
            if 0 < days_until <= 14:
                score += deadline_weight  # URGENT = max score
            elif 14 < days_until <= 30:
                score += deadline_weight * 0.7
            elif 30 < days_until <= 60:
                score += deadline_weight * 0.4
        except ValueError:
            pass

    # Set-aside match (0-5)
    sa_weight = weights.get("set_aside_match", 5)
    opp_sa = opp.get("set_aside", "")
    target_sa = config.get("filters", {}).get("set_aside_types", [])
    if opp_sa and opp_sa in target_sa:
        score += sa_weight
    elif not opp_sa:
        score += sa_weight * 0.5  # Unrestricted = partially good

    return round(score, 1)


def format_currency(amount):
    """Format a number as currency."""
    if amount is None:
        return "N/A"
    if amount >= 1_000_000:
        return f"${amount/1_000_000:.1f}M"
    elif amount >= 1_000:
        return f"${amount/1_000:.0f}K"
    return f"${amount:,.0f}"


# ---------------------------------------------------------------------------
# SAM.gov Scanner
# ---------------------------------------------------------------------------

class SAMGovScanner:
    """
    Scan SAM.gov for contract opportunities using the public API.

    API docs: https://open.gsa.gov/api/get-opportunities-public-api/
    Endpoint: https://api.sam.gov/opportunities/v2/search
    Auth: API key (free, register at sam.gov)
    Rate limit: ~1 req/sec recommended
    """

    BASE_URL = "https://api.sam.gov/opportunities/v2/search"

    def __init__(self, config):
        self.config = config
        self.api_key = os.environ.get(
            config["sources"]["sam_gov"].get("api_key_env_var", "SAM_GOV_API_KEY"),
            ""
        )
        self.rate_limit = config["sources"]["sam_gov"].get("rate_limit_per_second", 1)

    def is_available(self):
        """Check if SAM.gov scanning is possible."""
        if not self.config["sources"]["sam_gov"].get("enabled", True):
            return False, "SAM.gov scanning disabled in config"
        if not self.api_key:
            return False, (
                "SAM.gov API key not set. "
                "Register at https://sam.gov, go to Account Details, generate API key. "
                "Then: export SAM_GOV_API_KEY=your_key_here"
            )
        return True, "OK"

    def scan(self, days=60, state=None):
        """
        Scan SAM.gov for workforce development opportunities.

        Returns list of normalized opportunity dicts.
        """
        available, msg = self.is_available()
        if not available:
            print(f"  [SAM.gov] SKIP: {msg}")
            return []

        opportunities = []
        now = datetime.now()
        posted_from = (now - timedelta(days=days)).strftime("%m/%d/%Y")
        posted_to = now.strftime("%m/%d/%Y")

        # Build queries: one per primary NAICS code + one keyword-based
        queries = []

        # NAICS-based queries
        for naics in self.config.get("naics_codes", {}).get("primary", []):
            params = {
                "api_key": self.api_key,
                "postedFrom": posted_from,
                "postedTo": posted_to,
                "ncode": naics["code"],
                "limit": 100,
                "offset": 0,
                "status": "active",
            }
            if state:
                params["state"] = state
            queries.append(("NAICS " + naics["code"], params))

        # Keyword-based queries for primary keywords
        for kw in self.config.get("keywords", {}).get("primary", [])[:5]:
            params = {
                "api_key": self.api_key,
                "postedFrom": posted_from,
                "postedTo": posted_to,
                "title": kw,
                "limit": 100,
                "offset": 0,
                "status": "active",
            }
            if state:
                params["state"] = state
            queries.append(("keyword '" + kw + "'", params))

        seen_ids = set()
        total_queries = len(queries)

        for i, (label, params) in enumerate(queries, 1):
            print(f"  [SAM.gov] Query {i}/{total_queries}: {label}...")

            try:
                resp = requests.get(
                    self.BASE_URL,
                    params=params,
                    headers={"User-Agent": USER_AGENT},
                    timeout=REQUEST_TIMEOUT,
                )

                if resp.status_code == 200:
                    data = resp.json()
                    total = data.get("totalRecords", 0)
                    opps = data.get("opportunitiesData", [])
                    print(f"           Found {total} results, processing {len(opps)}")

                    for opp in opps:
                        notice_id = opp.get("noticeId", "")
                        if notice_id in seen_ids:
                            continue
                        seen_ids.add(notice_id)

                        normalized = self._normalize(opp)
                        if normalized:
                            opportunities.append(normalized)

                elif resp.status_code == 401:
                    print(f"           ERROR: Invalid API key (401 Unauthorized)")
                    print(f"           Verify your SAM_GOV_API_KEY is correct")
                    break
                elif resp.status_code == 429:
                    print(f"           RATE LIMITED: Waiting 60 seconds...")
                    time.sleep(60)
                else:
                    print(f"           HTTP {resp.status_code}: {resp.text[:200]}")

            except requests.exceptions.Timeout:
                print(f"           TIMEOUT: SAM.gov did not respond in {REQUEST_TIMEOUT}s")
            except requests.exceptions.ConnectionError:
                print(f"           CONNECTION ERROR: Could not reach SAM.gov")
            except requests.exceptions.RequestException as e:
                print(f"           ERROR: {str(e)[:200]}")

            rate_limit(self.rate_limit)

        print(f"  [SAM.gov] Total unique opportunities: {len(opportunities)}")
        return opportunities

    def _normalize(self, raw):
        """Normalize a SAM.gov opportunity record to our standard format."""
        try:
            # Extract award amount if available
            award = raw.get("award", {}) or {}
            amount = None
            if isinstance(award, dict):
                amount = award.get("amount")
                if amount:
                    try:
                        amount = float(amount)
                    except (ValueError, TypeError):
                        amount = None

            # Extract place of performance
            pop = raw.get("placeOfPerformance", {}) or {}
            state_code = ""
            if isinstance(pop, dict):
                state_obj = pop.get("state", {}) or {}
                if isinstance(state_obj, dict):
                    state_code = state_obj.get("code", "")
                elif isinstance(state_obj, str):
                    state_code = state_obj

            # Extract response deadline
            due_date = ""
            rdl = raw.get("responseDeadLine") or raw.get("archiveDate") or ""
            if rdl:
                try:
                    if "T" in str(rdl):
                        due_date = str(rdl).split("T")[0]
                    elif "/" in str(rdl):
                        parts = str(rdl).split("/")
                        if len(parts) == 3:
                            due_date = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                    else:
                        due_date = str(rdl)[:10]
                except Exception:
                    due_date = str(rdl)[:10]

            # Extract contact info
            contacts = raw.get("pointOfContact", []) or []
            contact_name = ""
            contact_email = ""
            if contacts and isinstance(contacts, list):
                primary = contacts[0] if contacts else {}
                contact_name = primary.get("fullName", "") or primary.get("name", "")
                contact_email = primary.get("email", "")

            notice_id = raw.get("noticeId", "")
            title = raw.get("title", "Unknown")

            return {
                "id": generate_opportunity_id("sam", title, notice_id),
                "source": "sam.gov",
                "source_id": notice_id,
                "title": title,
                "solicitation_number": raw.get("solicitationNumber", ""),
                "type": raw.get("type", ""),
                "posted_date": raw.get("postedDate", ""),
                "due_date": due_date,
                "dollar_amount": amount,
                "agency": raw.get("organizationName", "") or raw.get("departmentName", ""),
                "naics_code": raw.get("naicsCode", ""),
                "state": state_code,
                "set_aside": raw.get("typeOfSetAside", ""),
                "set_aside_desc": raw.get("typeOfSetAsideDescription", ""),
                "description": raw.get("description", ""),
                "link": f"https://sam.gov/opp/{notice_id}/view" if notice_id else "",
                "contact_name": contact_name,
                "contact_email": contact_email,
                "active": raw.get("active", "") == "Yes",
                "raw_source": "sam_gov",
                "scan_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "match_score": 0,  # Scored later
            }
        except Exception as e:
            print(f"           Warning: Could not parse opportunity: {str(e)[:100]}")
            return None


# ---------------------------------------------------------------------------
# Grants.gov Scanner
# ---------------------------------------------------------------------------

class GrantsGovScanner:
    """
    Scan Grants.gov for workforce development grants.

    API docs: https://grants.gov/api/api-guide
    Endpoint: POST https://api.grants.gov/v1/api/search2
    Auth: None required
    """

    SEARCH_URL = "https://api.grants.gov/v1/api/search2"
    DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity"

    def __init__(self, config):
        self.config = config
        self.rate_limit_sec = config["sources"]["grants_gov"].get("rate_limit_per_second", 1)

    def is_available(self):
        """Grants.gov API requires no auth -- always available if enabled."""
        if not self.config["sources"]["grants_gov"].get("enabled", True):
            return False, "Grants.gov scanning disabled in config"
        return True, "OK"

    def scan(self, days=60, state=None):
        """
        Scan Grants.gov for workforce development grants.

        Returns list of normalized opportunity dicts.
        """
        available, msg = self.is_available()
        if not available:
            print(f"  [Grants.gov] SKIP: {msg}")
            return []

        opportunities = []
        seen_ids = set()

        # Build keyword queries
        search_terms = [
            "workforce development training",
            "WIOA workforce",
            "dislocated worker training",
            "workforce innovation opportunity act",
            "job training retraining",
            "AI workforce development",
            "career services training provider",
        ]

        total_queries = len(search_terms)

        for i, keyword in enumerate(search_terms, 1):
            print(f"  [Grants.gov] Query {i}/{total_queries}: '{keyword}'...")

            payload = {
                "keyword": keyword,
                "oppStatuses": "posted|forecasted",
                "rows": 50,
                "startRecordNum": 0,
            }

            # Add funding category filter for education/employment
            # ED = Education, ELT = Employment, Labor and Training
            # HU = Human Resources
            if "workforce" in keyword.lower() or "WIOA" in keyword:
                payload["fundingCategories"] = "ELT"

            try:
                resp = requests.post(
                    self.SEARCH_URL,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                    timeout=REQUEST_TIMEOUT,
                )

                if resp.status_code == 200:
                    data = resp.json()

                    if data.get("errorcode") and data["errorcode"] != 0:
                        print(f"           API Error: {data.get('msg', 'Unknown')}")
                        rate_limit(self.rate_limit_sec)
                        continue

                    hits = data.get("data", {}).get("oppHits", [])
                    total = data.get("data", {}).get("hitCount", 0)
                    print(f"           Found {total} results, processing {len(hits)}")

                    for hit in hits:
                        opp_id = hit.get("id", "")
                        if opp_id in seen_ids:
                            continue
                        seen_ids.add(opp_id)

                        normalized = self._normalize(hit)
                        if normalized:
                            # Filter by due date window
                            if normalized["due_date"]:
                                try:
                                    due = datetime.strptime(normalized["due_date"], "%Y-%m-%d")
                                    if due < datetime.now():
                                        continue  # Past due
                                    if due > datetime.now() + timedelta(days=days):
                                        continue  # Too far out
                                except ValueError:
                                    pass

                            opportunities.append(normalized)
                else:
                    print(f"           HTTP {resp.status_code}: {resp.text[:200]}")

            except requests.exceptions.Timeout:
                print(f"           TIMEOUT: Grants.gov did not respond in {REQUEST_TIMEOUT}s")
            except requests.exceptions.ConnectionError:
                print(f"           CONNECTION ERROR: Could not reach Grants.gov")
            except requests.exceptions.RequestException as e:
                print(f"           ERROR: {str(e)[:200]}")

            rate_limit(self.rate_limit_sec)

        print(f"  [Grants.gov] Total unique opportunities: {len(opportunities)}")
        return opportunities

    def _normalize(self, raw):
        """Normalize a Grants.gov opportunity to our standard format."""
        try:
            opp_id = str(raw.get("id", ""))
            opp_number = raw.get("number", "")
            title = raw.get("title", "Unknown")

            # Parse dates (Grants.gov uses MM/dd/yyyy or yyyy-MM-dd)
            close_date = raw.get("closeDate", "") or ""
            open_date = raw.get("openDate", "") or ""

            due_date = self._parse_date(close_date)
            posted_date = self._parse_date(open_date)

            return {
                "id": generate_opportunity_id("grants", title, opp_id),
                "source": "grants.gov",
                "source_id": opp_id,
                "title": title,
                "solicitation_number": opp_number,
                "type": raw.get("docType", "grant"),
                "posted_date": posted_date,
                "due_date": due_date,
                "dollar_amount": None,  # Grants.gov search doesn't return amounts
                "agency": raw.get("agencyName", "") or raw.get("agencyCode", ""),
                "naics_code": "",  # Grants use CFDA/ALN, not NAICS
                "aln": ", ".join(raw.get("alnList", []) or []),
                "state": "",  # Grants.gov doesn't filter by state in search
                "set_aside": "",
                "set_aside_desc": "",
                "description": "",  # Would need fetchOpportunity call
                "link": f"https://www.grants.gov/search-results-detail/{opp_id}" if opp_id else "",
                "contact_name": "",
                "contact_email": "",
                "active": raw.get("oppStatus", "").lower() in ("posted", "forecasted"),
                "raw_source": "grants_gov",
                "scan_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "match_score": 0,
            }
        except Exception as e:
            print(f"           Warning: Could not parse grant: {str(e)[:100]}")
            return None

    def _parse_date(self, date_str):
        """Try multiple date formats and return YYYY-MM-DD."""
        if not date_str:
            return ""
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%m-%d-%Y"):
            try:
                return datetime.strptime(str(date_str).split("T")[0].strip(), fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        return str(date_str)[:10]


# ---------------------------------------------------------------------------
# USASpending.gov Scanner (Competitive Intelligence)
# ---------------------------------------------------------------------------

class USASpendingScanner:
    """
    Scan USASpending.gov to see who is winning workforce training contracts.

    This is competitive intelligence, not bid opportunities. Shows:
    - Which organizations win WIOA/workforce contracts
    - What dollar amounts are typical
    - Which agencies are awarding

    API docs: https://api.usaspending.gov/
    Auth: None required
    """

    BASE_URL = "https://api.usaspending.gov/api/v2"

    def __init__(self, config):
        self.config = config
        self.rate_limit_sec = config["sources"]["usaspending"].get("rate_limit_per_second", 1)

    def is_available(self):
        """USASpending API requires no auth."""
        if not self.config["sources"]["usaspending"].get("enabled", True):
            return False, "USASpending scanning disabled in config"
        return True, "OK"

    def scan(self, days=365, state=None):
        """
        Search recent workforce training awards for competitive intelligence.

        Returns list of award records (not opportunities to bid on).
        """
        available, msg = self.is_available()
        if not available:
            print(f"  [USASpending] SKIP: {msg}")
            return []

        awards = []

        # Search for recent awards in our NAICS codes
        naics_codes = [n["code"] for n in self.config.get("naics_codes", {}).get("primary", [])]
        naics_codes.extend([n["code"] for n in self.config.get("naics_codes", {}).get("secondary", [])[:3]])

        keywords = ["workforce training", "WIOA", "dislocated worker"]

        now = datetime.now()
        start_date = (now - timedelta(days=days)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        # Award search by keyword
        for kw in keywords:
            print(f"  [USASpending] Searching awards: '{kw}'...")

            payload = {
                "filters": {
                    "keywords": [kw],
                    "time_period": [
                        {"start_date": start_date, "end_date": end_date}
                    ],
                    "award_type_codes": ["02", "03", "04", "05"],  # Grants
                },
                "fields": [
                    "Award ID",
                    "Recipient Name",
                    "Award Amount",
                    "Description",
                    "Start Date",
                    "End Date",
                    "Awarding Agency",
                    "Awarding Sub Agency",
                    "recipient_id",
                    "Place of Performance State Code",
                ],
                "limit": 50,
                "page": 1,
                "sort": "Award Amount",
                "order": "desc",
            }

            if state:
                payload["filters"]["place_of_performance_locations"] = [
                    {"country": "USA", "state": state}
                ]

            try:
                resp = requests.post(
                    f"{self.BASE_URL}/search/spending_by_award/",
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                    timeout=REQUEST_TIMEOUT,
                )

                if resp.status_code == 200:
                    data = resp.json()
                    results = data.get("results", [])
                    total = data.get("page_metadata", {}).get("total", 0)
                    print(f"           Found {total} awards, processing {len(results)}")

                    for result in results:
                        award = {
                            "source": "usaspending.gov",
                            "type": "competitive_intel",
                            "award_id": result.get("Award ID", ""),
                            "recipient": result.get("Recipient Name", ""),
                            "amount": result.get("Award Amount"),
                            "description": result.get("Description", ""),
                            "start_date": result.get("Start Date", ""),
                            "end_date": result.get("End Date", ""),
                            "agency": result.get("Awarding Agency", ""),
                            "sub_agency": result.get("Awarding Sub Agency", ""),
                            "state": result.get("Place of Performance State Code", ""),
                            "keyword_matched": kw,
                            "scan_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        }
                        awards.append(award)

                else:
                    print(f"           HTTP {resp.status_code}: {resp.text[:200]}")

            except requests.exceptions.Timeout:
                print(f"           TIMEOUT: USASpending did not respond in {REQUEST_TIMEOUT}s")
            except requests.exceptions.ConnectionError:
                print(f"           CONNECTION ERROR: Could not reach USASpending.gov")
            except requests.exceptions.RequestException as e:
                print(f"           ERROR: {str(e)[:200]}")

            rate_limit(self.rate_limit_sec)

        print(f"  [USASpending] Total award records: {len(awards)}")
        return awards


# ---------------------------------------------------------------------------
# Main Scanner Orchestrator
# ---------------------------------------------------------------------------

def run_scan(args, config):
    """Execute the scan pipeline."""
    print("=" * 70)
    print(f"ANVIL BID SCANNER -- {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    if args.dry_run:
        print("\n[DRY RUN] Would query the following sources:")
        for source_name, source_cfg in config["sources"].items():
            status = "ENABLED" if source_cfg.get("enabled") else "DISABLED"
            auth = "API key required" if source_cfg.get("requires_api_key") else "No auth"
            print(f"  - {source_name}: {status} ({auth})")
        print(f"\nDays window: {args.days}")
        print(f"State filter: {args.state or 'ALL'}")
        print(f"NAICS codes: {[n['code'] for n in config['naics_codes']['primary']]}")
        print(f"Keywords: {config['keywords']['primary'][:5]}")
        return

    all_opportunities = []
    competitive_intel = []

    # SAM.gov
    if args.source in (None, "sam"):
        print(f"\n--- SAM.gov Contract Opportunities ---")
        scanner = SAMGovScanner(config)
        opps = scanner.scan(days=args.days, state=args.state)
        all_opportunities.extend(opps)

    # Grants.gov
    if args.source in (None, "grants"):
        print(f"\n--- Grants.gov Grant Opportunities ---")
        scanner = GrantsGovScanner(config)
        opps = scanner.scan(days=args.days, state=args.state)
        all_opportunities.extend(opps)

    # USASpending.gov (competitive intel)
    if args.source in (None, "spending"):
        print(f"\n--- USASpending.gov Competitive Intelligence ---")
        scanner = USASpendingScanner(config)
        awards = scanner.scan(days=365, state=args.state)
        competitive_intel.extend(awards)

    # Score all opportunities
    print(f"\n--- Scoring {len(all_opportunities)} opportunities ---")
    min_score = config.get("scoring", {}).get("minimum_score", 20)

    for opp in all_opportunities:
        opp["match_score"] = score_opportunity(opp, config)

    # Filter by minimum score
    scored = [o for o in all_opportunities if o["match_score"] >= min_score]
    filtered_out = len(all_opportunities) - len(scored)

    # Sort by score descending
    scored.sort(key=lambda x: x["match_score"], reverse=True)

    print(f"  Passed minimum score ({min_score}): {len(scored)}")
    print(f"  Filtered out: {filtered_out}")

    # Flag urgent deadlines
    urgent_days = config.get("filters", {}).get("urgent_deadline_days", 14)
    urgent_count = 0
    for opp in scored:
        if opp.get("due_date"):
            try:
                due = datetime.strptime(opp["due_date"], "%Y-%m-%d")
                days_left = (due - datetime.now()).days
                opp["days_until_due"] = days_left
                opp["urgent"] = 0 < days_left <= urgent_days
                if opp["urgent"]:
                    urgent_count += 1
            except ValueError:
                opp["days_until_due"] = None
                opp["urgent"] = False
        else:
            opp["days_until_due"] = None
            opp["urgent"] = False

    # Save results
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y%m%d")
    output_file = OUTPUT_DIR / f"scan-{date_str}.json"

    results = {
        "scan_metadata": {
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sources_queried": args.source or "all",
            "days_window": args.days,
            "state_filter": args.state,
            "total_found": len(all_opportunities),
            "passed_scoring": len(scored),
            "filtered_out": filtered_out,
            "urgent_deadlines": urgent_count,
            "minimum_score": min_score,
        },
        "opportunities": scored,
        "competitive_intel": competitive_intel,
    }

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2, default=str)

    print(f"\n--- Results saved to {output_file} ---")

    # Print summary
    print(f"\n{'='*70}")
    print(f"SCAN SUMMARY")
    print(f"{'='*70}")
    print(f"Total opportunities found: {len(all_opportunities)}")
    print(f"Passed scoring threshold:  {len(scored)}")
    print(f"Urgent (due in {urgent_days} days):  {urgent_count}")
    print(f"Competitive intel records:  {len(competitive_intel)}")

    if scored:
        print(f"\n--- TOP 10 OPPORTUNITIES ---\n")
        for i, opp in enumerate(scored[:10], 1):
            urgent_flag = " ** URGENT **" if opp.get("urgent") else ""
            days_str = f" ({opp['days_until_due']}d)" if opp.get("days_until_due") is not None else ""
            print(f"  {i:2d}. [{opp['match_score']:5.1f}] {opp['title'][:65]}")
            print(f"      Source: {opp['source']} | Agency: {opp['agency'][:40]}")
            print(f"      Amount: {format_currency(opp.get('dollar_amount'))} | "
                  f"Due: {opp.get('due_date', 'N/A')}{days_str}{urgent_flag}")
            print(f"      State: {opp.get('state', 'N/A')} | NAICS: {opp.get('naics_code', 'N/A')}")
            print(f"      Link: {opp.get('link', 'N/A')}")
            print()

    if competitive_intel:
        print(f"\n--- TOP COMPETITIVE INTEL (Who's Winning) ---\n")
        # Sort by amount
        sorted_intel = sorted(
            competitive_intel,
            key=lambda x: float(x.get("amount") or 0),
            reverse=True,
        )
        for i, award in enumerate(sorted_intel[:10], 1):
            print(f"  {i:2d}. {award.get('recipient', 'Unknown')[:50]}")
            print(f"      Amount: {format_currency(award.get('amount'))} | "
                  f"Agency: {award.get('agency', 'N/A')[:40]}")
            print(f"      State: {award.get('state', 'N/A')} | "
                  f"Period: {award.get('start_date', '?')} to {award.get('end_date', '?')}")
            print()

    print(f"\nFull results: {output_file}")
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="ANVIL Bid Scanner -- Find government workforce training opportunities",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bid-scanner.py                     # Scan all sources
  python bid-scanner.py --source sam        # SAM.gov only
  python bid-scanner.py --source grants     # Grants.gov only
  python bid-scanner.py --days 30           # Next 30 days only
  python bid-scanner.py --state CA          # California only
  python bid-scanner.py --dry-run           # Preview queries

Environment variables:
  SAM_GOV_API_KEY  - API key from sam.gov (free, required for SAM.gov)
        """,
    )
    parser.add_argument(
        "--source",
        choices=["sam", "grants", "spending"],
        help="Scan a specific source only (default: all)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=60,
        help="Due date window in days (default: 60)",
    )
    parser.add_argument(
        "--state",
        type=str,
        help="Filter by state code (e.g., CA, NY, TX)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be queried without making requests",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        help="Override minimum match score (default: from config)",
    )

    args = parser.parse_args()
    config = load_config()

    if args.min_score is not None:
        config.setdefault("scoring", {})["minimum_score"] = args.min_score

    if args.state:
        args.state = args.state.upper()

    run_scan(args, config)


if __name__ == "__main__":
    main()
