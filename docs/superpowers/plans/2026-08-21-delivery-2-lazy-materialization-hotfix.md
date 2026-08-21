# Delivery 2.0 Lazy Materialization Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure existing courier defaults are materialized into today's Delivery 2.0 route tables before every required production read.

**Architecture:** Keep all read models pure and orchestrate the existing idempotent `ensureCourierRouteStopsForDate` call in authenticated Next.js page entry points and the late-delivery handler. Authorization and the feature-flag short circuit remain ahead of any new page/cron work, while a materialization failure fails closed instead of rendering a false empty route.

**Tech Stack:** Next.js 16 App Router, React Server Components, TypeScript, Prisma 6, Vitest 4, Vercel.

---

### Task 1: Page entry-point regressions

**Files:**
- Modify: `src/app/(app)/delivery/courier-pages.test.ts`
- Modify: `src/app/(app)/delivery/manager-control-pages.test.ts`
- Modify: `src/app/(app)/delivery/page.tsx`
- Modify: `src/app/(app)/delivery/stops/[stopId]/page.tsx`
- Modify: `src/app/(app)/delivery/control/page.tsx`

- [ ] **Step 1: Write failing tests**

Mock `ensureCourierRouteStopsForDate` at the server boundary and assert that the manager control page, courier route list, and courier stop detail call it with `2026-08-21T00:00:00.000Z` before their read model.

```ts
expect(mockEnsure).toHaveBeenCalledWith(
  new Date('2026-08-21T00:00:00.000Z'),
  NOW,
)
expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(
  mockGetOwnRoute.mock.invocationCallOrder[0],
)
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run 'src/app/(app)/delivery/courier-pages.test.ts' 'src/app/(app)/delivery/manager-control-pages.test.ts'
```

Expected: FAIL because the three page entry points do not import or call the materializer.

- [ ] **Step 3: Implement the minimum page orchestration**

After `requireRole` and date resolution, add:

```ts
await ensureCourierRouteStopsForDate(deliveryDate, now)
```

Keep `getOwnCourierRouteDay`, `getOwnCourierRouteStop`, and `getManagerDeliveryControl` unchanged and read-only.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command. Expected: all page regression tests pass.

### Task 2: Late-cron regression

**Files:**
- Modify: `src/app/api/cron/check-late-deliveries/route.test.ts`
- Modify: `src/app/api/cron/check-late-deliveries/route.ts`

- [ ] **Step 1: Write the failing test**

Mock the materializer and assert it runs after the disabled-feature check but before `courierRouteStop.findMany`:

```ts
expect(mockEnsure).toHaveBeenCalledWith(
  new Date('2026-08-21T00:00:00.000Z'),
  NOW,
)
expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(
  mockFindMany.mock.invocationCallOrder[0],
)
```

- [ ] **Step 2: Run the cron test and verify RED**

Run:

```bash
npx vitest run src/app/api/cron/check-late-deliveries/route.test.ts
```

Expected: FAIL because `handler` currently queries stops without materializing today.

- [ ] **Step 3: Implement the minimum cron orchestration**

Import `ensureCourierRouteStopsForDate` and call it immediately before building the late-stop query. Preserve the disabled flag's no-op behavior and all existing claim/Telegram semantics.

- [ ] **Step 4: Run the cron test and verify GREEN**

Run the same Vitest command. Expected: all late-delivery tests pass.

### Task 3: Release verification and deployment

**Files:**
- Verify all changed hotfix files and the two hotfix documents.

- [ ] **Step 1: Run targeted Delivery 2.0 tests**

Run the page, materializer, read-model, route-action, assembly, courier-query, and late-cron Vitest files. Expected: zero failures.

- [ ] **Step 2: Validate Prisma and TypeScript**

Run:

```bash
npx dotenv -e .env.test -- npx prisma validate
npx dotenv -e .env.test -- npx prisma generate
npx tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 3: Run production build**

Run:

```bash
npx dotenv -e .env.test -e .env.local -- npm run build
```

Expected: Next.js production build exits 0 and lists the Delivery 2.0 pages and late cron.

- [ ] **Step 4: Inspect and commit only scoped changes**

Verify `git diff --check`, stage only the hotfix files/documents, and leave unrelated Boris/scripts/output/tmp changes untouched. Commit with `fix(delivery): materialize daily routes before reads`.

- [ ] **Step 5: Deploy and verify**

Push `main`, wait for the Vercel commit status to reach `success`, and perform a read-only HTTP smoke against the production login page. Do not manually invoke a cron or send Telegram.
