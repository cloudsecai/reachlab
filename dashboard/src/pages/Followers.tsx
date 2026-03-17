import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  BarElement,
  Tooltip,
  Filler,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { api, type FollowerSnapshot, type ProfileSnapshot } from "../api/client";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  BarElement,
  Tooltip,
  Filler
);

const chartGrid = { color: "#2a2a4a" };
const chartTick = { color: "#8888a8" };

export default function Followers() {
  const [followers, setFollowers] = useState<FollowerSnapshot[]>([]);
  const [profile, setProfile] = useState<ProfileSnapshot[]>([]);

  useEffect(() => {
    api.followers().then((r) => setFollowers(r.snapshots)).catch(() => {});
    api.profile().then((r) => setProfile(r.snapshots)).catch(() => {});
  }, []);

  const noData = followers.length === 0 && profile.length === 0;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Followers & Profile</h2>

      {noData ? (
        <div className="bg-surface-1 border border-border rounded-lg p-12 text-center text-text-muted">
          No follower or profile data yet. Sync first.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {/* Follower growth */}
          {followers.length > 0 && (
            <div className="bg-surface-1 border border-border rounded-lg p-5">
              <h3 className="text-sm font-medium text-text-secondary mb-4">
                Follower Growth
              </h3>
              <div className="h-56">
                <Line
                  data={{
                    labels: followers.map((f) => f.date),
                    datasets: [
                      {
                        label: "Total Followers",
                        data: followers.map((f) => f.total_followers),
                        borderColor: "#0a66c2",
                        backgroundColor: "rgba(10, 102, 194, 0.08)",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { ticks: chartTick, grid: chartGrid },
                      y: { ticks: chartTick, grid: chartGrid },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* New followers per day */}
          {followers.length > 1 && (
            <div className="bg-surface-1 border border-border rounded-lg p-5">
              <h3 className="text-sm font-medium text-text-secondary mb-4">
                New Followers / Day
              </h3>
              <div className="h-56">
                <Bar
                  data={{
                    labels: followers.slice(1).map((f) => f.date),
                    datasets: [
                      {
                        label: "New Followers",
                        data: followers
                          .slice(1)
                          .map((f) => f.new_followers ?? 0),
                        backgroundColor: followers
                          .slice(1)
                          .map((f) =>
                            (f.new_followers ?? 0) >= 0
                              ? "#34d399"
                              : "#f87171"
                          ),
                        borderRadius: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { ticks: chartTick, grid: chartGrid },
                      y: { ticks: chartTick, grid: chartGrid },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* Profile views */}
          {profile.length > 0 && (
            <div className="bg-surface-1 border border-border rounded-lg p-5">
              <h3 className="text-sm font-medium text-text-secondary mb-4">
                Profile Views (90-day cumulative)
              </h3>
              <div className="h-56">
                <Line
                  data={{
                    labels: profile.map((p) => p.date),
                    datasets: [
                      {
                        label: "Profile Views",
                        data: profile.map((p) => p.profile_views ?? 0),
                        borderColor: "#a78bfa",
                        backgroundColor: "rgba(167, 139, 250, 0.08)",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { ticks: chartTick, grid: chartGrid },
                      y: { ticks: chartTick, grid: chartGrid },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* Search appearances */}
          {profile.length > 0 && (
            <div className="bg-surface-1 border border-border rounded-lg p-5">
              <h3 className="text-sm font-medium text-text-secondary mb-4">
                Appearances
              </h3>
              <div className="h-56">
                <Line
                  data={{
                    labels: profile.map((p) => p.date),
                    datasets: [
                      {
                        label: "All Appearances",
                        data: profile.map((p) => p.all_appearances ?? 0),
                        borderColor: "#fbbf24",
                        tension: 0.3,
                        pointRadius: 2,
                      },
                      {
                        label: "Search",
                        data: profile.map(
                          (p) => p.search_appearances ?? 0
                        ),
                        borderColor: "#34d399",
                        tension: 0.3,
                        pointRadius: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { ticks: chartTick, grid: chartGrid },
                      y: { ticks: chartTick, grid: chartGrid },
                    },
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
