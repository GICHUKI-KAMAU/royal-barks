# Royal Barks

Royal Barks is a group management application with a React and TypeScript UI and a Node.js API. The API uses SQLite through `better-sqlite3`. Financial, authentication, and Chama authorization checks run on the server.

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
    database.js             SQLite connection, base schema, additive migration
    auth.js                 Sessions, invitations, password reset, roles, audit
    modules/
      chama.js              Chama schema, transitions, selection, and payout rules
      financeQueries.js     Dashboard, member balances, and report queries
      imports.js            CSV import preview, validation, and posting
    server.js               HTTP API, financial writes, imports, meetings, and routing
  scripts/                  First Admin password bootstrap and invitation commands
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

| Variable                                | Purpose                              | Default                        |
| --------------------------------------- | ------------------------------------ | ------------------------------ |
| `PORT`                                  | Local API listener port              | `8001`                         |
| `ROYAL_BARKS_DB`                        | SQLite database path                 | `API/data/royal_barks.sqlite3` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP transport                       | unset / `587` / `false`        |
| `SMTP_USER`, `SMTP_PASSWORD`            | Optional SMTP authentication         | unset                          |
| `SMTP_FROM`                             | Invitation and reset sender          | required for mail              |
| `APP_BASE_URL`                          | Frontend URL included in email links | `http://127.0.0.1:5173`        |
| `API_PROXY_TARGET`                      | Vite development proxy destination   | `http://127.0.0.1:8001`        |
| `VITE_API_BASE_URL`                     | Browser API base path                | `/api`                         |

Keep the browser API base same-origin (normally `/api`) so the HttpOnly session cookie works with a reverse proxy. `API_PROXY_TARGET` points the Vite development proxy at the local Node API. `APP_BASE_URL` must match the browser origin; the API uses it to validate state-changing requests behind the proxy. The client API helper includes credentials and moves an expired/revoked session back to sign-in.

## Database and migrations

The active default database is `API/data/royal_barks.sqlite3`. `API/src/database.js` creates missing tables and applies the existing additive `supplemental_json` import migration. Authentication and Chama initialize their own tables and backward-compatible additions when the API starts. The migration path does not drop, reset, or recreate existing records.

The root `royal_barks.sqlite3` is retained as a historical source and is not the API's default database. The older Python implementation is retained under `API/legacy_python` for reference. Take a protected backup before applying application updates; do not delete either database to solve migration errors.

SQLite does not provide PostgreSQL row-level security. The API scopes sensitive queries and checks each privileged operation server-side. Keep the SQLite file private and do not expose the API directly to the public internet. A public or multi-tenant deployment needs a reviewed PostgreSQL/RLS migration and production transport/session configuration.

## Authentication setup

Accounts are invite-only. No default account is created. To invite the first Admin to choose a password, run this command in a local terminal:

```sh
npm --prefix API run bootstrap-admin-invitation -- admin@example.org "Admin name"
```

With SMTP configured, the command emails the setup link. Without SMTP, it prints a one-time setup link in the local terminal; handle that link like a password until it is accepted. The database prevents repeated bootstrap and a second Admin. The legacy `npm --prefix API run bootstrap-admin` command remains available for a local operator who needs to set the initial password directly. Invitations expire after seven days and reset links after 30 minutes.

Run `npm run email:test -- recipient@example.org` to verify SMTP and send a test message. To send a pending first Admin invitation after configuring Gmail, run `npm run email:resend-admin-invitation -- gichukikamau01@gmail.com`. This issues a fresh setup link and emails it.

Members without email addresses remain member records without login accounts; do not share credentials or use unverified email addresses. A future phone/SMS sign-in requires a separately configured and tested identity provider.

Admin transfers are transactional and audited. Emergency recovery is restricted to an authorized database operator using a local protected SQLite session while the API is stopped. Never create a public recovery endpoint or publish recovery credentials.

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

## API and authorization

The browser uses `UI/src/services/apiClient.ts`, which prefixes requests with `VITE_API_BASE_URL`, sends the HttpOnly cookie, and maps expired sessions to the login flow. Vite proxies `/api` to `API_PROXY_TARGET` during development. API authentication, member scoping, and role checks are implemented in `API/src/auth.js` and `API/src/server.js`; protected routes do not trust frontend visibility or submitted role IDs.

The UI navigation shows all module names while the server limits records and actions by role. The financial ledger keeps imported opening balances separate from new payments and obligations. Chama records remain separate from ordinary Royal Barks finances.

## Current implementation notes

- Authentication, account invitations, password reset, Admin transfer, user roles, audit events, financial imports, member balances, meetings, and the Chama lifecycle are implemented.
- Chama card claims use SQLite transactions and uniqueness constraints; authorized viewers receive persisted board updates through server-sent events.
- The current automated suite covers authentication, role checks, account lifecycle, member scoping, Chama opt-in privacy, card selection, result publication, corrections, and payouts. There is no separate frontend test runner configured yet.
- Minutes, expenses, and settings currently have navigation entries but do not yet have dedicated record-management workflows.
- Historical summary imports do not claim a transaction-level historical audit trail when the source transactions were not provided.
