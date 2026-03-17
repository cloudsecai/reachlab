import { useState, useEffect } from "react";
import { api, type TimingSlot } from "../api/client";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

export default function Timing() {
  const [slots, setSlots] = useState<TimingSlot[]>([]);

  useEffect(() => {
    api.timing().then((r) => setSlots(r.slots)).catch(() => {});
  }, []);

  // Build lookup map
  const lookup = new Map<string, TimingSlot>();
  let maxRate = 0;
  for (const s of slots) {
    lookup.set(`${s.day}-${s.hour}`, s);
    if (s.avg_engagement_rate != null && s.avg_engagement_rate > maxRate) {
      maxRate = s.avg_engagement_rate;
    }
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const medianERByDay: { day: string; er: number }[] = [];
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    const daySlots = slots.filter((s) => s.day === day && s.avg_engagement_rate != null);
    if (daySlots.length === 0) continue;
    const rates = daySlots.map((s) => s.avg_engagement_rate!).sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    const med = rates.length % 2 === 0 ? (rates[mid - 1]! + rates[mid]!) / 2 : rates[mid]!;
    medianERByDay.push({ day: DAY_NAMES[day]!, er: med });
  }
  const overallMedian =
    medianERByDay.length > 0
      ? medianERByDay.map((d) => d.er).sort((a, b) => a - b)[
          Math.floor(medianERByDay.length / 2)
        ]!
      : 0;
  const bestDays = medianERByDay
    .filter((d) => d.er > overallMedian)
    .sort((a, b) => b.er - a.er)
    .slice(0, 3)
    .map((d) => d.day);

  function cellColor(slot: TimingSlot | undefined): string {
    if (!slot || slot.avg_engagement_rate == null || maxRate === 0) return "bg-surface-1";
    const intensity = slot.avg_engagement_rate / maxRate;
    if (intensity > 0.75) return "bg-positive";
    if (intensity > 0.5) return "bg-positive/60";
    if (intensity > 0.25) return "bg-positive/30";
    return "bg-positive/10";
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Posting Time Analysis</h2>
        <p className="text-sm text-text-secondary mt-1">
          Color intensity shows average engagement rate for posts published at
          each day/hour
        </p>
        {bestDays.length > 0 && (
          <p className="text-sm text-accent font-medium">
            Your strongest days: {bestDays.join(", ")}
          </p>
        )}
      </div>

      {slots.length === 0 ? (
        <div className="bg-surface-1 border border-border rounded-lg p-12 text-center text-text-muted">
          No timing data yet. Sync some posts first.
        </div>
      ) : (
        <div className="bg-surface-1 border border-border rounded-lg p-5 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="w-12" />
                {HOURS.map((h) => (
                  <th
                    key={h}
                    className="text-xs text-text-muted font-normal px-0.5 pb-2 text-center"
                  >
                    {formatHour(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((day, dayIdx) => (
                <tr key={day}>
                  <td className="text-xs text-text-muted font-medium pr-2 py-0.5">
                    {day}
                  </td>
                  {HOURS.map((hour) => {
                    const slot = lookup.get(`${dayIdx}-${hour}`);
                    return (
                      <td key={hour} className="p-0.5">
                        <div
                          className={`w-full aspect-square rounded-sm ${cellColor(slot)} transition-colors`}
                          title={
                            slot
                              ? `${day} ${formatHour(hour)}: ${
                                  slot.avg_engagement_rate != null
                                    ? (slot.avg_engagement_rate * 100).toFixed(
                                        1
                                      ) + "%"
                                    : "--"
                                } (${slot.post_count} posts)`
                              : `${day} ${formatHour(hour)}: No data`
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Legend */}
          <div className="flex items-center gap-3 mt-4 text-xs text-text-muted">
            <span>Low</span>
            <div className="flex gap-1">
              <div className="w-4 h-4 rounded-sm bg-positive/10" />
              <div className="w-4 h-4 rounded-sm bg-positive/30" />
              <div className="w-4 h-4 rounded-sm bg-positive/60" />
              <div className="w-4 h-4 rounded-sm bg-positive" />
            </div>
            <span>High engagement</span>
          </div>
        </div>
      )}
    </div>
  );
}
