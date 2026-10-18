# pureclear-reports

Privacy-first receiver for PureClear's **Report a problem** and **Share feedback**
forms. A single Cloudflare Worker that validates, filters and stores the
minimal sanitized payload the site sends — nothing else.

## What it stores

| Column | Notes |
|---|---|
| `type` | `report` or `feedback` |
| `reason` | Failure code — **allowlisted** (`tool.error`, `tool.unsupported`, `tool.encryptedPdf`, `unknown`). Anything else is rejected with 400. |
| `file_ext` | Extension only (`heic`) — never the file name |
| `size_bucket` | `<1MB` / `1-10MB` / `10-100MB` / `>100MB` — never exact bytes |
| `browser` / `os` | Family only (`Chrome`, `Windows`) — no versions |
| `category` | Feedback only: `bug` / `idea` / `other` |
| `message` | User-typed text, max 2000 chars |
| `page` | Page path where the form was submitted |

**Never stored:** file names, file contents, user names, emails, IPs, any identifier.

## Protection

- Strict payload validation (types, lengths, allowlists) — malformed requests get 400
- Origin check: only `https://pureclear.dusrel.com` and `https://pureclear.pages.dev`
- Rate limit: 20 requests / IP / hour (approximate)

## One-time setup

1. **Create the D1 database** — Cloudflare dashboard → Workers & Pages → D1 → Create
   database named `pureclear_reports`. Copy its **database ID**.
2. **Run the schema** — in the D1 dashboard SQL console, paste `schema.sql`
   (or `npx wrangler d1 execute pureclear_reports --file schema.sql`).
3. **Paste the database ID** into `wrangler.toml` (replace
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`) and push.
4. **API token permission** — dashboard → My Profile → API Tokens → edit the
   token used for deploys → add **Workers Scripts: Edit**. (The Pages deploy
   token doesn't have it by default — deploys fail without this.)
5. **Repo secrets** — repo Settings → Secrets → Actions → add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (same values as the
   PureClear site repo).
6. **Push to `main`** — the workflow deploys automatically. The Worker URL
   will look like `https://pureclear-reports.<your-subdomain>.workers.dev`.
7. **Wire up the site** — set `REPORT_API_BASE` in
   `pureclear/src/lib/report.ts` to that URL. Forms go live immediately.

## Useful queries

```sql
-- top failure reasons, last 30 days
SELECT reason, COUNT(*) AS n FROM reports
WHERE type = 'report' AND created_at > date('now', '-30 days')
GROUP BY reason ORDER BY n DESC;

-- failures by file type
SELECT file_ext, COUNT(*) AS n FROM reports
WHERE type = 'report' GROUP BY file_ext ORDER BY n DESC;
```
