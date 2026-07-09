## Agent skills

### Issue tracker

Issues live in GitHub Issues (github.com/parkerCYH/parker-api), managed via the `gh` CLI. External PRs are not treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Database conventions

This project has a single developer (parkerCYH). Keep the DB schema stable — prefer designing tables/columns to accommodate known future needs up front rather than iterating via many small migrations. Avoid generating a new migration for every minor tweak; batch related schema changes into one migration where possible.

## Code structure

Backend is Hono + Drizzle + PostgreSQL, single package (no monorepo/workspace — the Next.js admin frontend lives in a separate repo). Source is organized as one folder per service under `src/modules/<service>/`, matching the PostgreSQL schema name; each module only exposes its `index.ts` to other modules. Tests are e2e-only, colocated with the module they test, run with Vitest against a real Postgres database. See `docs/adr/0004-module-structure-and-e2e-testing.md`.

## Local development ports

The backend (`docker compose up`) runs on **port 3001**, not 3000 — port 3000 is reserved for local frontend dev servers (Next.js admin dashboard, Vite, etc.) that run alongside it. Keep any new port references (`PORT`, `GOOGLE_REDIRECT_URI`, Swagger UI links, etc.) on 3001.
