# Testing and coverage (NexQL)

## Policy A — instrumented application code

Line coverage is measured with **c8** (V8 coverage) on **Tier 1** TypeScript sources listed below. The following are **out of scope** for the gate (still covered by E2E or separate runs where noted):

- `src/activation/**` — thin wiring; exercised by `@vscode/test-electron` smoke tests.
- `src/extension.ts` — activation entry; smoke tests.
- Notebook/renderer UI bundles — use `npm run test:renderer` and `npm run test:renderer:coverage` for renderer-focused coverage.

## Tier 1 coverage gate (≥85% lines, ≥75% branches)

The `npm run coverage` script enforces thresholds on:

- `src/services/handlers/**/*.ts`
- `src/providers/kernel/SqlParser.ts`
- `src/lib/**/*.ts`
- `src/utils/**/*.ts`

`PgPassSupport.test.ts` is excluded from the coverage command only (it uses patterns that conflict with c8’s loader); password-file behaviour is still covered by `npm test` and by `pgPassUtils` unit tests.

## Commands

| Command | Purpose |
|--------|---------|
| `npm test` | Unit tests (Mocha + ts-node ESM loader). |
| `npm run test:unit` | Same tests via ts-mocha. |
| `npm run test:integration` | PostgreSQL integration tests (needs DB env). |
| `npm run coverage` | Runs the full coverage suite (excludes `PgPassSupport.test.ts`). |
| `npm run coverage:phase-utils` | Phase run for `src/utils` area (uses `.c8rc.phase-utils.json`). |
| `npm run coverage:phase-handlers` | Phase run for `src/services/handlers` area (uses `.c8rc.phase-handlers.json`). |
| `npm run coverage:phased` | Runs phased coverage (`coverage:phase-utils` then `coverage:phase-handlers`) and generates reports. |
| `npm run coverage:unit` | Legacy alias retained for local debugging: runs the unit test c8 wrapper (see `package.json`). |
| `npm run coverage:unit:instrument` | Same run with `COVERAGE_CHECK=0` (no threshold failure; use to verify c8 attribution). |
| `npm run test:e2e` | VS Code extension smoke tests (`@vscode/test-electron`). |
| `npm run coverage:e2e` | c8 wrapper around the E2E runner (collects host-side coverage where V8 attributes it; extension-host internals may be partial). |

## E2E vs Playwright

UI automation for this product targets the **VS Code Extension Host**. Use **`@vscode/test-electron`** (see `src/test/runTest.ts`). **Playwright** is not used for the extension shell; reserve it for future standalone web surfaces if any.

## CI

- Trigger model: `.github/workflows/test.yml` runs on `pull_request`, `push` (main/master), and `workflow_dispatch`.
- Unit job: `npm test`, `npm run coverage:phased` (phased per-area checks: utils → handlers, merged before report generation).
- Integration job: `npm run test:integration` with Postgres service.
- E2E job (optional / manual): `npm run test:e2e` under `xvfb-run` on Linux; artifacts include JUnit XML when `MOCHA_FILE` is set.
