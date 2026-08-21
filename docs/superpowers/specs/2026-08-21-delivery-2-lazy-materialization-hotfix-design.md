# Delivery 2.0 Lazy Materialization Hotfix Design

## Problem

Delivery 2.0 reads daily courier cards from `CourierRouteDay` and `CourierRouteStop`, while existing courier defaults remain on `ClientLocation.assignedCourierId`. The rollout intentionally created no destructive backfill. Several production entry points read the new tables before calling the idempotent materializer, so a valid legacy/default assignment can exist while the daily route is absent and the UI looks empty.

## Considered approaches

1. **Lazy materialization at each required server entry point (chosen).** Before reading today's route state, call `ensureCourierRouteStopsForDate(deliveryDate, now)`. This follows the approved mega-sprint, preserves history, is idempotent, and repairs both fresh and already-running days.
2. **One-time production backfill.** Rejected because it is operationally destructive, cannot safely infer historical intent, and was explicitly excluded by the rollout design.
3. **A new background cron.** Rejected because users can still observe an empty route before the cron runs, and it adds another schedule and recovery surface for work that is already safe on demand.

## Architecture and data flow

Read models remain read-only. Their authenticated server entry points perform orchestration in this order:

1. Resolve the Moscow calendar date and current timestamp.
2. Call the existing idempotent `ensureCourierRouteStopsForDate` materializer.
3. Query the existing courier or manager read model.
4. Render or process the resulting daily routes/stops.

The hotfix covers the required paths that are currently missing the call:

- courier `/delivery` route list;
- courier stop detail;
- manager `/delivery/control` today screen;
- late-delivery cron before its query.

Existing covered paths remain unchanged: route start and courier-assignment queries already invoke the materializer. No Telegram call, manual cron, manual production script, or location-default mutation is introduced.

## Failure handling

Materialization failure must fail the request/cron instead of silently rendering a false empty state. The materializer already retries serializable conflicts and is idempotent, so normal duplicate requests are safe. Authorization stays before any page-triggered database mutation.

## Testing

Regression tests must first fail against the current code and then prove:

- authenticated manager control materializes today's date before reading;
- authenticated courier route list materializes today's date before reading;
- courier stop detail materializes today's date before stop lookup;
- late-delivery handler materializes today before selecting late stops;
- existing authorization and cron behavior remain green.

Release verification: targeted Vitest, Prisma schema validation/generation, TypeScript, production build, scoped Git diff, Vercel deployment status, and a read-only production HTTP smoke.
