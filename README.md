# Будни CRM

CRM для кейтеринг-компании «Будни». Управление клиентами, меню, заказами, доставкой и финансовой отчётностью.

## Tech stack
Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, Prisma 6 + PostgreSQL (Neon), shadcn/ui (radix-nova), recharts, lucide-react, sonner, jose.

## Local development
```bash
npm install
cp .env.example .env.local
# Fill in DATABASE_URL, DIRECT_URL, JWT_SECRET, CRON_SECRET
npx prisma migrate dev
npm run db:seed
npm run dev
```
Open http://localhost:3000. Test users: ADMIN 1111, MANAGER 2222, CHEF 3333, COURIER 4444.

## Production deployment
1. Push code to GitHub repo
2. Import project in Vercel
3. Configure environment variables (see .env.example)
4. Deploy
5. After first deploy, run migrations: `npx prisma migrate deploy`
6. Run setup script for initial admin: `npm run db:seed:prod`

## Cron jobs
Configured in vercel.json:
- 03:00 UTC (06:00 MSK) — auto-generate FIXED/DYNAMIC orders
- 15:00 UTC (18:00 MSK) — lock orders for next day

Both protected by CRON_SECRET via Authorization: Bearer header.

## Roles
- **ADMIN** — full access, all data, settings
- **MANAGER** — clients, orders, production, delivery, reports
- **CHEF** — production summary, kitchen prints, catalog (read-only)
- **COURIER** — delivery only, mobile-first
