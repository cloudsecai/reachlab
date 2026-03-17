import { describe, test, expect } from "vitest";
import { buildClassifierPrompt, parseClassifierResponse } from "../ai/image-classifier";

test("buildClassifierPrompt returns system prompt with taxonomy", () => {
  const prompt = buildClassifierPrompt();
  expect(prompt).toContain("Format");
  expect(prompt).toContain("People");
  expect(prompt).toContain("Setting");
  expect(prompt).toContain("Text Density");
  expect(prompt).toContain("Energy");
  expect(prompt).toContain("photo");
  expect(prompt).toContain("author-solo");
});

test("parseClassifierResponse extracts valid classifications", () => {
  const response = JSON.stringify({
    format: "photo",
    people: "author-solo",
    setting: "casual-or-personal",
    text_density: "no-text",
    energy: "raw",
  });

  const result = parseClassifierResponse(response);
  expect(result).toEqual({
    format: "photo",
    people: "author-solo",
    setting: "casual-or-personal",
    text_density: "no-text",
    energy: "raw",
  });
});

test("parseClassifierResponse returns null for invalid JSON", () => {
  expect(parseClassifierResponse("not json")).toBeNull();
});

test("parseClassifierResponse returns null for missing fields", () => {
  const response = JSON.stringify({ format: "photo" });
  expect(parseClassifierResponse(response)).toBeNull();
});
