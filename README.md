# GMC Motor Service Log

**Status as of 2026-08-09**: running, healthy. Container `motor-service-tracker` up, `/healthz`-equivalent root path returns 200, clean logs.

**Web address**: https://motors.13industries.co.za (public, via Cloudflare Tunnel). On the local network you can also reach it directly at `http://<your-unraid-ip>:8091`.

A mobile-optimized web app for tracking ebike motor service records at Greg Minnaar Cycles, app at motors.13industries.co.za. Log serial numbers, dealer info, service work, and photos for every motor that comes through the workshop. Install it to your phone's home screen and it behaves like a native app.

## What it does

- Log a service record per motor: serial number, brand/model, dealer who sent it, dates, status, issue reported, work performed, parts replaced, technician, notes
- Attach photos straight from your phone's camera to any record
- Search by serial number, dealer, or brand
- Filter by status: Received / In Progress / Completed / Returned
- One shared workshop passcode — simple to log in on every phone, no per-user accounts to manage
- All data (SQLite database + photos) lives on your Unraid server

## Deploying on Unraid

1. Copy the whole `motor-service-tracker` folder onto your Unraid box, e.g. into `/mnt/user/appdata/motor-service-tracker`.
2. Open `docker-compose.yml` and change these two lines:
   ```yaml
   - APP_PASSCODE=changeme          # set your workshop passcode
   - JWT_SECRET=please-change-this-to-something-random   # any random string
   ```
3. From that folder, run:
   ```bash
   docker compose up -d --build
   ```
   (If your Unraid doesn't have the `docker compose` plugin, you can instead build the image and run it from the Unraid **Docker** tab using the `backend/Dockerfile`, mapping port `3000` to whatever host port you like, and mounting `/app/data` and `/app/uploads` to persistent appdata folders.)
4. The app will be available at `http://<your-unraid-ip>:8091` (or whatever host port you chose).

### Data persistence

Two folders are created next to `docker-compose.yml`:
- `./data` — the SQLite database (`motors.db`)
- `./uploads` — all uploaded service photos

Back these two folders up as part of your normal Unraid backup routine (e.g. your existing appdata backup plugin) — that's your entire service history.

## Using it on your phones

1. Open https://motors.13industries.co.za (or `http://<your-unraid-ip>:8091` on the local network) in Chrome (Android) or Safari (iPhone).
2. Log in with the workshop passcode.
3. Use the browser menu → **"Add to Home screen" / "Install app"**. It'll then open full-screen like a normal app, with its own icon.
4. Do this on each phone that needs access — everyone shares the same passcode and sees the same records.

## Adding fields or changing the workflow later

The whole app is plain Node.js/Express + SQLite on the backend and vanilla JS on the frontend (no build step) — everything is in `backend/server.js`, `backend/db.js`, and `backend/public/`. If you want new fields, different statuses, or a dealer-return checklist added later, just say so and it can be built on top of this.

## Security note

This app is meant to run on your own network (or behind Tailscale/your VPN, consistent with the rest of your stack) rather than exposed directly to the internet, since the single shared passcode is convenience-oriented rather than hardened multi-user auth.
