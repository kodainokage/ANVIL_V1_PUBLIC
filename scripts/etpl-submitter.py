#!/usr/bin/env python3
"""
ANVIL ETPL Submitter -- Eligible Training Provider List Application Tracker

Maintains a database of all 50 state workforce board ETPL contacts,
tracks application status, generates state-specific applications,
and creates follow-up email drafts.

Usage:
    python etpl-submitter.py                          # Show dashboard
    python etpl-submitter.py --list                   # List all states + status
    python etpl-submitter.py --priority               # Show priority states
    python etpl-submitter.py --generate CA            # Generate CA ETPL application
    python etpl-submitter.py --update CA --status applied --date 2026-03-15
    python etpl-submitter.py --followups              # Show pending follow-ups
    python etpl-submitter.py --generate-followup CA   # Draft follow-up email for CA
    python etpl-submitter.py --stats                  # Show application statistics
    python etpl-submitter.py --init                   # Initialize/reset the state database

Output:
    data/etpl/etpl-tracker.json     -- State tracking database
    data/etpl/applications/         -- Generated ETPL applications
    data/etpl/followups/            -- Follow-up email drafts
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
ETPL_DIR = PROJECT_DIR / "data" / "etpl"
TRACKER_PATH = ETPL_DIR / "etpl-tracker.json"
APP_DIR = ETPL_DIR / "applications"
FOLLOWUP_DIR = ETPL_DIR / "followups"
CONFIG_PATH = SCRIPT_DIR / "bid-config.json"

VALID_STATUSES = [
    "not_started",     # Haven't begun the process
    "researching",     # Gathering state-specific requirements
    "preparing",       # Application in progress
    "applied",         # Application submitted
    "under_review",    # Confirmed received, being reviewed
    "approved",        # Approved! On the ETPL
    "denied",          # Denied (with reason)
    "reapplying",      # Denied but trying again
    "on_hold",         # Paused for strategic reasons
]

# ---------------------------------------------------------------------------
# All 50 States + DC + Territories ETPL Data
#
# Sources:
#   - CareerOneStop.org Workforce Board Directory
#   - Individual state workforce agency websites
#   - WIOA Section 122 regulations (20 CFR Part 680 Subpart D)
#
# NOTE: Contact info changes. Verify before submitting.
# Last researched: March 2026
# ---------------------------------------------------------------------------

STATE_ETPL_DATA = {
    "AL": {
        "name": "Alabama",
        "agency": "Alabama Department of Commerce, Workforce Development Division",
        "etpl_url": "https://www.madeinalabama.com/workforce-development/",
        "portal": "AlabamaWorks",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Applications through local workforce boards",
        "difficulty": "medium",
        "wioa_funding_rank": 22,
        "market_size": "small",
    },
    "AK": {
        "name": "Alaska",
        "agency": "Alaska Department of Labor and Workforce Development",
        "etpl_url": "https://jobs.alaska.gov/etpl/",
        "portal": "ALEXsys",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Small state, limited WIOA funding",
        "difficulty": "easy",
        "wioa_funding_rank": 50,
        "market_size": "tiny",
    },
    "AZ": {
        "name": "Arizona",
        "agency": "Arizona Department of Economic Security",
        "etpl_url": "https://des.az.gov/services/employment/workforce-innovation-and-opportunity-act-wioa/eligible-training-provider-list",
        "portal": "Arizona Job Connection",
        "contact_email": "WIOA@azdes.gov",
        "contact_phone": "",
        "notes": "Online application through DES portal",
        "difficulty": "medium",
        "wioa_funding_rank": 18,
        "market_size": "medium",
    },
    "AR": {
        "name": "Arkansas",
        "agency": "Arkansas Division of Workforce Services",
        "etpl_url": "https://www.dws.arkansas.gov/workforce-services/wioa/",
        "portal": "Arkansas Job Link",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Smaller market, moderate process",
        "difficulty": "medium",
        "wioa_funding_rank": 33,
        "market_size": "small",
    },
    "CA": {
        "name": "California",
        "agency": "California Employment Development Department (EDD)",
        "etpl_url": "https://www.edd.ca.gov/jobs_and_training/eligible-training-provider-list.htm",
        "portal": "CalJOBS",
        "contact_email": "ETPL@edd.ca.gov",
        "contact_phone": "",
        "notes": "Largest WIOA allocation (~$539M). Apply through local workforce boards. Each LWDB has own process. Start with LA County or Bay Area.",
        "difficulty": "hard",
        "wioa_funding_rank": 1,
        "market_size": "massive",
    },
    "CO": {
        "name": "Colorado",
        "agency": "Colorado Department of Labor and Employment",
        "etpl_url": "https://www.colorado.gov/cdle/etpl",
        "portal": "Connecting Colorado",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Tech-forward state, receptive to AI training",
        "difficulty": "medium",
        "wioa_funding_rank": 20,
        "market_size": "medium",
    },
    "CT": {
        "name": "Connecticut",
        "agency": "Connecticut Department of Labor",
        "etpl_url": "https://www.ctdol.state.ct.us/progsupt/jobsvc/etpl/",
        "portal": "CT Hires",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Smaller but well-funded per capita",
        "difficulty": "medium",
        "wioa_funding_rank": 28,
        "market_size": "small",
    },
    "DE": {
        "name": "Delaware",
        "agency": "Delaware Department of Labor",
        "etpl_url": "https://dol.delaware.gov/",
        "portal": "Delaware JobLink",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small state, single workforce area",
        "difficulty": "easy",
        "wioa_funding_rank": 49,
        "market_size": "tiny",
    },
    "FL": {
        "name": "Florida",
        "agency": "Florida Department of Commerce (formerly DEO)",
        "etpl_url": "https://www.floridajobs.org/office-directory/division-of-workforce-services/workforce-programs/eligible-training-provider-list",
        "portal": "Employ Florida",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Large state. Statewide ETPL process as of 7/1/2024 through FL Commerce via Employ Florida portal. 24 local boards.",
        "difficulty": "medium",
        "wioa_funding_rank": 4,
        "market_size": "large",
    },
    "GA": {
        "name": "Georgia",
        "agency": "Technical College System of Georgia (WorkSource Georgia)",
        "etpl_url": "https://www.tcsg.edu/worksource/",
        "portal": "WorkSource Georgia",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Atlanta metro is key market. Apply through local workforce boards.",
        "difficulty": "medium",
        "wioa_funding_rank": 10,
        "market_size": "large",
    },
    "HI": {
        "name": "Hawaii",
        "agency": "Hawaii Department of Labor and Industrial Relations",
        "etpl_url": "https://labor.hawaii.gov/wdd/",
        "portal": "HireNet Hawaii",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small market, single workforce area",
        "difficulty": "easy",
        "wioa_funding_rank": 48,
        "market_size": "tiny",
    },
    "ID": {
        "name": "Idaho",
        "agency": "Idaho Department of Labor",
        "etpl_url": "https://www.labor.idaho.gov/dnn/Businesses/Training-Resources",
        "portal": "IdahoWorks",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Small state, growing tech sector",
        "difficulty": "easy",
        "wioa_funding_rank": 44,
        "market_size": "small",
    },
    "IL": {
        "name": "Illinois",
        "agency": "Illinois Department of Commerce and Economic Opportunity",
        "etpl_url": "https://www.illinois.gov/dceo/workforce",
        "portal": "Illinois workNet",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Large market, Chicago metro key. 22 local workforce areas.",
        "difficulty": "hard",
        "wioa_funding_rank": 6,
        "market_size": "large",
    },
    "IN": {
        "name": "Indiana",
        "agency": "Indiana Department of Workforce Development",
        "etpl_url": "https://www.in.gov/dwd/",
        "portal": "INdiana Career Connect",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Manufacturing displacement market. WorkOne centers.",
        "difficulty": "medium",
        "wioa_funding_rank": 16,
        "market_size": "medium",
    },
    "IA": {
        "name": "Iowa",
        "agency": "Iowa Workforce Development",
        "etpl_url": "https://workforce.iowa.gov/jobs/worker-programs/eligible-training-provider",
        "portal": "IowaWORKS",
        "contact_email": "",
        "contact_phone": "",
        "notes": "IWD makes eligibility determinations. Apply through IowaWORKS.",
        "difficulty": "medium",
        "wioa_funding_rank": 30,
        "market_size": "small",
    },
    "KS": {
        "name": "Kansas",
        "agency": "Kansas Department of Commerce, Workforce Services",
        "etpl_url": "https://www.kansascommerce.gov/workforce/",
        "portal": "KANSASWORKS",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Moderate market, centralized application",
        "difficulty": "medium",
        "wioa_funding_rank": 31,
        "market_size": "small",
    },
    "KY": {
        "name": "Kentucky",
        "agency": "Kentucky Education and Workforce Development Cabinet",
        "etpl_url": "https://kcc.ky.gov/Workforce/Pages/WIOA.aspx",
        "portal": "Kentucky Career Center",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Coal country displacement. Focus on eastern KY.",
        "difficulty": "medium",
        "wioa_funding_rank": 19,
        "market_size": "medium",
    },
    "LA": {
        "name": "Louisiana",
        "agency": "Louisiana Workforce Commission",
        "etpl_url": "https://www.laworks.net/",
        "portal": "HiRE (Helping Individuals Reach Employment)",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Oil industry displacement. Baton Rouge/New Orleans metro.",
        "difficulty": "medium",
        "wioa_funding_rank": 17,
        "market_size": "medium",
    },
    "ME": {
        "name": "Maine",
        "agency": "Maine Department of Labor",
        "etpl_url": "https://www.maine.gov/labor/",
        "portal": "Maine JobLink",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Small state, aging workforce, good fit for program",
        "difficulty": "easy",
        "wioa_funding_rank": 42,
        "market_size": "small",
    },
    "MD": {
        "name": "Maryland",
        "agency": "Maryland Division of Workforce Development and Adult Learning",
        "etpl_url": "https://www.labor.maryland.gov/employment/train/",
        "portal": "Maryland Workforce Exchange (MWE)",
        "contact_email": "dllr-etpl@maryland.gov",
        "contact_phone": "",
        "notes": "DC-adjacent market. Apply through MWE portal. Good documentation online.",
        "difficulty": "medium",
        "wioa_funding_rank": 21,
        "market_size": "medium",
    },
    "MA": {
        "name": "Massachusetts",
        "agency": "Massachusetts Executive Office of Labor and Workforce Development",
        "etpl_url": "https://www.mass.gov/orgs/executive-office-of-labor-and-workforce-development",
        "portal": "MOSES (Mass Online System for Employment Services)",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Tech hub, high education standards. MassHire career centers.",
        "difficulty": "hard",
        "wioa_funding_rank": 14,
        "market_size": "medium",
    },
    "MI": {
        "name": "Michigan",
        "agency": "Michigan Department of Labor and Economic Opportunity",
        "etpl_url": "https://www.michigan.gov/leo/bureaus-agencies/wd",
        "portal": "Pure Michigan Talent Connect",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Auto industry AI displacement. Michigan Works! agencies. 16 workforce areas.",
        "difficulty": "medium",
        "wioa_funding_rank": 8,
        "market_size": "large",
    },
    "MN": {
        "name": "Minnesota",
        "agency": "Minnesota Department of Employment and Economic Development",
        "etpl_url": "https://mn.gov/deed/job-seekers/workforce-centers/",
        "portal": "MinnesotaWorks",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Well-run workforce system. CareerForce centers.",
        "difficulty": "medium",
        "wioa_funding_rank": 23,
        "market_size": "medium",
    },
    "MS": {
        "name": "Mississippi",
        "agency": "Mississippi Department of Employment Security",
        "etpl_url": "https://mdes.ms.gov/",
        "portal": "MS Works",
        "contact_email": "",
        "contact_phone": "",
        "notes": "High need population, lower competition",
        "difficulty": "easy",
        "wioa_funding_rank": 26,
        "market_size": "small",
    },
    "MO": {
        "name": "Missouri",
        "agency": "Missouri Department of Higher Education and Workforce Development",
        "etpl_url": "https://jobs.mo.gov/workforce-development",
        "portal": "MoJobs",
        "contact_email": "",
        "contact_phone": "",
        "notes": "KC and St. Louis metros. 14 workforce regions.",
        "difficulty": "medium",
        "wioa_funding_rank": 15,
        "market_size": "medium",
    },
    "MT": {
        "name": "Montana",
        "agency": "Montana Department of Labor and Industry",
        "etpl_url": "https://wsd.dli.mt.gov/",
        "portal": "Montana Job Service",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small market, single workforce area essentially",
        "difficulty": "easy",
        "wioa_funding_rank": 47,
        "market_size": "tiny",
    },
    "NE": {
        "name": "Nebraska",
        "agency": "Nebraska Department of Labor",
        "etpl_url": "https://dol.nebraska.gov/",
        "portal": "NEworks",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Small but efficient workforce system",
        "difficulty": "easy",
        "wioa_funding_rank": 40,
        "market_size": "small",
    },
    "NV": {
        "name": "Nevada",
        "agency": "Nevada Department of Employment, Training and Rehabilitation",
        "etpl_url": "https://detr.nv.gov/Page/Workforce_Innovation_and_Opportunity_Act",
        "portal": "EmployNV",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Las Vegas metro key. Service industry displacement.",
        "difficulty": "medium",
        "wioa_funding_rank": 25,
        "market_size": "medium",
    },
    "NH": {
        "name": "New Hampshire",
        "agency": "New Hampshire Employment Security",
        "etpl_url": "https://www.nhes.nh.gov/",
        "portal": "NH Works",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small state, single workforce area",
        "difficulty": "easy",
        "wioa_funding_rank": 46,
        "market_size": "tiny",
    },
    "NJ": {
        "name": "New Jersey",
        "agency": "New Jersey Department of Labor and Workforce Development",
        "etpl_url": "https://www.nj.gov/labor/career-services/",
        "portal": "Career Connections",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Dense market, NYC spillover. One Stop Career Centers.",
        "difficulty": "hard",
        "wioa_funding_rank": 11,
        "market_size": "large",
    },
    "NM": {
        "name": "New Mexico",
        "agency": "New Mexico Department of Workforce Solutions",
        "etpl_url": "https://www.dws.state.nm.us/",
        "portal": "NM Workforce Connection",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Smaller market, high need population",
        "difficulty": "medium",
        "wioa_funding_rank": 34,
        "market_size": "small",
    },
    "NY": {
        "name": "New York",
        "agency": "New York State Department of Labor",
        "etpl_url": "https://dol.ny.gov/eligible-training-provider-list",
        "portal": "NY Talent (formerly JobZone)",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Huge market. NYC metro alone has massive displaced worker pool. Apply through local workforce boards. 33 workforce areas.",
        "difficulty": "hard",
        "wioa_funding_rank": 3,
        "market_size": "massive",
    },
    "NC": {
        "name": "North Carolina",
        "agency": "NCWorks Commission / NC Division of Workforce Solutions",
        "etpl_url": "https://www.nccommerce.com/workforce/workforce-professionals",
        "portal": "NCWorks Online",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Growing tech sector, banking industry displacement. 23 workforce boards.",
        "difficulty": "medium",
        "wioa_funding_rank": 9,
        "market_size": "large",
    },
    "ND": {
        "name": "North Dakota",
        "agency": "North Dakota Job Service",
        "etpl_url": "https://www.jobsnd.com/",
        "portal": "Job Service ND",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small market, energy sector focus",
        "difficulty": "easy",
        "wioa_funding_rank": 51,
        "market_size": "tiny",
    },
    "OH": {
        "name": "Ohio",
        "agency": "Ohio Department of Job and Family Services",
        "etpl_url": "https://jfs.ohio.gov/workforce/wioa/",
        "portal": "OhioMeansJobs",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Manufacturing + tech displacement. 20 workforce areas. OhioMeansJobs centers.",
        "difficulty": "medium",
        "wioa_funding_rank": 7,
        "market_size": "large",
    },
    "OK": {
        "name": "Oklahoma",
        "agency": "Oklahoma Employment Security Commission",
        "etpl_url": "https://oklahoma.gov/oesc.html",
        "portal": "OKJobMatch",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Energy sector displacement. Oklahoma Works system.",
        "difficulty": "medium",
        "wioa_funding_rank": 27,
        "market_size": "small",
    },
    "OR": {
        "name": "Oregon",
        "agency": "Oregon Employment Department / Higher Education Coordinating Commission",
        "etpl_url": "https://www.oregon.gov/highered/institutions-programs/workforce/Pages/ETPL.aspx",
        "portal": "iMatchSkills",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Portland metro key. Tech industry awareness of AI displacement.",
        "difficulty": "medium",
        "wioa_funding_rank": 24,
        "market_size": "medium",
    },
    "PA": {
        "name": "Pennsylvania",
        "agency": "Pennsylvania Department of Labor and Industry",
        "etpl_url": "https://www.dli.pa.gov/Businesses/Workforce-Development/Pages/default.aspx",
        "portal": "PA CareerLink",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Large state, significant manufacturing/coal displacement. 22 workforce areas. PA CareerLink centers.",
        "difficulty": "medium",
        "wioa_funding_rank": 5,
        "market_size": "large",
    },
    "RI": {
        "name": "Rhode Island",
        "agency": "Rhode Island Department of Labor and Training",
        "etpl_url": "https://dlt.ri.gov/",
        "portal": "RI EmployRI",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small state, single workforce area essentially",
        "difficulty": "easy",
        "wioa_funding_rank": 43,
        "market_size": "tiny",
    },
    "SC": {
        "name": "South Carolina",
        "agency": "South Carolina Department of Employment and Workforce",
        "etpl_url": "https://dew.sc.gov/",
        "portal": "SC Works Online Services",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Growing market, manufacturing transition. SC Works centers.",
        "difficulty": "medium",
        "wioa_funding_rank": 24,
        "market_size": "medium",
    },
    "SD": {
        "name": "South Dakota",
        "agency": "South Dakota Department of Labor and Regulation",
        "etpl_url": "https://dlr.sd.gov/workforce_services/",
        "portal": "SD Works",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small market",
        "difficulty": "easy",
        "wioa_funding_rank": 48,
        "market_size": "tiny",
    },
    "TN": {
        "name": "Tennessee",
        "agency": "Tennessee Department of Labor and Workforce Development",
        "etpl_url": "https://www.tn.gov/workforce.html",
        "portal": "Jobs4TN",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Nashville/Memphis metros growing. American Job Centers statewide.",
        "difficulty": "medium",
        "wioa_funding_rank": 13,
        "market_size": "medium",
    },
    "TX": {
        "name": "Texas",
        "agency": "Texas Workforce Commission",
        "etpl_url": "https://www.twc.texas.gov/agency/workforce-development-boards/eligible-training-providers",
        "portal": "WorkInTexas",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Second largest WIOA allocation. 28 workforce boards. Apply through local boards. ETP Coordinator List available on TWC site.",
        "difficulty": "hard",
        "wioa_funding_rank": 2,
        "market_size": "massive",
    },
    "UT": {
        "name": "Utah",
        "agency": "Utah Department of Workforce Services",
        "etpl_url": "https://jobs.utah.gov/wioa/",
        "portal": "Utah Job Connection",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Growing tech sector, low unemployment but AI displacement relevant",
        "difficulty": "medium",
        "wioa_funding_rank": 35,
        "market_size": "small",
    },
    "VT": {
        "name": "Vermont",
        "agency": "Vermont Department of Labor",
        "etpl_url": "https://labor.vermont.gov/",
        "portal": "Vermont JobLink",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Tiny state, single workforce area",
        "difficulty": "easy",
        "wioa_funding_rank": 50,
        "market_size": "tiny",
    },
    "VA": {
        "name": "Virginia",
        "agency": "Virginia Employment Commission / Virginia Board of Workforce Development",
        "etpl_url": "https://www.vec.virginia.gov/",
        "portal": "Virginia Workforce Connection",
        "contact_email": "",
        "contact_phone": "",
        "notes": "DC-adjacent, Northern VA tech corridor. 15 workforce areas.",
        "difficulty": "medium",
        "wioa_funding_rank": 12,
        "market_size": "large",
    },
    "WA": {
        "name": "Washington",
        "agency": "Washington Workforce Training & Education Coordinating Board",
        "etpl_url": "https://wtb.wa.gov/research-resources/etpl/",
        "portal": "CareerBridge",
        "contact_email": "careerbridge@wtb.wa.gov",
        "contact_phone": "",
        "notes": "Seattle tech hub. High AI awareness. WTECB manages ETPL statewide.",
        "difficulty": "hard",
        "wioa_funding_rank": 15,
        "market_size": "large",
    },
    "WV": {
        "name": "West Virginia",
        "agency": "WorkForce West Virginia",
        "etpl_url": "https://workforcewv.org/",
        "portal": "WorkForce WV",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Coal country displacement, high need, lower competition",
        "difficulty": "easy",
        "wioa_funding_rank": 32,
        "market_size": "small",
    },
    "WI": {
        "name": "Wisconsin",
        "agency": "Wisconsin Department of Workforce Development",
        "etpl_url": "https://dwd.wisconsin.gov/wioa/etpl/",
        "portal": "Job Center of Wisconsin",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Won $7.3M for AI/manufacturing training grants (Feb 2026). Hot market for AI workforce training.",
        "difficulty": "medium",
        "wioa_funding_rank": 18,
        "market_size": "medium",
    },
    "WY": {
        "name": "Wyoming",
        "agency": "Wyoming Department of Workforce Services",
        "etpl_url": "https://dws.wyo.gov/dws-division/workforce-center-program-operations/eligible-training-provider-list/",
        "portal": "Wyoming at Work",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Very small market, energy sector focus",
        "difficulty": "easy",
        "wioa_funding_rank": 51,
        "market_size": "tiny",
    },
    "DC": {
        "name": "District of Columbia",
        "agency": "DC Department of Employment Services",
        "etpl_url": "https://does.dc.gov/",
        "portal": "DC Networks",
        "contact_email": "",
        "contact_phone": "",
        "notes": "Federal workforce proximity. Government services market.",
        "difficulty": "medium",
        "wioa_funding_rank": 45,
        "market_size": "small",
    },
}


# ---------------------------------------------------------------------------
# Priority Ranking
# ---------------------------------------------------------------------------

def calculate_priority_score(state_data):
    """
    Score each state 0-100 for ETPL application priority.

    Factors:
    - WIOA funding rank (higher funding = higher priority)
    - Market size (bigger = more participants)
    - Application difficulty (easier = faster win)
    - Strategic notes (e.g., WI's AI training grant)
    """
    score = 0

    # Funding rank (inverted: rank 1 = highest score)
    rank = state_data.get("wioa_funding_rank", 25)
    score += max(0, (52 - rank)) * 1.0  # Max ~51 points

    # Market size
    market_scores = {"massive": 25, "large": 18, "medium": 12, "small": 6, "tiny": 2}
    score += market_scores.get(state_data.get("market_size", "small"), 5)

    # Difficulty (easier = bonus)
    diff_scores = {"easy": 15, "medium": 8, "hard": 3}
    score += diff_scores.get(state_data.get("difficulty", "medium"), 5)

    # Bonus for specific strategic notes
    notes = state_data.get("notes", "").lower()
    if "ai" in notes or "tech" in notes:
        score += 5
    if "displacement" in notes:
        score += 3

    return round(score, 1)


# ---------------------------------------------------------------------------
# ETPL Tracker Database
# ---------------------------------------------------------------------------

class ETPLTracker:
    """JSON-backed ETPL application tracking database."""

    def __init__(self, path=None):
        self.path = Path(path) if path else TRACKER_PATH
        self.data = self._load()

    def _load(self):
        if self.path.exists():
            try:
                with open(self.path, "r") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return self._create_new()

    def _create_new(self):
        """Initialize tracker with all state data."""
        states = {}
        for code, info in STATE_ETPL_DATA.items():
            states[code] = {
                **info,
                "code": code,
                "priority_score": calculate_priority_score(info),
                "status": "not_started",
                "status_history": [],
                "application_date": "",
                "approval_date": "",
                "denial_date": "",
                "denial_reason": "",
                "follow_up_dates": [],
                "last_follow_up": "",
                "next_follow_up": "",
                "contact_log": [],
                "application_file": "",
                "notes_log": [],
            }
        return {
            "metadata": {
                "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "version": "1.0",
            },
            "states": states,
        }

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data["metadata"]["last_updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2, default=str)

    def init_database(self):
        """Re-initialize the state database (preserving existing status data if any)."""
        old_states = self.data.get("states", {})
        self.data = self._create_new()

        # Preserve existing status data
        for code, old in old_states.items():
            if code in self.data["states"] and old.get("status") != "not_started":
                new = self.data["states"][code]
                for key in ["status", "status_history", "application_date", "approval_date",
                           "denial_date", "denial_reason", "follow_up_dates", "last_follow_up",
                           "next_follow_up", "contact_log", "application_file", "notes_log"]:
                    if key in old:
                        new[key] = old[key]

        self.save()
        print(f"ETPL tracker initialized with {len(self.data['states'])} states")

    def update_state(self, state_code, status=None, date=None, notes=""):
        """Update a state's ETPL application status."""
        code = state_code.upper()
        if code not in self.data["states"]:
            print(f"ERROR: Unknown state code '{code}'")
            return False

        state = self.data["states"][code]
        old_status = state["status"]

        if status and status in VALID_STATUSES:
            state["status"] = status
            state["status_history"].append({
                "from": old_status,
                "to": status,
                "date": date or datetime.now().strftime("%Y-%m-%d"),
                "notes": notes,
            })

            if status == "applied":
                state["application_date"] = date or datetime.now().strftime("%Y-%m-%d")
                # Set first follow-up for 2 weeks out
                app_date = datetime.strptime(state["application_date"], "%Y-%m-%d")
                state["next_follow_up"] = (app_date + timedelta(days=14)).strftime("%Y-%m-%d")
            elif status == "approved":
                state["approval_date"] = date or datetime.now().strftime("%Y-%m-%d")
                state["next_follow_up"] = ""
            elif status == "denied":
                state["denial_date"] = date or datetime.now().strftime("%Y-%m-%d")
                state["denial_reason"] = notes

        if notes:
            state["notes_log"].append({
                "date": datetime.now().strftime("%Y-%m-%d"),
                "note": notes,
            })

        self.save()
        print(f"Updated {code} ({state['name']}): {old_status} -> {state['status']}")
        return True

    def get_priority_list(self, limit=20):
        """Get states sorted by priority score."""
        states = list(self.data["states"].values())
        states.sort(key=lambda x: x.get("priority_score", 0), reverse=True)
        return states[:limit]

    def get_by_status(self, status):
        """Get states with a given status."""
        return [
            s for s in self.data["states"].values()
            if s.get("status") == status
        ]

    def get_pending_followups(self):
        """Get states with pending follow-up dates."""
        pending = []
        today = datetime.now().strftime("%Y-%m-%d")
        for state in self.data["states"].values():
            nfu = state.get("next_follow_up", "")
            if nfu and nfu <= today and state["status"] not in ("approved", "denied", "not_started"):
                state["overdue_days"] = (datetime.now() - datetime.strptime(nfu, "%Y-%m-%d")).days
                pending.append(state)
        pending.sort(key=lambda x: x.get("next_follow_up", ""))
        return pending

    def record_followup(self, state_code, notes=""):
        """Record a follow-up and schedule the next one (2 weeks out)."""
        code = state_code.upper()
        if code not in self.data["states"]:
            print(f"ERROR: Unknown state code '{code}'")
            return

        state = self.data["states"][code]
        today = datetime.now().strftime("%Y-%m-%d")

        state["last_follow_up"] = today
        state["follow_up_dates"].append(today)
        state["next_follow_up"] = (datetime.now() + timedelta(days=14)).strftime("%Y-%m-%d")
        state["contact_log"].append({
            "date": today,
            "type": "follow_up",
            "notes": notes or "Follow-up email sent",
        })

        self.save()
        print(f"Follow-up recorded for {code}. Next follow-up: {state['next_follow_up']}")

    def get_statistics(self):
        """Get ETPL application statistics."""
        states = list(self.data["states"].values())
        status_counts = {}
        for status in VALID_STATUSES:
            count = len([s for s in states if s.get("status") == status])
            if count > 0:
                status_counts[status] = count

        approved = [s for s in states if s.get("status") == "approved"]
        applied = [s for s in states if s.get("status") in ("applied", "under_review")]
        pending_fu = self.get_pending_followups()

        return {
            "total_states": len(states),
            "by_status": status_counts,
            "approved_count": len(approved),
            "applied_count": len(applied),
            "pending_followups": len(pending_fu),
            "coverage_pct": round(
                (len(approved) / len(states)) * 100, 1
            ) if states else 0,
        }


# ---------------------------------------------------------------------------
# Application / Follow-up Generation
# ---------------------------------------------------------------------------

def generate_etpl_application(state_code, tracker):
    """Generate a state-specific ETPL application from our template."""
    code = state_code.upper()
    state = tracker.data["states"].get(code)
    if not state:
        print(f"ERROR: Unknown state code '{code}'")
        return

    app_content = f"""# ETPL Application: {state['name']}

## Eligible Training Provider List Application
## State: {state['name']} ({code})
## Agency: {state['agency']}
## Portal: {state.get('portal', 'N/A')}
## ETPL URL: {state.get('etpl_url', 'N/A')}

---

**Date Prepared:** {datetime.now().strftime('%Y-%m-%d')}

**Application Status:** {state['status']}

---

## Section 1: Training Provider Information

**Provider Name:** [LEGAL ENTITY NAME]

**DBA/Trade Name:** ANVIL -- AI Navigation & Vocational Integration Layer

**Federal Employer Identification Number (FEIN):** [EIN]

**DUNS Number / SAM.gov UEI:** [UEI NUMBER]

**Provider Type:** Private training provider

**Physical Address:** [ADDRESS]

**Website:** [WEBSITE URL]

**Primary Contact:** [CONTACT NAME] | [PHONE] | [EMAIL]

**Authorized Representative:** [AUTH REP NAME] | [TITLE]

---

## Section 2: Program Information

**Program Name:** AI-Augmented Specialist Training Sprint

**Program Description:** 7-day, 19-hour intensive training program that prepares dislocated workers and unemployed adults to deliver professional services in high-demand community service niches using AI tools. Three career pathways: Government Benefits Navigation, Medical Bill Auditing, and Small Business Compliance.

**Program Duration:** 7 days (19 hours of structured instruction)

**Delivery Method:** In-person at host sites, live virtual, or hybrid

**Cohort Size:** 10-25 participants

**Cost to Participant:** $0

**Requested WIOA Reimbursement:** $2,000-$3,000 per participant

**Credential Awarded:** ANVIL AI-Augmented Specialist Certification (performance-based)

---

## Section 3: Career Pathways and SOC Codes

### Pathway 1: Government Benefits Navigation
- **Primary SOC:** 21-1093 (Social and Human Service Assistants)
- **Secondary SOC:** 43-4061 (Eligibility Interviewers, Government Programs)
- **Additional SOC:** 21-1094 (Community Health Workers)
- **Median Wage:** $39,790 | **Growth:** 12%

### Pathway 2: Medical Bill Auditing
- **Primary SOC:** 13-2011 (Accountants and Auditors)
- **Secondary SOC:** 43-3011 (Bill and Account Collectors)
- **Additional SOC:** 43-9041 (Insurance Claims and Policy Processing Clerks)
- **Median Wage:** $79,880 | **Growth:** 4%

### Pathway 3: Small Business Compliance
- **Primary SOC:** 13-1041 (Compliance Officers)
- **Secondary SOC:** 13-1199 (Business Operations Specialists, All Other)
- **Additional SOC:** 43-4199 (Information and Record Clerks, All Other)
- **Median Wage:** $75,670 | **Growth:** 4%

---

## Section 4: Curriculum Summary

| Day | Topic | Hours |
|-----|-------|-------|
| 1 | AI Is Your New Co-Worker | 2.5 |
| 2 | Your Niche Deep Dive | 2.5 |
| 3 | The AI Workflow | 3.0 |
| 4 | Quality and Ethics | 2.5 |
| 5 | Finding Clients | 2.5 |
| 6 | Real Cases Under Supervision | 3.0 |
| 7 | Certification and Launch | 3.0 |
| **Total** | | **19.0** |

---

## Section 5: Outcomes Targets

| Indicator | Target |
|-----------|--------|
| Program Completion Rate | 75% |
| Credential Attainment | 70% of completers |
| Employment Rate (Q2) | 55% |
| Employment Rate (Q4) | 50% |
| Median Earnings (Q2) | $5,500+/quarter |
| Measurable Skill Gains | 80% |

---

## Section 6: {state['name']}-Specific Information

**State Workforce Agency:** {state['agency']}

**Application Portal:** {state.get('portal', '[VERIFY]')}

**ETPL URL:** {state.get('etpl_url', '[VERIFY]')}

**Contact Email:** {state.get('contact_email') or '[RESEARCH NEEDED]'}

**State-Specific Notes:** {state.get('notes', 'None')}

**Difficulty Assessment:** {state.get('difficulty', 'unknown')}

---

## Section 7: Checklist Before Submission

- [ ] Verify state-specific ETPL requirements at {state.get('etpl_url', 'state website')}
- [ ] Confirm acceptable SOC codes for {state['name']}
- [ ] Check if {state['name']} requires in-state physical presence
- [ ] Verify credential recognition requirements
- [ ] Complete all [BRACKETED] fields with actual information
- [ ] Obtain required signatures
- [ ] Prepare any supplemental documents (financial statements, insurance certificates, etc.)
- [ ] Register in {state.get('portal', 'state portal')} if required
- [ ] Confirm application submission method (online portal, email, mail)

---

*Generated by ANVIL ETPL Submitter on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*

*This application is a template. Verify all state-specific requirements before submission.*
*Each state has unique ETPL processes. Some require local workforce board endorsement.*
"""

    # Save the application
    APP_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"etpl-{code}-{datetime.now().strftime('%Y%m%d')}.md"
    output_path = APP_DIR / filename

    with open(output_path, "w") as f:
        f.write(app_content)

    # Update tracker
    state["application_file"] = str(output_path)
    if state["status"] == "not_started":
        tracker.update_state(code, status="preparing", notes="Application generated")
    tracker.save()

    print(f"\nETPL application generated: {output_path}")
    print(f"State: {state['name']} ({code})")
    print(f"Agency: {state['agency']}")
    print(f"Portal: {state.get('portal', 'N/A')}")
    print(f"\nNEXT STEPS:")
    print(f"  1. Visit {state.get('etpl_url', 'state ETPL website')}")
    print(f"  2. Verify state-specific requirements")
    print(f"  3. Fill in all [BRACKETED] fields")
    print(f"  4. Submit through designated channel")
    print(f"  5. Run: python etpl-submitter.py --update {code} --status applied")

    return output_path


def generate_followup_email(state_code, tracker, followup_number=1):
    """Generate a follow-up email draft for a state."""
    code = state_code.upper()
    state = tracker.data["states"].get(code)
    if not state:
        print(f"ERROR: Unknown state code '{code}'")
        return

    fu_count = len(state.get("follow_up_dates", [])) + 1
    app_date = state.get("application_date", "[APPLICATION DATE]")

    if fu_count == 1:
        subject = f"Follow-Up: ANVIL ETPL Application - AI-Augmented Specialist Training Sprint"
        tone = "initial"
    elif fu_count == 2:
        subject = f"Second Follow-Up: ANVIL ETPL Application Status"
        tone = "polite"
    else:
        subject = f"Follow-Up #{fu_count}: ANVIL ETPL Application - {state['name']}"
        tone = "persistent"

    contact = state.get("contact_email") or "[STATE ETPL CONTACT EMAIL]"

    email = f"""# Follow-Up Email: {state['name']} ETPL

**To:** {contact}

**Subject:** {subject}

**Follow-Up #:** {fu_count}

**Application Date:** {app_date}

---

Dear ETPL Review Team,

"""
    if tone == "initial":
        email += f"""I am writing to follow up on the Eligible Training Provider List application submitted by ANVIL -- AI Navigation & Vocational Integration Layer on {app_date}.

We submitted our application for the AI-Augmented Specialist Training Sprint, a 7-day workforce training program that prepares displaced workers to become AI-augmented service specialists in Government Benefits Navigation, Medical Bill Auditing, and Small Business Compliance.

I wanted to confirm that our application was received and inquire about the typical review timeline. We are eager to begin serving {state['name']}'s workforce and are happy to provide any additional documentation that may be needed.

"""
    elif tone == "polite":
        email += f"""I am following up on our ETPL application submitted on {app_date} for the ANVIL AI-Augmented Specialist Training Sprint program.

We remain very interested in serving {state['name']}'s displaced and dislocated workers through our 7-day AI training program. If there are any questions about our application or if additional materials would be helpful, I would be glad to provide them promptly.

Could you provide an update on the review status or an estimated timeline for a decision?

"""
    else:
        email += f"""I am writing regarding our ETPL application (submitted {app_date}) for the ANVIL AI-Augmented Specialist Training Sprint. This is follow-up #{fu_count}.

ANVIL trains displaced workers to become AI-augmented specialists in community service niches -- at $2,000-$3,000 per participant, well below the typical ITA amount, with a 7-day completion timeline.

I would appreciate any update on our application status. If a phone call or in-person meeting would be helpful, I am available at your convenience.

"""
    email += f"""Thank you for your time and for the important work your office does in connecting {state['name']}'s residents with quality training opportunities.

Respectfully,

[YOUR NAME]
[TITLE]
ANVIL -- AI Navigation & Vocational Integration Layer
[PHONE] | [EMAIL]
[WEBSITE]

---

*Follow-up #{fu_count} | Application submitted: {app_date}*
*Previous follow-ups: {', '.join(state.get('follow_up_dates', [])) or 'None'}*
"""

    # Save the follow-up
    FOLLOWUP_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"followup-{code}-{fu_count}-{datetime.now().strftime('%Y%m%d')}.md"
    output_path = FOLLOWUP_DIR / filename

    with open(output_path, "w") as f:
        f.write(email)

    print(f"\nFollow-up email generated: {output_path}")
    print(f"State: {state['name']} ({code}) | Follow-up #{fu_count}")
    print(f"\nAfter sending, run:")
    print(f"  python etpl-submitter.py --record-followup {code}")

    return output_path


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

def show_dashboard(tracker):
    """Show the ETPL pipeline dashboard."""
    stats = tracker.get_statistics()
    priority = tracker.get_priority_list(15)
    pending_fu = tracker.get_pending_followups()

    print("=" * 70)
    print("ANVIL ETPL APPLICATION PIPELINE")
    print(f"Updated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 70)

    # Overall stats
    print(f"\n  Total states tracked: {stats['total_states']}")
    print(f"  ETPL coverage:        {stats['coverage_pct']}% ({stats['approved_count']} approved)")
    print(f"  Applications pending: {stats['applied_count']}")
    print(f"  Follow-ups due:       {stats['pending_followups']}")

    print(f"\n  Status Breakdown:")
    for status, count in stats.get("by_status", {}).items():
        bar = "#" * min(count, 40)
        print(f"    {status:15s}: {count:3d} {bar}")

    # Pending follow-ups (URGENT)
    if pending_fu:
        print(f"\n{'!'*70}")
        print(f"  FOLLOW-UPS DUE ({len(pending_fu)})")
        print(f"{'!'*70}")
        for state in pending_fu:
            overdue = state.get("overdue_days", 0)
            flag = " ** OVERDUE **" if overdue > 7 else ""
            print(f"  {state['code']} ({state['name']}): due {state['next_follow_up']}{flag}")
            print(f"     Status: {state['status']} | Applied: {state.get('application_date', 'N/A')}")

    # Priority states not yet started
    not_started = [s for s in priority if s["status"] == "not_started"]
    if not_started:
        print(f"\n--- TOP PRIORITY STATES (Not Started) ---\n")
        for i, state in enumerate(not_started[:10], 1):
            print(f"  {i:2d}. {state['code']} - {state['name']} "
                  f"[Score: {state['priority_score']}] "
                  f"[{state.get('difficulty', '?')} difficulty] "
                  f"[{state.get('market_size', '?')} market]")
            if state.get("notes"):
                print(f"      {state['notes'][:70]}")

    # Approved states
    approved = tracker.get_by_status("approved")
    if approved:
        print(f"\n--- APPROVED STATES ({len(approved)}) ---")
        for state in approved:
            print(f"  {state['code']} - {state['name']} (approved {state.get('approval_date', 'N/A')})")

    print(f"\n{'='*70}")
    print(f"Commands:")
    print(f"  Generate app:    python etpl-submitter.py --generate CA")
    print(f"  Update status:   python etpl-submitter.py --update CA --status applied --date 2026-03-15")
    print(f"  Follow-up email: python etpl-submitter.py --generate-followup CA")
    print(f"  Record followup: python etpl-submitter.py --record-followup CA")
    print(f"  Priority list:   python etpl-submitter.py --priority")
    print(f"  All states:      python etpl-submitter.py --list")
    print(f"{'='*70}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="ANVIL ETPL Submitter -- Track and manage ETPL applications across all 50 states",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Status lifecycle:
  not_started -> researching -> preparing -> applied -> under_review -> approved/denied
  denied -> reapplying -> applied -> ...

Examples:
  python etpl-submitter.py                              # Dashboard
  python etpl-submitter.py --init                       # Initialize/reset database
  python etpl-submitter.py --list                       # All states
  python etpl-submitter.py --priority                   # Priority ranking
  python etpl-submitter.py --generate CA                # Generate CA application
  python etpl-submitter.py --update CA --status applied # Mark as applied
  python etpl-submitter.py --followups                  # Due follow-ups
  python etpl-submitter.py --generate-followup CA       # Draft follow-up email
  python etpl-submitter.py --record-followup CA         # Record follow-up sent
  python etpl-submitter.py --stats                      # Statistics
        """,
    )

    parser.add_argument("--init", action="store_true", help="Initialize/reset state database")
    parser.add_argument("--list", action="store_true", help="List all states and status")
    parser.add_argument("--priority", action="store_true", help="Show priority-ranked states")
    parser.add_argument("--generate", metavar="STATE", help="Generate ETPL application for state")
    parser.add_argument("--update", metavar="STATE", help="Update state status")
    parser.add_argument("--status", help="New status (with --update)")
    parser.add_argument("--date", help="Date for status change (YYYY-MM-DD)")
    parser.add_argument("--notes", default="", help="Notes for update")
    parser.add_argument("--followups", action="store_true", help="Show pending follow-ups")
    parser.add_argument("--generate-followup", metavar="STATE", help="Generate follow-up email")
    parser.add_argument("--record-followup", metavar="STATE", help="Record that follow-up was sent")
    parser.add_argument("--stats", action="store_true", help="Show statistics")
    parser.add_argument("--state-info", metavar="STATE", help="Show detailed info for a state")

    args = parser.parse_args()
    tracker = ETPLTracker()

    # Default: show dashboard
    if not any([
        args.init, args.list, args.priority, args.generate,
        args.update, args.followups, args.generate_followup,
        args.record_followup, args.stats, args.state_info,
    ]):
        show_dashboard(tracker)
        return

    if args.init:
        tracker.init_database()

    if args.list:
        print(f"\n{'='*85}")
        print(f"{'State':6s} {'Name':22s} {'Status':15s} {'Priority':8s} {'Difficulty':10s} {'Market':8s}")
        print(f"{'='*85}")
        states = sorted(
            tracker.data["states"].values(),
            key=lambda x: x.get("priority_score", 0),
            reverse=True,
        )
        for state in states:
            print(f"  {state['code']:4s} {state['name']:22s} "
                  f"{state['status']:15s} "
                  f"{state.get('priority_score', 0):6.1f}  "
                  f"{state.get('difficulty', '?'):10s} "
                  f"{state.get('market_size', '?'):8s}")

    if args.priority:
        priority = tracker.get_priority_list(25)
        print(f"\n--- ETPL APPLICATION PRIORITY RANKING ---\n")
        for i, state in enumerate(priority, 1):
            status_flag = f" [{state['status']}]" if state["status"] != "not_started" else ""
            print(f"  {i:2d}. [{state['priority_score']:5.1f}] "
                  f"{state['code']} - {state['name']}{status_flag}")
            print(f"      Rank: #{state.get('wioa_funding_rank', '?')} | "
                  f"Market: {state.get('market_size', '?')} | "
                  f"Difficulty: {state.get('difficulty', '?')}")
            if state.get("notes"):
                print(f"      {state['notes'][:70]}")
            print()

    if args.generate:
        generate_etpl_application(args.generate, tracker)

    if args.update:
        if not args.status:
            print(f"ERROR: --status required with --update")
            print(f"Valid: {', '.join(VALID_STATUSES)}")
            return
        tracker.update_state(args.update, args.status, date=args.date, notes=args.notes)

    if args.followups:
        pending = tracker.get_pending_followups()
        if not pending:
            print("No follow-ups due. All caught up.")
            return
        print(f"\n--- PENDING FOLLOW-UPS ({len(pending)}) ---\n")
        for state in pending:
            overdue = state.get("overdue_days", 0)
            flag = " *** OVERDUE ***" if overdue > 7 else ""
            print(f"  {state['code']} - {state['name']}{flag}")
            print(f"    Due: {state['next_follow_up']} (overdue by {overdue} days)")
            print(f"    Status: {state['status']} | Applied: {state.get('application_date', 'N/A')}")
            print(f"    Previous follow-ups: {len(state.get('follow_up_dates', []))}")
            print(f"    Generate: python etpl-submitter.py --generate-followup {state['code']}")
            print()

    if args.generate_followup:
        generate_followup_email(args.generate_followup, tracker)

    if args.record_followup:
        tracker.record_followup(args.record_followup, args.notes)

    if args.stats:
        stats = tracker.get_statistics()
        print(f"\n{'='*50}")
        print(f"ETPL APPLICATION STATISTICS")
        print(f"{'='*50}")
        print(f"\nTotal states: {stats['total_states']}")
        print(f"Approved: {stats['approved_count']} ({stats['coverage_pct']}% coverage)")
        print(f"Applied/Under Review: {stats['applied_count']}")
        print(f"Follow-ups pending: {stats['pending_followups']}")
        print(f"\nBy Status:")
        for status, count in stats.get("by_status", {}).items():
            bar = "#" * min(count, 40)
            print(f"  {status:15s}: {count:3d} {bar}")

    if args.state_info:
        code = args.state_info.upper()
        state = tracker.data["states"].get(code)
        if not state:
            print(f"ERROR: Unknown state code '{code}'")
            return
        print(f"\n{'='*60}")
        print(f"STATE: {state['name']} ({code})")
        print(f"{'='*60}")
        for key, val in state.items():
            if key not in ("status_history", "follow_up_dates", "contact_log", "notes_log"):
                print(f"  {key}: {val}")
        if state.get("status_history"):
            print(f"\n  Status History:")
            for h in state["status_history"]:
                print(f"    {h.get('date', '?')}: {h.get('from', '?')} -> {h.get('to', '?')}"
                      f" ({h.get('notes', '')})")
        if state.get("notes_log"):
            print(f"\n  Notes:")
            for n in state["notes_log"]:
                print(f"    {n.get('date', '?')}: {n.get('note', '')}")


if __name__ == "__main__":
    main()
