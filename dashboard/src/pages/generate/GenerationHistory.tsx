import { useState, useEffect } from "react";
import { api, type GenHistoryItem } from "../../api/client";

const statusFilters = ["all", "published", "draft", "discarded"] as const;
type StatusFilter = (typeof statusFilters)[number];

interface GenerationHistoryProps {
  onOpen: (id: number) => void;
}

export default function GenerationHistory({ onOpen }: GenerationHistoryProps) {
  const [items, setItems] = useState<GenHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const load = async (status: string, off: number) => {
    try {
      const res = await api.generateHistory(status, off, limit);
      if (off === 0) {
        setItems(res.generations);
      } else {
        setItems((prev) => [...prev, ...res.generations]);
      }
      setTotal(res.total);
    } catch (err) {
      console.error("Load history failed:", err);
    }
  };

  useEffect(() => {
    setOffset(0);
    load(filter, 0);
  }, [filter]);

  const handleDiscard = async (id: number) => {
    try {
      await api.generateDiscard(id);
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: "discarded" } : item))
      );
    } catch (err) {
      console.error("Discard failed:", err);
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "published":
        return "bg-positive/10 text-positive border-positive/20";
      case "draft":
        return "bg-gen-bg-3 text-gen-text-2 border-gen-border-2";
      case "copied":
        return "bg-gen-accent-soft text-gen-accent border-gen-accent-border";
      case "discarded":
        return "bg-gen-bg-3 text-gen-text-4 border-gen-border-1";
      default:
        return "bg-gen-bg-3 text-gen-text-3 border-gen-border-2";
    }
  };

  return (
    <div>
      {/* Filter pills */}
      <div className="flex gap-1.5 mb-5">
        {statusFilters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-lg text-[13px] font-medium transition-colors capitalize ${
              filter === f
                ? "bg-gen-accent-soft text-gen-accent border border-gen-accent-border"
                : "text-gen-text-3 hover:text-gen-text-1 border border-transparent"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <div className="text-gen-text-3 text-[14px] py-10 text-center">
          No generations yet. Start by generating a post.
        </div>
      ) : (
        <div className="border border-gen-border-1 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gen-border-1 bg-gen-bg-2">
                <th className="text-left px-4 py-2.5 text-[11px] uppercase tracking-wider text-gen-text-3 font-medium">Post</th>
                <th className="text-left px-4 py-2.5 text-[11px] uppercase tracking-wider text-gen-text-3 font-medium w-[80px]">Type</th>
                <th className="text-left px-4 py-2.5 text-[11px] uppercase tracking-wider text-gen-text-3 font-medium w-[90px]">Status</th>
                <th className="text-left px-4 py-2.5 text-[11px] uppercase tracking-wider text-gen-text-3 font-medium w-[120px]">Date</th>
                <th className="w-[100px]" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gen-border-1 hover:bg-gen-bg-2/50 group">
                  <td className="px-4 py-3">
                    <p className="text-[13px] text-gen-text-1 leading-snug line-clamp-1">{item.hook_excerpt}</p>
                    <p className="text-[11px] text-gen-text-3 mt-0.5">
                      {item.story_headline} - {item.drafts_used} draft{item.drafts_used !== 1 ? "s" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[12px] text-gen-text-2 capitalize">{item.post_type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium border capitalize ${statusBadge(item.status)}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gen-text-3">
                    {new Date(item.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => onOpen(item.id)}
                        className="text-[11px] text-gen-accent hover:underline"
                      >
                        Open
                      </button>
                      {item.status !== "discarded" && (
                        <button
                          onClick={() => handleDiscard(item.id)}
                          className="text-[11px] text-gen-text-3 hover:text-negative"
                        >
                          Discard
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {items.length < total && (
        <div className="text-center mt-4">
          <button
            onClick={() => {
              const newOffset = offset + limit;
              setOffset(newOffset);
              load(filter, newOffset);
            }}
            className="text-[13px] text-gen-text-3 hover:text-gen-text-1 transition-colors"
          >
            Showing {items.length} of {total} generations - Load more
          </button>
        </div>
      )}
    </div>
  );
}
