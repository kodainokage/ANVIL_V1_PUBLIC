#!/usr/bin/env python3
"""
ANVIL Bid Tracker -- Opportunity Pipeline Management

Reads bid-scanner output and maintains a persistent tracking database.
Manages opportunity lifecycle: new -> reviewing -> preparing -> submitted -> awarded/rejected.

Usage:
    python bid-tracker.py                        # Import latest scan + show digest
    python bid-tracker.py --import scan-file.json  # Import specific scan
    python bid-tracker.py --digest                 # Show daily digest
    python bid-tracker.py --status reviewing       # List by status
    python bid-tracker.py --update ID --status preparing  # Update status
    python bid-tracker.py --urgent                 # Show urgent deadlines
    python bid-tracker.py --stats                  # Show pipeline statistics
    python bid-tracker.py --export csv             # Export to CSV

Output: data/bid-tracker.json (persistent database)
"""

import argparse
import csv
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
SCAN_DIR = PROJECT_DIR / "data" / "opportunities"
TRACKER_PATH = PROJECT_DIR / "data" / "bid-tracker.json"
DIGEST_DIR = PROJECT_DIR / "data" / "digests"

VALID_STATUSES = [
    "new",          # Just discovered by scanner
    "reviewing",    # Being evaluated for fit
    "preparing",    # Application in progress
    "submitted",    # Application submitted
    "awarded",      # We won!
    "rejected",     # We lost or chose not to pursue
    "expired",      # Deadline passed without submission
    "watching",     # Interesting but not pursuing yet
]

# ---------------------------------------------------------------------------
# Tracker Database
# ---------------------------------------------------------------------------

class BidTracker:
    """
    JSON-file-backed opportunity tracking database.

    Schema:
    {
        "metadata": { "created", "last_updated", "version" },
        "opportunities": {
            "<id>": {
                "id", "source", "title", "agency", "dollar_amount",
                "due_date", "state", "link", "match_score",
                "status", "status_history": [{"status", "date", "notes"}],
                "notes", "assigned_to", "follow_up_date",
                "first_seen", "last_updated",
                "application_file", "submission_date",
                "result_date", "result_notes"
            }
        },
        "statistics": { ... }
    }
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else TRACKER_PATH
        self.data = self._load()

    def _load(self):
        """Load tracker database or create new one."""
        if self.path.exists():
            try:
                with open(self.path, "r") as f:
                    data = json.load(f)
                return data
            except (json.JSONDecodeError, IOError) as e:
                print(f"WARNING: Could not load tracker at {self.path}: {e}")
                print("Creating new tracker database.")
        return self._create_new()

    def _create_new(self):
        """Create empty tracker database."""
        return {
            "metadata": {
                "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "version": "1.0",
                "total_imported": 0,
            },
            "opportunities": {},
            "import_history": [],
        }

    def save(self):
        """Persist tracker to disk."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data["metadata"]["last_updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2, default=str)

    def import_scan(self, scan_file):
        """
        Import opportunities from a scan result file.

        Returns: (new_count, updated_count, skipped_count)
        """
        scan_path = Path(scan_file)
        if not scan_path.exists():
            # Try looking in the scan directory
            scan_path = SCAN_DIR / scan_file
        if not scan_path.exists():
            print(f"ERROR: Scan file not found: {scan_file}")
            return 0, 0, 0

        with open(scan_path, "r") as f:
            scan_data = json.load(f)

        opportunities = scan_data.get("opportunities", [])
        new_count = 0
        updated_count = 0
        skipped_count = 0

        for opp in opportunities:
            opp_id = opp.get("id")
            if not opp_id:
                skipped_count += 1
                continue

            if opp_id in self.data["opportunities"]:
                # Update existing: refresh score, due date, etc. but keep status
                existing = self.data["opportunities"][opp_id]
                existing["match_score"] = opp.get("match_score", existing.get("match_score", 0))
                existing["due_date"] = opp.get("due_date") or existing.get("due_date", "")
                existing["dollar_amount"] = opp.get("dollar_amount") or existing.get("dollar_amount")
                existing["last_updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                existing["active"] = opp.get("active", True)

                # Auto-expire if deadline passed
                if existing.get("due_date") and existing.get("status") not in ("submitted", "awarded", "rejected"):
                    try:
                        due = datetime.strptime(existing["due_date"], "%Y-%m-%d")
                        if due < datetime.now():
                            existing["status"] = "expired"
                            existing.setdefault("status_history", []).append({
                                "status": "expired",
                                "date": datetime.now().strftime("%Y-%m-%d"),
                                "notes": "Auto-expired: deadline passed",
                            })
                    except ValueError:
                        pass

                updated_count += 1
            else:
                # New opportunity
                self.data["opportunities"][opp_id] = {
                    "id": opp_id,
                    "source": opp.get("source", ""),
                    "source_id": opp.get("source_id", ""),
                    "title": opp.get("title", ""),
                    "solicitation_number": opp.get("solicitation_number", ""),
                    "type": opp.get("type", ""),
                    "agency": opp.get("agency", ""),
                    "dollar_amount": opp.get("dollar_amount"),
                    "due_date": opp.get("due_date", ""),
                    "state": opp.get("state", ""),
                    "naics_code": opp.get("naics_code", ""),
                    "link": opp.get("link", ""),
                    "contact_name": opp.get("contact_name", ""),
                    "contact_email": opp.get("contact_email", ""),
                    "match_score": opp.get("match_score", 0),
                    "active": opp.get("active", True),
                    "status": "new",
                    "status_history": [
                        {
                            "status": "new",
                            "date": datetime.now().strftime("%Y-%m-%d"),
                            "notes": f"Imported from {scan_path.name}",
                        }
                    ],
                    "notes": "",
                    "assigned_to": "",
                    "follow_up_date": "",
                    "first_seen": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "application_file": "",
                    "submission_date": "",
                    "result_date": "",
                    "result_notes": "",
                    "urgent": opp.get("urgent", False),
                    "days_until_due": opp.get("days_until_due"),
                }
                new_count += 1

        self.data["metadata"]["total_imported"] = (
            self.data["metadata"].get("total_imported", 0) + new_count
        )
        self.data["import_history"].append({
            "file": str(scan_path.name),
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "new": new_count,
            "updated": updated_count,
            "skipped": skipped_count,
        })

        self.save()
        return new_count, updated_count, skipped_count

    def update_status(self, opp_id, new_status, notes=""):
        """Update the status of an opportunity."""
        if new_status not in VALID_STATUSES:
            print(f"ERROR: Invalid status '{new_status}'")
            print(f"Valid statuses: {', '.join(VALID_STATUSES)}")
            return False

        # Find by full ID or partial match
        matched = None
        for oid, opp in self.data["opportunities"].items():
            if oid == opp_id or oid.startswith(opp_id):
                matched = opp
                break

        if not matched:
            print(f"ERROR: Opportunity '{opp_id}' not found")
            return False

        old_status = matched["status"]
        matched["status"] = new_status
        matched["last_updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        matched.setdefault("status_history", []).append({
            "status": new_status,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "notes": notes or f"Changed from {old_status}",
        })

        self.save()
        print(f"Updated: {matched['title'][:60]}")
        print(f"  Status: {old_status} -> {new_status}")
        return True

    def get_by_status(self, status):
        """Get all opportunities with a given status."""
        return [
            opp for opp in self.data["opportunities"].values()
            if opp.get("status") == status
        ]

    def get_urgent(self):
        """Get opportunities with deadlines within 14 days."""
        urgent = []
        for opp in self.data["opportunities"].values():
            if opp.get("status") in ("expired", "rejected", "awarded"):
                continue
            if opp.get("due_date"):
                try:
                    due = datetime.strptime(opp["due_date"], "%Y-%m-%d")
                    days_left = (due - datetime.now()).days
                    if 0 < days_left <= 14:
                        opp["days_until_due"] = days_left
                        urgent.append(opp)
                except ValueError:
                    pass
        urgent.sort(key=lambda x: x.get("days_until_due", 999))
        return urgent

    def get_statistics(self):
        """Calculate pipeline statistics."""
        opps = self.data["opportunities"].values()
        total = len(list(opps))

        status_counts = {}
        for status in VALID_STATUSES:
            count = len([o for o in self.data["opportunities"].values() if o.get("status") == status])
            if count > 0:
                status_counts[status] = count

        # Dollar amounts by status
        dollar_by_status = {}
        for status in VALID_STATUSES:
            amounts = [
                o.get("dollar_amount", 0) or 0
                for o in self.data["opportunities"].values()
                if o.get("status") == status and o.get("dollar_amount")
            ]
            if amounts:
                dollar_by_status[status] = {
                    "total": sum(amounts),
                    "average": sum(amounts) / len(amounts),
                    "count": len(amounts),
                }

        # Source breakdown
        source_counts = {}
        for opp in self.data["opportunities"].values():
            src = opp.get("source", "unknown")
            source_counts[src] = source_counts.get(src, 0) + 1

        # State breakdown (top 10)
        state_counts = {}
        for opp in self.data["opportunities"].values():
            st = opp.get("state", "")
            if st:
                state_counts[st] = state_counts.get(st, 0) + 1
        top_states = sorted(state_counts.items(), key=lambda x: x[1], reverse=True)[:10]

        return {
            "total_tracked": total,
            "by_status": status_counts,
            "dollar_pipeline": dollar_by_status,
            "by_source": source_counts,
            "top_states": dict(top_states),
            "urgent_count": len(self.get_urgent()),
            "imports": len(self.data.get("import_history", [])),
        }


# ---------------------------------------------------------------------------
# Digest Generation
# ---------------------------------------------------------------------------

def generate_digest(tracker):
    """Generate a daily digest of the opportunity pipeline."""
    stats = tracker.get_statistics()
    urgent = tracker.get_urgent()
    new_opps = tracker.get_by_status("new")
    preparing = tracker.get_by_status("preparing")
    submitted = tracker.get_by_status("submitted")

    lines = []
    lines.append("=" * 70)
    lines.append(f"ANVIL BID TRACKER -- DAILY DIGEST")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("=" * 70)

    # Pipeline overview
    lines.append(f"\nPIPELINE OVERVIEW")
    lines.append(f"-" * 40)
    lines.append(f"  Total tracked:  {stats['total_tracked']}")
    for status, count in stats.get("by_status", {}).items():
        marker = ">>>" if status == "new" else "   "
        lines.append(f"  {marker} {status:15s}: {count}")

    # URGENT deadlines
    if urgent:
        lines.append(f"\n{'!'*70}")
        lines.append(f"  URGENT DEADLINES ({len(urgent)} opportunities)")
        lines.append(f"{'!'*70}")
        for opp in urgent:
            days = opp.get("days_until_due", "?")
            lines.append(f"\n  [{days}d] {opp['title'][:60]}")
            lines.append(f"       Status: {opp['status']} | Score: {opp.get('match_score', 0)}")
            lines.append(f"       Due: {opp.get('due_date', 'N/A')} | Amount: {format_currency(opp.get('dollar_amount'))}")
            lines.append(f"       Agency: {opp.get('agency', 'N/A')[:50]}")
            lines.append(f"       Link: {opp.get('link', 'N/A')}")
    else:
        lines.append(f"\n  No urgent deadlines (next 14 days).")

    # New opportunities
    if new_opps:
        # Sort by score
        new_opps.sort(key=lambda x: x.get("match_score", 0), reverse=True)
        lines.append(f"\n--- NEW OPPORTUNITIES ({len(new_opps)}) ---")
        for opp in new_opps[:15]:
            lines.append(f"\n  [{opp.get('match_score', 0):5.1f}] {opp['title'][:60]}")
            lines.append(f"       Source: {opp['source']} | State: {opp.get('state', 'N/A')}")
            lines.append(f"       Due: {opp.get('due_date', 'N/A')} | Amount: {format_currency(opp.get('dollar_amount'))}")
            lines.append(f"       Agency: {opp.get('agency', 'N/A')[:50]}")
        if len(new_opps) > 15:
            lines.append(f"\n  ... and {len(new_opps) - 15} more. Run: python bid-tracker.py --status new")

    # In-progress
    if preparing:
        lines.append(f"\n--- IN PROGRESS ({len(preparing)}) ---")
        for opp in preparing:
            lines.append(f"  - {opp['title'][:55]} | Due: {opp.get('due_date', 'N/A')}")

    # Submitted
    if submitted:
        lines.append(f"\n--- SUBMITTED ({len(submitted)}) ---")
        for opp in submitted:
            lines.append(f"  - {opp['title'][:55]} | Submitted: {opp.get('submission_date', 'N/A')}")

    # Dollar pipeline
    dollar_stats = stats.get("dollar_pipeline", {})
    if dollar_stats:
        lines.append(f"\n--- DOLLAR PIPELINE ---")
        for status, data in dollar_stats.items():
            lines.append(f"  {status:15s}: {format_currency(data['total'])} "
                        f"({data['count']} opps, avg {format_currency(data['average'])})")

    lines.append(f"\n{'='*70}")
    lines.append(f"Actions:")
    lines.append(f"  Review new:    python bid-tracker.py --status new")
    lines.append(f"  See urgent:    python bid-tracker.py --urgent")
    lines.append(f"  Update status: python bid-tracker.py --update <ID> --status reviewing")
    lines.append(f"  Generate app:  python application-generator.py --opportunity <ID>")
    lines.append(f"  Full stats:    python bid-tracker.py --stats")
    lines.append(f"{'='*70}")

    return "\n".join(lines)


def generate_email_digest(tracker):
    """Generate an email-formatted daily digest."""
    stats = tracker.get_statistics()
    urgent = tracker.get_urgent()
    new_opps = sorted(
        tracker.get_by_status("new"),
        key=lambda x: x.get("match_score", 0),
        reverse=True,
    )

    lines = []
    lines.append(f"Subject: ANVIL Bid Pipeline -- {datetime.now().strftime('%b %d')} "
                 f"| {len(new_opps)} New | {len(urgent)} Urgent")
    lines.append("")
    lines.append(f"ANVIL Government Opportunity Pipeline")
    lines.append(f"Daily Digest -- {datetime.now().strftime('%B %d, %Y')}")
    lines.append("")

    if urgent:
        lines.append(f"URGENT ({len(urgent)} deadlines within 14 days):")
        for opp in urgent:
            lines.append(f"  - [{opp.get('days_until_due', '?')}d] {opp['title'][:50]}")
            lines.append(f"    {opp.get('link', '')}")
        lines.append("")

    if new_opps[:5]:
        lines.append(f"Top New Opportunities:")
        for opp in new_opps[:5]:
            lines.append(f"  - [Score: {opp.get('match_score', 0)}] {opp['title'][:50]}")
            lines.append(f"    Due: {opp.get('due_date', 'N/A')} | {format_currency(opp.get('dollar_amount'))}")
            lines.append(f"    {opp.get('link', '')}")
        lines.append("")

    lines.append(f"Pipeline: {stats['total_tracked']} tracked | "
                 f"{stats.get('by_status', {}).get('preparing', 0)} preparing | "
                 f"{stats.get('by_status', {}).get('submitted', 0)} submitted")
    lines.append("")
    lines.append("Run: python bid-tracker.py --digest for full details")

    return "\n".join(lines)


def format_currency(amount):
    """Format a number as currency."""
    if amount is None:
        return "N/A"
    if amount >= 1_000_000:
        return f"${amount/1_000_000:.1f}M"
    elif amount >= 1_000:
        return f"${amount/1_000:.0f}K"
    return f"${amount:,.0f}"


def export_csv(tracker, output_path):
    """Export tracked opportunities to CSV."""
    opps = list(tracker.data["opportunities"].values())
    if not opps:
        print("No opportunities to export.")
        return

    fields = [
        "id", "title", "source", "agency", "status", "match_score",
        "dollar_amount", "due_date", "state", "naics_code", "link",
        "contact_name", "contact_email", "notes", "first_seen",
    ]

    output = Path(output_path) if output_path else PROJECT_DIR / "data" / "bid-pipeline-export.csv"
    output.parent.mkdir(parents=True, exist_ok=True)

    with open(output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        # Sort by score descending
        opps.sort(key=lambda x: x.get("match_score", 0), reverse=True)
        writer.writerows(opps)

    print(f"Exported {len(opps)} opportunities to {output}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="ANVIL Bid Tracker -- Government opportunity pipeline management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Status lifecycle:
  new -> reviewing -> preparing -> submitted -> awarded/rejected
  new -> watching (park for later)
  new -> expired (deadline passed)

Examples:
  python bid-tracker.py                              # Import latest + digest
  python bid-tracker.py --import scan-20260302.json  # Import specific scan
  python bid-tracker.py --digest                     # Daily digest
  python bid-tracker.py --email-digest               # Email-format digest
  python bid-tracker.py --status new                 # List new opportunities
  python bid-tracker.py --update abc123 --status reviewing --notes "Looks promising"
  python bid-tracker.py --urgent                     # Urgent deadlines
  python bid-tracker.py --stats                      # Pipeline statistics
  python bid-tracker.py --export csv                 # Export to CSV
        """,
    )
    parser.add_argument(
        "--import", dest="import_file",
        help="Import a scan result file (default: latest in data/opportunities/)",
    )
    parser.add_argument("--digest", action="store_true", help="Show daily digest")
    parser.add_argument("--email-digest", action="store_true", help="Email-format digest")
    parser.add_argument("--status", help="List opportunities by status")
    parser.add_argument("--update", metavar="ID", help="Update opportunity by ID (prefix match)")
    parser.add_argument("--set-status", dest="new_status", help="New status (with --update)")
    parser.add_argument("--notes", default="", help="Notes for status update")
    parser.add_argument("--urgent", action="store_true", help="Show urgent deadlines")
    parser.add_argument("--stats", action="store_true", help="Show pipeline statistics")
    parser.add_argument("--export", choices=["csv"], help="Export tracked opportunities")
    parser.add_argument("--export-path", help="Custom export file path")

    args = parser.parse_args()
    tracker = BidTracker()

    # Default action: import latest scan + show digest
    if not any([
        args.import_file, args.digest, args.email_digest,
        args.status, args.update, args.urgent, args.stats, args.export,
    ]):
        # Find latest scan file
        if SCAN_DIR.exists():
            scans = sorted(SCAN_DIR.glob("scan-*.json"), reverse=True)
            if scans:
                latest = scans[0]
                print(f"Importing latest scan: {latest.name}")
                new, updated, skipped = tracker.import_scan(str(latest))
                print(f"  New: {new} | Updated: {updated} | Skipped: {skipped}")
                print()
            else:
                print("No scan files found. Run bid-scanner.py first.")
                print()

        print(generate_digest(tracker))
        return

    # Import scan
    if args.import_file:
        new, updated, skipped = tracker.import_scan(args.import_file)
        print(f"Import complete: New={new}, Updated={updated}, Skipped={skipped}")

    # Show digest
    if args.digest:
        print(generate_digest(tracker))

    # Email digest
    if args.email_digest:
        print(generate_email_digest(tracker))

    # List by status
    if args.status:
        opps = tracker.get_by_status(args.status)
        if not opps:
            print(f"No opportunities with status '{args.status}'")
            return
        opps.sort(key=lambda x: x.get("match_score", 0), reverse=True)
        print(f"\n--- {args.status.upper()} ({len(opps)}) ---\n")
        for opp in opps:
            print(f"  [{opp.get('match_score', 0):5.1f}] {opp['title'][:60]}")
            print(f"       ID: {opp['id']}")
            print(f"       Source: {opp['source']} | State: {opp.get('state', 'N/A')}")
            print(f"       Due: {opp.get('due_date', 'N/A')} | Amount: {format_currency(opp.get('dollar_amount'))}")
            print(f"       Agency: {opp.get('agency', 'N/A')[:50]}")
            print(f"       Link: {opp.get('link', 'N/A')}")
            if opp.get("notes"):
                print(f"       Notes: {opp['notes'][:60]}")
            print()

    # Update status
    if args.update:
        if not args.new_status:
            print("ERROR: --set-status required with --update")
            print(f"Valid statuses: {', '.join(VALID_STATUSES)}")
            return
        tracker.update_status(args.update, args.new_status, args.notes)

    # Urgent deadlines
    if args.urgent:
        urgent = tracker.get_urgent()
        if not urgent:
            print("No urgent deadlines (next 14 days). You're good.")
            return
        print(f"\n--- URGENT DEADLINES ({len(urgent)}) ---\n")
        for opp in urgent:
            days = opp.get("days_until_due", "?")
            print(f"  [{days}d left] {opp['title'][:55]}")
            print(f"       ID: {opp['id']}")
            print(f"       Status: {opp['status']} | Score: {opp.get('match_score', 0)}")
            print(f"       Due: {opp['due_date']} | Amount: {format_currency(opp.get('dollar_amount'))}")
            print(f"       Link: {opp.get('link', 'N/A')}")
            print()

    # Statistics
    if args.stats:
        stats = tracker.get_statistics()
        print(f"\n{'='*50}")
        print(f"ANVIL BID PIPELINE STATISTICS")
        print(f"{'='*50}")
        print(f"\nTotal tracked: {stats['total_tracked']}")
        print(f"Imports run:   {stats['imports']}")
        print(f"Urgent now:    {stats['urgent_count']}")
        print(f"\nBy Status:")
        for status, count in stats.get("by_status", {}).items():
            bar = "#" * min(count, 40)
            print(f"  {status:15s}: {count:4d} {bar}")
        print(f"\nBy Source:")
        for source, count in stats.get("by_source", {}).items():
            print(f"  {source:20s}: {count}")
        print(f"\nTop States:")
        for state, count in stats.get("top_states", {}).items():
            print(f"  {state}: {count}")
        dollar_stats = stats.get("dollar_pipeline", {})
        if dollar_stats:
            print(f"\nDollar Pipeline:")
            for status, data in dollar_stats.items():
                print(f"  {status:15s}: {format_currency(data['total'])} total "
                      f"({data['count']} opps)")

    # Export
    if args.export:
        export_csv(tracker, args.export_path)


if __name__ == "__main__":
    main()
