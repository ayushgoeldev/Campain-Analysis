# Lead Report App

A web app + **PostgreSQL** replacement for the "Weekly Report" Google Sheet.
It ingests a CRM export (meritto or any CSV/XLSX), stores it in Postgres, and
builds the full weekly report — KPIs, Top Lead Codes / Courses / Cities, Lead
Stages, and by-month breakdowns — with primary **and** duplicate metrics.

Postgres does the aggregation the sheet couldn't, so **2 lakh+ (200,000+) rows**
are no problem.

## Why this exists

The original Google Sheet relied on `QUERY`, `SORT`, `FILTER`, `UNIQUE` and
`ARRAYFORMULA`, which don't scale to hundreds of thousands of rows and break
outside Google Sheets. This app reproduces the same logic as plain SQL
aggregations over an indexed table.

## How it maps to the sheet

| Sheet tab | Here |
|---|---|
| `Setup` (yellow cells) | `settings` table / **Settings** tab in the UI |
| `Course_Mapping`, `Lead Code_Mapping` | `course_mapping`, `lead_code_mapping` tables (seeded from your file) |
| `Dump` (raw rows) | `leads.data` (jsonb, the untouched row) |
| `Rank` (per-lead flags) | `leads` derived columns, computed by `src/derive.js` |
| `Report` (tables) | `src/report.js` SQL + the **Report** tab in the UI |

## Quick start

```bash
# 1. Start Postgres (or point DATABASE_URL at your own)
docker compose up -d

# 2. Configure
cp .env.example .env          # edit DATABASE_URL if needed

# 3. Install + create schema and seed mappings/settings
npm install
npm run init-db

# 4. Run
npm start                     # http://localhost:3000
```

Then open the app, go to **Data**, and upload a CSV/XLSX export. The report
builds automatically.

### Bulk import from the command line

For very large files you can skip the browser:

```bash
node scripts/import-file.js path/to/export.csv --name "Week 30"
# optional: --header-row N   (0-based; omit to auto-detect and skip banner rows)
```

## Configuration (Settings)

Every mapping from the sheet's Setup tab is editable in the **Settings** tab
(or the `settings` row): which column is the Lead Code source, the delimiter and
token, the Course/City/Form-Initiated/Application/Admission/Date/Instance
columns, the value sets that count as an application/admission/form-initiated
(blank = "any non-empty"), and the instance keyword counted as *primary*.

After changing settings, click **Recompute** — it re-derives every lead from the
stored raw data (no re-upload needed).

## Data model

- `datasets` — one row per uploaded export; the newest is marked active.
- `leads` — raw row in `data` (jsonb) + derived fields (`lead_code`,
  `kapp_course`, `city`, `origin`, `month`, `fi_flag`, `app_flag`, `adm_flag`,
  `prim_flag`) with indexes for fast GROUP BY.
- `settings`, `course_mapping`, `lead_code_mapping` — config and lookups.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/report` | Full report for the active dataset |
| POST | `/api/upload` | Upload + import a file (multipart `file`) |
| GET/PUT | `/api/settings` | Read / update configuration |
| POST | `/api/recompute` | Re-derive the active dataset |
| GET | `/api/datasets` | List datasets |
| POST | `/api/datasets/:id/activate` | Switch active dataset |
| DELETE | `/api/datasets/:id` | Delete a dataset |

## Tests

```bash
npm test          # unit tests for the derivation logic
```

## Deployment

Runs anywhere Node + Postgres are available (Render, Railway, Fly, a VM). Set
`DATABASE_URL` (managed Postgres usually needs SSL — the pool enables it when
the URL contains `sslmode=require` or `PGSSL=true`). `npm run init-db` once
against the target database, then `npm start`.
