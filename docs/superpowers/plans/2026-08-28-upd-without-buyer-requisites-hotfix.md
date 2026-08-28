# UPD Without Buyer Requisites Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпускать и печатать УПД выбранного клиента одним нажатием, не требуя юридических реквизитов покупателя и не угадывая неоднозначного продавца.

**Architecture:** Валидация отделяет нашего продавца от реквизитов покупателя. Существующий авторизованный Server Action получает optional `clientId`, безопасно материализует отсутствующий snapshot продавца и выпускает только этот scope; клиентская кнопка вызывает action через POST перед переходом на read-only PDF GET.

**Tech Stack:** Next.js 16.2 App Router, React 19 Server Actions, TypeScript, Prisma 6/PostgreSQL, Vitest 4, `@react-pdf/renderer`, Vercel.

---

## Context recovery

- Worktree: `/Users/macbook/Documents/CRM_FOOD/.worktrees/fix-upd-no-legal-data`
- Branch: `codex/fix-upd-no-legal-data`
- Base: `origin/main@fa4f10c8e66b5444713d3bae4e8a0c03ab882745`
- Root cause and design: `docs/superpowers/specs/2026-08-28-upd-without-buyer-requisites-hotfix-design.md`
- Baseline: `npm test` → 171 files / 2134 tests passed.
- Never stage the dirty parent checkout; stage exact paths only inside this worktree.
- Never run local `npm run vercel-build`; it executes `prisma migrate deploy`.

### Task 1: Decouple seller selection from buyer requisites

**Files:**
- Create: `src/app/(app)/clients/actions.upd.test.ts`
- Modify: `src/app/(app)/clients/actions.ts`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Write the failing validation regression**

Mock `requireRole`, Prisma and `revalidatePath`, call `createClient({ name: 'Без реквизитов', defaultOurLegalEntityId: 'seller_1' })`, and assert success plus this Prisma payload:

```ts
expect(mockPrisma.client.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    name: 'Без реквизитов',
    inn: null,
    legalName: null,
    defaultOurLegalEntityId: 'seller_1',
  }),
})
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- 'src/app/(app)/clients/actions.upd.test.ts'
```

Expected: FAIL because current `clientSchema` rejects `defaultOurLegalEntityId` when `inn` is empty.

- [ ] **Step 3: Make the minimal validation change**

Remove only `defaultOurLegalEntityId` from `juridicalFields`; keep `legalName`, `kpp`, `ogrn`, and `legalAddress`. Update the Prisma comment to state that the seller choice is independent from buyer requisites.

- [ ] **Step 4: Verify GREEN**

Run the same targeted test and expect PASS.

### Task 2: Add client-scoped idempotent issuance and seller materialization

**Files:**
- Create: `src/app/(app)/production/print/upd/generate-client.test.ts`
- Modify: `src/app/(app)/production/print/upd/actions.ts`

- [ ] **Step 1: Write failing client-scope regression tests**

Use hoisted Prisma/auth/numbering mocks. Cover:

```ts
await generateAndGetUpdForDate('2026-08-28', 'client_1')
expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
  expect.objectContaining({
    where: expect.objectContaining({ clientId: 'client_1' }),
  }),
)
```

The returned order fixture has all buyer legal/bank/contract fields `null`. Assert `tx.updDocument.create` receives a `buyerSnapshot` with those nulls and returns `createdCount: 1`.

Add a null-seller fixture and assert a saved client default is copied to `Order.ourLegalEntityId`/`vatRate` before issuance. Add `default = null` cases: exactly one active seller is persisted and used; two active sellers return `ok: false` and do not create an UPD.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- 'src/app/(app)/production/print/upd/generate-client.test.ts'
```

Expected: FAIL because the second argument is currently ignored and null-seller orders are filtered out.

- [ ] **Step 3: Implement seller materialization**

Add an unexported async helper in `actions.ts` that:

```ts
const missingOrders = await prisma.order.findMany({
  where: {
    clientId,
    deliveryDate: { gte: range.from, lte: range.to },
    status: { in: PRODUCTION_STATUSES },
    ourLegalEntityId: null,
  },
  select: { id: true },
})
```

Resolve an active saved client seller, otherwise query at most two active sellers. Proceed with the sole active seller only. In one interactive transaction, conditionally update null orders, conditionally set a null client default, and write `UPD_ORDER_SELLER_ASSIGNED` with source, date and order IDs.

- [ ] **Step 4: Implement optional client scope**

Change the action signature to:

```ts
export async function generateAndGetUpdForDate(
  dateIso: string,
  clientId?: string,
): Promise<ActionResult<UpdGenerateResult>>
```

Validate a non-blank optional ID, run seller preparation for the narrow mode, and add `...(clientId ? { clientId } : {})` to the generation query. If a narrow scope has neither eligible groups nor existing documents, return a readable business error instead of sending the browser to the old text response. Preserve the old all-client call and P2002 behavior.

- [ ] **Step 5: Verify GREEN**

Run the new test plus existing `actions.test.ts`; expect all PASS.

### Task 3: Prepare from the Orders button before opening PDF

**Files:**
- Modify: `src/app/(app)/orders/orders-list.tsx`

- [ ] **Step 1: Replace direct-only click behavior**

Keep the href as a non-JS fallback. In `UpdClientButton`, synchronously open a blank tab, then invoke:

```ts
startTransition(async () => {
  try {
    const result = await generateAndGetUpdForDate(dateYmd, clientId)
    if (!result.ok) {
      win.close()
      toast.error(result.error)
      return
    }
    win.location.href = pdfHref
  } catch {
    win.close()
    toast.error('Не удалось сформировать УПД. Повторите попытку.')
  }
})
```

Prevent row navigation, guard repeated clicks, preserve popup-blocker feedback, and expose a pending label/ARIA state.

- [ ] **Step 2: Run targeted tests and typecheck**

```bash
npm test -- 'src/app/(app)/clients/actions.upd.test.ts' 'src/app/(app)/production/print/upd/actions.test.ts' 'src/app/(app)/production/print/upd/generate-client.test.ts'
npx tsc --noEmit
```

Expected: PASS / exit 0.

### Task 4: Lock in PDF rendering without buyer requisites

**Files:**
- Create: `src/app/(app)/production/print/upd/pdf/upd-pdf-document.test.ts`

- [ ] **Step 1: Add the render characterization**

Construct `UpdPdfDocData` with a complete supplier, one food line, and every nullable buyer legal/bank/contract field set to `null`. Render using `renderToBuffer(createElement(UpdPdfDocument, { docs: [doc] }))` and assert the result begins with `%PDF` and is non-trivial in size.

- [ ] **Step 2: Run the PDF test**

```bash
npm test -- 'src/app/(app)/production/print/upd/pdf/upd-pdf-document.test.ts'
```

Expected: PASS, proving the existing fallback contract.

### Task 5: Verification, review and production release

**Files:**
- Modify checkboxes in this plan as durable progress state.

- [ ] **Step 1: Run the full verification matrix**

```bash
npm test
npx prisma validate
npx prisma generate
npx tsc --noEmit
./node_modules/.bin/dotenv -e .env.test -o -- npm run build
git diff --check
git status --short
```

Expected: 0 test failures, valid/generated Prisma client, TypeScript/build exit 0, no whitespace errors, only intended files changed.

- [ ] **Step 2: Independent spec and quality review**

Provide the design, plan, diff and verification output to a reviewer agent. Resolve every spec or important quality issue and rerun affected checks.

- [ ] **Step 3: Commit exact files**

Use explicit `git add -- <paths>` only. Commit code/docs/tests; confirm the commit contains no migration and no unrelated Boris files.

- [ ] **Step 4: Deploy production**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Poll the GitHub commit status until Vercel is `success`. Do not force-push.

- [ ] **Step 5: Smoke production**

Check `https://budni-crm.vercel.app/login` for HTTP 200 and deployment ID matching the new Vercel status, dispatch `.github/workflows/daily-smoke.yml` on `main`, and wait for success. Do not manually trigger a numbered UPD without an authenticated test client.

- [ ] **Step 6: Recovery if release fails**

Use `git revert <hotfix-sha>` and push the revert to `main`; never reset. Record the failed Vercel/smoke evidence in the final report.
