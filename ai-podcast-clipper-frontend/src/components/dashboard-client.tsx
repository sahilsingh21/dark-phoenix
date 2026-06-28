"use client";

import Dropzone, { type DropzoneState } from "shadcn-dropzone";
import type { Clip } from "@prisma/client";
import Link from "next/link";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { Loader2, UploadCloud, Youtube } from "lucide-react";
import { useState } from "react";
import { generateUploadUrl } from "~/actions/s3";
import { ingestYouTubeUrl } from "~/actions/youtube";
import { toast } from "sonner";
import { processVideo } from "~/actions/generation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Badge } from "./ui/badge";
import { useRouter } from "next/navigation";
import { ClipDisplay } from "./clip-display";

export function DashboardClient({
  uploadedFiles,
  clips,
}: {
  uploadedFiles: {
    id: string;
    s3Key: string;
    filename: string;
    status: string;
    clipsCount: number;
    createdAt: Date;
  }[];
  clips: Clip[];
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [ingestingYoutube, setIngestingYoutube] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const handleRefresh = async () => {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  const handleDrop = (acceptedFiles: File[]) => {
    setFiles(acceptedFiles);
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    const file = files[0]!;
    setUploading(true);

    try {
      const { success, signedUrl, uploadedFileId } = await generateUploadUrl({
        filename: file.name,
        contentType: file.type,
      });

      if (!success) throw new Error("Failed to get upload URL");

      const uploadResponse = await fetch(signedUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadResponse.ok)
        throw new Error(`Upload filed with status: ${uploadResponse.status}`);

      await processVideo(uploadedFileId);

      setFiles([]);

      toast.success("Video uploaded successfully", {
        description:
          "Your video has been scheduled for processing. Check the status below.",
        duration: 5000,
      });
    } catch (error) {
      toast.error("Upload failed", {
        description:
          "There was a problem uploading your video. Please try again.",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleYoutubeIngest = async () => {
    if (!youtubeUrl.trim()) return;

    setIngestingYoutube(true);
    try {
      const result = await ingestYouTubeUrl(youtubeUrl.trim());
      if (result.success) {
        setYoutubeUrl("");
        toast.success("YouTube video queued", {
          description:
            "The video is being downloaded and processed. Check the status below.",
          duration: 6000,
        });
      } else {
        toast.error("Failed to queue YouTube video", {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error("Unexpected error", {
        description: "Could not queue the YouTube video. Please try again.",
      });
    } finally {
      setIngestingYoutube(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Podcast Clipper
          </h1>
          <p className="text-muted-foreground">
            Upload your podcast or paste a YouTube URL to get AI-generated clips
          </p>
        </div>
        <Link href="/dashboard/billing">
          <Button>Buy Credits</Button>
        </Link>
      </div>

      <Tabs defaultValue="youtube">
        <TabsList>
          <TabsTrigger value="youtube">YouTube URL</TabsTrigger>
          <TabsTrigger value="upload">Upload File</TabsTrigger>
          <TabsTrigger value="my-clips">My Clips</TabsTrigger>
        </TabsList>

        {/* ── YouTube URL Tab ─────────────────────────────────────── */}
        <TabsContent value="youtube">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Youtube className="h-5 w-5 text-red-500" />
                Process YouTube Video
              </CardTitle>
              <CardDescription>
                Paste a YouTube URL and we will download and clip it
                automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  disabled={ingestingYoutube}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleYoutubeIngest();
                  }}
                />
                <Button
                  onClick={() => void handleYoutubeIngest()}
                  disabled={!youtubeUrl.trim() || ingestingYoutube}
                >
                  {ingestingYoutube ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Queuing…
                    </>
                  ) : (
                    "Generate Clips"
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Supports youtube.com/watch and youtu.be links. The video is
                downloaded server-side — no browser upload required.
              </p>

              {uploadedFiles.length > 0 && (
                <QueueTable
                  uploadedFiles={uploadedFiles}
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── File Upload Tab ──────────────────────────────────────── */}
        <TabsContent value="upload">
          <Card>
            <CardHeader>
              <CardTitle>Upload Podcast</CardTitle>
              <CardDescription>
                Upload your audio or video file to generate clips
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Dropzone
                onDrop={handleDrop}
                accept={{ "video/mp4": [".mp4"] }}
                maxSize={500 * 1024 * 1024}
                disabled={uploading}
                maxFiles={1}
              >
                {(dropzone: DropzoneState) => (
                  <>
                    <div className="flex flex-col items-center justify-center space-y-4 rounded-lg p-10 text-center">
                      <UploadCloud className="text-muted-foreground h-12 w-12" />
                      <p className="font-medium">Drag and drop your file</p>
                      <p className="text-muted-foreground text-sm">
                        or click to browse (MP4 up to 500MB)
                      </p>
                      <Button
                        className="cursor-pointer"
                        variant="default"
                        size="sm"
                        disabled={uploading}
                      >
                        Select File
                      </Button>
                    </div>
                  </>
                )}
              </Dropzone>

              <div className="mt-2 flex items-start justify-between">
                <div>
                  {files.length > 0 && (
                    <div className="space-y-1 text-sm">
                      <p className="font-medium">Selected file:</p>
                      {files.map((file) => (
                        <p key={file.name} className="text-muted-foreground">
                          {file.name}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  disabled={files.length === 0 || uploading}
                  onClick={handleUpload}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    "Upload and Generate Clips"
                  )}
                </Button>
              </div>

              {uploadedFiles.length > 0 && (
                <QueueTable
                  uploadedFiles={uploadedFiles}
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── My Clips Tab ─────────────────────────────────────────── */}
        <TabsContent value="my-clips">
          <Card>
            <CardHeader>
              <CardTitle>My Clips</CardTitle>
              <CardDescription>
                View and manage your generated clips here. Processing may take a
                few minutes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ClipDisplay clips={clips} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Shared queue status table used by both upload tabs. */
function QueueTable({
  uploadedFiles,
  refreshing,
  onRefresh,
}: {
  uploadedFiles: {
    id: string;
    s3Key: string;
    filename: string;
    status: string;
    clipsCount: number;
    createdAt: Date;
  }[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="pt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-md mb-2 font-medium">Queue status</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Refresh
        </Button>
      </div>
      <div className="max-h-[300px] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Clips created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {uploadedFiles.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="max-w-xs truncate font-medium">
                  {item.filename}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {new Date(item.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  {item.status === "queued" && (
                    <Badge variant="outline">Queued</Badge>
                  )}
                  {item.status === "processing" && (
                    <Badge variant="outline">Processing</Badge>
                  )}
                  {item.status === "processed" && (
                    <Badge variant="outline">Processed</Badge>
                  )}
                  {item.status === "no credits" && (
                    <Badge variant="destructive">No credits</Badge>
                  )}
                  {item.status === "failed" && (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {item.clipsCount > 0 ? (
                    <span>
                      {item.clipsCount} clip
                      {item.clipsCount !== 1 ? "s" : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No clips yet</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
