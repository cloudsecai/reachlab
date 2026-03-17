const ranges = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 0 },
] as const;

interface Props {
  selected: number;
  onChange: (days: number) => void;
}

export default function DateRangeSelector({ selected, onChange }: Props) {
  return (
    <div className="flex gap-1 bg-surface-1 border border-border rounded-md p-0.5">
      {ranges.map((r) => (
        <button
          key={r.label}
          onClick={() => onChange(r.days)}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            selected === r.days
              ? "bg-surface-3 text-text-primary"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function daysToDateRange(days: number) {
  if (days === 0) return {};
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
  };
}
