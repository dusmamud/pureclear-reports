/**
 * pureclear-reports — privacy-first receiver for PureClear's report/feedback forms.
 *
 * This Worker is the ONLY server-side piece of PureClear. It receives the
 * minimal sanitized payload documented in the site's src/lib/report.ts,
 * validates + filters it, and stores it in D1. Nothing else.
 *
 * Filtering rules (the "reason filter"):
 *  - `reason` must be in the allowlist below — anything else is rejected (400)
 *  - every field is length-checked and type-checked; extra fields are ignored
 *  - max 20 requests / IP / hour (approximate, per-isolate)
 *  - only the two production origins are accepted (CORS + Origin check)
 */

const ALLOWED_ORIGINS = [
  "https://pureclear.dusrel.com",
  "https://pureclear.pages.dev",
];

// The reason filter: only these failure reasons are accepted.
const REPORT_REASONS = new Set([
  "tool.error",
  "tool.unsupported",
  "tool.encryptedPdf",
  "unknown",
]);

const SIZE_BUCKETS = new Set(["<1MB", "1-10MB", "10-100MB", ">100MB"]);
const FEEDBACK_CATEGORIES = new Set(["bug", "idea", "other"]);

// --- rate limiting (simple sliding window, per-isolate approximate) ---
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // ip -> number[]

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  // opportunistic cleanup so the map can't grow unbounded
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
    }
  }
  return arr.length > RATE_LIMIT;
}

// --- helpers ---
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

const str = (v, max) =>
  typeof v === "string" && v.length <= max ? v : null;

function validateReport(p) {
  if (p.type !== "report") return { ok: false, error: "bad_type" };
  const reason = str(p.reason, 40);
  if (!reason || !REPORT_REASONS.has(reason))
    return { ok: false, error: "bad_reason" };
  const fileExt = str(p.fileExt, 10);
  if (fileExt === null || !/^[a-z0-9]*$/i.test(fileExt))
    return { ok: false, error: "bad_ext" };
  const sizeBucket = str(p.sizeBucket, 10);
  if (!sizeBucket || !SIZE_BUCKETS.has(sizeBucket))
    return { ok: false, error: "bad_size" };
  const browser = str(p.browser, 30);
  const os = str(p.os, 30);
  if (browser === null || os === null) return { ok: false, error: "bad_client" };
  const message = str(p.message ?? "", 2000);
  if (message === null) return { ok: false, error: "bad_message" };
  const page = str(p.page ?? "/", 200);
  if (page === null) return { ok: false, error: "bad_page" };
  const appVersion = str(p.appVersion ?? "", 20);
  if (appVersion === null) return { ok: false, error: "bad_version" };
  return {
    ok: true,
    row: {
      type: "report", reason, fileExt, sizeBucket, browser, os,
      appVersion, category: null, message, page,
    },
  };
}

function validateFeedback(p) {
  if (p.type !== "feedback") return { ok: false, error: "bad_type" };
  const category = str(p.category, 10);
  if (!category || !FEEDBACK_CATEGORIES.has(category))
    return { ok: false, error: "bad_category" };
  const browser = str(p.browser, 30);
  const os = str(p.os, 30);
  if (browser === null || os === null) return { ok: false, error: "bad_client" };
  const message = str(p.message ?? "", 2000);
  if (message === null || message.length === 0)
    return { ok: false, error: "bad_message" };
  const page = str(p.page ?? "/", 200);
  if (page === null) return { ok: false, error: "bad_page" };
  const appVersion = str(p.appVersion ?? "", 20);
  if (appVersion === null) return { ok: false, error: "bad_version" };
  return {
    ok: true,
    row: {
      type: "feedback", reason: null, fileExt: null, sizeBucket: null,
      browser, os, appVersion, category, message, page,
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.includes(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (url.pathname !== "/report" && url.pathname !== "/feedback")
      return json({ ok: false, error: "not_found" }, 404);
    if (!ALLOWED_ORIGINS.includes(origin))
      return json({ ok: false, error: "forbidden_origin" }, 403);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) return json({ ok: false, error: "rate_limited" }, 429);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, origin);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return json({ ok: false, error: "invalid_json" }, 400, origin);

    const v =
      url.pathname === "/report" ? validateReport(body) : validateFeedback(body);
    if (!v.ok) return json({ ok: false, error: v.error }, 400, origin);

    try {
      await env.DB.prepare(
        `INSERT INTO reports
           (type, reason, file_ext, size_bucket, browser, os, app_version, category, message, page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          v.row.type, v.row.reason, v.row.fileExt, v.row.sizeBucket,
          v.row.browser, v.row.os, v.row.appVersion, v.row.category,
          v.row.message, v.row.page
        )
        .run();
    } catch (e) {
      return json({ ok: false, error: "db_error" }, 500, origin);
    }

    return json({ ok: true }, 200, origin);
  },
};
