import { useState, useEffect } from "react";
import { api, type HealthData } from "./api/client";
import Overview from "./pages/Overview";
import Posts from "./pages/Posts";
import Timing from "./pages/Timing";
import Followers from "./pages/Followers";

const tabs = ["Overview", "Posts", "Timing", "Followers"] as const;
type Tab = (typeof tabs)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  const hasErrors = health?.sources
    ? Object.values(health.sources).some((s) => s.status === "error")
    : false;

  return (
    <div className="min-h-screen">
      {/* Alert banner */}
      {hasErrors && health && (
        <div className="bg-negative/10 border-b border-negative/30 px-6 py-3 text-sm text-negative flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 10.5a.75.75 0 110-1.5.75.75 0 010 1.5zM8.75 4.5v4a.75.75 0 01-1.5 0v-4a.75.75 0 011.5 0z" />
          </svg>
          <span>
            Sync issues detected:{" "}
            {Object.entries(health.sources)
              .filter(([, s]) => s.status === "error")
              .map(([name]) => name)
              .join(", ")}
          </span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-accent">LI</span> Analytics
          </h1>
          <nav className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  tab === t
                    ? "bg-surface-3 text-text-primary"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-2"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
        {health?.last_sync_at && (
          <span className="text-xs text-text-muted font-mono">
            Last sync: {new Date(health.last_sync_at).toLocaleString()}
          </span>
        )}
      </header>

      {/* Content */}
      <main className="px-6 py-6 max-w-[1400px] mx-auto">
        {tab === "Overview" && <Overview />}
        {tab === "Posts" && <Posts />}
        {tab === "Timing" && <Timing />}
        {tab === "Followers" && <Followers />}
      </main>
    </div>
  );
}
