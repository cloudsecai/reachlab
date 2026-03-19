import { useState, useEffect } from "react";
import { api, type GenRule, type GenRulesResponse } from "../../api/client";
import RuleSection from "./components/RuleSection";

interface RulesState {
  voice_tone: GenRule[];
  structure_formatting: GenRule[];
  anti_ai_tropes: { enabled: boolean; rules: GenRule[] };
}

export default function Rules() {
  const [rules, setRules] = useState<RulesState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.generateGetRules().then((res) => setRules(res.categories)).catch(console.error);
  }, []);

  const save = async (updated: RulesState) => {
    setRules(updated);
    setSaving(true);
    try {
      await api.generateSaveRules(updated);
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const res = await api.generateResetRules();
      setRules(res.categories);
    } catch (err) {
      console.error("Reset failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const makeHandlers = (category: "voice_tone" | "structure_formatting") => ({
    onUpdateRule: (index: number, ruleText: string, exampleText?: string) => {
      if (!rules) return;
      const updated = { ...rules };
      const arr = [...updated[category]];
      arr[index] = { ...arr[index], rule_text: ruleText, example_text: exampleText ?? null };
      updated[category] = arr;
      save(updated);
    },
    onDeleteRule: (index: number) => {
      if (!rules) return;
      const updated = { ...rules };
      updated[category] = updated[category].filter((_, i) => i !== index);
      save(updated);
    },
    onAddRule: (ruleText: string) => {
      if (!rules) return;
      const updated = { ...rules };
      updated[category] = [
        ...updated[category],
        { rule_text: ruleText, sort_order: updated[category].length },
      ];
      save(updated);
    },
  });

  const antiAiHandlers = {
    onUpdateRule: (index: number, ruleText: string, exampleText?: string) => {
      if (!rules) return;
      const updated = { ...rules };
      const arr = [...updated.anti_ai_tropes.rules];
      arr[index] = { ...arr[index], rule_text: ruleText, example_text: exampleText ?? null };
      updated.anti_ai_tropes = { ...updated.anti_ai_tropes, rules: arr };
      save(updated);
    },
    onDeleteRule: (index: number) => {
      if (!rules) return;
      const updated = { ...rules };
      updated.anti_ai_tropes = {
        ...updated.anti_ai_tropes,
        rules: updated.anti_ai_tropes.rules.filter((_, i) => i !== index),
      };
      save(updated);
    },
    onAddRule: (ruleText: string) => {
      if (!rules) return;
      const updated = { ...rules };
      updated.anti_ai_tropes = {
        ...updated.anti_ai_tropes,
        rules: [
          ...updated.anti_ai_tropes.rules,
          { rule_text: ruleText, sort_order: updated.anti_ai_tropes.rules.length },
        ],
      };
      save(updated);
    },
  };

  if (!rules) {
    return <div className="text-gen-text-3 text-[14px] py-10 text-center">Loading rules...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[17px] font-semibold text-gen-text-0">Writing rules</h2>
        <button
          onClick={handleReset}
          disabled={saving}
          className="text-[12px] text-gen-text-3 hover:text-gen-text-1 transition-colors disabled:opacity-50"
        >
          Reset to defaults
        </button>
      </div>
      <p className="text-[13px] text-gen-text-2 mb-6">
        Applied to every post you generate. Edit, delete, or add your own.
      </p>

      {/* Sections */}
      <div className="space-y-3">
        <RuleSection
          title="Voice & tone"
          category="voice_tone"
          rules={rules.voice_tone}
          defaultExpanded={true}
          {...makeHandlers("voice_tone")}
        />
        <RuleSection
          title="Structure & formatting"
          category="structure_formatting"
          rules={rules.structure_formatting}
          defaultExpanded={true}
          {...makeHandlers("structure_formatting")}
        />
        <RuleSection
          title="Anti-AI tropes"
          category="anti_ai_tropes"
          rules={rules.anti_ai_tropes.rules}
          defaultExpanded={false}
          masterToggle={{
            enabled: rules.anti_ai_tropes.enabled,
            onToggle: (v) => {
              const updated = {
                ...rules,
                anti_ai_tropes: { ...rules.anti_ai_tropes, enabled: v },
              };
              save(updated);
            },
          }}
          {...antiAiHandlers}
        />
      </div>
    </div>
  );
}
