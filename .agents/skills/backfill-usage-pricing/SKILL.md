---
name: backfill-usage-pricing
description: Inspect, plan, and apply usage.unit_price backfills against a Floway Node SQLite database or Cloudflare D1. Use when filling NULL usage prices or correcting a selected historical usage range.
---

# Backfill Usage Pricing

Use `pnpm --silent tools:backfill-usage-pricing`. The CLI is non-interactive and emits
versioned JSON. Never bypass it with handwritten SQL or manually transcribed
scalar rates.

## Workflow

1. Announce the database target and environment. Use the Node database path for
   Node deployments. For D1, specify `--remote` or `--local`; production D1 is
   `--remote`.
2. Inspect enabled upstreams and grouped NULL-price slices:

   ```bash
   pnpm --silent tools:backfill-usage-pricing inspect --database node --database-path <path>
   pnpm --silent tools:backfill-usage-pricing inspect --database d1 --remote --binding DB
   ```

3. Establish the exact upstream ID, public model, wire model key, half-open UTC
   hour range, human timezone, metrics, and write mode. Use `fill` to change only
   NULL prices and `overwrite` to replace prices throughout the selected slice.
4. Create a plan inside the repository:

   ```bash
   pnpm --silent tools:backfill-usage-pricing plan \
     --database d1 --remote --binding DB \
     --upstream <id> --model <public-id> --model-key <wire-id> \
     --start-hour <YYYY-MM-DDTHH> --end-hour <YYYY-MM-DDTHH> \
     --timezone <IANA-timezone> --mode <fill-or-overwrite> \
     --metric <metric> --output .tmp/backfill-usage-pricing/<name>.json
   ```

5. Read the complete plan. Report its database identity, plan ID, pricing
   source, selected and affected row counts, selector/metric/rate operations,
   skipped metrics, expected remaining NULL rows, and blockers. Do not apply a
   blocked plan.
6. Treat a production apply as a deploy-grade mutation. Obtain authorization
   for the exact plan when the user's request did not already authorize that
   production write.
7. Apply only the saved plan:

   ```bash
   pnpm --silent tools:backfill-usage-pricing apply --plan .tmp/backfill-usage-pricing/<name>.json
   ```

8. Report every verified operation, total rows updated, and remaining NULL
   rows. Delete the temporary plan after successful verification.

The CLI refuses stale or modified plans, catalog ambiguity, historical selector
drift, database identity changes, and schema mismatches. A missing metric rate
remains NULL; a non-NULL aggregate cost does not prove the slice is fully
priced.

Copilot backfills use the current fetched model catalog's official Copilot
prices, not a static vendor API rate card. Refresh the saved Copilot upstream's
models before planning if its cache is missing, obsolete, or at least 24 hours
old. The raw model key must occur in the cached public family's variants;
public aliases do not replace that wire identity. Changed prices invalidate the
saved plan, and the write guards against concurrent catalog changes. Applying current rates to historical usage remains
an explicit operator decision, not an automatic consequence of catalog refresh.

For historical models absent from the current catalog, `plan --pricing-file`
accepts an explicitly verified source without changing runtime configuration or
the model catalog. Use only primary-source prices for that exact model and
confirm whether the human wants historical rates or current-rate estimates.
Never substitute a similarly named model. The JSON contains
`schemaVersion: 1`, `kind: "usage-pricing-source"`, the exact `upstream`, `model`,
and `modelKey`, an HTTPS `referenceUrl`, canonical ISO `observedAt`, and a
validated `pricing` in the existing USD-per-base-unit `ModelPricing` shape.
Generate token rates with the shared conversion helpers from the verified
source instead of manually transcribing scalar update values.

The saved plan binds the source's canonical path and SHA-256 digest. `apply`
re-reads it and rejects changed, missing, invalid or scope-mismatched sources.
Keep the source available through apply; remove both temporary plan and source
after verification. Missing historical request-level context bands cannot be
reconstructed from hourly token totals. Get explicit approval before using
default-band estimates for such records, and report that limitation.
