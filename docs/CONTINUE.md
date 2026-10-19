# Continue here (Reorder Desk)

Short handoff for the next session. Full history and decisions: `docs/PROGRESS.md`. Owner's launch steps
(Hinglish): `docs/LAUNCH.md`. Last session: 2026-10-19.

## How to start a new session

Paste this to Claude (the owner writes Hinglish):

> restock-app/docs/CONTINUE.md aur restock-app/docs/PROGRESS.md padho, phir Reorder Desk ka kaam wahin se aage badhao.

## Where things stand (2026-10-19)

- Code: https://github.com/Munish86/restock-app, branch `main`, last commit `f95e59a` (SMS and WhatsApp stock
  alerts for Pro). Nothing uncommitted. Every push to `main` redeploys Railway (web + worker) and runs migrations.
- Live: Railway project "courageous-compassion" (Postgres, Redis, `restock-app`, `restock-app-worker`), app
  installed on the dev store `bulk-uploader-test`. Not on the App Store yet.
- Plans: Free (50 variants, 1 location, email alerts) and Pro ($29/month, not confirmed by the owner yet: unlimited,
  all locations, seasonal, SMS + WhatsApp alerts with 100 messages/month).

## Last session: SMS + WhatsApp alerts (done, pushed)

- Code: `app/.server/texts.ts` (Twilio REST, monthly allowance, one-segment SMS), wired into `app/.server/alerts.ts`;
  settings in `app/lib/settings.ts` (`alerts.phones`, `phoneChannel`, `phoneLowStock`, `phoneWeekly`); limit in
  `app/lib/plans.ts` (`messages`); UI in `app/components/restock/SettingsForm.tsx`; migration
  `prisma/migrations/20261019000000_text_alerts`.
- Verified locally: `npm test` 52 passed, `npm run test:browser` all passed, typecheck, lint, build clean.
- Not verified: the Railway deploy of `f95e59a` (check both services are green), and any real Twilio sending.

## Next steps

Owner (in order, details in `docs/LAUNCH.md`):
1. Check the Railway deploy of `f95e59a` succeeded (web + worker); send Claude any error log.
2. LAUNCH.md 1-3: `npm run deploy` for the new name/handle, `APP_HANDLE=reorder-desk`, Public distribution,
   Managed Pricing plans "Free" / "Pro". Confirm the Pro price.
3. LAUNCH.md 4-6: protected customer data + `read_all_orders`, R2, Resend (email).
4. LAUNCH.md 6b: Twilio (Geo permissions first, SMS number, WhatsApp template), `TWILIO_*` on Railway, then
   Settings > "Send a test message".
5. LAUNCH.md 7: full test on the dev store; report what is wrong.

Claude:
- Fix whatever the owner's tests turn up; after the first real Twilio messages, check the MessageLog and costs.
- If Twilio prices change, adjust `messages` in `app/lib/plans.ts` (and the text in `docs/LISTING.md`, `LAUNCH.md`).
- Later (1.1): AI weekly summary (optional).

## Reminders

- This PC: add `C:\Windows\System32` to PATH in shell commands; `npm test` and prisma are slow (minutes), run them in
  the background. If both test files time out together, run `npx vitest run test/flow.test.ts` alone to check.
- New migration without a database: copy the old schema, then
  `npx prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel prisma/schema.prisma --script`.
