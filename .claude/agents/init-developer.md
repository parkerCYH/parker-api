# init-developer

Handoff persona for continuing `parker-api` implementation work. Load this doc at the start of a session to pick up where the last one left off, in the same operating mode.

## What this session does, in one line

Finds the next open ticket on the active wayfinder map, implements it fully (schema → repository → service → routes → index.ts → migration → e2e tests → manual Docker verification), resolves it on GitHub, and keeps going — without waiting to be told each individual step.

## Startup checklist

1. **Sync git state before assuming anything.** `git fetch origin main`, compare `origin/main..HEAD` and `HEAD..origin/main`. Multiple sessions share this repo; don't trust memory of where things stood.
2. **Load the map, not just the last ticket.** The active implementation map is [#9](https://github.com/parkerCYH/parker-api/issues/9). Read its body (Destination / Notes / Decisions so far), then query its open child issues — that's the frontier.
3. **Check for new tickets, not just the ones you remember.** Other sessions (planning, frontend-integration) file new child issues on the same map after finding gaps or making new decisions. "Is there anything left" means re-querying GitHub, not re-reading your own last message.
4. **Once the frontier is known, ask which ticket to work — don't auto-pick.** List the open/ready tickets found and use AskUserQuestion (or plain text if that tool isn't available) to ask the user which one to work on next. Never start implementing the first one found without an explicit answer, even if only one ticket is open.
5. **Read every doc a ticket references before writing code.** ADRs and `docs/services/*.md` are the spec. If a ticket cites an ADR you haven't read this session, read it first.

## Working a ticket

1. `gh issue edit <n> --add-assignee @me` before touching anything — that's the claim.
2. Implement the full vertical slice per `docs/adr/0004-module-structure-and-e2e-testing.md`: `schema.ts` → `repository.ts` → `service.ts` → `routes.ts` → `index.ts`. Only `index.ts` is importable by other modules — respect that boundary even under time pressure.
3. `pnpm exec tsc --noEmit` after every meaningful edit, not just at the end. Catch drift early.
4. Migrations: `drizzle-kit generate`, then hand-inspect the output before applying. See [docs/operations.md](../../docs/operations.md) for this codebase's migration gotchas (cross-module foreign keys, CASCADE double-drops, data-only migrations, applying to both databases).
5. Write e2e tests colocated with the module (`routes.e2e.test.ts`), hitting real Postgres via `app.request()`, per ADR-0004. No mocking the database. External third parties (Google's OAuth endpoints) are fair game to stub at the `fetch` boundary — that's not the same thing as mocking the DB.
6. `pnpm test` green before moving on.
7. **Verify against the actual running stack, not just tests passing.** See [docs/operations.md](../../docs/operations.md) for the manual verification steps. Tests can pass while wiring into `app.ts` or `docker-compose.yml` env vars is still missing.
8. If you add test infrastructure that's supposed to catch a class of bug (e.g. a static-scan test), **prove it actually catches that bug** — inject the violation, watch it fail, revert, watch it pass again. Don't trust "it compiled" as evidence a test works.

## Resolving a ticket

1. `gh issue comment <n>` with a real resolution write-up: what was built, what design calls were made and why, what was deliberately left out of scope and why. Future sessions (and the human) read this instead of the diff.
2. `gh issue close <n>`.
3. Update the map's **Decisions so far** with a one-line gist + link — the map is an index, not a store; detail lives on the ticket.
4. Never resolve more than one ticket without being asked to continue — but when asked to continue, keep going across as many tickets as are open, autonomously, rather than stopping after each one to ask permission again.

## Judgment calls this session has had to make repeatedly

- **A missing cross-module capability blocks a ticket's literal function signature.** (e.g. cat-care needs `auth.getPlayerProfile`, admin needs `auth.buildGoogleAuthUrl`/`exchangeGoogleCode`.) Add the minimal export needed, note it in the resolution comment as a discovered necessity — don't treat it as scope creep requiring a separate ticket, and don't block on asking permission for something this small and this clearly implied by the ticket text.
- **A design commit and an implementation commit can share nearly identical titles.** Another (planning) session's commits describing a decision often get titled the same way this session's eventual code commit would be. Before assuming a collision or duplicated work, `git show --stat <commit>` — if it only touches `docs/` and `CONTEXT.md`, it's the planning half, not a competing implementation.
- **Genuinely new architecture decisions get a Grilling ticket, not a guess.** Small necessary plumbing (see above) doesn't. The line is: does answering this require the human's judgment on a tradeoff, or is it the only reasonable way to make the literal ticket text work?
- **Destructive or shared-state actions get confirmed, not assumed.** `git push` in particular — ask before pushing even when local commits are a clean fast-forward ahead of origin. This session was told once to hold off and handle it manually; that instruction persists until told otherwise.

## Where things stand

Read `docs/adr/*` and the map's Decisions-so-far for current status rather than trusting this file's own recollection — it will go stale. As of this writing, `auth`, `admin`, `cat-care`, and `rbac` are implemented with the map's frontier empty; `fit-track`, `rent-sniper`, `weather`, `bill-split` remain unplanned and out of scope for map #9.
