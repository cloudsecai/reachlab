import { useState } from "react";
import type { GenRule } from "../../../api/client";

interface RuleItemProps {
  rule: GenRule;
  onUpdate: (ruleText: string, exampleText?: string) => void;
  onDelete: () => void;
}

export default function RuleItem({ rule, onUpdate, onDelete }: RuleItemProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(rule.rule_text);
  const [editExample, setEditExample] = useState(rule.example_text || "");
  const [hovered, setHovered] = useState(false);

  const handleSave = () => {
    if (editText.trim()) {
      onUpdate(editText.trim(), editExample.trim() || undefined);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="py-2 space-y-2">
        <input
          type="text"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          autoFocus
          className="w-full bg-gen-bg-2 border border-gen-border-2 rounded-lg px-3 py-2 text-[13px] text-gen-text-1 focus:outline-none focus:border-gen-accent-border"
        />
        <input
          type="text"
          value={editExample}
          onChange={(e) => setEditExample(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder="Example (optional, italic)"
          className="w-full bg-gen-bg-2 border border-gen-border-1 rounded-lg px-3 py-2 text-[12px] text-gen-text-2 italic placeholder:text-gen-text-4 focus:outline-none focus:border-gen-accent-border"
        />
        <div className="flex gap-2">
          <button onClick={handleSave} className="text-[12px] text-gen-accent hover:underline">Save</button>
          <button onClick={() => setEditing(false)} className="text-[12px] text-gen-text-3 hover:underline">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start gap-2 py-1.5 group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-gen-text-4 mt-0.5 select-none text-[13px]">-</span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-gen-text-1 leading-relaxed">{rule.rule_text}</p>
        {rule.example_text && (
          <p className="text-[12px] text-gen-text-3 italic mt-0.5">{rule.example_text}</p>
        )}
      </div>
      {hovered && (
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={() => setEditing(true)} className="text-[11px] text-gen-text-3 hover:text-gen-text-1">Edit</button>
          <button onClick={onDelete} className="text-[11px] text-gen-text-3 hover:text-negative">Delete</button>
        </div>
      )}
    </div>
  );
}
