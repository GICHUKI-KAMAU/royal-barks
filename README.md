# Royal Barks

Royal Barks is a group management application with a React and TypeScript UI and a Node.js API. The API supports local SQLite through `better-sqlite3` and hosted PostgreSQL through `pg`. Financial, authentication, and Chama authorization checks run on the server.

## Architecture

```text
UI/                         React application and Vite configuration
  src/
    components/common/      Reusable form, status, and table feedback components
    features/auth/          Login, invitation acceptance, and password reset
    features/chama/         Chama cycle, board, and payout experience
    features/finance/       Financial transaction and CSV import dialog
    features/members/       Member status workflow
    features/reports/       Historical and as-of financial reports
    features/users/         Admin invitation and role management
    services/               API client and API base URL
    utils/                  Currency/date formatting and CSV parsing
API/
  src/
    database.js             Database selection and SQLite base schema
    postgresDatabase.js     PostgreSQL compatibility adapter
    postgres.worker.js      Isolated PostgreSQL connection
    auth.js                 Sessions, invitations, password reset, roles, audit
    modules/
      chama.js              Chama schema, transitions, selection, and payout rules
      financeQueries.js     Dashboard, member balances, and report queries
      imports.js            CSV import preview, validation, and posting
    server.js               HTTP API, financial writes, imports, meetings, and routing
  migrations/               Ordered PostgreSQL schema and security migrations
  scripts/                  Admin, migration, and database import commands
  test/                     Auth, finance, access-control, and Chama tests
shared/
  contracts.js              Safe role and status constants imported by both apps
  contracts.d.ts            Framework-independent shared API types
```

The frontend and API share only public role/status constants and safe profile types. Password hashes, session secrets, SMTP configuration, and database code stay in `API`. The browser calls a configurable API base path; the server makes all authorization decisions.

## Prerequisites and installation

- Node.js 20.19 or newer (Node 22 LTS recommended).
- npm 10 or newer.

From the repository root:

```sh
npm install
```

Copy `.env.example` to `.env` and configure SMTP before sending invitations or password-reset messages. Gmail uses `smtp.gmail.com` on port 465 with TLS. It requires an App Password for an account with 2-Step Verification enabled; put it in `SMTP_PASSWORD` in the ignored local `.env`. See Google's [App Password instructions](https://support.google.com/accounts/answer/185833). Never put SMTP credentials or other server secrets in a `VITE_` variable.

## Environment configuration

The API reads the root `.env` file. Supported settings include:

| Variable                                | Purpose                              | Default                                 |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| `PORT`                                  | Local API listener port              | `8001`                                  |
| `ROYAL_BARKS_DB`                        | SQLite database path                 | `API/data/royal_barks.sqlite3`          |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP transport                       | unset / `587` / `false`                 |
| `SMTP_USER`, `SMTP_PASSWORD`            | Optional SMTP authentication         | unset                                   |
| `SMTP_FROM`                             | Invitation and reset sender          | required for mail                       |
| `APP_BASE_URL`                          | Frontend URL included in email links | `http://127.0.0.1:5173`                 |
| `API_PROXY_TARGET`                      | Vite development proxy destination   | `http://127.0.0.1:8001`                 |
| `VITE_API_BASE_URL`                     | Browser API base path                | `/api`                                  |
| `DATABASE_URL`                          | Optional PostgreSQL connection URL   | unset (SQLite)                          |
| `DATABASE_SSL`                          | PostgreSQL TLS; set `false` locally  | `true`                                  |
| `SESSION_COOKIE_SAME_SITE`              | Session cookie cross-site policy     | `Strict` locally / `None` in production |

For local development, keep the browser API base same-origin (`/api`) and let Vite proxy requests to the Node API. For separate production hosts, set `VITE_API_BASE_URL` to the HTTPS API URL and set `APP_BASE_URL` to the frontend origin; the API allows credentialed requests only from that origin. The API uses `APP_BASE_URL` to validate state-changing requests. Production cookies use `SameSite=None; Secure`; browser third-party cookie restrictions may make a same-site proxy or custom domain preferable. The client API helper includes credentials and moves an expired/revoked session back to sign-in.

## Database and migrations

Without `DATABASE_URL`, the API uses `API/data/royal_barks.sqlite3`. When `DATABASE_URL` is set, it uses PostgreSQL instead. Run `npm run db:migrate:postgres` to apply the ordered migrations before starting the API. PostgreSQL migrations add tables and security rules; they do not drop or reset records.

To move local records, configure the PostgreSQL URL in the ignored root `.env`, run `npm run db:migrate:postgres`, then run `npm run db:import:sqlite` and type `IMPORT` at its confirmation prompt. The importer refuses a non-empty PostgreSQL target and records a source fingerprint to prevent duplicate imports. It preserves financial history, profiles, role assignments, pending invitation tokens, audit records, and Chama records. Existing login sessions and temporary login rate limits are intentionally omitted, so users must sign in again. Keep a protected SQLite backup until you reconcile member counts and financial totals.

For local PostgreSQL, set `DATABASE_SSL=false` and use a URL for your local database. For Supabase, use the session pooler connection string from the project's Connect panel and keep `DATABASE_SSL=true`. Never put the database URL in a `VITE_` variable. All application tables have RLS enabled with no browser-facing policies; the API connects server-side and continues to enforce user and role permissions.

The current API exposes synchronous SQLite-style queries. PostgreSQL runs in a worker thread through a compatibility adapter so existing authorization and financial rules remain unchanged during migration. Requests wait synchronously for database responses; this fits the current small group but should be replaced with asynchronous repository methods before scaling to heavier concurrent use.

The root `royal_barks.sqlite3` is retained as a historical source and is not the API's default database. The older Python implementation is retained under `API/legacy_python` for reference. Take a protected backup before applying application updates; do not delete either database to solve migration errors.

The root `royal_barks.sqlite3` is retained as a historical source and is not the API's default database. The older Python implementation is retained under `API/legacy_python` for reference. Take a protected backup before applying application updates; do not delete either database to solve migration errors.

## Authentication setup

Accounts are invite-only. No default account is created. To invite the first Admin to choose a password, run this command in a local terminal:

```sh
npm --prefix API run bootstrap-admin-invitation -- admin@example.org "Admin name"
```

With SMTP configured, the command emails the setup link. Without SMTP, it prints a one-time setup link in the local terminal; handle that link like a password until it is accepted. The database prevents repeated bootstrap and a second Admin. The legacy `npm --prefix API run bootstrap-admin` command remains available for a local operator who needs to set the initial password directly. Invitations expire after seven days and reset links after 30 minutes.

Run `npm run email:test -- recipient@example.org` to verify SMTP and send a test message. To send a pending first Admin invitation after configuring Gmail, run `npm run email:resend-admin-invitation -- gichukikamau01@gmail.com`. This issues a fresh setup link and emails it.

Members without email addresses remain member records without login accounts; do not share credentials or use unverified email addresses. A future phone/SMS sign-in requires a separately configured and tested identity provider.

Admin transfers are transactional and audited. Emergency recovery is restricted to an authorized database operator using protected direct database access while the API is stopped. Never create a public recovery endpoint or publish recovery credentials.

## Development commands

Run frontend and backend together:

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. The local health endpoint is <http://127.0.0.1:8001/api/health>.

```sh
npm run build          # UI production build and Node syntax checks
npm run typecheck      # strict UI TypeScript project check
npm test               # API tests
npm run lint           # ESLint across UI, API, tests, and scripts
npm run format         # Prettier on application code, docs, and JSON
npm run format:check   # Prettier verification
```

## Vercel frontend deployment

The root `vercel.json` builds the Vite frontend and publishes `UI/dist`, which is
the output directory created by `npm run build`. Set `VITE_API_BASE_URL` in the
Vercel project to the deployed API base URL. For a same-origin reverse proxy,
keep it as `/api`; for a separately hosted API, use its HTTPS URL and configure
that API's allowed browser origin and secure cookie settings accordingly.

This configuration deploys the frontend only. The API is a persistent Node.js
HTTP server and runs on a separate Node host; PostgreSQL provides persistent
data storage. Keep SMTP credentials and other server secrets in the API host's
environment, never in `VITE_` variables.

## PostgreSQL backend deployment

`render.yaml` defines a free Render Node service. Connect the repository in Render and provide `DATABASE_URL`, `APP_BASE_URL`, and SMTP values in its environment settings. The build applies PostgreSQL migrations before compiling and checking the applications. Set Vercel's `VITE_API_BASE_URL` to the deployed API HTTPS URL and Render's `APP_BASE_URL` to the Vercel site origin. Production sessions use secure cross-site cookies, and the API only allows the configured frontend origin. The Render service needs no local disk because PostgreSQL holds application records.

The Supabase schema and RLS migrations are applied to project `xotlbfjfqbrbtpgujioi`. The SQLite data import still requires the Supabase connection URL in the ignored `.env`; after importing, verify member counts and the April 2026 statement totals before directing users to the hosted API.

## API and authorization

The browser uses `UI/src/services/apiClient.ts`, which prefixes requests with `VITE_API_BASE_URL`, sends the HttpOnly cookie, and maps expired sessions to the login flow. Vite proxies `/api` to `API_PROXY_TARGET` during development. API authentication, member scoping, and role checks are implemented in `API/src/auth.js` and `API/src/server.js`; protected routes do not trust frontend visibility or submitted role IDs.

The UI navigation shows all module names while the server limits records and actions by role. The financial ledger keeps imported opening balances separate from new payments and obligations. Chama records remain separate from ordinary Royal Barks finances.

## Current implementation notes

- Authentication, account invitations, password reset, Admin transfer, user roles, audit events, financial imports, member balances, meetings, and the Chama lifecycle are implemented.
- Chama card claims use database transactions and uniqueness constraints; authorized viewers receive persisted board updates through server-sent events.
- The current automated suite covers authentication, role checks, account lifecycle, member scoping, Chama opt-in privacy, card selection, result publication, corrections, and payouts. There is no separate frontend test runner configured yet.
- Minutes, expenses, and settings currently have navigation entries but do not yet have dedicated record-management workflows.
- Historical summary imports do not claim a transaction-level historical audit trail when the source transactions were not provided.
