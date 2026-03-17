import { useState, useEffect } from "react";
import { api, type OverviewData, type AiOverview } from "../api/client";
import KPICard from "../components/KPICard";
import DateRangeSelector, {
  daysToDateRange,
} from "../components/DateRangeSelector";

function fmt(n: number | null | undefined): string {
  if (n == null) return "--";
  return n.toLocaleString();
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "--";
  return (n * 100).toFixed(1) + "%";
}

function pctChange(
  current: number | null | undefined,
  previous: number | null | undefined,
  rangeDays: number,
): string | null {
  if (rangeDays === 0) return null; // "All" — no meaningful comparison
  if (current == null || previous == null || previous === 0) return null;
  const delta = ((current - previous) / previous) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}% vs prev ${rangeDays}d`;
}

export default function Overview() {
  const [range, setRange] = useState(30);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [prevOverview, setPrevOverview] = useState<OverviewData | null>(null);
  const [aiOverview, setAiOverview] = useState<AiOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const params = daysToDateRange(range);
    api.overview(params).then(setOverview).catch(() => {});

    // Fetch previous period for comparison
    if (range > 0) {
      const until = new Date();
      until.setDate(until.getDate() - range);
      const since = new Date();
      since.setDate(since.getDate() - range * 2);
      api
        .overview({ since: since.toISOString(), until: until.toISOString() })
        .then(setPrevOverview)
        .catch(() => {});
    } else {
      setPrevOverview(null);
    }

    api
      .insightsOverview()
      .then((r) => setAiOverview(r.overview))
      .catch(() => {});
  }, [range]);

  const handleRefresh = () => {
    setRefreshing(true);
    api
      .insightsRefresh()
      .then(() => {
        // Pipeline runs async — poll for results every 5s for up to 3 minutes
        let attempts = 0;
        const poll = () => {
          attempts++;
          api
            .insightsOverview()
            .then((r) => {
              if (r.overview || attempts >= 36) {
                setAiOverview(r.overview);
                setRefreshing(false);
              } else {
                setTimeout(poll, 5000);
              }
            })
            .catch(() => setRefreshing(false));
        };
        setTimeout(poll, 5000);
      })
      .catch(() => setRefreshing(false));
  };

  let quickInsights: string[] = [];
  if (aiOverview?.quick_insights) {
    try {
      quickInsights = JSON.parse(aiOverview.quick_insights);
    } catch {
      /* ignore parse errors */
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Overview</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {refreshing ? "Refreshing..." : "Refresh AI"}
          </button>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {/* AI Summary Card */}
      {aiOverview ? (
        <div className="bg-gradient-to-r from-accent/10 via-accent/5 to-surface-1 border border-accent/20 rounded-lg p-5">
          <h3 className="text-sm font-medium text-accent mb-2">AI Summary</h3>
          <p className="text-sm text-text-primary leading-relaxed">
            {aiOverview.summary_text}
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-border rounded-lg p-5 text-center">
          <p className="text-sm text-text-muted">
            AI insights are not available yet. Click{" "}
            <strong>Refresh AI</strong> to generate your first analysis.
          </p>
        </div>
      )}

      {/* KPI Cards with % change */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          label="Impressions"
          value={fmt(overview?.total_impressions)}
          subtitle={pctChange(
            overview?.total_impressions,
            prevOverview?.total_impressions,
            range,
          )}
        />
        <KPICard
          label="Avg Engagement"
          value={fmtPct(overview?.avg_engagement_rate)}
          subtitle={pctChange(
            overview?.avg_engagement_rate,
            prevOverview?.avg_engagement_rate,
            range,
          )}
        />
        <KPICard
          label="Followers"
          value={fmt(overview?.total_followers)}
          subtitle={pctChange(
            overview?.total_followers,
            prevOverview?.total_followers,
            range,
          )}
        />
        <KPICard
          label="Profile Views"
          value={fmt(overview?.profile_views)}
          subtitle={pctChange(
            overview?.profile_views,
            prevOverview?.profile_views,
            range,
          )}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Top Performer Card */}
        {aiOverview?.top_performer_reason && (
          <div className="bg-positive/5 border border-positive/20 rounded-lg p-5">
            <h3 className="text-sm font-medium text-positive mb-2">
              Top Performer
            </h3>
            <p className="text-sm text-text-primary leading-relaxed">
              {aiOverview.top_performer_reason}
            </p>
            {aiOverview.top_performer_post_id && (
              <a
                href={`https://www.linkedin.com/feed/update/urn:li:activity:${aiOverview.top_performer_post_id}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline mt-2 inline-block"
              >
                View post on LinkedIn
              </a>
            )}
          </div>
        )}

        {/* Quick Insights */}
        {quickInsights.length > 0 && (
          <div className="bg-surface-1 border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-text-secondary mb-3">
              Quick Insights
            </h3>
            <ul className="space-y-2">
              {quickInsights.map((insight, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-text-primary"
                >
                  <span className="text-accent mt-0.5 shrink-0">&#8226;</span>
                  <span>{insight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
