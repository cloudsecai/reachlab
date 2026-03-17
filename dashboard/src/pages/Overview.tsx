import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { api, type OverviewData, type Post } from "../api/client";
import KPICard from "../components/KPICard";
import DateRangeSelector, {
  daysToDateRange,
} from "../components/DateRangeSelector";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

function fmt(n: number | null | undefined): string {
  if (n == null) return "--";
  return n.toLocaleString();
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "--";
  return (n * 100).toFixed(1) + "%";
}

export default function Overview() {
  const [range, setRange] = useState(30);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);

  useEffect(() => {
    const params = daysToDateRange(range);
    api.overview(params).then(setOverview).catch(() => {});
    api
      .posts({
        ...params,
        sort_by: "published_at",
        sort_order: "desc",
        limit: 10,
      })
      .then((r) => setPosts(r.posts))
      .catch(() => {});
  }, [range]);

  // Group posts by content type for engagement comparison
  const byType: Record<string, { count: number; totalEngagement: number }> = {};
  for (const p of posts) {
    const t = p.content_type;
    if (!byType[t]) byType[t] = { count: 0, totalEngagement: 0 };
    byType[t].count++;
    byType[t].totalEngagement += p.engagement_rate ?? 0;
  }
  const typeLabels = Object.keys(byType);
  const typeData = typeLabels.map(
    (t) => ((byType[t].totalEngagement / byType[t].count) * 100)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Overview</h2>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          label="Impressions"
          value={fmt(overview?.total_impressions)}
        />
        <KPICard
          label="Avg Engagement"
          value={fmtPct(overview?.avg_engagement_rate)}
        />
        <KPICard
          label="Followers"
          value={fmt(overview?.total_followers)}
        />
        <KPICard
          label="Profile Views"
          value={fmt(overview?.profile_views)}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Engagement by content type */}
        {typeLabels.length > 0 && (
          <div className="bg-surface-1 border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-text-secondary mb-4">
              Avg Engagement by Content Type
            </h3>
            <Bar
              data={{
                labels: typeLabels,
                datasets: [
                  {
                    data: typeData,
                    backgroundColor: [
                      "#0a66c2",
                      "#34d399",
                      "#fbbf24",
                      "#a78bfa",
                      "#f87171",
                    ],
                    borderRadius: 4,
                    maxBarThickness: 48,
                  },
                ],
              }}
              options={{
                indexAxis: "y",
                responsive: true,
                plugins: {
                  tooltip: {
                    callbacks: {
                      label: (ctx) => `${ctx.parsed.x.toFixed(2)}%`,
                    },
                  },
                },
                scales: {
                  x: {
                    ticks: { color: "#8888a8", callback: (v) => `${v}%` },
                    grid: { color: "#2a2a4a" },
                  },
                  y: {
                    ticks: { color: "#ededed" },
                    grid: { display: false },
                  },
                },
              }}
            />
          </div>
        )}

        {/* Recent posts */}
        <div className="bg-surface-1 border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-4">
            Recent Posts
          </h3>
          <div className="space-y-3">
            {posts.slice(0, 5).map((p) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-text-primary">
                    {p.content_preview || "(no preview)"}
                  </p>
                  <div className="flex gap-3 mt-0.5 text-text-muted text-xs">
                    <span className="font-mono">{p.content_type}</span>
                    <span>
                      {new Date(p.published_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-mono text-text-primary">
                    {fmt(p.impressions)}
                  </p>
                  <p className="text-xs text-text-muted">impressions</p>
                </div>
              </div>
            ))}
            {posts.length === 0 && (
              <p className="text-text-muted text-sm">No posts yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
