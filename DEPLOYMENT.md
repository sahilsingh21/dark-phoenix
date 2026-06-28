# Dark Phoenix — Deployment Guide

> This document is the single source of truth for reproducing the full
> deployed environment.  Every decision is explained.

---

## Live URLs

| Layer | URL |
|---|---|
| Frontend | `https://dark-phoenix-<your-name>.vercel.app` |
| Modal backend | `https://<org>--ai-podcast-clipper-aipodcastclipper-process-video.modal.run` |

---

## Stack Overview

| Layer | Service | Reason |
|---|---|---|
| Frontend | Vercel | Lowest-friction Next.js 15 host; native Inngest integration |
| Database | Supabase Postgres | Quick provisioning; works with Prisma out of the box |
| Object storage | AWS S3 | Frontend & backend already use `@aws-sdk` and `boto3` |
| Job queue | Inngest Cloud | Already wired into the repo; handles retries and concurrency |
| GPU backend | Modal | Repo is already a Modal app using `@modal.cls` + `@modal.fastapi_endpoint` |
| AI | Gemini (Google AI Studio) | Backend already uses `genai.Client` |
| Billing | Stripe test mode (optional) | Reviewer credits are seeded in DB; billing page is non-critical for review |

---

## Step-by-step setup

### 1. Clone and configure

```bash
git clone <your-private-fork>
cd dark-phoenix
cp .env.example .env
# Fill in every value in .env (see Environment Variable Matrix below)
```

### 2. Provision a Supabase database

1. Create a project at https://supabase.com
2. Go to **Project Settings → Database → Connection string** and copy the **URI** form.
3. Paste it into `.env` as `DATABASE_URL`.

```bash
cd ai-podcast-clipper-frontend
npm install
npm run db:push   # applies the Prisma schema to Supabase
```

### 3. Provision an AWS S3 bucket

1. Create a private bucket in your chosen region.
2. Block all public access.
3. Set CORS on the bucket (Settings → Permissions → CORS):

```json
[
  {
    "AllowedHeaders": ["Content-Type", "Content-Length", "Authorization"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": ["https://YOUR_DEPLOYED_VERCEL_DOMAIN"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Create an IAM user with `AmazonS3FullAccess` (or a scoped policy), then generate access keys.
5. Fill `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME` in `.env`.

### 4. Deploy the Modal backend

```bash
cd ai-podcast-clipper-backend

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\activate           # Windows

pip install -r requirements.txt
pip install modal python-dotenv    # modal CLI + dotenv for setup script

# Authenticate with Modal
modal setup

# Create the Modal Secret (reads values from ../.env)
python setup_modal_secret.py
# If the above only prints (doesn't actually create the secret), create it
# manually at https://modal.com/secrets with these keys:
#   GEMINI_API_KEY, AUTH_TOKEN, AWS_ACCESS_KEY_ID,
#   AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET_NAME
# Note: AUTH_TOKEN must equal PROCESS_VIDEO_ENDPOINT_AUTH in .env

# Deploy — Modal will print the endpoint URL
modal deploy main.py
```

Copy the endpoint URL into `.env` as `PROCESS_VIDEO_ENDPOINT`.

Verify the endpoint works:

```bash
curl -X POST "$PROCESS_VIDEO_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROCESS_VIDEO_ENDPOINT_AUTH" \
  -d '{"s3_key":"test/does-not-exist.mp4"}'
# Should return 500 (not 401) meaning auth passed but S3 key doesn't exist
```

### 5. Deploy the frontend to Vercel

1. Create a new Vercel project from the fork.
2. Set **Root Directory** to `ai-podcast-clipper-frontend`.
3. Set **Node Version** to 20 or newer.
4. Add all environment variables from `.env` directly in **Vercel → Settings → Environment Variables**.
   - Set `BASE_URL` to your Vercel domain, e.g. `https://dark-phoenix-sahil.vercel.app`
5. Deploy.

> The `next.config.js` calls `@next/env loadEnvConfig('..')` only in development.
> In production Vercel reads variables directly from its env store — this is correct.

### 6. Configure Inngest Cloud

1. Create an account at https://www.inngest.com
2. Create an app and install the **Inngest Vercel integration** (or manually set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel env vars).
3. Verify Inngest can reach `https://YOUR_DOMAIN/api/inngest` (the route is already in the repo).
4. Trigger a test event in the Inngest dashboard and confirm it appears in Run History.

Keep the existing concurrency limit in `src/inngest/functions.ts` (`limit: 1` per user) to avoid unintended parallel GPU runs.

### 7. Seed the reviewer account

The reviewer should not need to buy credits.  After deploying the frontend:

1. Register a new account via the `/signup` page.
2. Run the credit-seeding script against the deployed database:

```bash
cd ai-podcast-clipper-frontend
# Make sure DATABASE_URL is set in your local .env
node add-credits.js  # update the email in the script to match the reviewer account
```

Or update credits directly in Supabase's SQL editor:

```sql
UPDATE "User" SET credits = 500 WHERE email = 'reviewer@example.com';
```

Include the reviewer credentials (email + password) in your submission email — do **not** commit them to the repo.

### 8. Stripe (optional)

Stripe is required only if the billing page needs to work during review.  The reviewer path (pre-seeded credits) does not touch Stripe at all.

- To enable billing: create a Stripe test-mode account, add three prices (small/medium/large credit packs), and fill the `STRIPE_*` variables.
- To skip billing: leave all `STRIPE_*` variables blank.  The app starts, billing page loads the UI, but clicking "Buy" throws a server-side error (handled gracefully).

---

## Environment Variable Matrix

| Variable | Where set | Required | Notes |
|---|---|---|---|
| `AUTH_SECRET` | Vercel env | Yes | Generate with `npx auth secret` |
| `DATABASE_URL` | Vercel env | Yes | Supabase Postgres URI |
| `AWS_ACCESS_KEY_ID` | Vercel env + Modal secret | Yes | |
| `AWS_SECRET_ACCESS_KEY` | Vercel env + Modal secret | Yes | |
| `AWS_REGION` | Vercel env + Modal secret | Yes | e.g. `us-east-1` |
| `S3_BUCKET_NAME` | Vercel env + Modal secret | Yes | |
| `PROCESS_VIDEO_ENDPOINT` | Vercel env | Yes | Printed by `modal deploy main.py` |
| `PROCESS_VIDEO_ENDPOINT_AUTH` | Vercel env | Yes | Must match Modal `AUTH_TOKEN` |
| `GEMINI_API_KEY` | Modal secret only | Yes | Google AI Studio |
| `AUTH_TOKEN` | Modal secret only | Yes | Same value as `PROCESS_VIDEO_ENDPOINT_AUTH` |
| `BASE_URL` | Vercel env | Yes | `https://your-vercel-domain.vercel.app` |
| `STRIPE_SECRET_KEY` | Vercel env | No | Only needed if billing should work |
| `STRIPE_WEBHOOK_SECRET` | Vercel env | No | Only needed if billing should work |
| `STRIPE_SMALL_CREDIT_PACK` | Vercel env | No | Stripe price ID |
| `STRIPE_MEDIUM_CREDIT_PACK` | Vercel env | No | Stripe price ID |
| `STRIPE_LARGE_CREDIT_PACK` | Vercel env | No | Stripe price ID |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Vercel env | No | Only needed if billing should work |

---

## How to reproduce the assigned video job

1. Log in to the deployed app with the reviewer account.
2. On the dashboard, open the **YouTube URL** tab.
3. Paste `https://www.youtube.com/watch?v=YRvf00NooN8` and click **Generate Clips**.
4. The Inngest event fires immediately.  Inngest calls the Modal endpoint.
5. Modal downloads the video from YouTube via `yt-dlp`, uploads to S3, then runs:
   - WhisperX transcription
   - Gemini moment selection
   - LR-ASD speaker tracking per clip
   - ffmpeg vertical reframe + subtitle burn + **LUNARTECH.AI watermark**
6. Clips are uploaded to S3.  Inngest creates `Clip` records in the database.
7. Refresh the **My Clips** tab to see the generated clips.
8. Download each clip and verify the watermark is burned into the file.

---

## LUNARTECH.AI watermark implementation

The watermark is burned into each MP4 during the ffmpeg subtitle-render step in
`ai-podcast-clipper-backend/main.py` inside `create_subtitles_with_ffmpeg()`.

The `drawtext` filter is chained with the ASS subtitle filter in a single ffmpeg pass:

```
-vf "ass=<subtitle_path>,drawtext=text='LUNARTECH.AI':fontfile=/usr/share/fonts/truetype/custom/Anton-Regular.ttf:fontsize=36:fontcolor=white@0.75:x=w-tw-24:y=24:shadowcolor=black@0.60:shadowx=2:shadowy=2"
```

Watermark properties:
- **Text**: `LUNARTECH.AI`
- **Font**: Anton Regular (already installed in the Modal image)
- **Size**: 36 px on a 1080-px-wide frame (~3.3 % of width)
- **Position**: upper-right safe area (`x = width - text_width - 24 px`, `y = 24 px`)
- **Opacity**: 75 % white text with 60 % black shadow
- **Format**: burned into the exported MP4 — visible when downloaded from Google Drive

---

## How to find generated clips in the app

Navigate to **Dashboard → My Clips** tab.  Each clip card shows an inline player
and a Download button.  Playback uses S3 signed GET URLs (1-hour expiry).

---

## How to regenerate and re-upload clips

1. Delete the `UploadedFile` record from the Supabase DB (and its associated `Clip` records).
2. Re-submit the YouTube URL from the dashboard.
3. After processing, download each clip from the app and re-upload to the Google Drive folder.

---

## S3 CORS

CORS is restricted to the deployed Vercel domain.  During local development
you may temporarily use `*` for `AllowedOrigins`, but revert before submission.

---

## Known limitations

- **Cold start**: The Modal L40S GPU has a cold-start time of ~3–5 minutes on first invocation.  Subsequent runs are faster.
- **Inngest timeout**: The Inngest step that calls Modal (`step.fetch`) must complete within Inngest's function timeout.  Long videos may require extending the timeout.
- **yt-dlp rate limits**: YouTube throttles large downloads.  If the assigned video is geo-restricted or throttled, Modal logs will show the yt-dlp error.
- **Stripe**: Billing is disabled by default (Stripe keys are optional).  The billing page renders but clicking "Buy" returns an error.
- **Prisma schema**: Adding `youtubeUrl` and `youtubeVideoId` fields requires running `npm run db:push` against the deployed database after the first deploy.
