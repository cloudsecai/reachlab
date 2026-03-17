import { describe, it, expect } from "vitest";
import { activityIdToDate, parseMetricValue, parseWatchTime, detectContentType, extractActivityId } from "../shared/utils.js";

describe("activityIdToDate", () => {
  it("decodes a known activity ID to the correct date", () => {
    // From dom-selectors.md: 7437529606678802433 → 2026-03-11T16:07:20.850Z
    const date = activityIdToDate("7437529606678802433");
    expect(date.toISOString()).toBe("2026-03-11T16:07:20.850Z");
  });

  it("decodes another known activity ID", () => {
    // 7436834189745983488 → 2026-03-09T18:04:00.533Z
    const date = activityIdToDate("7436834189745983488");
    expect(date.toISOString()).toBe("2026-03-09T18:04:00.533Z");
  });

  it("decodes an older activity ID", () => {
    // 7363913952889589764 → 2025-08-20T12:45:01.274Z
    const date = activityIdToDate("7363913952889589764");
    expect(date.toISOString()).toBe("2025-08-20T12:45:01.274Z");
  });
});

describe("parseMetricValue", () => {
  it("parses a plain number", () => {
    expect(parseMetricValue("100")).toBe(100);
  });

  it("parses a comma-formatted number", () => {
    expect(parseMetricValue("2,003")).toBe(2003);
  });

  it("parses a large comma-formatted number", () => {
    expect(parseMetricValue("8,042")).toBe(8042);
  });

  it("returns null for non-numeric text", () => {
    expect(parseMetricValue("N/A")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseMetricValue("")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseMetricValue("  1,234  ")).toBe(1234);
  });
});

describe("parseWatchTime", () => {
  it("parses hours, minutes, seconds", () => {
    expect(parseWatchTime("3h 14m 9s")).toBe(3 * 3600 + 14 * 60 + 9);
  });

  it("parses minutes and seconds only", () => {
    expect(parseWatchTime("14m 9s")).toBe(14 * 60 + 9);
  });

  it("parses seconds only", () => {
    expect(parseWatchTime("19s")).toBe(19);
  });

  it("parses hours and minutes only", () => {
    expect(parseWatchTime("2h 30m")).toBe(2 * 3600 + 30 * 60);
  });

  it("returns null for unparseable text", () => {
    expect(parseWatchTime("N/A")).toBeNull();
  });
});

describe("extractActivityId", () => {
  it("extracts from URN-style path with colon", () => {
    expect(extractActivityId("/feed/update/urn:li:activity:7437529606678802433/")).toBe("7437529606678802433");
  });

  it("extracts from hyphenated format", () => {
    expect(extractActivityId("/analytics/post-summary/urn:li:activity:7437529606678802433")).toBe("7437529606678802433");
  });

  it("returns null for non-matching input", () => {
    expect(extractActivityId("/some/other/path")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractActivityId("")).toBeNull();
  });
});

describe("detectContentType", () => {
  it("detects video from videocover in img src", () => {
    const div = document.createElement("div");
    div.innerHTML = `<img class="feed-mini-update-commentary__image" src="https://media.licdn.com/dms/videocover-low/123">`;
    expect(detectContentType(div)).toBe("video");
  });

  it("detects image from ivm-image-view-model", () => {
    const div = document.createElement("div");
    div.innerHTML = `<div class="ivm-image-view-model"><img src="https://media.licdn.com/dms/image/123"></div>`;
    expect(detectContentType(div)).toBe("image");
  });

  it("detects text when no media elements", () => {
    const div = document.createElement("div");
    div.innerHTML = `<span>Just some text post</span>`;
    expect(detectContentType(div)).toBe("text");
  });
});
