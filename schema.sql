-- Run once after creating the D1 database:
--   npx wrangler d1 execute pureclear_reports --file schema.sql
-- or paste into the D1 dashboard's SQL console.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('report', 'feedback')),
  reason      TEXT,          -- report only; allowlisted failure code
  file_ext    TEXT,          -- report only; extension, never the file name
  size_bucket TEXT,          -- report only; <1MB / 1-10MB / 10-100MB / >100MB
  browser     TEXT,          -- family only (Chrome, Firefox, …)
  os          TEXT,          -- family only (Windows, macOS, …)
  app_version TEXT,
  category    TEXT,          -- feedback only; bug / idea / other
  message     TEXT,          -- user-typed, max 2000 chars
  page        TEXT,           -- locale-agnostic page path
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_type_reason ON reports(type, reason);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
