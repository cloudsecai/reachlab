// Pure functions that return system/user prompt strings for AI analysis stages.
// No external dependencies.

export function getTier(postCount: number): string {
  if (postCount < 30) return "foundation";
  if (postCount < 60) return "patterns";
  if (postCount < 120) return "trends";
  if (postCount < 250) return "prediction";
  return "strategic";
}

export function patternDetectionPrompt(
  summary: string,
  tier: string
): string {
  return `You are an expert LinkedIn content analyst performing Stage 1: Pattern Detection.

Current analysis tier: ${tier}

## Sample Size Rules
When reporting findings, label evidence strength by sample size:
- <5 posts: "potential area to explore"
- 5-10 posts: "preliminary signal"
- 10-20 posts: "moderate evidence"
- 20+ posts: standard confidence level applies

## Confounder Awareness
Before attributing performance to any single factor, consider whether other variables (timing, format, topic, audience state) could explain the pattern. Flag any confounds you notice.

## Data Summary
${summary}

## Database Schema
Available tables and columns for query_db:

- **posts**: id (TEXT PK), content_preview (TEXT), content_type (TEXT), published_at (DATETIME), url (TEXT), created_at (DATETIME)
- **post_metrics**: id (INTEGER PK), post_id (TEXT FK→posts.id), scraped_at (DATETIME), impressions (INTEGER), members_reached (INTEGER), reactions (INTEGER), comments (INTEGER), reposts (INTEGER), saves (INTEGER), sends (INTEGER), video_views (INTEGER), watch_time_seconds (INTEGER), avg_watch_time_seconds (INTEGER)
- **follower_snapshots**: date (DATE PK), total_followers (INTEGER)
- **profile_snapshots**: date (DATE PK), profile_views (INTEGER), search_appearances (INTEGER), all_appearances (INTEGER)
- **ai_tags**: post_id (TEXT), tag (TEXT) — content tags
- **ai_post_topics**: post_id (TEXT FK→posts.id), topic_id (TEXT FK→ai_taxonomy.id)
- **ai_taxonomy**: id (TEXT PK), label (TEXT), description (TEXT)

Note: post_metrics may have multiple rows per post (scraped at different times). Use the latest row per post for current metrics.
Weighted engagement formula: (comments*5 + reposts*3 + saves*3 + sends*3 + reactions*1) / impressions

## Instructions
Using the data summary above, identify patterns in content performance. Use the query_db tool to explore the database and find correlations between content attributes and engagement metrics. Focus on actionable patterns the author can use to improve.`;
}

export function hypothesisTestingPrompt(
  stage1Findings: string,
  previousInsights: string
): string {
  return `You are an expert LinkedIn content analyst performing Stage 2: Hypothesis Testing.

## Stage 1 Findings
${stage1Findings}

## Previous Insights
${previousInsights}

## Confounder Checklist
For each finding, systematically check these potential confounders:
1. **Content confounders**: Could the topic, hook, or format explain the result instead?
2. **Timing confounders**: Could day-of-week, time-of-day, or seasonal effects explain it?
3. **Audience confounders**: Could follower count changes or audience composition shifts explain it?
4. **Measurement confounders**: Could metric collection delays, algorithm changes, or impression counting differences explain it?

## Instructions
Test each Stage 1 finding against these confounders using the query_db tool. Strengthen, weaken, or refine each hypothesis based on evidence. Compare with previous insights to identify trend continuations or reversals.`;
}

export function synthesisPrompt(
  verifiedFindings: string,
  feedbackHistory: string
): string {
  return `You are an expert LinkedIn content analyst performing Stage 3: Synthesis.

## Verified Findings
${verifiedFindings}

## User Feedback History
${feedbackHistory}

## Evidence Strength Labels
Rate each insight using these labels:
- **STRONG**: Consistent across 20+ posts, survives confounder checks, replicated across time periods
- **MODERATE**: Supported by 10-20 posts with partial confounder control
- **WEAK**: Based on 5-10 posts or has unresolved confounders
- **INSUFFICIENT**: Fewer than 5 posts or significant confounders unaddressed

## Recommendation Types
Classify recommendations as: quick_win, experiment, long_term, or stop_doing.

## Rules
- Always back claims by citing specific numbers (e.g., "Posts with questions get 2.3x more comments")
- Never make claims without citing supporting data
- Incorporate user feedback to refine recommendations
- Use the submit_analysis tool to deliver your final structured output.`;
}

export function overviewSummaryPrompt(
  topPerformerInfo: string,
  quickInsights: string[]
): string {
  return `You are a LinkedIn analytics assistant generating a brief overview summary.

## Top Performer
${topPerformerInfo}

## Quick Insights
${quickInsights.join("\n")}

## Instructions
Write a concise 2-3 sentence summary of the author's LinkedIn content performance. Highlight the most important trend and the top-performing post. Keep it actionable and encouraging.`;
}

export function taxonomyPrompt(postSummaries: string): string {
  return `You are a content taxonomy expert. Analyze the following LinkedIn post summaries and discover the natural topic categories.

## Post Summaries
${postSummaries}

## Instructions
Return a JSON array of topic objects. Each object should have:
- "name": A short, clear category name (2-4 words)
- "description": A one-sentence description of what posts in this category cover

Aim for 5-15 categories that meaningfully distinguish the content. Categories should be specific enough to be useful but broad enough to contain multiple posts. Return ONLY the JSON array, no other text.`;
}

export function taggingPrompt(
  taxonomy: { name: string; description: string }[]
): string {
  const categoryList = taxonomy
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");

  return `You are a LinkedIn content tagger. Classify each post using the taxonomy below.

## Topic Categories
${categoryList}

## Instructions
For each post, return a JSON array of objects with:
- "post_id": The post ID
- "topics": Array of matching category names from the taxonomy above (1-3 topics per post)
- "hook_type": The type of hook used (e.g., "question", "statistic", "story", "bold_claim", "how_to", "list", "contrarian", "personal", "other")
- "tone": The overall tone (e.g., "professional", "conversational", "inspirational", "educational", "humorous", "provocative")
- "format_style": The format style (e.g., "short_text", "long_form", "listicle", "story", "tips", "case_study", "poll", "carousel", "video")

Return ONLY the JSON array, no other text.`;
}
