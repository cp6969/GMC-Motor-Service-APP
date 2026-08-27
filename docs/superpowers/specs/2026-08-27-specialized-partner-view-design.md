# Specialized partner view — design

**Date**: 2026-08-27
**Status**: approved by owner, ready to implement

## Purpose

Specialized wants read-only access to GMC's motor service log so their own
office staff can check, if a "comeback" (warranty/defect claim) comes in
against a motor, whether GMC actually serviced that motor and what was
found/done — without giving Specialized any access to the internal
tech-facing app, customer contact details, or pricing.

## Access model

- New app-setting key `specialized_passcode` (same `app_settings` key/value
  table and pattern the existing workshop `passcode` already uses — seeded
  once, editable from Settings afterward, no redeploy needed to rotate it).
- New login page at `GET /partner`, posting to `POST /api/partner/login`.
  On success, issues a JWT signed with the same `JWT_SECRET` but carrying
  `{ role: 'specialized' }` instead of `{ workshop: 'gmc' }`, 90-day expiry
  (matching the internal login's own expiry).
- Desktop-oriented only (per owner: Specialized will only ever access this
  from a computer) — no mobile/PWA treatment needed, unlike the rest of the
  app.

### Role separation (security-critical)

Today `authMiddleware` accepts *any* validly-signed JWT — it never checks
the payload's claims. That means, unmodified, a `role: 'specialized'` token
would also work against every internal CRUD endpoint (`/api/records`,
`/api/dealers`, delete routes, etc.), which defeats the whole point of this
being a restricted, read-only view.

Fix, before adding anything else:
- `authMiddleware` (guards every existing internal route) is tightened to
  require `payload.workshop === 'gmc'` — a `specialized`-role token is
  rejected with 401.
- New `partnerAuthMiddleware` requires `payload.role === 'specialized'` —
  an internal workshop token is rejected with 401 here too.

So the two tokens are mutually exclusive: a leaked Specialized credential
can only ever reach the new read-only search endpoint; a leaked internal
token can't authenticate as a partner either (not a real risk today, but
keeps the boundary honest either way).

## The page

- Single page, `public/partner.html` + `public/partner.js`, same minimal
  shell pattern as the existing `dealer-share.html`/`.js` (own `<div
  id="app">`, own script, `noindex, nofollow`, no shared nav with the
  internal app).
- On login, immediately loads and shows **every** service record (small
  volume today — 12 records — no pagination needed yet; revisit if this
  grows into the hundreds).
- A search box filters that same list, live, on partial match against
  serial number / dealer name / brand (same `LIKE %term%` shape the
  internal search already uses) — client-side filtering of the one fetched
  list, no extra round trip per keystroke.
- Sorted newest received first.
- No other navigation, no create/edit UI, no list of dealers/customers to
  browse independently of a motor record.

## Data returned per record

Included: `serial_number`, `brand`, `model`, `dealer_name` (or dealer
alias, same resolution the internal list already does), `status`,
`date_received`, `date_completed`, `date_returned`, `issue_reported`,
`work_performed`, `parts_replaced`, and any attached photos (served from
the existing public, unauthenticated `/uploads/...` path — same trust
model already accepted for the dealer-share view).

Deliberately excluded: `technician`, `notes` (internal-only), and
everything quote/pricing-related (`quote_amount`, `quote_status`,
`quote_line_items`, `lightspeed_*` fields) — none of this is Specialized's
business, per the owner's explicit choice.

## Endpoints

- `POST /api/partner/login` — `{ passcode }` → `{ token }` (no auth
  required to call this one, obviously).
- `GET /api/partner/records` — `partnerAuthMiddleware`. Returns every
  record with the field set above, newest-received first, plus each
  record's photo filenames (`SELECT filename FROM service_images WHERE
  record_id = ?`).
- Settings: reuse the existing `/api/settings/passcode`-style route shape
  for a new `POST /api/settings/specialized-passcode` (internal
  `authMiddleware`-gated, current-passcode-confirmation same as the
  existing one) so the owner can set/rotate it from the internal Settings
  page.

## Out of scope

- No pagination (revisit if record count grows substantially).
- No per-Specialized-user accounts/audit log of who searched what — single
  shared passcode, same trust level as every other credential in this app.
- No write access of any kind from the partner side.
