#!/usr/bin/env python3
"""
ANVIL Application Generator -- Template-Based Proposal Builder

Takes a bid opportunity (from bid-tracker.json or scan output) and generates
a customized application/proposal by merging ANVIL's WIOA docs with the
opportunity's specific requirements.

Human reviews and submits -- NO auto-submission.

Usage:
    python application-generator.py --opportunity <ID>       # By tracker ID
    python application-generator.py --opportunity <ID> --type proposal
    python application-generator.py --opportunity <ID> --type letter-of-interest
    python application-generator.py --manual --title "..." --agency "..." --amount 50000 --state CA
    python application-generator.py --list-templates

Output: data/applications/app-{opportunity_id}-{date}.md
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from textwrap import dedent, wrap

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
WIOA_DIR = PROJECT_DIR / "wioa"
TRACKER_PATH = PROJECT_DIR / "data" / "bid-tracker.json"
OUTPUT_DIR = PROJECT_DIR / "data" / "applications"
CONFIG_PATH = SCRIPT_DIR / "bid-config.json"

# ---------------------------------------------------------------------------
# ANVIL Program Data (from wioa/ docs)
# ---------------------------------------------------------------------------

ANVIL_PROGRAM = {
    "name": "ANVIL AI-Augmented Specialist Training Sprint",
    "provider": "[LEGAL ENTITY NAME]",
    "dba": "ANVIL -- AI Navigation & Vocational Integration Layer",
    "duration_days": 7,
    "duration_hours": 19,
    "cohort_size_min": 10,
    "cohort_size_max": 25,
    "cost_per_participant_min": 2000,
    "cost_per_participant_max": 3000,
    "actual_cost_per_participant": 600,
    "credential": "ANVIL AI-Augmented Specialist Certification",
    "delivery_modes": ["In-person at host sites", "Live virtual (video conference)", "Hybrid"],
    "career_pathways": [
        {
            "name": "Government Benefits Navigation",
            "description": "Helping individuals identify and apply for government programs they qualify for (SNAP, Medicaid, LIHEAP, WIOA, SSI/SSDI, and 15+ additional programs)",
            "primary_soc": "21-1093",
            "soc_title": "Social and Human Service Assistants",
            "median_wage": "$39,790",
            "growth": "12% (much faster than average)",
        },
        {
            "name": "Medical Bill Auditing",
            "description": "Finding errors on medical bills (present in approximately 80% of hospital bills), negotiating reductions, and connecting patients to financial assistance",
            "primary_soc": "13-2011",
            "soc_title": "Accountants and Auditors",
            "median_wage": "$79,880",
            "growth": "4% (as fast as average)",
        },
        {
            "name": "Small Business Compliance",
            "description": "Identifying every permit, license, and registration a small business needs at the federal, state, county, and city level",
            "primary_soc": "13-1041",
            "soc_title": "Compliance Officers",
            "median_wage": "$75,670",
            "growth": "4% (as fast as average)",
        },
    ],
    "outcomes": {
        "completion_rate": "75%",
        "credential_attainment": "70% of completers",
        "employment_q2": "55%",
        "employment_q4": "50%",
        "median_earnings_q2": "$5,500+ per quarter",
        "measurable_skill_gains": "80%",
    },
    "target_populations": [
        "Dislocated Workers (WIOA Section 3(15))",
        "Long-Term Unemployed (27+ weeks)",
        "Underemployed Adults",
        "Low-Income Adults (WIOA Section 3(36))",
        "Individuals with Barriers to Employment",
    ],
    "all_soc_codes": [
        ("21-1093", "Social and Human Service Assistants"),
        ("43-4061", "Eligibility Interviewers, Government Programs"),
        ("21-1094", "Community Health Workers"),
        ("13-2011", "Accountants and Auditors"),
        ("43-3011", "Bill and Account Collectors"),
        ("43-9041", "Insurance Claims and Policy Processing Clerks"),
        ("13-1041", "Compliance Officers"),
        ("13-1199", "Business Operations Specialists, All Other"),
        ("43-4199", "Information and Record Clerks, All Other"),
    ],
    "curriculum_summary": [
        ("Day 1", "AI Is Your New Co-Worker", "2.5 hours"),
        ("Day 2", "Your Niche Deep Dive", "2.5 hours"),
        ("Day 3", "The AI Workflow", "3.0 hours"),
        ("Day 4", "Quality and Ethics", "2.5 hours"),
        ("Day 5", "Finding Clients", "2.5 hours"),
        ("Day 6", "Real Cases Under Supervision", "3.0 hours"),
        ("Day 7", "Certification and Launch", "3.0 hours"),
    ],
}


# ---------------------------------------------------------------------------
# Budget Scaler
# ---------------------------------------------------------------------------

def scale_budget(total_amount, num_participants=None):
    """
    Scale ANVIL's budget narrative to fit a specific dollar amount.

    Returns a budget breakdown dict.
    """
    if not total_amount or total_amount <= 0:
        total_amount = 100000  # Default assumption

    if num_participants is None:
        # Estimate participants from amount at $2,500/participant
        num_participants = max(10, int(total_amount / 2500))

    # Cap at reasonable numbers
    num_participants = min(num_participants, 500)
    num_cohorts = max(1, num_participants // 20)  # ~20 per cohort

    # Cost structure (based on budget-narrative.md)
    personnel_pct = 0.55
    tech_pct = 0.05
    materials_pct = 0.03
    facilities_pct = 0.08
    marketing_pct = 0.05
    prof_dev_pct = 0.02
    insurance_pct = 0.03
    admin_pct = 0.10
    reserve_pct = 0.09

    budget = {
        "total": total_amount,
        "participants": num_participants,
        "cohorts": num_cohorts,
        "cost_per_participant": round(total_amount / num_participants, 2),
        "line_items": {
            "personnel": {
                "amount": round(total_amount * personnel_pct),
                "description": "Lead instructor, program administrator, follow-up coordinator, payroll taxes",
            },
            "technology": {
                "amount": round(total_amount * tech_pct),
                "description": "Web hosting, video conferencing, AI tool subscriptions, LMS",
            },
            "materials": {
                "amount": round(total_amount * materials_pct),
                "description": "Participant workbooks, printed resources, certification materials",
            },
            "facilities": {
                "amount": round(total_amount * facilities_pct),
                "description": "Host site rental, equipment, accessibility accommodations",
            },
            "marketing_outreach": {
                "amount": round(total_amount * marketing_pct),
                "description": "Participant recruitment, community outreach, partner coordination",
            },
            "professional_development": {
                "amount": round(total_amount * prof_dev_pct),
                "description": "Instructor training, curriculum updates, industry certification",
            },
            "insurance_compliance": {
                "amount": round(total_amount * insurance_pct),
                "description": "Professional liability, workers compensation, compliance auditing",
            },
            "administrative": {
                "amount": round(total_amount * admin_pct),
                "description": "Data management, reporting systems, WIOA outcome tracking",
            },
            "program_reserve": {
                "amount": round(total_amount * reserve_pct),
                "description": "Program sustainability, contingency, post-program support services",
            },
        },
    }
    return budget


# ---------------------------------------------------------------------------
# Application Templates
# ---------------------------------------------------------------------------

def generate_full_proposal(opp, budget):
    """Generate a full RFP response / proposal."""
    state = opp.get("state", "[STATE]")
    agency = opp.get("agency", "[AGENCY NAME]")
    amount = opp.get("dollar_amount") or budget["total"]
    title = opp.get("title", "[OPPORTUNITY TITLE]")
    due_date = opp.get("due_date", "[DUE DATE]")

    soc_table = "\n".join([
        f"| {code} | {title} |" for code, title in ANVIL_PROGRAM["all_soc_codes"]
    ])

    curriculum_table = "\n".join([
        f"| {day} | {topic} | {hours} |"
        for day, topic, hours in ANVIL_PROGRAM["curriculum_summary"]
    ])

    pathways_detail = ""
    for pw in ANVIL_PROGRAM["career_pathways"]:
        pathways_detail += f"""
### {pw['name']}

{pw['description']}

- **Primary SOC Code:** {pw['primary_soc']} ({pw['soc_title']})
- **Median Annual Wage:** {pw['median_wage']}
- **Projected Growth:** {pw['growth']}
"""

    budget_table = "\n".join([
        f"| {name.replace('_', ' ').title()} | ${item['amount']:,.0f} | {item['description']} |"
        for name, item in budget["line_items"].items()
    ])

    proposal = f"""# PROPOSAL: {title}

## Submitted to: {agency}
## Submitted by: ANVIL -- AI Navigation & Vocational Integration Layer

**Solicitation/Opportunity:** {opp.get('solicitation_number', title)}

**Date Submitted:** [SUBMISSION DATE]

**Response Deadline:** {due_date}

**Proposed Amount:** ${amount:,.0f}

**Place of Performance:** {state}

---

## EXECUTIVE SUMMARY

ANVIL -- AI Navigation & Vocational Integration Layer proposes to deliver the **AI-Augmented Specialist Training Sprint**, a 7-day, 19-hour intensive workforce training program that prepares displaced and dislocated workers to become AI-augmented service specialists in high-demand community service niches.

This program directly addresses the growing crisis of AI-driven workforce displacement by training participants to work *with* artificial intelligence rather than compete against it. Graduates are equipped to deliver professional services in Government Benefits Navigation, Medical Bill Auditing, and Small Business Compliance -- fields where AI tools accelerate research but cannot replace human judgment, empathy, and verification.

**Key Program Metrics:**
- **Duration:** 7 days, 19 hours of structured instruction
- **Cost per participant:** ${budget['cost_per_participant']:,.0f} (well below typical ITA range of $3,000-$5,000)
- **Projected participants:** {budget['participants']}
- **Employment rate target (Q2):** {ANVIL_PROGRAM['outcomes']['employment_q2']}
- **Credential attainment:** {ANVIL_PROGRAM['outcomes']['credential_attainment']}
- **Time to first income:** 14 days post-completion

---

## 1. ORGANIZATIONAL BACKGROUND AND QUALIFICATIONS

### 1.1 About ANVIL

ANVIL exists to transition workers displaced by artificial intelligence into AI-augmented service specialists who serve their communities in high-demand, underserved niches. The program provides free, intensive training that equips participants to deliver professional-grade services in fields where AI tools accelerate research but cannot replace the human judgment, empathy, and verification that clients require.

### 1.2 Organizational Capacity

ANVIL has developed a comprehensive, replicable training model supported by:

- **Complete curriculum** covering 7 days of instruction across three career pathways
- **Structured playbooks** for Government Benefits Navigation, Medical Bill Auditing, and Small Business Compliance
- **Certification assessment system** with practical, performance-based evaluation
- **Outcomes tracking framework** aligned with all six WIOA Primary Indicators of Performance
- **Post-program support infrastructure** including 30/60/90/180-day follow-up protocols
- **Quality assurance processes** for AI-assisted service delivery

### 1.3 Relevant Experience

ANVIL's training methodology is built on direct experience with AI tool deployment in professional service contexts. The program design reflects practical understanding of which professional tasks AI can accelerate, which tasks require human judgment, and how to train adults to operate effectively at that intersection.

---

## 2. PROGRAM DESIGN

### 2.1 Program Overview

The AI-Augmented Specialist Training Sprint prepares adults for immediate entry into one of three career pathways through a structured 7-day intensive program. The program is delivered at no cost to participants.

**Key Program Characteristics:**
- Duration: 7 consecutive days, 19 hours of structured instruction
- Cost to participant: $0
- Delivery: {', '.join(ANVIL_PROGRAM['delivery_modes'])}
- Cohort size: {ANVIL_PROGRAM['cohort_size_min']}--{ANVIL_PROGRAM['cohort_size_max']} participants
- Credential: {ANVIL_PROGRAM['credential']}
- Employment model: Self-employment/freelance service delivery, with pathways to traditional employment

### 2.2 Target Population

The program serves the following WIOA-eligible populations:

{"".join(f"- {pop}" + chr(10) for pop in ANVIL_PROGRAM['target_populations'])}

### 2.3 Career Pathways
{pathways_detail}

### 2.4 Curriculum

| Day | Topic | Duration |
|-----|-------|----------|
{curriculum_table}

### 2.5 Training Methodology

ANVIL's training methodology is built on a foundational premise: in an increasing number of professional service fields, AI tools can perform 70-90% of the research and analysis work, but cannot replace the human functions of client relationship management, output verification, ethical judgment, and plain-language communication.

The model consists of four core competencies taught in sequence:

1. **AI Tool Proficiency:** Effective use of commercially available AI platforms (ChatGPT, Claude, Gemini, Perplexity) for research, analysis, and document generation.
2. **Niche-Specific Domain Knowledge:** Working knowledge of regulations, processes, and client needs in the chosen career pathway.
3. **Verification and Quality Assurance:** Systematic methods for verifying AI-generated outputs against authoritative primary sources.
4. **Client Service Delivery:** Professional intake procedures, communication, ethical boundaries, pricing, and follow-up protocols.

---

## 3. OUTCOMES AND PERFORMANCE

### 3.1 WIOA Primary Indicators of Performance

| Indicator | Target |
|-----------|--------|
| Program Completion Rate | {ANVIL_PROGRAM['outcomes']['completion_rate']} |
| Credential Attainment Rate | {ANVIL_PROGRAM['outcomes']['credential_attainment']} |
| Employment Rate, Q2 After Exit | {ANVIL_PROGRAM['outcomes']['employment_q2']} |
| Employment Rate, Q4 After Exit | {ANVIL_PROGRAM['outcomes']['employment_q4']} |
| Median Earnings, Q2 After Exit | {ANVIL_PROGRAM['outcomes']['median_earnings_q2']} |
| Measurable Skill Gains | {ANVIL_PROGRAM['outcomes']['measurable_skill_gains']} |

### 3.2 Outcomes Tracking

ANVIL maintains a comprehensive outcomes tracking system including:

- Enrollment data captured on Day 1
- Daily attendance and participation records
- Certification assessment results (Day 7)
- Post-program follow-up at 30, 60, 90, and 180 days
- Employment and earnings verification
- Quarterly reporting in state-required format

### 3.3 Data Collection Methods

- **Wage record match** through state workforce data systems (with participant consent)
- **Direct participant surveys** at each follow-up milestone
- **Self-employment verification** including business registration, client contracts, and revenue documentation
- **Credential verification** through ANVIL's assessment and certification system

---

## 4. SOC CODE ALIGNMENT

ANVIL's career pathways align with the following Standard Occupational Classification codes:

| SOC Code | Occupation Title |
|----------|-----------------|
{soc_table}

---

## 5. BUDGET NARRATIVE

### 5.1 Budget Summary

**Total Proposed Amount:** ${amount:,.0f}

**Projected Participants:** {budget['participants']}

**Cost Per Participant:** ${budget['cost_per_participant']:,.0f}

**Number of Cohorts:** {budget['cohorts']}

### 5.2 Line-Item Budget

| Category | Amount | Description |
|----------|--------|-------------|
{budget_table}
| **TOTAL** | **${budget['total']:,.0f}** | |

### 5.3 Cost Justification

The requested amount of ${budget['cost_per_participant']:,.0f} per participant is {round((1 - budget['cost_per_participant']/4000) * 100)}% below the national average WIOA Individual Training Account of $3,000-$5,000. This efficiency is achieved through:

- **AI-augmented instruction** reducing the need for multiple subject matter experts
- **7-day intensive format** minimizing facility and overhead costs compared to multi-week programs
- **Lean technology stack** using free-tier tools and open-source platforms
- **Scalable virtual delivery** reducing per-cohort facility costs
- **Streamlined administration** through automated enrollment and tracking systems

---

## 6. IMPLEMENTATION PLAN

### 6.1 Timeline

| Phase | Timeline | Activities |
|-------|----------|------------|
| Startup | Weeks 1-4 | Instructor recruitment, host site selection, technology setup, marketing launch |
| Cohort 1 | Weeks 5-6 | First cohort delivery (7 days), initial outcomes collection |
| Ramp-Up | Weeks 7-16 | Bi-weekly cohorts, process refinement, employer outreach |
| Steady State | Weeks 17-52 | Regular cohort delivery, quarterly reporting, program optimization |

### 6.2 Participant Recruitment

- Partnership with {state} American Job Centers for referrals of WIOA-eligible individuals
- Community outreach through workforce development partners, libraries, and community organizations
- Digital marketing targeting displaced workers searching for retraining opportunities
- Employer referrals for workers being displaced by AI adoption

### 6.3 Quality Assurance

- Pre/post assessments for measurable skill gains documentation
- Daily session evaluations by participants
- Certification assessment with standardized rubric
- Monthly curriculum review and updates based on participant feedback and industry changes
- Quarterly outcome reporting and program adjustment

---

## 7. SUSTAINABILITY

Beyond the proposed contract period, ANVIL sustains operations through:

- Expansion to additional WIOA service areas and Local Workforce Development Boards
- ETPL listing enabling Individual Training Account referrals across {state}
- Private-pay enrollment for participants not eligible for WIOA funding
- Institutional partnerships with community colleges and workforce agencies
- Employer-sponsored training for organizations managing AI-driven workforce transitions

---

## 8. AUTHORIZED REPRESENTATIVE

**Organization:** ANVIL -- AI Navigation & Vocational Integration Layer

**Authorized Representative:** [NAME]

**Title:** [TITLE]

**Address:** [ADDRESS]

**Phone:** [PHONE]

**Email:** [EMAIL]

**Date:** [DATE]

**Signature:** ____________________________

---

*This proposal is submitted in response to {title} and represents ANVIL's commitment to delivering measurable workforce development outcomes in {state}. ANVIL certifies that all information contained herein is accurate and that the organization has the capacity to deliver the proposed program.*
"""
    return proposal


def generate_letter_of_interest(opp, budget):
    """Generate a shorter letter of interest / capability statement."""
    state = opp.get("state", "[STATE]")
    agency = opp.get("agency", "[AGENCY NAME]")
    amount = opp.get("dollar_amount") or budget["total"]
    title = opp.get("title", "[OPPORTUNITY TITLE]")

    return f"""# LETTER OF INTEREST

**To:** {agency}

**From:** ANVIL -- AI Navigation & Vocational Integration Layer

**Re:** {title}

**Date:** [DATE]

---

Dear Selection Committee,

ANVIL -- AI Navigation & Vocational Integration Layer respectfully submits this letter of interest in response to the above-referenced opportunity. We believe our AI-Augmented Specialist Training Sprint program is uniquely positioned to deliver measurable workforce development outcomes for {state}'s displaced and dislocated workers.

## About ANVIL

ANVIL delivers a **7-day, 19-hour intensive training program** that transforms workers displaced by artificial intelligence into AI-augmented service specialists. Graduates are equipped to deliver professional services in:

1. **Government Benefits Navigation** -- Helping residents access SNAP, Medicaid, LIHEAP, SSI/SSDI, and 15+ programs
2. **Medical Bill Auditing** -- Finding billing errors (present in ~80% of hospital bills) and negotiating reductions
3. **Small Business Compliance** -- Identifying permits, licenses, and regulatory requirements

## Why ANVIL

- **Cost-effective:** ${budget['cost_per_participant']:,.0f} per participant vs. $3,000-$5,000 industry average
- **Fast results:** 7-day program; graduates serving clients within 14 days
- **Community impact:** Every graduate directly serves residents in your service area
- **WIOA-aligned:** Full compliance with Section 116 performance indicators
- **Projected employment rate:** {ANVIL_PROGRAM['outcomes']['employment_q2']} at Q2 after exit

## Proposed Scope

For the requested amount of ${amount:,.0f}, ANVIL proposes to train approximately {budget['participants']} participants across {budget['cohorts']} cohorts, delivered at host sites or virtually within {state}. Each participant earns the ANVIL AI-Augmented Specialist Certification through a performance-based assessment.

## Relevant SOC Codes

Our program aligns with SOC codes 21-1093 (Social and Human Service Assistants), 13-2011 (Accountants and Auditors), and 13-1041 (Compliance Officers), among others. All pathways lead to occupations with positive growth outlooks and median wages above the state minimum.

## Next Steps

We welcome the opportunity to provide a full proposal, present to your board, or discuss a pilot engagement. Full program documentation, curriculum materials, and outcome tracking methodology are available upon request.

Respectfully,

[AUTHORIZED REPRESENTATIVE NAME]
[TITLE]
ANVIL -- AI Navigation & Vocational Integration Layer
[PHONE] | [EMAIL] | [WEBSITE]
"""


def generate_capability_statement(opp, budget):
    """Generate a one-page capability statement."""
    state = opp.get("state", "[STATE]")

    return f"""# ANVIL -- Capability Statement

## AI Navigation & Vocational Integration Layer
## Workforce Training Provider

---

**NAICS Codes:** 611430 (Professional Development Training), 611710 (Educational Support Services)

**UEI:** [UEI NUMBER]

**CAGE Code:** [CAGE CODE]

**Size Standard:** Small Business

---

## Core Competency

7-day intensive workforce training program converting AI-displaced workers into AI-augmented service specialists in Government Benefits Navigation, Medical Bill Auditing, and Small Business Compliance.

## Key Differentiators

| Factor | ANVIL | Industry Average |
|--------|-------|------------------|
| Training Duration | 7 days (19 hours) | 12-24 weeks |
| Cost Per Participant | $2,000-3,000 | $5,000-10,000 |
| Time to Employment | 14 days | 3-6 months |
| WIOA Credential | Yes (performance-based) | Varies |
| Direct Community Service | Yes | Indirect |

## Performance Targets

- Completion Rate: {ANVIL_PROGRAM['outcomes']['completion_rate']}
- Employment Rate (Q2): {ANVIL_PROGRAM['outcomes']['employment_q2']}
- Credential Attainment: {ANVIL_PROGRAM['outcomes']['credential_attainment']}
- Median Earnings (Q2): {ANVIL_PROGRAM['outcomes']['median_earnings_q2']}

## Career Pathways & SOC Codes

- **Benefits Navigation:** SOC 21-1093, 43-4061, 21-1094
- **Medical Bill Auditing:** SOC 13-2011, 43-3011, 43-9041
- **Business Compliance:** SOC 13-1041, 13-1199, 43-4199

## Target Populations

Dislocated workers, long-term unemployed, underemployed adults, low-income adults, individuals with barriers to employment -- with focus on workers displaced by AI adoption.

## Past Performance

[TO BE COMPLETED after initial cohorts]

## Contact

[NAME] | [TITLE]
[PHONE] | [EMAIL]
[ADDRESS]
[WEBSITE]
"""


# ---------------------------------------------------------------------------
# Opportunity Loader
# ---------------------------------------------------------------------------

def load_opportunity_from_tracker(opp_id):
    """Load an opportunity from the bid tracker database."""
    if not TRACKER_PATH.exists():
        print(f"ERROR: Tracker database not found at {TRACKER_PATH}")
        print("Run bid-scanner.py then bid-tracker.py first.")
        return None

    with open(TRACKER_PATH, "r") as f:
        tracker = json.load(f)

    opps = tracker.get("opportunities", {})

    # Exact match
    if opp_id in opps:
        return opps[opp_id]

    # Prefix match
    for oid, opp in opps.items():
        if oid.startswith(opp_id):
            return opp

    # Title search
    for oid, opp in opps.items():
        if opp_id.lower() in opp.get("title", "").lower():
            return opp

    print(f"ERROR: Opportunity '{opp_id}' not found in tracker")
    return None


def create_manual_opportunity(args):
    """Create an opportunity dict from manual CLI args."""
    return {
        "id": f"manual-{datetime.now().strftime('%Y%m%d%H%M%S')}",
        "source": "manual",
        "title": args.title or "[OPPORTUNITY TITLE]",
        "agency": args.agency or "[AGENCY NAME]",
        "dollar_amount": args.amount,
        "due_date": args.due_date or "",
        "state": (args.state or "").upper(),
        "solicitation_number": args.solicitation or "",
        "link": args.link or "",
        "naics_code": "",
        "match_score": 0,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="ANVIL Application Generator -- Build customized proposals from templates",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Application types:
  proposal              Full RFP response (default)
  letter-of-interest    Shorter LOI for initial expressions
  capability            One-page capability statement

Examples:
  python application-generator.py --opportunity abc123
  python application-generator.py --opportunity abc123 --type letter-of-interest
  python application-generator.py --manual --title "CA Workforce Training" --agency "EDD" --amount 100000 --state CA
  python application-generator.py --list-templates

IMPORTANT: All generated applications require HUMAN REVIEW before submission.
Bracketed fields [LIKE THIS] must be filled in manually.
        """,
    )

    parser.add_argument("--opportunity", "-o", help="Opportunity ID from bid-tracker (prefix match)")
    parser.add_argument("--type", "-t", default="proposal",
                       choices=["proposal", "letter-of-interest", "capability"],
                       help="Application type (default: proposal)")
    parser.add_argument("--manual", action="store_true", help="Create from manual input instead of tracker")
    parser.add_argument("--title", help="Opportunity title (with --manual)")
    parser.add_argument("--agency", help="Agency name (with --manual)")
    parser.add_argument("--amount", type=float, help="Dollar amount (with --manual)")
    parser.add_argument("--state", help="State code (with --manual)")
    parser.add_argument("--due-date", help="Due date YYYY-MM-DD (with --manual)")
    parser.add_argument("--solicitation", help="Solicitation number (with --manual)")
    parser.add_argument("--link", help="Opportunity URL (with --manual)")
    parser.add_argument("--participants", type=int, help="Override participant count")
    parser.add_argument("--output", "-O", help="Custom output file path")
    parser.add_argument("--list-templates", action="store_true", help="List available templates")
    parser.add_argument("--stdout", action="store_true", help="Print to stdout instead of file")

    args = parser.parse_args()

    # List templates
    if args.list_templates:
        print("\nAvailable Application Templates:")
        print("=" * 50)
        print("  proposal            Full RFP response / grant application")
        print("                      Includes: executive summary, program design,")
        print("                      outcomes, SOC codes, budget narrative,")
        print("                      implementation plan, sustainability")
        print()
        print("  letter-of-interest  Shorter expression of interest")
        print("                      Includes: overview, qualifications, scope,")
        print("                      SOC codes, contact info")
        print()
        print("  capability          One-page capability statement")
        print("                      Includes: core competency, differentiators,")
        print("                      performance targets, NAICS/SOC codes")
        print()
        print("WIOA Reference Documents (in wioa/ directory):")
        if WIOA_DIR.exists():
            for f in sorted(WIOA_DIR.glob("*.md")):
                print(f"  - {f.name}")
        return

    # Load or create opportunity
    if args.manual:
        opp = create_manual_opportunity(args)
    elif args.opportunity:
        opp = load_opportunity_from_tracker(args.opportunity)
        if not opp:
            sys.exit(1)
    else:
        print("ERROR: Provide --opportunity <ID> or use --manual with details")
        print("Run: python application-generator.py --help")
        sys.exit(1)

    # Scale budget
    amount = args.amount or opp.get("dollar_amount") or 100000
    budget = scale_budget(amount, args.participants)

    # Generate application
    print(f"\nGenerating {args.type} for: {opp.get('title', 'Unknown')[:60]}")
    print(f"  Amount: ${amount:,.0f} | Participants: {budget['participants']} | State: {opp.get('state', 'N/A')}")

    generators = {
        "proposal": generate_full_proposal,
        "letter-of-interest": generate_letter_of_interest,
        "capability": generate_capability_statement,
    }

    content = generators[args.type](opp, budget)

    # Add generation metadata footer
    content += f"""

---

*Generated by ANVIL Application Generator on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*

*Source: {opp.get('source', 'manual')} | Opportunity ID: {opp.get('id', 'N/A')}*

*IMPORTANT: This document was auto-generated from templates and MUST be reviewed*
*by a human before submission. All fields marked with [BRACKETS] require manual entry.*
*Verify all claims, numbers, and compliance requirements against the specific solicitation.*
"""

    # Output
    if args.stdout:
        print(content)
    else:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        if args.output:
            output_path = Path(args.output)
        else:
            date_str = datetime.now().strftime("%Y%m%d")
            opp_id = opp.get("id", "manual")[:12]
            output_path = OUTPUT_DIR / f"app-{opp_id}-{args.type}-{date_str}.md"

        with open(output_path, "w") as f:
            f.write(content)

        print(f"\n  Application saved to: {output_path}")
        print(f"  Type: {args.type}")
        print(f"  Word count: ~{len(content.split())}")
        print()
        print("  NEXT STEPS:")
        print("  1. Review the entire document")
        print("  2. Fill in all [BRACKETED] fields with actual information")
        print("  3. Verify budget numbers match the solicitation requirements")
        print("  4. Check SOC codes against the specific state's accepted codes")
        print("  5. Have a second person proofread before submission")
        print("  6. Submit through the designated channel (SAM.gov, email, portal)")
        print()
        print("  DO NOT auto-submit. Human review is required.")


if __name__ == "__main__":
    main()
