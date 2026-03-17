interface Props {
  label: string;
  value: string;
  subtitle?: string;
}

export default function KPICard({ label, value, subtitle }: Props) {
  return (
    <div className="bg-surface-1 border border-border rounded-lg p-5 flex flex-col gap-1">
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
        {label}
      </span>
      <span className="text-2xl font-semibold tracking-tight font-mono">
        {value}
      </span>
      {subtitle && (
        <span className="text-xs text-text-secondary">{subtitle}</span>
      )}
    </div>
  );
}
