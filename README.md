# PSD Template Studio

A platform where admins upload real Adobe PSD templates and publish them —
every unlocked layer becomes a field end users can edit, locked layers stay
fixed design — and end users fill in those fields (text,
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
  scene-graph/      Shared, zod-validated PSD scene-graph types (layers, fields, overrides)
  psd-engine/       Real PSD ingestion (ag-psd) + the server compositor (@napi-rs/canvas)
  canvas-renderer/  The browser compositor behind both editing canvases, plus hit testing,
                    text layout/measurement and crop geometry
```

The API and the ingestion/render workers are the same codebase (`apps/api`)
running two different entry points (`dist/main.js` vs `dist/worker/main.js`)
so they can scale independently. Both talk to Postgres, Redis (BullMQ), and
object storage (local disk in dev, S3/Cloudflare R2 in prod) through the same
services.

The defining architectural bet: the admin workspace, the end-user editor
and the final export all render the **same** scene graph, with field values
merged in by the **same** `toFieldOverrides` (`packages/scene-graph`). The
two canvases composite it live in the browser (`packages/canvas-renderer`);
exports are rendered by the worker (`SceneCompositor` in
`packages/psd-engine`). The two compositors deliberately mirror each other
— same layer order, clip-group approximation, text wrap and crop maths —
and the e2e suite checks the editor canvas's pixels against a real export.
Where they knowingly differ, the code marks it (`Diverges from server` in
`canvas-renderer/src`) and the editor tells the user on the affected field;
see [Known scope limits](#known-scope-limits-stated-up-front-not-discovered-later).

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

Packages typecheck against each other's emitted `.d.ts`, so build the
shared packages (and generate the Prisma client) once after installing:

```sh
pnpm --filter @psd-studio/scene-graph run build
pnpm --filter @psd-studio/psd-engine run build
pnpm --filter @psd-studio/canvas-renderer run build
pnpm --filter @psd-studio/api run prisma:generate
```

```sh
pnpm run typecheck   # every package
pnpm run test:unit   # scene-graph + psd-engine + canvas-renderer — pure logic, no services needed
pnpm run test:api    # NestJS integration tests — builds the API, needs Postgres + Redis
pnpm run test:e2e    # Playwright, drives the real app end-to-end — needs
                      # Postgres, Redis, the API, the worker, and a web
                      # build all running (see the e2e job in .github/workflows/ci.yml)
```

The e2e suite reads `E2E_WEB_URL` (default `http://localhost:5173`),
`DATABASE_URL` (it truncates that database and grants the admin role
directly), `PASSWORD_PEPPER` (the password + TOTP admin spec provisions
its admin with the built API's `seed-admin` script) and optionally
`E2E_CHROMIUM_PATH`. Each spec starts from an empty database.

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
`apps/api/test`. (Within the canvas controls, touch/trackpad pinch and
middle-drag pan are implemented but not covered by the e2e specs, which
drive mouse, wheel, keyboard and Space+drag.)

- Passkey (WebAuthn) registration and login as the primary auth path;
  password+TOTP as an always-MFA fallback (no password-only login for any
  role); rotating refresh tokens with reuse detection; step-up
  re-authentication (passkey, or authenticator code for accounts without
  one) gating publishing and destructive admin actions; RBAC enforced
  server-side; a hash-chained, tamper-evident audit log.
- Real PSD/PSB ingestion via `ag-psd` — layers, groups, multi-run text,
  smart objects, adjustment layers, blend-mode mapping with documented
  fidelity notes — running in a memory-capped, time-boxed child process so
  a hostile or malformed file can't take down the worker.
- Two compositors over the same scene graph: the worker's
  (`SceneCompositor`, for exports at any resolution) and the browser's
  (`canvas-renderer`, for both editing canvases, rendering only the
  zoomed/panned viewport). Both handle clip groups and isolated
  (non-pass-through) group blending, and paint field overrides the same
  way. Layer rasters are served per layer and decoded downsampled in the
  browser, so large print PSDs stay responsive.
- A shared canvas (`apps/web/src/canvas/SceneCanvas.tsx`) with the same
  controls in both apps: wheel/trackpad-pinch/touch-pinch zoom around the
  pointer, Space+drag or middle-drag pan, a Fit / 100% / ± toolbar, `+`/`-`,
  Ctrl/⌘+0 (fit) and Ctrl/⌘+1 (100%), alpha-accurate click selection,
  hover outlines, and drag-and-drop of PNG/JPEG/WebP files with a live
  "will land here / can't land here" highlight.
- Zero-touch publishing: upload a PSD with a name and category and publish
  it from the template library as soon as it's processed. Every layer not
  locked (in Photoshop, or in the workspace's Layers panel; locking a group
  locks its contents) is a field: text layers become text, pixel/shape/smart
  object layers photo replacements, groups and adjustments show/hide
  toggles, labelled with the layer name and given permissive default rules
  (`packages/scene-graph/src/autoFields.ts`). Fields are synced from lock
  state at ingestion, on every lock change and again at publish; published
  versions' fields are frozen.
- Admin field-mapping workspace (optional): a Photoshop-style layers panel
  (thumbnails, search, collapsible groups, view-only eye toggles, and locks
  that are saved and make canvas clicks pass through) kept in sync with
  the canvas; double-click text to inspect its individual runs (font,
  size, colour, tracking); drop an image onto a pixel or smart-object layer
  to replace its raster; rename fields, change their type or tighten their
  constraints (removing a field locks its layer; creating one unlocks it); undo/redo (buttons or Ctrl/⌘+Z, Ctrl/⌘+Shift+Z,
  Ctrl/⌘+Y) across field, eye, lock and raster changes; publish (step-up
  gated).
- End-user editor: the project's field values composited live on the same
  canvas. Only the template's fields are interactive — everything else
  is fixed design that clicks and drops pass straight through: type text
  in place on the canvas (synced with the sidebar, with
  length/required/overflow feedback as you type), drop a photo onto its
  layer or pick a file, then drag/scroll/pinch/arrow-key to reposition and
  zoom it (saved as the field's crop window, with a warning when the
  export would visibly upscale it), and toggle show/hide layers from
  on-canvas chips. Edits autosave per field (typing debounced) and Export
  saves anything pending first. Where the canvas knowingly differs from
  the export, the field says so. Photo uploads are validated server-side
  (type, bytes, pixels, dimensions after EXIF orientation) and bound to
  their project.
- An async export pipeline producing PNG/JPEG/real-PDF (via Skia)/TIFF
  with signed, expiring download URLs.

## Known scope limits (stated up front, not discovered later)

In the spirit of the spec's own "honest scope limits" principle:

- **No email delivery is wired up.** Registration creates an `ACTIVE`
  account immediately rather than sending a verification email — there's
  no SMTP/email provider configured in this environment. The schema and
  flow support adding it later without a redesign.
- **Fonts are the biggest fidelity gap between canvas and export.** PSD
  fonts are never embedded or registered anywhere. The browser tries the
  PSD's PostScript name, then a derived family name with a weight/style
  inferred from it ("OpenSans-SemiBold" → "Open Sans" 600); the export only
  asks for the exact PostScript name (plus the PSD's bold/italic flags)
  and otherwise falls back to a system font — in the Docker image that's
  Liberation or DejaVu. So unless the server has the PSD's exact font
  installed, exported text is set in a stand-in face and can wrap
  differently from the canvas. The editor warns when *the browser* lacks
  a field's font, but can't tell whether the server has it.
- **Other known canvas-vs-export differences** (each flagged on the
  affected field in the editor; see `canvas-renderer/src/divergence.ts`):
  text tracking (letter spacing), a text layer's own opacity and blend
  mode, and "clip to layer below" on top-level layers are shown on the
  canvas but not applied in exports yet.
- **Text rendering is simplified in both compositors.** Replacement text
  takes the style of the layer's first run, greedy-wraps to the layer's
  width and treats justified alignment as left; authored text keeps its
  per-run styles but is drawn left-aligned from the layer's left edge.
  Warped text, paragraph spacing and OpenType features aren't modelled.
- **Shared approximations** (both compositors, matching each other rather
  than Photoshop): adjustment layers are structural (toggle-only), their
  pixel effect isn't applied; a pass-through group's own opacity isn't
  applied; clipped layers are masked to the base's alpha and composited
  normally; warp/Liquify and most non-Canvas2D blend modes are
  approximated at ingestion (see `packages/psd-engine/src/blendMode.ts` and
  the ingestion warnings surfaced in the admin workspace).
- **Desktop-first layout.** The app shell has no phone layout (at ~390px
  wide the editor's canvas has no room), and the admin workspace's three
  panes get tight below ~1280px wide. Touch pinch/pan works on the canvas
  itself, e.g. on tablets.
- **The template gallery has no thumbnails** — cards show the category
  name.
- **The server-rendered preview endpoints**
  (`GET /templates/:id/versions/:vid/preview`, `POST /projects/:id/preview`)
  still exist but the web app no longer uses them.
- **The photo cropper is reposition/zoom only.** Uploads start
  cover-fitted to their layer (never distorted) and can be dragged and
  scaled inside it; there's no rotation, and the admin's aspect-ratio
  constraint isn't enforced on upload since the crop always matches the
  layer.
- **The editor has no undo/redo for field edits** (the admin workspace
  does). Text boxes keep the browser's own undo while typing.
- **No lint tooling is configured** (`lint` scripts are stubs). Type
  checking and the test suites are the current correctness net.
- **The Docker images haven't been built end to end from this
  environment** (its network blocks package installs inside builds). The
  install and compile steps have been run on the host instead; the API's
  `pnpm deploy --prod` step and both runtime stages (including the font
  packages in `apps/api/Dockerfile`) are untested in an actual image.
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
