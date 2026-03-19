import { useState } from "react";
import type { GenRule } from "../../../api/client";
import RuleItem from "./RuleItem";

interface RuleSectionProps {
  title: string;
  category: string;
  rules: GenRule[];
  defaultExpanded?: boolean;
  masterToggle?: { enabled: boolean; onToggle: (v: boolean) => void };
  onUpdateRule: (index: number, ruleText: string, exampleText?: string) => void;
  onDeleteRule: (index: number) => void;
  onAddRule: (ruleText: string) => void;
}

export default function RuleSection({
  title,
  category,
  rules,
  defaultExpanded = true,
  masterToggle,
  onUpdateRule,
  onDeleteRule,
  onAddRule,
}: RuleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [newRuleText, setNewRuleText] = useState("");

  const categoryLabel = title.toLowerCase().replace(/ & /g, " ").split(" ")[0];

  return (
    <div className="border border-gen-border-1 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-gen-bg-2 hover:bg-gen-bg-3 transition-colors"
      >
        <div className="flex items-center gap-3">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[14px] font-medium text-gen-text-0">{title}</span>
          <span className="text-[12px] text-gen-text-3">{rules.length}</span>
        </div>
        {masterToggle && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              masterToggle.onToggle(!masterToggle.enabled);
            }}
            className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer ${
              masterToggle.enabled ? "bg-gen-accent" : "bg-gen-bg-3"
            }`}
          >
            <span
              className={`absolute top-[3px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                masterToggle.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </div>
        )}
      </button>

      {/* Content */}
      {expanded && (
        <div className="px-5 py-3">
          {rules.map((rule, i) => (
            <RuleItem
              key={`${category}-${i}`}
              rule={rule}
              onUpdate={(text, ex) => onUpdateRule(i, text, ex)}
              onDelete={() => onDeleteRule(i)}
            />
          ))}

          {/* Add rule input */}
          <div className="mt-3 pt-2 border-t border-gen-border-1">
            <input
              type="text"
              value={newRuleText}
              onChange={(e) => setNewRuleText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newRuleText.trim()) {
                  onAddRule(newRuleText.trim());
                  setNewRuleText("");
                }
              }}
              placeholder={`Add a ${categoryLabel} rule...`}
              className="w-full bg-transparent text-[13px] text-gen-text-2 placeholder:text-gen-text-4 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
