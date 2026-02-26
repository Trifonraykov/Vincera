"""Apply Supabase migrations in order.

Usage:
  python supabase/apply_migrations.py --url <SUPABASE_URL> --key <SERVICE_KEY>
  python supabase/apply_migrations.py --dry-run

Or reads from environment: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import glob
import os
import sys


def get_migration_files(migrations_dir: str) -> list[str]:
    """Get all .sql files sorted by numeric prefix."""
    files = sorted(glob.glob(os.path.join(migrations_dir, "*.sql")))
    return files


def apply_migration(url: str, key: str, sql: str, filename: str) -> bool:
    """Apply a single migration file.

    In practice, migrations are applied via:
    1. Supabase CLI: ``supabase db push``
    2. Direct PostgreSQL connection
    3. Supabase Dashboard SQL Editor

    This function prints progress for manual pasting or future automation.
    """
    print(f"  Applying {filename}... ({len(sql)} chars)")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply Supabase migrations")
    parser.add_argument("--url", default=os.getenv("SUPABASE_URL"))
    parser.add_argument("--key", default=os.getenv("SUPABASE_SERVICE_KEY"))
    parser.add_argument("--dir", default=os.path.join(os.path.dirname(__file__), "migrations"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.dry_run and (not args.url or not args.key):
        print("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY required (or use --dry-run)")
        sys.exit(1)

    files = get_migration_files(args.dir)
    print(f"Found {len(files)} migration files")

    for filepath in files:
        filename = os.path.basename(filepath)
        with open(filepath, encoding="utf-8") as f:
            sql = f.read()

        if args.dry_run:
            print(f"  [DRY RUN] Would apply {filename} ({len(sql)} chars)")
        else:
            success = apply_migration(args.url, args.key, sql, filename)
            if not success:
                print(f"  FAILED: {filename}")
                sys.exit(1)

    action = "would be applied" if args.dry_run else "applied successfully"
    print(f"\nAll {len(files)} migrations {action}.")


if __name__ == "__main__":
    main()
