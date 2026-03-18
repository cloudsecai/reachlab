import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────

export interface PostRow {
  id: string;
  hook_text: string | null;
  full_text: string | null;
  content_preview: string | null;
  content_type: string;
  published_at: string;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number | null;
  sends: number | null;
}

export interface PostWithER extends PostRow {
  er: number | null;
  wer: number | null;
  quadrant: "home_run" | "reach_win" | "niche_hit" | "underperformer" | null;
}

// ── Stats helpers ──────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function iqr(values: number[]): number | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 4)]!;
  const q3 = sorted[Math.floor((sorted.length * 3) / 4)]!;
  return q3 - q1;
}

export function cliffsDelta(x: number[], y: number[]): { d: number; label: string } {
  if (x.length === 0 || y.length === 0) return { d: 0, label: "negligible" };
  let dominance = 0;
  for (const xi of x) {
    for (const yj of y) {
      if (xi > yj) dominance++;
      else if (xi < yj) dominance--;
    }
  }
  const d = dominance / (x.length * y.length);
  const absD = Math.abs(d);
  const label =
    absD < 0.147 ? "negligible" : absD < 0.33 ? "small" : absD < 0.474 ? "medium" : "large";
  return { d, label };
}

export function computeER(
  reactions: number,
  comments: number,
  reposts: number,
  impressions: number
): number | null {
  if (impressions <= 0) return null;
  return ((reactions + comments + reposts) / impressions) * 100;
}

export function computeWeightedER(
  reactions: number,
  comments: number,
  reposts: number,
  saves: number | null,
  sends: number | null,
  impressions: number
): number | null {
  if (impressions <= 0) return null;
  const score =
    (comments * 5) +
    (reposts * 3) +
    ((saves ?? 0) * 3) +
    ((sends ?? 0) * 3) +
    (reactions * 1);
  return (score / impressions) * 100;
}

// ── Formatters ─────────────────────────────────────────────

export function pct(n: number): string {
  return n.toFixed(1) + "%";
}

export function getPostPreview(post: {
  hook_text: string | null;
  full_text: string | null;
  content_preview: string | null;
}): string {
  const rawText = post.hook_text ?? post.full_text ?? post.content_preview;
  if (!rawText) return "Untitled post";
  return rawText.length > 80 ? rawText.slice(0, 77) + "..." : rawText;
}

export function formatInTimezone(
  date: Date,
  tz: string,
  opts: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(date);
}

export function getLocalHour(isoString: string, tz: string): number {
  const date = new Date(isoString);
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  }).format(date);
  return parseInt(formatted, 10) % 24;
}

export function getLocalDayName(isoString: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: tz,
  }).format(new Date(isoString));
}

// ── Quadrant assignment ───────────────────────────────────

function assignQuadrants(posts: PostWithER[]): void {
  const medianImpr = median(posts.map((p) => p.impressions));
  const werValues = posts.filter((p) => p.wer !== null).map((p) => p.wer!);
  const medianWER = median(werValues);

  if (medianImpr === null || medianWER === null) return;

  for (const p of posts) {
    if (p.wer === null) { p.quadrant = null; continue; }
    const highReach = p.impressions >= medianImpr;
    const highQuality = p.wer >= medianWER;
    if (highReach && highQuality) p.quadrant = "home_run";
    else if (highReach && !highQuality) p.quadrant = "reach_win";
    else if (!highReach && highQuality) p.quadrant = "niche_hit";
    else p.quadrant = "underperformer";
  }
}

// ── DB loader ──────────────────────────────────────────────

function loadPostsWithMetrics(db: Database.Database): PostWithER[] {
  const rows = db
    .prepare(
      `SELECT
         p.id, p.hook_text, p.full_text, p.content_preview, p.content_type, p.published_at,
         COALESCE(pm.impressions, 0) as impressions,
         COALESCE(pm.reactions, 0) as reactions,
         COALESCE(pm.comments, 0) as comments,
         COALESCE(pm.reposts, 0) as reposts,
         pm.saves,
         pm.sends
       FROM posts p
       JOIN post_metrics pm ON pm.post_id = p.id
       JOIN (
         SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id
       ) latest ON pm.id = latest.max_id
       WHERE pm.impressions > 0
       ORDER BY p.published_at DESC`
    )
    .all() as PostRow[];

  const posts = rows.map((r) => ({
    ...r,
    er: computeER(r.reactions, r.comments, r.reposts, r.impressions),
    wer: computeWeightedER(r.reactions, r.comments, r.reposts, r.saves, r.sends, r.impressions),
    quadrant: null as PostWithER["quadrant"],
  }));

  assignQuadrants(posts);
  return posts;
}

// ── Section builders ───────────────────────────────────────

function benchmarkLabel(er: number): string {
  if (er < 2) return "below average (under 2%)";
  if (er < 3.5) return "solid (2–3.5% is average)";
  if (er < 5) return "good (3.5–5% range)";
  return "exceptional (above 5%)";
}

const QUADRANT_LABELS: Record<string, string> = {
  home_run: "🏆 HOME RUN",
  reach_win: "⚡ REACH WIN",
  niche_hit: "💎 NICHE HIT",
  underperformer: "📉 UNDERPERFORMER",
};

function buildOverviewSection(
  db: Database.Database,
  posts: PostWithER[],
  globalMedianER: number | null,
  globalMedianWER: number | null,
  globalIQR: number | null,
  timezone: string
): string {
  const followerRow = db
    .prepare(
      "SELECT total_followers FROM follower_snapshots ORDER BY date DESC LIMIT 1"
    )
    .get() as { total_followers: number } | undefined;

  const dates = posts.map((p) => p.published_at).sort();
  const earliest = dates[0]
    ? formatInTimezone(new Date(dates[0]), timezone, { month: "short", day: "numeric", year: "numeric" })
    : "N/A";
  const latest = dates[dates.length - 1]
    ? formatInTimezone(new Date(dates[dates.length - 1]), timezone, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "N/A";

  const lines = [
    "## 1. Overview",
    `Total posts with metrics: ${posts.length}`,
    `Date range: ${earliest} to ${latest}`,
  ];

  const allImpressions = posts.map((p) => p.impressions);
  const globalMedianImpr = median(allImpressions);
  const totalImpressions = allImpressions.reduce((sum, v) => sum + v, 0);

  if (globalMedianWER !== null) {
    lines.push(`Median weighted engagement rate: ${pct(globalMedianWER)} (primary quality metric)`);
  }
  if (globalMedianER !== null) {
    const iqrStr = globalIQR !== null ? ` (IQR: ${pct(globalIQR)})` : "";
    lines.push(`Median standard engagement rate: ${pct(globalMedianER)}${iqrStr} — ${benchmarkLabel(globalMedianER)}`);
  }

  if (globalMedianImpr !== null) {
    lines.push(`Median impressions per post: ${globalMedianImpr.toLocaleString()}`);
    lines.push(`Total impressions: ${totalImpressions.toLocaleString()}`);
  }

  if (followerRow) {
    lines.push(`Current followers: ${followerRow.total_followers.toLocaleString()}`);
  }

  // Quadrant distribution
  const quadrants = posts.filter((p) => p.quadrant !== null);
  if (quadrants.length > 0) {
    const counts: Record<string, number> = { home_run: 0, reach_win: 0, niche_hit: 0, underperformer: 0 };
    for (const p of quadrants) counts[p.quadrant!]++;
    lines.push("");
    lines.push("Post performance quadrants (reach × quality):");
    lines.push(`  🏆 Home Runs (high reach + high quality): ${counts.home_run}`);
    lines.push(`  ⚡ Reach Wins (high reach, lower quality): ${counts.reach_win}`);
    lines.push(`  💎 Niche Hits (lower reach, high quality): ${counts.niche_hit}`);
    lines.push(`  📉 Underperformers (low reach + low quality): ${counts.underperformer}`);
  }

  return lines.join("\n");
}

function buildRecentVsBaselineSection(posts: PostWithER[], timezone: string): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  const recent = posts.filter((p) => new Date(p.published_at) >= cutoff);
  const baseline = posts.filter((p) => new Date(p.published_at) < cutoff);

  const recentWERs = recent.filter((p) => p.wer !== null).map((p) => p.wer!);
  const baselineWERs = baseline.filter((p) => p.wer !== null).map((p) => p.wer!);
  const recentERs = recent.filter((p) => p.er !== null).map((p) => p.er!);
  const baselineERs = baseline.filter((p) => p.er !== null).map((p) => p.er!);
  const recentImpressions = recent.map((p) => p.impressions);
  const baselineImpressions = baseline.map((p) => p.impressions);

  const recentMedianWER = median(recentWERs);
  const baselineMedianWER = median(baselineWERs);
  const recentMedianER = median(recentERs);
  const baselineMedianER = median(baselineERs);
  const recentMedianImpr = median(recentImpressions);
  const baselineMedianImpr = median(baselineImpressions);

  const lines = [
    "## 2. Recent vs Baseline (last 14 days vs all-time)",
    `Last 14 days: ${recent.length} posts`,
    `All-time baseline: ${baseline.length} posts`,
  ];

  if (recentMedianWER !== null && baselineMedianWER !== null) {
    const dir = recentMedianWER > baselineMedianWER ? "above" : "below";
    lines.push(
      `Recent median weighted ER: ${pct(recentMedianWER)} — ${dir} all-time median of ${pct(baselineMedianWER)}`
    );
  }

  if (recentMedianER !== null && baselineMedianER !== null) {
    const erDir = recentMedianER > baselineMedianER ? "above" : "below";
    lines.push(
      `Recent median standard ER: ${pct(recentMedianER)} — ${erDir} all-time median of ${pct(baselineMedianER)}`
    );
  }

  if (recentMedianImpr !== null && baselineMedianImpr !== null) {
    const imprDir = recentMedianImpr > baselineMedianImpr ? "above" : "below";
    const ratio = (recentMedianImpr / baselineMedianImpr).toFixed(1);
    lines.push(
      `Recent median impressions: ${recentMedianImpr.toLocaleString()} — ${imprDir} all-time median of ${baselineMedianImpr.toLocaleString()} (${ratio}x)`
    );
  }

  if (recentMedianER !== null && baselineMedianER !== null &&
      recentMedianImpr !== null && baselineMedianImpr !== null) {
    const erDown = recentMedianER < baselineMedianER;
    const imprUp = recentMedianImpr > baselineMedianImpr;
    if (erDown && imprUp) {
      lines.push(
        `⚠ Note: ER is down but impressions are up. This is expected when LinkedIn pushes content to broader, colder audiences — higher reach naturally dilutes ER.`
      );
    }
  }

  // Standout recent posts — show top by weighted ER and top by impressions
  const topRecentByWER = [...recent]
    .filter((p) => p.wer !== null)
    .sort((a, b) => b.wer! - a.wer!)
    .slice(0, 3);
  const topRecentByImpr = [...recent]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 3);

  if (topRecentByWER.length > 0) {
    lines.push("Standout recent posts (by weighted engagement):");
    for (const p of topRecentByWER) {
      lines.push(`  ${formatPostLine(p, timezone)}`);
    }
  }
  if (topRecentByImpr.length > 0) {
    lines.push("Standout recent posts (by impressions/reach):");
    for (const p of topRecentByImpr) {
      lines.push(`  ${formatPostLine(p, timezone)}`);
    }
  }

  return lines.join("\n");
}

function buildFormatSection(posts: PostWithER[]): string {
  const byType = new Map<string, PostWithER[]>();
  for (const p of posts) {
    if (p.wer === null) continue;
    const arr = byType.get(p.content_type) ?? [];
    arr.push(p);
    byType.set(p.content_type, arr);
  }

  const lines = [
    "## 3. Format Comparison",
    "⚠ IMPORTANT: Each format has different platform benchmarks. Do NOT compare formats against each other.",
    "Platform benchmarks: carousels ~6.6%, multi-image ~6.1%, text ~4%, single-image ~4.8%, video ~1.75%",
    "",
  ];

  for (const [type, typePosts] of byType) {
    const wers = typePosts.map((p) => p.wer!);
    const ers = typePosts.map((p) => p.er!);
    const impressions = typePosts.map((p) => p.impressions);
    const medWER = median(wers);
    const medER = median(ers);
    const medImpr = median(impressions);
    if (medWER === null) continue;

    lines.push(`### ${type} (n=${typePosts.length})`);
    lines.push(`  Median weighted ER: ${pct(medWER)}, median standard ER: ${medER !== null ? pct(medER) : "N/A"}, median impressions: ${medImpr?.toLocaleString() ?? "N/A"}`);

    if (typePosts.length < 5) {
      lines.push(`  ⚠ Too few posts for reliable comparison`);
      continue;
    }

    // Per-format top 3
    const sorted = [...typePosts].sort((a, b) => b.wer! - a.wer!);
    lines.push(`  Top performers in this format:`);
    for (const p of sorted.slice(0, 3)) {
      lines.push(`    ${formatPostLineShort(p)}`);
    }
    if (sorted.length > 3) {
      const bottom = sorted.slice(-2);
      lines.push(`  Weakest in this format:`);
      for (const p of bottom) {
        lines.push(`    ${formatPostLineShort(p)}`);
      }
    }
  }

  if (byType.size === 0) lines.push("No format data available.");
  return lines.join("\n");
}

function formatPostLine(p: PostWithER, tz: string): string {
  const preview = getPostPreview(p);
  const date = formatInTimezone(new Date(p.published_at), tz, {
    month: "short",
    day: "numeric",
  });
  const werStr = p.wer !== null ? pct(p.wer) : "N/A";
  const erStr = p.er !== null ? pct(p.er) : "N/A";
  const saves = p.saves ? `, ${p.saves} saves` : "";
  const sends = p.sends ? `, ${p.sends} sends` : "";
  const quad = p.quadrant ? ` ${QUADRANT_LABELS[p.quadrant]}` : "";
  return `- "${preview}" (${date}, ${p.content_type}) — ${p.impressions.toLocaleString()} impressions, ${werStr} weighted ER, ${erStr} standard ER, ${p.reactions} reactions, ${p.comments} comments${saves}${sends}${quad}`;
}

function formatPostLineShort(p: PostWithER): string {
  const preview = getPostPreview(p);
  const werStr = p.wer !== null ? pct(p.wer) : "N/A";
  const quad = p.quadrant ? ` ${QUADRANT_LABELS[p.quadrant]}` : "";
  return `- "${preview}" — ${p.impressions.toLocaleString()} impr, ${werStr} weighted ER, ${p.comments} comments${quad}`;
}

function buildTopBottomSection(posts: PostWithER[], timezone: string): string {
  const withWER = [...posts].filter((p) => p.wer !== null);

  // Top by weighted ER
  const sortedByWER = [...withWER].sort((a, b) => b.wer! - a.wer!);
  const topWER = sortedByWER.slice(0, 10);

  // Top by impressions (reach)
  const sortedByImpr = [...posts].sort((a, b) => b.impressions - a.impressions);
  const topImpr = sortedByImpr.slice(0, 10);

  // Home runs: top posts that appear in BOTH lists
  const topWERSet = new Set(topWER.map((p) => p.id));
  const homeRuns = topImpr.filter((p) => topWERSet.has(p.id));

  const lines = ["## 4. Top 10 Posts (by weighted engagement rate — primary quality metric)"];
  if (topWER.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of topWER) lines.push(formatPostLine(p, timezone));
  }

  lines.push("", "## 5. Top 10 Posts (by impressions/reach)");
  if (topImpr.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of topImpr) lines.push(formatPostLine(p, timezone));
  }

  if (homeRuns.length > 0) {
    lines.push("", "## 5b. Home Runs (top 10 in BOTH weighted ER and impressions — these are the gold standard)");
    for (const p of homeRuns) lines.push(formatPostLine(p, timezone));
  }

  // Bottom by weighted ER
  const bottomWER = sortedByWER.slice(-10).reverse();
  lines.push("", "## 6. Bottom 10 Posts (by weighted engagement rate)");
  if (bottomWER.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of bottomWER) lines.push(formatPostLine(p, timezone));
  }

  // Bottom by impressions
  const sortedByImprAsc = [...posts].sort((a, b) => a.impressions - b.impressions);
  const bottomImpr = sortedByImprAsc.slice(0, 10);
  lines.push("", "## 6b. Bottom 10 Posts (by impressions — lowest reach)");
  if (bottomImpr.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of bottomImpr) lines.push(formatPostLine(p, timezone));
  }

  return lines.join("\n");
}

function buildDaySection(posts: PostWithER[], timezone: string): string {
  const byDay = new Map<string, PostWithER[]>();
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  for (const p of posts) {
    if (p.wer === null) continue;
    const day = getLocalDayName(p.published_at, timezone);
    const arr = byDay.get(day) ?? [];
    arr.push(p);
    byDay.set(day, arr);
  }

  const lines = ["## 7. Day-of-Week Breakdown"];
  for (const day of dayOrder) {
    const dayPosts = byDay.get(day);
    if (!dayPosts || dayPosts.length === 0) {
      lines.push(`- ${day}: no posts`);
      continue;
    }
    const medWER = median(dayPosts.map((p) => p.wer!))!;
    const medER = median(dayPosts.map((p) => p.er!))!;
    const medImpr = median(dayPosts.map((p) => p.impressions));
    lines.push(`- ${day} (n=${dayPosts.length}): ${pct(medWER)} median weighted ER, ${pct(medER)} standard ER, ${medImpr?.toLocaleString() ?? "N/A"} median impressions`);
  }

  return lines.join("\n");
}

function getTimeWindow(hour: number): string {
  if (hour >= 6 && hour < 10) return "morning (6–10am)";
  if (hour >= 10 && hour < 14) return "midday (10am–2pm)";
  if (hour >= 14 && hour < 18) return "afternoon (2–6pm)";
  if (hour >= 18 && hour < 22) return "evening (6–10pm)";
  return "off-hours (10pm–6am)";
}

function buildTimeSection(posts: PostWithER[], timezone: string): string {
  const byWindow = new Map<string, PostWithER[]>();

  for (const p of posts) {
    if (p.wer === null) continue;
    const hour = getLocalHour(p.published_at, timezone);
    const window = getTimeWindow(hour);
    const arr = byWindow.get(window) ?? [];
    arr.push(p);
    byWindow.set(window, arr);
  }

  const lines = ["## 8. Time-of-Day Breakdown"];
  const windowOrder = [
    "morning (6–10am)",
    "midday (10am–2pm)",
    "afternoon (2–6pm)",
    "evening (6–10pm)",
    "off-hours (10pm–6am)",
  ];

  for (const window of windowOrder) {
    const windowPosts = byWindow.get(window);
    if (!windowPosts || windowPosts.length === 0) {
      lines.push(`- ${window}: no posts`);
      continue;
    }
    const medWER = median(windowPosts.map((p) => p.wer!))!;
    const medImpr = median(windowPosts.map((p) => p.impressions));
    lines.push(`- ${window} (n=${windowPosts.length}): ${pct(medWER)} median weighted ER, ${medImpr?.toLocaleString() ?? "N/A"} median impressions`);
  }

  return lines.join("\n");
}

function buildCommentQualitySection(posts: PostWithER[]): string {
  const buckets = [
    { label: "0–4 comments", min: 0, max: 4 },
    { label: "5–14 comments", min: 5, max: 14 },
    { label: "15–29 comments", min: 15, max: 29 },
    { label: "30+ comments", min: 30, max: Infinity },
  ];

  const lines = ["## 9. Comment Volume Breakdown"];

  for (const bucket of buckets) {
    const inBucket = posts.filter(
      (p) => p.comments >= bucket.min && p.comments <= bucket.max && p.wer !== null
    );
    if (inBucket.length === 0) {
      lines.push(`- ${bucket.label}: no posts`);
      continue;
    }
    const medWER = median(inBucket.map((p) => p.wer!));
    const medReposts = median(inBucket.map((p) => p.reposts)) ?? 0;
    const medSaves = median(inBucket.filter((p) => p.saves !== null).map((p) => p.saves!));
    const savesStr = medSaves !== null ? `, ${medSaves.toFixed(1)} median saves` : "";
    const werStr = medWER !== null ? `, ${pct(medWER)} median weighted ER` : "";
    lines.push(
      `- ${bucket.label} (n=${inBucket.length}): ${medReposts.toFixed(1)} median reposts${savesStr}${werStr}`
    );
  }

  return lines.join("\n");
}

function buildSavesSendsSection(posts: PostWithER[]): string {
  const withSaves = posts.filter((p) => p.saves !== null && p.saves > 0);
  const withSends = posts.filter((p) => p.sends !== null && p.sends > 0);
  const allSaves = withSaves.map((p) => p.saves!);
  const allSends = withSends.map((p) => p.sends!);
  const medSaves = median(allSaves);
  const medSends = median(allSends);

  const lines = ["## 10. Saves & Sends Highlights"];

  if (medSaves !== null) {
    lines.push(`Median saves: ${medSaves.toFixed(1)} (across ${withSaves.length} posts with save data)`);
    const outliers = withSaves.filter((p) => p.saves! > medSaves * 2);
    for (const p of outliers.slice(0, 5)) {
      lines.push(`  - "${getPostPreview(p)}" — ${p.saves} saves (${(p.saves! / medSaves).toFixed(1)}x median)`);
    }
  } else {
    lines.push("No saves data available.");
  }

  if (medSends !== null) {
    lines.push(`Median sends: ${medSends.toFixed(1)} (across ${withSends.length} posts with send data)`);
  } else {
    lines.push("No sends data available.");
  }

  return lines.join("\n");
}

function buildFrequencySection(posts: PostWithER[]): string {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recent = posts.filter((p) => new Date(p.published_at) >= ninetyDaysAgo);
  const postsPerWeek = (recent.length / 90) * 7;

  const lines = [
    "## 11. Posting Frequency",
    `Posts in last 90 days: ${recent.length}`,
    `Average: ${postsPerWeek.toFixed(1)} posts/week`,
  ];

  return lines.join("\n");
}

function buildContentGapsSection(db: Database.Database): string {
  const missingText = db
    .prepare("SELECT COUNT(*) as count FROM posts WHERE full_text IS NULL")
    .get() as { count: number };
  const totalPosts = db
    .prepare("SELECT COUNT(*) as count FROM posts")
    .get() as { count: number };
  const missingImages = db
    .prepare(
      `SELECT COUNT(*) as count FROM posts
       WHERE image_local_paths IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ai_image_tags WHERE post_id = posts.id)`
    )
    .get() as { count: number };

  const lines = ["## 12. Content Gaps (data quality notes)"];

  if (missingText.count > 0) {
    lines.push(
      `- ${missingText.count} of ${totalPosts.count} posts have no full text content (open LinkedIn with extension active to backfill)`
    );
  } else {
    lines.push("- All posts have text content ✓");
  }

  if (missingImages.count > 0) {
    lines.push(`- ${missingImages.count} image posts not yet classified`);
  }

  return lines.join("\n");
}

function buildWritingPromptSection(writingPrompt: string | null): string {
  const lines = ["## 13. Author's Writing Prompt"];
  if (writingPrompt) {
    lines.push(writingPrompt);
  } else {
    lines.push("(none set — user can add a writing prompt in Settings)");
  }
  return lines.join("\n");
}

// ── Main export ────────────────────────────────────────────

export function buildStatsReport(
  db: Database.Database,
  timezone: string,
  writingPrompt: string | null
): string {
  const posts = loadPostsWithMetrics(db);
  const validERs = posts.filter((p) => p.er !== null).map((p) => p.er!);
  const validWERs = posts.filter((p) => p.wer !== null).map((p) => p.wer!);
  const globalMedianER = median(validERs);
  const globalMedianWER = median(validWERs);
  const globalIQR = iqr(validERs);

  const sections = [
    buildOverviewSection(db, posts, globalMedianER, globalMedianWER, globalIQR, timezone),
    buildRecentVsBaselineSection(posts, timezone),
    buildFormatSection(posts),
    buildTopBottomSection(posts, timezone),
    buildDaySection(posts, timezone),
    buildTimeSection(posts, timezone),
    buildCommentQualitySection(posts),
    buildSavesSendsSection(posts),
    buildFrequencySection(posts),
    buildContentGapsSection(db),
    buildWritingPromptSection(writingPrompt),
  ];

  return sections.join("\n\n---\n\n");
}
