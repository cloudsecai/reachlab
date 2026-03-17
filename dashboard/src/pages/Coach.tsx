import { useState, useEffect } from "react";
import {
  api,
  type Recommendation,
  type Insight,
  type Changelog,
} from "../api/client";

function getPriorityLabel(p: number | string): { label: string; classes: string } {
  if (typeof p === "string") {
    const upper = p.toUpperCase();
    if (upper === "HIGH") return { label: "HIGH", classes: "bg-negative/15 text-negative" };
    if (upper === "MED" || upper === "MEDIUM") return { label: "MED", classes: "bg-warning/15 text-warning" };
    return { label: "LOW", classes: "bg-surface-2 text-text-muted" };
  }
  // Numeric: 1 = high, 2 = med, 3+ = low
  if (p <= 1) return { label: "HIGH", classes: "bg-negative/15 text-negative" };
  if (p <= 2) return { label: "MED", classes: "bg-warning/15 text-warning" };
  return { label: "LOW", classes: "bg-surface-2 text-text-muted" };
}

function getConfidenceLabel(c: number | string): { label: string; dotClass: string } {
  if (typeof c === "string") {
    const upper = c.toUpperCase();
    if (upper === "STRONG") return { label: "Strong", dotClass: "bg-positive" };
    if (upper === "MODERATE") return { label: "Moderate", dotClass: "bg-warning" };
    return { label: "Weak", dotClass: "bg-negative" };
  }
  // Numeric: 0.8+ = strong, 0.6+ = moderate, else weak
  if (c >= 0.8) return { label: "Strong", dotClass: "bg-positive" };
  if (c >= 0.6) return { label: "Moderate", dotClass: "bg-warning" };
  return { label: "Weak", dotClass: "bg-negative" };
}

function formatCategory(s: string): string {
  return s.replace(/_/g, " ");
}

export default function Coach() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [changelog, setChangelog] = useState<Changelog | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<number, string>>({});
  const [reasonMap, setReasonMap] = useState<Record<number, string>>({});
  const [showReasonFor, setShowReasonFor] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    api
      .insights()
      .then((r) => {
        setRecommendations(r.recommendations);
        setInsights(r.insights);
        // Initialize feedback state from existing data (may be JSON or plain string)
        const fb: Record<number, string> = {};
        for (const rec of r.recommendations) {
          if (rec.feedback) {
            try {
              const parsed = JSON.parse(rec.feedback);
              fb[rec.id] = parsed.rating ?? rec.feedback;
            } catch {
              fb[rec.id] = rec.feedback;
            }
          }
        }
        setFeedbackMap(fb);
      })
      .catch(() => {});
    api.insightsChangelog().then(setChangelog).catch(() => {});
  };

  useEffect(load, []);

  const handleRefresh = () => {
    setRefreshing(true);
    api
      .insightsRefresh()
      .then(() => {
        load();
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  const handleFeedback = (id: number, feedback: string) => {
    setFeedbackMap((prev) => ({ ...prev, [id]: feedback }));
    setShowReasonFor(id);
    api.recommendationFeedback(id, feedback).catch(() => {});
  };

  const handleReasonSubmit = (id: number) => {
    const reason = reasonMap[id];
    if (reason?.trim()) {
      api.recommendationFeedback(id, feedbackMap[id], reason).catch(() => {});
    }
    setShowReasonFor(null);
  };

  const changelogSections: { key: keyof Changelog; label: string; color: string }[] = [
    { key: "confirmed", label: "CONFIRMED", color: "text-positive" },
    { key: "new_signal", label: "NEW SIGNAL", color: "text-accent" },
    { key: "reversed", label: "REVERSED", color: "text-warning" },
    { key: "retired", label: "RETIRED", color: "text-text-muted" },
  ];

  const hasChangelog =
    changelog &&
    (changelog.confirmed.length > 0 ||
      changelog.new_signal.length > 0 ||
      changelog.reversed.length > 0 ||
      changelog.retired.length > 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">AI Coach</h2>
          {recommendations.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent">
              {recommendations.length} recommendation
              {recommendations.length !== 1 ? "s" : ""}
            </span>
          )}
          {insights.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 text-text-secondary">
              {insights.length} insight{insights.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          {refreshing ? "Refreshing..." : "Refresh AI"}
        </button>
      </div>

      {/* Evidence strength legend */}
      <div className="flex items-center gap-4 text-xs text-text-muted">
        <span className="font-medium">Confidence:</span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-positive" />
          Strong
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-warning" />
          Moderate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-negative" />
          Weak
        </span>
      </div>

      {/* Recommendations */}
      {recommendations.length === 0 && insights.length === 0 ? (
        <div className="bg-surface-1 border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-text-muted">
            No recommendations yet. Click <strong>Refresh AI</strong> to
            generate insights from your posts.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {recommendations.map((rec) => (
            <div
              key={rec.id}
              className="bg-surface-1 border border-border rounded-lg p-5 space-y-3"
            >
              {/* Top row: priority + category + confidence */}
              <div className="flex items-center gap-2 flex-wrap">
                {(() => {
                  const p = getPriorityLabel(rec.priority);
                  return (
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${p.classes}`}>
                      {p.label}
                    </span>
                  );
                })()}
                <span className="text-xs text-text-muted uppercase tracking-wider">
                  {formatCategory(rec.type)}
                </span>
                {(() => {
                  const c = getConfidenceLabel(rec.confidence);
                  return (
                    <span className="flex items-center gap-1 text-xs text-text-muted ml-auto">
                      <span className={`w-2 h-2 rounded-full ${c.dotClass}`} />
                      {c.label}
                    </span>
                  );
                })()}
              </div>

              {/* Headline + detail */}
              <p className="text-sm font-semibold text-text-primary">
                {rec.headline}
              </p>
              <p className="text-sm text-text-secondary leading-relaxed">
                {rec.detail}
              </p>

              {/* Action sub-card */}
              {rec.action && (
                <div className="bg-accent/5 border border-accent/15 rounded-md px-4 py-3">
                  <span className="text-xs font-medium text-accent uppercase tracking-wider">
                    Try next
                  </span>
                  <p className="text-sm text-text-primary mt-1">{rec.action}</p>
                </div>
              )}

              {/* Feedback buttons */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleFeedback(rec.id, "useful")}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      feedbackMap[rec.id] === "useful"
                        ? "bg-positive/15 text-positive"
                        : "bg-surface-2 text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Useful
                  </button>
                  <button
                    onClick={() => handleFeedback(rec.id, "not_useful")}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      feedbackMap[rec.id] === "not_useful"
                        ? "bg-negative/15 text-negative"
                        : "bg-surface-2 text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Not useful
                  </button>
                </div>

                {/* Reason input — slides open after feedback */}
                {showReasonFor === rec.id && (
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder={
                        feedbackMap[rec.id] === "useful"
                          ? "Why was this helpful?"
                          : "What would make this more useful?"
                      }
                      value={reasonMap[rec.id] || ""}
                      onChange={(e) =>
                        setReasonMap((prev) => ({ ...prev, [rec.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleReasonSubmit(rec.id);
                      }}
                      className="flex-1 bg-surface-2 border border-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                      autoFocus
                    />
                    <button
                      onClick={() => handleReasonSubmit(rec.id)}
                      className="px-2 py-1.5 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20"
                    >
                      Send
                    </button>
                    <button
                      onClick={() => setShowReasonFor(null)}
                      className="px-2 py-1.5 rounded text-xs text-text-muted hover:text-text-primary"
                    >
                      Skip
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* What Changed section */}
      {hasChangelog && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">What Changed</h3>
          {changelogSections.map(
            ({ key, label, color }) =>
              changelog[key].length > 0 && (
                <div key={key} className="space-y-2">
                  <span
                    className={`text-xs font-semibold uppercase tracking-wider ${color}`}
                  >
                    {label}
                  </span>
                  {changelog[key].map((item) => (
                    <div
                      key={item.id}
                      className="bg-surface-1 border border-border rounded-md px-4 py-3"
                    >
                      <p className="text-sm font-medium text-text-primary">
                        {item.claim}
                      </p>
                      <p className="text-xs text-text-muted mt-1">
                        {item.evidence}
                      </p>
                    </div>
                  ))}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}
