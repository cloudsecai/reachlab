import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { api, type Post, type MetricSnapshot } from "../api/client";

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip);

function fmt(n: number | null | undefined): string {
  if (n == null) return "--";
  return n.toLocaleString();
}

const contentTypes = ["all", "text", "image", "video", "carousel", "article"];
const sortOptions = [
  { value: "published_at", label: "Date" },
  { value: "impressions", label: "Impressions" },
  { value: "engagement_rate", label: "Engagement" },
  { value: "reactions", label: "Reactions" },
  { value: "comments", label: "Comments" },
];

export default function Posts() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [contentType, setContentType] = useState("all");
  const [sortBy, setSortBy] = useState("published_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricSnapshot[]>([]);
  const [backfillCount, setBackfillCount] = useState<number>(0);

  useEffect(() => {
    fetch("/api/posts/needs-content")
      .then((r) => r.json())
      .then((r) => setBackfillCount(r.post_ids?.length ?? 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params: Record<string, string | number> = {
      sort_by: sortBy,
      sort_order: sortOrder,
      offset,
      limit: 20,
    };
    if (contentType !== "all") params.content_type = contentType;
    api
      .posts(params)
      .then((r) => {
        setPosts(r.posts);
        setTotal(r.total);
      })
      .catch(() => {});
  }, [contentType, sortBy, sortOrder, offset]);

  useEffect(() => {
    if (selected) {
      api
        .metrics(selected)
        .then((r) => setMetrics(r.metrics))
        .catch(() => setMetrics([]));
    }
  }, [selected]);

  const toggleSort = (col: string) => {
    if (sortBy === col) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortOrder("desc");
    }
  };

  const sortIndicator = (col: string) => {
    if (sortBy !== col) return "";
    return sortOrder === "asc" ? " ↑" : " ↓";
  };

  const selectedPost = posts.find((p) => p.id === selected) ?? null;

  const imageCount = (p: Post): number => {
    if (!p.image_local_paths) return 0;
    try { return JSON.parse(p.image_local_paths).length; } catch { return 0; }
  };

  const handleSelect = (id: string) => {
    setSelected((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-4">
      {backfillCount > 0 && (
        <div className="bg-accent/5 border border-accent/20 rounded-md px-4 py-2.5 text-sm text-text-secondary flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
          Content pending for {backfillCount} post{backfillCount !== 1 ? "s" : ""} — open LinkedIn with the extension active to backfill.
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-semibold">Posts</h2>
        <div className="flex gap-2">
          <select
            value={contentType}
            onChange={(e) => { setContentType(e.target.value); setOffset(0); }}
            className="bg-surface-2 border border-border rounded px-2.5 py-1.5 text-sm text-text-primary"
          >
            {contentTypes.map((t) => (
              <option key={t} value={t}>
                {t === "all" ? "All types" : t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-surface-1 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">Post</th>
              <th className="text-left px-4 py-3 font-medium w-20">Type</th>
              {sortOptions.map((s) => (
                <th
                  key={s.value}
                  onClick={() => toggleSort(s.value)}
                  className="text-right px-4 py-3 font-medium cursor-pointer hover:text-text-primary w-28"
                >
                  {s.label}
                  {sortIndicator(s.value)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <>
                <tr
                  key={p.id}
                  onClick={() => handleSelect(p.id)}
                  className={`border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-2 ${
                    selected === p.id ? "bg-surface-2 border-l-2 border-l-accent" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {p.image_local_paths && (() => {
                        try {
                          return JSON.parse(p.image_local_paths).length > 0 ? (
                            <img
                              src={`/api/images/${p.id}/0`}
                              alt=""
                              className="w-10 h-10 rounded object-cover shrink-0"
                              loading="lazy"
                            />
                          ) : null;
                        } catch { return null; }
                      })()}
                      <p className="truncate max-w-xs text-text-primary">
                        {p.hook_text || (p.full_text ? p.full_text.slice(0, 80) : p.content_preview) || "(no preview)"}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-mono bg-surface-3 text-text-secondary">
                      {p.content_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-text-secondary">
                    {new Date(p.published_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {fmt(p.impressions)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {p.engagement_rate != null
                      ? (p.engagement_rate * 100).toFixed(1) + "%"
                      : "--"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {fmt(p.reactions)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {fmt(p.comments)}
                  </td>
                </tr>

                {/* Inline expansion */}
                {selected === p.id && selectedPost && (
                  <tr key={`${p.id}-detail`} className="border-b border-border/50">
                    <td colSpan={7} className="p-0">
                      <div className="bg-surface-2/50 px-6 py-5 space-y-4">
                        {/* Header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-medium text-text-primary">
                              {new Date(selectedPost.published_at).toLocaleDateString("en-US", {
                                weekday: "short",
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-mono bg-surface-3 text-text-secondary">
                              {selectedPost.content_type}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            {selectedPost.url && (
                              <a
                                href={selectedPost.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-accent hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                View on LinkedIn
                              </a>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); setSelected(null); }}
                              className="text-text-muted text-xs hover:text-text-primary"
                            >
                              Close
                            </button>
                          </div>
                        </div>

                        {/* Content: text + images side by side */}
                        <div className="flex gap-5">
                          {/* Full text */}
                          <div className="flex-1 min-w-0">
                            {selectedPost.full_text ? (
                              <div className="text-sm text-text-primary leading-relaxed space-y-2 max-h-64 overflow-y-auto pr-2">
                                {(selectedPost.full_text.includes("\n")
                                  ? selectedPost.full_text.split(/\n+/)
                                  : selectedPost.full_text.split(/(?<=[.!?"])(?=[A-Z])/)
                                ).filter(Boolean).map((para, i) => (
                                  <p key={i}>{para}</p>
                                ))}
                              </div>
                            ) : selectedPost.content_preview ? (
                              <p className="text-sm text-text-secondary italic">{selectedPost.content_preview}</p>
                            ) : (
                              <p className="text-sm text-text-muted italic">No text content available</p>
                            )}
                          </div>

                          {/* Images */}
                          {imageCount(selectedPost) > 0 && (
                            <div className="flex gap-2 shrink-0">
                              {Array.from({ length: Math.min(imageCount(selectedPost), 4) }, (_, i) => (
                                <img
                                  key={i}
                                  src={`/api/images/${selectedPost.id}/${i}`}
                                  alt=""
                                  className="w-24 h-24 rounded-lg object-cover border border-border"
                                  loading="lazy"
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Metrics grid */}
                        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                          {[
                            { label: "Impressions", value: fmt(selectedPost.impressions) },
                            { label: "Reactions", value: fmt(selectedPost.reactions) },
                            { label: "Comments", value: fmt(selectedPost.comments) },
                            { label: "Reposts", value: fmt(selectedPost.reposts) },
                            { label: "Engagement", value: selectedPost.engagement_rate != null ? (selectedPost.engagement_rate * 100).toFixed(1) + "%" : "--" },
                            { label: "Saves", value: metrics.length > 0 ? fmt(metrics[metrics.length - 1]?.saves) : "--" },
                          ].map((stat) => (
                            <div key={stat.label} className="bg-surface-1 rounded-md px-3 py-2 text-center">
                              <div className="text-xs text-text-muted">{stat.label}</div>
                              <div className="text-sm font-mono font-medium text-text-primary">{stat.value}</div>
                            </div>
                          ))}
                        </div>

                        {/* Impression velocity chart */}
                        {metrics.length > 1 && (
                          <div>
                            <h4 className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wider">
                              Impressions over time
                            </h4>
                            <div className="h-40">
                              <Line
                                data={{
                                  labels: metrics.map((m) =>
                                    new Date(m.scraped_at).toLocaleDateString()
                                  ),
                                  datasets: [
                                    {
                                      label: "Impressions",
                                      data: metrics.map((m) => m.impressions ?? 0),
                                      borderColor: "#0a66c2",
                                      backgroundColor: "rgba(10, 102, 194, 0.1)",
                                      fill: true,
                                      tension: 0.3,
                                      pointRadius: 3,
                                    },
                                  ],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  plugins: { tooltip: {} },
                                  scales: {
                                    x: { ticks: { color: "#8888a8" }, grid: { color: "#2a2a4a" } },
                                    y: { ticks: { color: "#8888a8" }, grid: { color: "#2a2a4a" } },
                                  },
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                  No posts found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 20 && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>
            Showing {offset + 1}-{Math.min(offset + 20, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
              className="px-3 py-1 rounded bg-surface-2 border border-border disabled:opacity-40"
            >
              Prev
            </button>
            <button
              disabled={offset + 20 >= total}
              onClick={() => setOffset(offset + 20)}
              className="px-3 py-1 rounded bg-surface-2 border border-border disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
