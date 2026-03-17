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

      {/* Post detail panel */}
      {selected && metrics.length > 0 && (
        <div className="bg-surface-1 border border-border rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-text-secondary">
              Impression velocity — {selected}
            </h3>
            <button
              onClick={() => setSelected(null)}
              className="text-text-muted text-xs hover:text-text-primary"
            >
              Close
            </button>
          </div>
          <div className="h-48">
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
              <tr
                key={p.id}
                onClick={() => setSelected(p.id)}
                className={`border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-2 ${
                  selected === p.id ? "bg-surface-2" : ""
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
