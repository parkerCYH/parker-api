## Agent skills

### Issue tracker

Issues live in GitHub Issues (github.com/parkerCYH/parker-api), managed via the `gh` CLI. External PRs are not treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Database conventions

This project has a single developer (parkerCYH). Keep the DB schema stable — prefer designing tables/columns to accommodate known future needs up front rather than iterating via many small migrations. Avoid generating a new migration for every minor tweak; batch related schema changes into one migration where possible.
