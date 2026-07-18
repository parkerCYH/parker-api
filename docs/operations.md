# Operations

Operational know-how for working on `parker-api` day to day — migration gotchas and manual verification steps that don't belong in the role definition itself.

## Migrations

`drizzle-kit generate`, then hand-inspect the output before applying — don't trust it blindly. Two known gotchas in this codebase:

- **Cross-module foreign keys**: drizzle-kit's loader can't resolve relative imports across module boundaries (a `.js` specifier pointing at another module's `.ts` source). Declare the column as a plain `uuid(...)` with no `.references()`, and hand-append the real `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` to the generated SQL.
- **CASCADE double-drops**: when a generated migration does `DROP TABLE ... CASCADE`, it can also separately emit a `DROP CONSTRAINT` for something the CASCADE already removed — that second statement errors. Read the generated SQL before trusting it.

Data-only migrations (seeding roles, rules, backfills) use `drizzle-kit generate --custom` and get hand-written SQL.

Apply every migration to **both** `parker_api` and `parker_api_test` — don't forget the test database, and don't be afraid to drop and recreate `parker_api_test` from scratch if accumulated test data violates a new constraint (it's disposable, unlike the dev database).

## Manual verification against the running stack

Passing tests isn't proof the wiring is correct — `app.ts` registration or `docker-compose.yml` env vars can still be missing. Before considering a change done:

```
docker compose up -d --build
```

Then curl `/health` and any new routes, and check `/openapi.json` for the expected paths.
