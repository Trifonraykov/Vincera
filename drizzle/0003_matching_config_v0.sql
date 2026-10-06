-- Custom migration: matching v0 weights from CLAUDE.md §8, active by default.
-- matches.model_version references matching_config.model_version, so v0 must exist everywhere.
-- The id is a fixed UUIDv7 (Postgres 16 has no uuidv7()).
INSERT INTO "matching_config" ("id", "model_version", "weights", "active", "notes")
VALUES (
  '01999a6c-6a00-7000-8000-000000000000',
  'v0',
  '{"semantic": 0.35, "topic_overlap": 0.20, "audience_fit": 0.15, "format_fit": 0.10, "stage_fit": 0.10, "price_fit": 0.05, "reliability": 0.05}'::jsonb,
  true,
  'Hand-tuned v0 weights (CLAUDE.md §8).'
)
ON CONFLICT ("model_version") DO NOTHING;
