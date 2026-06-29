"use server";

import { inngest } from "~/inngest/client";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { v4 as uuidv4 } from "uuid";
import { revalidatePath } from "next/cache";

/**
 * Extract the 11-character YouTube video ID from a variety of URL formats:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://youtube.com/shorts/VIDEO_ID
 */
function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");

    if (hostname === "youtu.be") {
      const id = parsed.pathname.slice(1).split("?")[0];
      return id && id.length === 11 ? id : null;
    }

    if (hostname === "youtube.com") {
      // /watch?v=...
      const v = parsed.searchParams.get("v");
      if (v && v.length === 11) return v;

      // /shorts/VIDEO_ID or /embed/VIDEO_ID
      const match = /\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/.exec(parsed.pathname);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Invalid URL
  }
  return null;
}

export type IngestYouTubeResult =
  | { success: true; uploadedFileId: string }
  | { success: false; error: string };

/**
 * Create an UploadedFile record for the given YouTube URL, then fire the
 * existing Inngest process-video-events event.  The Modal backend will
 * download the video from YouTube and upload it to S3 before processing.
 */
export async function ingestYouTubeUrl(
  youtubeUrl: string,
): Promise<IngestYouTubeResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  // Validate URL and extract video ID
  const trimmedUrl = youtubeUrl.trim();
  const videoId = extractYouTubeVideoId(trimmedUrl);
  if (!videoId) {
    return {
      success: false,
      error:
        "Invalid YouTube URL. Expected format: https://www.youtube.com/watch?v=VIDEO_ID",
    };
  }

  // Pre-compute the S3 key — Modal will upload the video here during processing
  const uniqueId = uuidv4();
  const s3Key = `${uniqueId}/original.mp4`;

  // Create the DB record; mark as `uploaded: true` because there is no
  // browser-upload step — the backend handles the download to S3 directly.
  const uploadedFile = await db.uploadedFile.create({
    data: {
      userId: session.user.id,
      s3Key,
      displayName: `YouTube: ${videoId}`,
      uploaded: true,
      youtubeUrl: trimmedUrl,
      youtubeVideoId: videoId,
    },
    select: { id: true },
  });

  // Fire the standard Inngest event — the Inngest function will pass
  // youtubeUrl to Modal so it knows to download from YouTube first.
  await inngest.send({
    name: "process-video-events",
    data: {
      uploadedFileId: uploadedFile.id,
      userId: session.user.id,
    },
  });

  revalidatePath("/dashboard");

  return { success: true, uploadedFileId: uploadedFile.id };
}
