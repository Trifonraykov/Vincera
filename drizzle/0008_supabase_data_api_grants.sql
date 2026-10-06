-- Custom migration: keep Supabase's auto-generated Data API away from the platform's tables.
--
-- On Supabase, PostgREST serves the `public` schema to the `anon` and `authenticated` roles, and
-- the project's default privileges grant those roles every table and sequence the migrations
-- create. The platform never uses that API: the app connects as the tables' owner (the role that
-- runs these migrations). Row-level security without policies (0007) already hides every row from
-- them; this also revokes their grants, and the default privileges for objects created later, so
-- the API neither lists nor touches the tables. The service_role key keeps its access: it is a
-- server secret and the platform never hands it out.
-- On plain Postgres or Neon these roles do not exist and nothing happens.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role
      );
    END IF;
  END LOOP;
END
$$;
