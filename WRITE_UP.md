# Dark Phoenix — Technical Write-Up

---

## What changed from the original repo

### Backend (`ai-podcast-clipper-backend/`)

**`main.py`**

1. **LUNARTECH.AI watermark** — Extended `create_subtitles_with_ffmpeg()` to chain
   a `drawtext` filter alongside the existing ASS subtitle filter in the ffmpeg
   render command.  The watermark is burned into the exported MP4 (not a CSS
   overlay) at 36 px Anton Regular, upper-right corner, 75% white with a black
   shadow.  Single-pass render; no extra file or encode step.

2. **YouTube ingestion** — Added `download_youtube_to_s3(youtube_url, s3_key)`
   helper function that uses `yt-dlp` to download the video server-side and
   upload it to S3 at the caller-specified key.  Extended `ProcessVideoRequest`
   with an optional `youtube_url` field.  In `process_video`, if `youtube_url`
   is present the helper runs before the existing S3 download step — the rest of
   the pipeline is unchanged.

3. **Modal image** — Added `.pip_install(["yt-dlp"])` to the Modal image
   definition.  `yt-dlp` is installed separately from `requirements.txt` so it
   can be updated independently without rebuilding the heavy ML layer.

**`requirements.txt`**

Added `yt-dlp` (more reliable and actively maintained YouTube downloader vs.
`pytubefix`).

---

### Frontend (`ai-podcast-clipper-frontend/`)

**`prisma/schema.prisma`**

Added two optional fields to `UploadedFile`:
- `youtubeUrl String?` — stores the original YouTube URL for traceability
- `youtubeVideoId String?` — stores the 11-character video ID

These are nullable so existing direct-upload records are unaffected.  Schema
applied with `prisma db push` (no migration file needed for additive changes).

**`src/env.js`**

Made all `STRIPE_*` environment variables optional (`.optional()`).  The
billing page still renders and the Stripe client is lazy-initialised, so the
app starts and the review path works without Stripe keys.  When Stripe keys
_are_ provided, billing works normally.

**`src/actions/youtube.ts` (new)**

Server action `ingestYouTubeUrl(url)` that:
1. Validates the URL and extracts the 11-char video ID (supports
   `youtube.com/watch`, `youtu.be`, `youtube.com/shorts`)
2. Pre-computes `s3Key = {uuid}/original.mp4`
3. Creates an `UploadedFile` record with `uploaded: true` and the YouTube
   metadata fields
4. Fires the existing `process-video-events` Inngest event

No browser download or re-upload.  All video I/O happens server-side inside Modal.

**`src/inngest/functions.ts`**

Extended the `check-credits` step to also select `youtubeUrl` from
`UploadedFile`.  When building the Modal request payload, `youtube_url` is
included if the record has one.  No other logic changed.

**`src/components/dashboard-client.tsx`**

Added a **YouTube URL** tab as the default tab, containing a text input and
"Generate Clips" button.  The existing file-upload tab is preserved.  Extracted
the shared queue-status table into a `QueueTable` sub-component to avoid
duplication between the two tabs.

**`src/actions/stripe.ts`**

Replaced module-level `new Stripe(...)` initialisation with a `getStripe()`
function that throws a descriptive error if `STRIPE_SECRET_KEY` is not set.
This prevents the module from crashing at import time when Stripe is not
configured.

**`src/app/api/webhooks/stripe/route.ts`**

Added an early return with `200 OK` when Stripe env vars are absent so the
route doesn't crash on cold start.

**`.env.example`**

Removed the unused Discord OAuth fields (the repo uses credentials login, not
Discord).  Marked Stripe variables as optional with a comment explaining the
reviewer path.

---

## Why this deployment stack

The recommended stack from the PDF (Vercel + Inngest + Modal + Supabase + S3)
was chosen because:

- The existing code is _already built_ for these services.  Switching any of
  them would have required rewriting integration code, not just configuration.
- **Vercel** handles Next.js 15 without configuration and natively integrates
  with Inngest via the Vercel integration.
- **Modal** is the only practical choice for the GPU backend — the code uses
  `modal.App`, `@modal.cls`, `@modal.fastapi_endpoint`, and a Modal Volume for
  model caching.  Porting to another GPU host would have been a full rewrite.
- **Inngest** is already wired into the repo's API routes.  The durable step
  execution (`step.run`, `step.fetch`) handles Modal's long cold-start times
  without hitting serverless timeout limits.
- **Supabase** provides a hosted Postgres that works with Prisma and the
  existing `DATABASE_URL` pattern.
- **AWS S3** is used by both the TypeScript SDK (`@aws-sdk/client-s3`) and the
  Python backend (`boto3`).  Switching to Supabase Storage or R2 would have
  required rewriting both sides.

---

## How YouTube ingestion is wired into the existing S3/Modal flow

```
User submits YouTube URL
        │
        ▼
ingestYouTubeUrl() server action
  - validate URL, extract video ID
  - generate UUID → s3Key = {uuid}/original.mp4
  - create UploadedFile {s3Key, youtubeUrl, youtubeVideoId, uploaded: true}
  - send Inngest event {uploadedFileId, userId}
        │
        ▼
Inngest processVideo function
  - check-credits step: read s3Key + youtubeUrl from DB
  - set-status-processing
  - step.fetch Modal endpoint with {s3_key, youtube_url}
        │
        ▼
Modal process_video endpoint
  - if youtube_url present: download_youtube_to_s3(youtube_url, s3_key)
      • yt-dlp downloads video to /tmp
      • boto3 uploads to S3 at s3_key
  - download input.mp4 from S3 (now exists regardless of path)
  - WhisperX transcription
  - Gemini moment selection
  - for each clip moment:
      • ffmpeg cut + ASD speaker track + vertical reframe
      • ffmpeg subtitle burn + LUNARTECH.AI watermark burn
      • upload clip_{n}.mp4 to S3
        │
        ▼
Inngest create-clips-in-db step
  - list S3 objects with prefix {uuid}/
  - filter out original.mp4
  - create Clip records in DB
        │
        ▼
Frontend My Clips tab
  - generates signed GET URLs for playback/download
```

The key insight: `youtubeUrl` is stored in the `UploadedFile` record and read
by Inngest, which passes it through to Modal.  Modal handles the download
transparently — from Inngest's perspective the contract is the same as a
direct-upload job.

---

## How watermarking is implemented

The watermark is a single `drawtext` filter chained with the ASS subtitle
filter inside `create_subtitles_with_ffmpeg()` in `main.py`.

```bash
ffmpeg -y -i <vertical_video.mp4> \
  -vf "ass=<subtitles.ass>,drawtext=\
    text='LUNARTECH.AI':\
    fontfile=/usr/share/fonts/truetype/custom/Anton-Regular.ttf:\
    fontsize=36:\
    fontcolor=white@0.75:\
    x=w-tw-24:\
    y=24:\
    shadowcolor=black@0.60:\
    shadowx=2:\
    shadowy=2" \
  -c:v h264 -preset fast -crf 23 \
  <output_clip.mp4>
```

Properties:
- **Position**: upper-right safe area — `x = frame_width - text_width - 24px`, `y = 24px`
- **Size**: 36 px on a 1080px-wide 9:16 frame = 3.3% of frame width
- **Font**: Anton Regular (installed in the Modal image via `wget` during build)
- **Opacity**: 75% white text, 60% black shadow — visible on light and dark backgrounds without obscuring captions or faces
- **Render**: burned into the MP4 bitstream in the same ffmpeg pass as subtitles — no CSS overlays, no post-processing

---

## What failed during deployment and how it was fixed

### Stripe crash on import

`stripe.ts` initialised `new Stripe(env.STRIPE_SECRET_KEY)` at module level.
When `STRIPE_SECRET_KEY` was undefined (which it is for the reviewer path), the
module threw on import, crashing the Next.js server.

Fix: Wrapped Stripe instantiation in a `getStripe()` helper that is only called
when billing actions are invoked.  Made all `STRIPE_*` env vars optional in
`env.js`.

### `UploadedFile` missing `youtubeUrl` field

The Prisma client didn't know about `youtubeUrl` until `prisma db push` was
run.  The Inngest function would silently receive `undefined` for the new field
if the schema wasn't applied.

Fix: Documented `npm run db:push` as a required step after the first Vercel
deploy, and added the schema change to the checklist in `DEPLOYMENT.md`.

### yt-dlp not in Modal image

The `requirements.txt` was used to build the Modal image layer, but `yt-dlp`
was added to `requirements.txt` _after_ the initial build cache was created.
Modal cached the old image layer.

Fix: Added a separate `.pip_install(["yt-dlp"])` call in `image` definition
so it lives in its own layer and can be invalidated independently.

---

## What I would improve with another week

1. **YouTube ingestion status feedback** — Currently the dashboard shows "processing"
   but gives no indication of which sub-step is running (downloading, transcribing,
   rendering).  I would add a `statusDetail` field to `UploadedFile` and stream
   progress from Modal to Inngest to the frontend via SSE or polling.

2. **Retry on yt-dlp failure** — If YouTube throttles the download, the whole
   job fails.  I would add exponential backoff inside `download_youtube_to_s3`
   and a separate Inngest retry for the download step only.

3. **Clip naming on S3** — Currently clips are stored as `clip_0.mp4`,
   `clip_1.mp4`, etc.  I would name them
   `dark-phoenix_{videoId}_clip_{n:02d}_lunartech.mp4` on S3 so the Google
   Drive upload step requires no renaming.

4. **Automated Google Drive upload** — Right now the reviewer must manually
   download clips and upload them to Drive.  I would add a post-processing
   Inngest step that uses the Google Drive API (service account) to upload clips
   automatically after Modal finishes.

5. **Stripe test mode** — Configure real Stripe test keys and seed price IDs so
   the billing page works end-to-end for completeness.

6. **Longer Inngest timeout** — The default Inngest function timeout may be too
   short for a long YouTube video.  I would configure `timeoutMs` on the
   function and test with the assigned video's actual length.

7. **Video size guard** — `yt-dlp` will happily download a multi-hour video.
   I would add a size/duration check before uploading to S3 and return a clear
   user-facing error if the video exceeds the limit.
