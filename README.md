# PSD Template Studio

A platform where admins upload real Adobe PSD templates, tag which layers
end users are allowed to edit, and end users fill in those fields (text,
photo replacement, layer visibility) and export at full production quality
— PDF/TIFF/PNG/JPEG, at the template's native DPI or higher. Built from the
[full specification](#specification) with a genuine PSD compositing engine,
not a flattened-template clone.

## Architecture

```
apps/
  api/     NestJS API — auth, categories/templates, projects, exports, admin
  web/     React + Vite frontend — auth UI, admin console, editor
  e2e/     Playwright end-to-end suite (drives the real app + a virtual passkey)
packages/
  scene-graph/  Shared, zod-validated PSD scene-graph types (layers, fields, overrides)
  psd-engine/   Real PSD ingestion (ag-psd) + a from-scratch compositor (@napi-rs/canvas)
```

The API and the ingestion/render workers are the same codebase (`apps/api`)
running two different entry points (`dist/main.js` vs `dist/worker/main.js`)
so they can scale independently. Both talk to Postgres, Redis (BullMQ), and
object storage (local disk in dev, S3/Cloudflare R2 in prod) through the same
services.

The defining architectural bet: the admin's field-mapping preview, the
end-user editor's live preview, and the final export all render the **same**
scene graph through the **same** compositor (`SceneCompositor` in
`packages/psd-engine`), just at different resolutions. That's what
guarantees the exported file matches what everyone saw while editing.

## Running locally

### Option A — Docker Compose (closest to production)

```sh
cp .env.example .env   # fill in real secrets; see comments in the file
docker compose up --build
```

This builds and runs Postgres, Redis, the API, the ingestion/render worker,
and the web app (served via nginx) together, running migrations
automatically before the API/worker start. The web app is at
`http://localhost:5173`, the API at `http://localhost:3000`.

### Option B — Run each piece directly (faster iteration)

Needs a local Postgres and Redis (or point `DATABASE_URL`/`REDIS_URL` at
any reachable instance).

```sh
pnpm install
cp .env.example .env          # then edit apps/api/.env or export the same vars
pnpm --filter @psd-studio/api run prisma:migrate

pnpm --filter @psd-studio/api run build
pnpm --filter @psd-studio/api run start          # API on :3000
pnpm --filter @psd-studio/api run start:worker    # ingestion/render worker
pnpm --filter @psd-studio/web run dev             # web app on :5173
```

The API reads its `.env` via `@nestjs/config`'s built-in dotenv loading —
put the file at `apps/api/.env` (or export the same variables in your
shell) when running outside Docker Compose.

### Bootstrapping the first admin

There is deliberately no API endpoint that hands out `SUPER_ADMIN` — the
first platform admin is granted directly in the database, same as any
real deployment's break-glass admin account:

```sql
INSERT INTO user_role_assignments (id, "userId", role, "createdAt")
VALUES (gen_random_uuid(), '<the user's id>', 'SUPER_ADMIN', now());
```

(Register the account and enroll a passkey through the UI first, to get its
id — then re-login, or refresh the page if already signed in, to pick up
the new role on the next token.)

## Testing

```sh
pnpm run test:unit   # scene-graph + psd-engine — pure logic, no services needed
pnpm run test:api    # NestJS integration tests — needs Postgres + Redis
pnpm run test:e2e    # Playwright, drives the real app end-to-end — needs
                      # Postgres, Redis, the API, the worker, and the web
                      # app all running (see apps/e2e/README notes below)
pnpm run typecheck   # every package
```

`test:e2e` uses Chrome DevTools Protocol's WebAuthn domain to attach a
*virtual* authenticator, so the passkey flows are exercised for real —
challenge/response, attestation, assertion — without any hardware key or
manual interaction.

## Deploying

The Dockerfiles (`apps/api/Dockerfile`, `apps/web/Dockerfile`) are
self-contained and build from the repository root:

```sh
docker build -f apps/api/Dockerfile -t psd-studio-api .
docker build -f apps/web/Dockerfile -t psd-studio-web \
  --build-arg VITE_API_URL=https://api.yourdomain.com/api/v1 .
```

The intended production pairing (spec §6, §14) is **Railway** for the API,
worker, Postgres and Redis, and **Cloudflare** in front for DNS/CDN/WAF/
Turnstile and R2 object storage:

1. Create Postgres and Redis on Railway (or bring your own).
2. Create two Railway services from `apps/api/Dockerfile` — one running the
   default CMD (the API), one overriding it to `node dist/worker/main.js`
   — pointed at the same Postgres/Redis.
3. Create a Railway service from `apps/web/Dockerfile` with
   `VITE_API_URL` set to the API service's public URL.
4. Set `STORAGE_DRIVER=s3` and the `S3_*` variables to a Cloudflare R2
   bucket for production object storage (the local-disk driver is dev-only).
5. Set `TRUST_PROXY=true` (Railway/Cloudflare front every request through a
   proxy — without this, rate limiting and the audit log would see the
   proxy's IP for every request instead of the caller's).
6. Run `pnpm --filter @psd-studio/api run prisma:deploy` against the
   production `DATABASE_URL` before first boot (CI does this automatically;
   see `.github/workflows/ci.yml`).

See `.env.example` for the full list of required variables.

## What's genuinely implemented

Every item below has been exercised end-to-end against a real running
stack, not just written and assumed correct — see `apps/e2e` and
`apps/api/test`:

- Passkey (WebAuthn) registration and login as the primary auth path;
  password+TOTP as an always-MFA fallback (no password-only login for any
  role); rotating refresh tokens with reuse detection; step-up
  re-authentication gating destructive admin actions; RBAC enforced
  server-side; a hash-chained, tamper-evident audit log.
- Real PSD/PSB ingestion via `ag-psd` — layers, groups, multi-run text,
  smart objects, adjustment layers, blend-mode mapping with documented
  fidelity notes — running in a memory-capped, time-boxed child process so
  a hostile or malformed file can't take down the worker.
- A from-scratch compositor that renders the ingested scene graph (with
  field overrides merged in) at any resolution, including clip groups and
  isolated (non-pass-through) group blending.
- Admin field-mapping workspace: click a layer in the real parsed layer
  tree, tag it as a text/image/smart-object/visibility field with
  constraints, publish (step-up gated).
- End-user editor: a live layered canvas composited in the browser
  (`packages/canvas-renderer`, the same one the admin workspace uses) with
  the project's field values merged in through the same
  `toFieldOverrides` the server's export uses. Only fields an admin mapped
  are interactive: type text in place on the canvas (synced with the
  sidebar, with length/required/overflow feedback), drop a photo onto its
  layer and drag/scroll/pinch to reposition and zoom it (saved as the
  field's crop window), toggle show/hide layers from on-canvas chips, and
  zoom/pan like the admin canvas. Where the browser canvas knowingly
  differs from the export (a missing font, text styling the server
  doesn't apply yet, top-level clipping masks) the field says so. Photo
  uploads are validated server-side (type, bytes, pixels, dimensions after
  EXIF orientation) and bound to their project. An async export pipeline
  produces PNG/JPEG/real-PDF (via Skia)/TIFF with signed, expiring
  download URLs.

## Known scope limits (stated up front, not discovered later)

In the spirit of the spec's own "honest scope limits" principle:

- **No email delivery is wired up.** Registration creates an `ACTIVE`
  account immediately rather than sending a verification email — there's
  no SMTP/email provider configured in this environment. The schema and
  flow support adding it later without a redesign.
- **The photo cropper is reposition/zoom only.** Uploads start
  cover-fitted to their layer (never distorted) and can be dragged and
  scaled inside it; there's no rotation, and the admin's aspect-ratio
  constraint isn't enforced on upload since the crop always matches the
  layer.
- **The editor has no undo/redo for field edits** (the admin workspace
  does). Text boxes keep the browser's own undo while typing.
- **No lint tooling is configured** (`lint` scripts are stubs). Type
  checking and the test suites are the current correctness net.
- **Advanced PSD fidelity gaps are real, not hidden**: warp/Liquify and
  most non-Canvas2D blend modes are approximated, not pixel-exact (see
  `packages/psd-engine/src/blendMode.ts` and the ingestion warnings
  surfaced in the admin workspace); adjustment layers are structural
  (toggle-only) in this version, not yet applying their pixel effect.
- **S3/R2 storage driver is implemented but untested against a real
  bucket** in this environment (no credentials available here) — the
  local-disk driver is what's actually been exercised end-to-end.
- **CI is defined but has not been run on GitHub's infrastructure** from
  this environment — it mirrors the exact steps verified locally
  (build → migrate → integration tests → e2e), but hasn't had a live run
  on `actions/checkout`'s runners to shake out CI-specific environment
  differences.

## Specification

The original full software specification (architecture, security model,
data model, roadmap, open questions) this system was built from lives in a
companion living doc, not in this repository.
