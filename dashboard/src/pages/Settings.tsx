import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";

export default function Settings() {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [promptText, setPromptText] = useState<string>("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [promptHistory, setPromptHistory] = useState<import("../api/client").WritingPromptHistory[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);

  useEffect(() => {
    api.authorPhoto().then(setPhotoUrl).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/author-photo")
      .then((r) => {
        if (r.ok) setPhotoPreviewUrl(`/api/settings/author-photo?t=${Date.now()}`);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.getWritingPrompt().then((r) => setPromptText(r.text ?? "")).catch(() => {});
    api.getWritingPromptHistory().then((r) => setPromptHistory(r.history)).catch(() => {});
  }, []);

  // Revoke previous blob URL whenever photoUrl changes or on unmount
  const prevUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
    }
    prevUrlRef.current = photoUrl;
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png"].includes(file.type)) {
      alert("Please upload a JPEG or PNG file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("File too large. Max 5MB.");
      return;
    }

    setUploading(true);
    try {
      await api.uploadAuthorPhoto(file);
      const url = await api.authorPhoto();
      setPhotoUrl(url);
    } catch {
      alert("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const handlePhotoUpload = async (file: File) => {
    setPhotoError(null);
    try {
      const res = await fetch("/api/settings/author-photo", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setPhotoError((err as any).error ?? "Upload failed");
        return;
      }
      setPhotoPreviewUrl(`/api/settings/author-photo?t=${Date.now()}`);
    } catch {
      setPhotoError("Upload failed — check your connection");
    }
  };

  const handleDelete = async () => {
    await api.deleteAuthorPhoto();
    setPhotoUrl(null);
  };

  const handleSavePrompt = async () => {
    setPromptLoading(true);
    try {
      await api.saveWritingPrompt(promptText, "manual_edit");
      const histRes = await api.getWritingPromptHistory();
      setPromptHistory(histRes.history);
      setPromptSaved(true);
      setTimeout(() => setPromptSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setPromptLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Settings</h2>

      <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">
            Author Reference Photo
          </h3>
          <p className="text-xs text-text-muted">
            Upload a photo of yourself so the AI can identify you in post
            images. Used for image classification — helps determine which posts
            feature you vs. other people.
          </p>
        </div>

        {photoUrl ? (
          <div className="flex items-center gap-4">
            <img
              src={photoUrl}
              alt="Author reference"
              className="w-24 h-24 rounded-lg object-cover border border-border"
            />
            <div className="flex flex-col gap-2">
              <button
                onClick={() => fileInput.current?.click()}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-2 text-text-primary hover:bg-surface-3 transition-colors"
              >
                Replace
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-negative hover:bg-negative/10 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload Photo"}
          </button>
        )}

        {photoPreviewUrl && (
          <img src={photoPreviewUrl} alt="Author photo preview" className="w-16 h-16 rounded-full object-cover" />
        )}
        {photoError && (
          <p className="text-xs text-negative">{photoError}</p>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          onChange={handleUpload}
          className="hidden"
        />
      </div>

      {/* Writing Prompt */}
      <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">LinkedIn Writing Prompt</h3>
          <p className="text-xs text-text-muted">
            The prompt or guidelines you use when writing LinkedIn posts. The AI Coach uses this
            to suggest improvements based on your performance data.
          </p>
        </div>

        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={6}
          placeholder="e.g. Always start with a compelling question. Use short paragraphs. End with a call to action..."
          className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={handleSavePrompt}
            disabled={promptLoading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {promptLoading ? "Saving..." : promptSaved ? "Saved" : "Save Prompt"}
          </button>
        </div>

        {/* Revision History */}
        {promptHistory.length > 0 && (
          <div className="space-y-2">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <span className={`transition-transform ${historyOpen ? "rotate-90" : ""}`}>&#9654;</span>
              Revision history ({promptHistory.length})
            </button>
            {historyOpen && (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {promptHistory.map((h) => (
                  <div key={h.id} className="bg-surface-2 rounded-md px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-muted">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        h.source === "ai_suggestion"
                          ? "bg-accent/10 text-accent"
                          : "bg-surface-3 text-text-muted"
                      }`}>
                        {h.source === "ai_suggestion" ? "AI suggestion" : "Manual edit"}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary line-clamp-3">{h.prompt_text}</p>
                    {h.suggestion_evidence && (
                      <p className="text-xs text-text-muted italic">{h.suggestion_evidence}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
