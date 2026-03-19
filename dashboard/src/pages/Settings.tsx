import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/client";
import type { AiRun } from "../api/client";

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-sm font-semibold tracking-wide uppercase text-text-muted mb-0.5">
        {title}
      </h3>
      {description && (
        <p className="text-xs text-text-muted/70">{description}</p>
      )}
    </div>
  );
}

function SavedIndicator({ show }: { show: boolean }) {
  return (
    <span
      className={`text-xs text-positive transition-opacity duration-300 ${
        show ? "opacity-100" : "opacity-0"
      }`}
    >
      Saved
    </span>
  );
}

export default function Settings() {
  // ── Photo state ──────────────────────────────────────────
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // ── Writing prompt state ─────────────────────────────────
  const [promptText, setPromptText] = useState<string>("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [promptHistory, setPromptHistory] = useState<import("../api/client").WritingPromptHistory[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);

  // ── AI Analysis state ────────────────────────────────────
  const [schedule, setSchedule] = useState<string>("weekly");
  const [postThreshold, setPostThreshold] = useState<number>(5);
  const [aiRuns, setAiRuns] = useState<AiRun[]>([]);
  const [totalCostCents, setTotalCostCents] = useState<number>(0);
  const [refreshSaved, setRefreshSaved] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const thresholdTimer = useRef<ReturnType<typeof setTimeout>>();

  // ── Load data ────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/settings/author-photo", { method: "HEAD" })
      .then((r) => {
        if (r.ok) setPhotoUrl(`/api/settings/author-photo?t=${Date.now()}`);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.getWritingPrompt().then((r) => setPromptText(r.text ?? "")).catch(() => {});
    api.getWritingPromptHistory().then((r) => setPromptHistory(r.history)).catch(() => {});
  }, []);

  useEffect(() => {
    api.getAutoRefreshSettings()
      .then((r) => {
        setSchedule(r.schedule);
        setPostThreshold(r.post_threshold);
      })
      .catch(() => {});
    api.getAiRuns()
      .then((r) => {
        setAiRuns(r.runs);
        setTotalCostCents(r.total_cost_cents);
      })
      .catch(() => {});
  }, []);

  // ── Photo handlers ───────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setPhotoError("Please upload a JPEG or PNG file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError("File too large. Max 5MB.");
      return;
    }
    setPhotoLoading(true);
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
      setPhotoUrl(`/api/settings/author-photo?t=${Date.now()}`);
    } catch {
      setPhotoError("Upload failed — check your connection");
    } finally {
      setPhotoLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await fetch("/api/settings/author-photo", { method: "DELETE" });
      setPhotoUrl(null);
    } catch {
      setPhotoError("Delete failed");
    }
  };

  // ── Prompt handlers ──────────────────────────────────────
  const handleCopyPrompt = async () => {
    setCopyLoading(true);
    try {
      const res = await fetch("/api/posts/top-examples?limit=10");
      const data = await res.json();
      const topPosts = data.posts as Array<{
        full_text: string;
        published_at: string;
        impressions: number;
        engagement_rate: number | null;
      }>;

      let assembled = promptText;
      if (topPosts.length > 0) {
        assembled += "\n\n---\n\nHere are my most popular previous posts for use as a style guide:\n\n";
        assembled += topPosts.map((p, i) => {
          const date = new Date(p.published_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
          const eng = p.engagement_rate != null ? (p.engagement_rate * 100).toFixed(1) + "%" : "N/A";
          return `${i + 1}. [${date}] (Impressions: ${p.impressions.toLocaleString()}, Engagement: ${eng})\n${p.full_text}`;
        }).join("\n\n");
      }

      await navigator.clipboard.writeText(assembled);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setCopyLoading(false);
    }
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

  // ── AI refresh handlers ──────────────────────────────────
  const saveRefreshSettings = useCallback(async (settings: { schedule?: string; post_threshold?: number }) => {
    try {
      await api.saveAutoRefreshSettings(settings);
      setRefreshSaved(true);
      setTimeout(() => setRefreshSaved(false), 2000);
    } catch {
      // silent
    }
  }, []);

  const handleScheduleChange = (value: string) => {
    setSchedule(value);
    saveRefreshSettings({ schedule: value });
  };

  const handleThresholdChange = (value: number) => {
    setPostThreshold(value);
    if (thresholdTimer.current) clearTimeout(thresholdTimer.current);
    thresholdTimer.current = setTimeout(() => {
      saveRefreshSettings({ post_threshold: value });
    }, 600);
  };

  const formatCost = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatTrigger = (triggeredBy: string) => {
    const labels: Record<string, string> = {
      sync_tagging: "Auto (tagging)",
      auto: "Auto (full)",
      manual: "Manual",
      retag: "Retag",
      force: "Force",
      sync: "Sync",
    };
    return labels[triggeredBy] ?? triggeredBy;
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <h2 className="text-xl font-semibold">Settings</h2>

      {/* ── Profile ─────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Profile" description="Your identity for AI features" />
        <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-1">
              Author Reference Photo
            </h4>
            <p className="text-xs text-text-muted">
              Upload a photo so the AI can identify you in post images.
            </p>
          </div>

          {photoUrl ? (
            <div className="flex items-center gap-4">
              <img
                src={photoUrl}
                alt="Author reference"
                className="w-20 h-20 rounded-lg object-cover border border-border"
              />
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => fileInput.current?.click()}
                  disabled={photoLoading}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-2 text-text-primary hover:bg-surface-3 transition-colors disabled:opacity-50"
                >
                  {photoLoading ? "Uploading..." : "Replace"}
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
              disabled={photoLoading}
              className="px-4 py-2 rounded-md text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              {photoLoading ? "Uploading..." : "Upload Photo"}
            </button>
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
      </section>

      {/* ── Writing ─────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Writing" description="Your LinkedIn writing guidelines" />
        <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-1">Writing Prompt</h4>
            <p className="text-xs text-text-muted">
              The AI Coach uses this to suggest improvements based on your performance data.
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
            <button
              onClick={handleCopyPrompt}
              disabled={copyLoading || !promptText.trim()}
              className="px-4 py-2 rounded-md text-sm font-medium bg-surface-2 text-text-primary hover:bg-surface-3 transition-colors disabled:opacity-50"
              title="Copy your writing prompt with top performing posts as a style guide"
            >
              {copyLoading ? "Loading..." : copied ? "Copied!" : "Copy Prompt"}
            </button>
          </div>

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
      </section>

      {/* ── AI Analysis ─────────────────────────────────────── */}
      <section>
        <SectionHeader title="AI Analysis" description="Configure when the AI interprets your data" />

        {/* Schedule & Threshold */}
        <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-5">
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-3 flex-1">
              <div>
                <h4 className="text-sm font-medium text-text-primary mb-1">Auto-refresh schedule</h4>
                <p className="text-xs text-text-muted">
                  How often to run the full AI interpretation. Tagging always runs on every sync.
                </p>
              </div>
              <div className="flex gap-1 bg-surface-2 rounded-md p-0.5 w-fit">
                {(["daily", "weekly", "off"] as const).map((option) => (
                  <button
                    key={option}
                    onClick={() => handleScheduleChange(option)}
                    className={`px-3.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      schedule === option
                        ? "bg-accent text-white shadow-sm"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium text-text-primary mb-1">Post threshold</h4>
                <p className="text-xs text-text-muted">Or run after this many new posts</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={postThreshold}
                  onChange={(e) => handleThresholdChange(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  className="w-16 bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-text-primary text-center focus:outline-none focus:border-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-xs text-text-muted">posts</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-border/50">
            <SavedIndicator show={refreshSaved} />
          </div>
        </div>

        {/* Cost & Run History */}
        <div className="bg-surface-1 border border-border rounded-lg p-5 mt-3 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-text-primary mb-1">Usage</h4>
              <p className="text-xs text-text-muted">
                AI analysis cost tracking across all runs
              </p>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-text-primary tabular-nums">
                {formatCost(totalCostCents)}
              </div>
              <div className="text-xs text-text-muted">total spent</div>
            </div>
          </div>

          {aiRuns.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setRunsOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                <span className={`transition-transform ${runsOpen ? "rotate-90" : ""}`}>&#9654;</span>
                Run history ({aiRuns.length})
              </button>
              {runsOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted border-b border-border/50">
                        <th className="text-left py-2 pr-3 font-medium">Date</th>
                        <th className="text-left py-2 pr-3 font-medium">Trigger</th>
                        <th className="text-right py-2 pr-3 font-medium">Posts</th>
                        <th className="text-right py-2 pr-3 font-medium">Tokens</th>
                        <th className="text-right py-2 font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiRuns.map((run) => (
                        <tr key={run.id} className="border-b border-border/30 last:border-0">
                          <td className="py-1.5 pr-3 text-text-secondary tabular-nums">
                            {run.completed_at
                              ? new Date(run.completed_at + "Z").toLocaleDateString()
                              : "—"}
                          </td>
                          <td className="py-1.5 pr-3">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${
                              run.triggered_by.includes("tagging")
                                ? "bg-surface-2 text-text-muted"
                                : run.triggered_by === "auto"
                                ? "bg-accent/10 text-accent"
                                : "bg-surface-2 text-text-secondary"
                            }`}>
                              {formatTrigger(run.triggered_by)}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right text-text-secondary tabular-nums">
                            {run.post_count}
                          </td>
                          <td className="py-1.5 pr-3 text-right text-text-muted tabular-nums">
                            {((run.total_input_tokens ?? 0) + (run.total_output_tokens ?? 0)).toLocaleString()}
                          </td>
                          <td className="py-1.5 text-right text-text-secondary tabular-nums">
                            {run.total_cost_cents != null ? formatCost(run.total_cost_cents) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
