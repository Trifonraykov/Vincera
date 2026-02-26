# Vincera Deployment Guide

## Overview

Three components to deploy:

1. **Supabase** (database + realtime) — cloud-hosted
2. **Agent** (Python) — on the company's machine
3. **Dashboard** (Next.js) — Vercel, Railway, or self-hosted

## 1. Supabase Setup

### Create Project

1. Go to [supabase.com](https://supabase.com), create a new project
2. Note these values from Settings > API:
   - **Project URL** (e.g., `https://xxx.supabase.co`)
   - **Anon key** (public, safe for browser)
   - **Service role key** (private, agent only)

### Run Migrations

**Option A: Supabase CLI (recommended)**

```bash
cd Vincera/supabase
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

**Option B: Manual**

Apply each file in `supabase/migrations/` in order via the Supabase SQL editor:

```
001_companies.sql
002_agent_statuses.sql
003_automations.sql
004_events.sql
005_messages.sql
006_knowledge.sql
007_decisions.sql
008_playbook_entries.sql
009_corrections.sql
010_research.sql
011_brain_states.sql
012_ghost_reports.sql
013_metrics.sql
014_cross_company_patterns.sql
015_rls_policies.sql
016_indexes.sql
017_functions.sql
```

### Enable Realtime

If not already enabled by migrations, enable Realtime on these tables via the Supabase dashboard (Database > Replication):

- `agent_statuses`
- `automations`
- `events`
- `messages`
- `decisions`
- `knowledge`
- `brain_states`

### Verify

- [ ] All 15 tables created (check Database > Tables)
- [ ] RLS policies active on all tables (check Authentication > Policies)
- [ ] Realtime working on 7 tables (check Database > Replication)
- [ ] Functions created: `update_updated_at`, `increment_metric`, `clean_old_events`, `get_latest_brain_state`

## 2. Agent Deployment

### Requirements

- Python 3.11+
- Docker (for sandbox execution)
- Network access to Supabase and OpenRouter API

### Install

```bash
cd Vincera
pip install -e .
```

### Configure

```bash
vincera install
```

This interactive setup prompts for:
- Supabase URL
- Supabase anon key
- Supabase service key
- OpenRouter API key
- Company name

Secrets are encrypted with Fernet and stored in `~/VinceraHQ/config.json`.

### Run as Service

#### Linux (systemd)

```bash
vincera start
# Creates /etc/systemd/system/vincera.service
# Starts automatically on boot
```

Or manually:

```bash
sudo systemctl enable vincera
sudo systemctl start vincera
sudo systemctl status vincera
```

#### macOS (launchd)

```bash
vincera start
# Creates ~/Library/LaunchAgents/com.vincera.bot.plist
# Starts automatically on login
```

#### Windows (NSSM)

```bash
vincera start
# Uses NSSM to create a Windows service
```

Or manually with NSSM:

```powershell
nssm install Vincera python -m vincera.main
nssm start Vincera
```

#### Run Directly (any OS)

```bash
python -m vincera.main
```

### Verify

- [ ] `vincera --status` shows agent statuses
- [ ] Agent appears in Supabase `agent_statuses` table
- [ ] Discovery narration starts appearing in `messages` table
- [ ] Log files appear in `~/VinceraHQ/logs/`

## 3. Dashboard Deployment

### Environment Variables

Create `.env.local` with:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

> **WARNING: NEVER use the service role key in the dashboard.** The dashboard must use the anon key only. The service role key bypasses all RLS policies and would expose every company's data. The anon key enforces row-level security so each user only sees their own data.

### Option A: Vercel (recommended)

1. Connect your repository on [vercel.com](https://vercel.com)
2. Set environment variables in Vercel dashboard
3. Set root directory to `dashboard`
4. Build command: `npm run build`
5. Deploy

### Option B: Railway

1. Connect your repository on [railway.app](https://railway.app)
2. Set environment variables
3. Build command: `cd dashboard && npm install && npm run build`
4. Start command: `cd dashboard && npm start`

### Option C: Self-hosted

```bash
cd dashboard
npm install
npm run build
npm start
```

Or with PM2 for process management:

```bash
pm2 start npm --name vincera-dashboard -- start
```

### Verify

- [ ] Dashboard loads at your URL
- [ ] Agent status dots appear (green = running, gray = idle)
- [ ] Chat messages flow between dashboard and agent
- [ ] Brain View shows orchestrator state
- [ ] Decisions page shows pending approvals (if any)

## Troubleshooting

### Agent can't connect to Supabase

- Verify the Supabase URL is correct (no trailing slash)
- Check that the service role key is valid
- Ensure network access to `*.supabase.co` port 443
- Check logs: `~/VinceraHQ/logs/vincera.log`

### Dashboard shows no agents

- Verify the agent is running (`vincera --status` or check system service)
- Confirm `company_id` matches between agent config and Supabase
- Check browser console for Supabase connection errors
- Verify Realtime is enabled on `agent_statuses` table

### Realtime not working

- Enable Realtime on required tables in Supabase dashboard (Database > Replication)
- Check that the anon key has the correct permissions
- Verify the Supabase project is not paused (free tier pauses after inactivity)

### Service won't start

- **Linux:** `journalctl -u vincera` for systemd logs
- **macOS:** `~/Library/Logs/vincera.log` or `log show --predicate 'processImagePath CONTAINS "vincera"'`
- **Windows:** Check Windows Event Viewer or NSSM logs
- **All platforms:** Check `~/VinceraHQ/logs/` for application logs

### Docker sandbox failures

- Verify Docker is installed and running: `docker info`
- Check that the current user has Docker permissions (Linux: add user to `docker` group)
- The sandbox falls back to subprocess execution if Docker is unavailable

### Ghost Mode not transitioning

- Check `ghost_mode_until` in the `companies` table
- Verify the Orchestrator is running (check `agent_statuses`)
- Ghost mode can be ended early via the dashboard's Ghost Mode page
