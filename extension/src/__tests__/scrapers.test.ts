import { describe, it, expect } from "vitest";
import { scrapeTopPosts, scrapePostDetail, scrapeAudience, scrapeProfileViews, scrapeSearchAppearances } from "../content/scrapers.js";
import { scrapedPostSchema, scrapedPostMetricsSchema, scrapedAudienceSchema, scrapedProfileViewsSchema, scrapedSearchAppearancesSchema } from "../shared/types.js";
import { z } from "zod";

// Helper to create a DOM from HTML string
function createDoc(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
}

describe("scrapeTopPosts", () => {
  it("extracts post IDs, content previews, impressions, and content types", () => {
    const doc = createDoc(`
      <ul>
        <li class="list-style-none">
          <a class="member-analytics-addon__mini-update-item" href="/feed/update/urn:li:activity:7437529606678802433/">
            <span aria-label="Hello world this is my post">link</span>
            <div class="ivm-image-view-model"><img src="https://media.licdn.com/dms/image/123"></div>
          </a>
          <a class="member-analytics-addon__cta-item-with-secondary-anchor" href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7437529606678802433">
            <span class="member-analytics-addon__cta-item-with-secondary-list-item-title">2,002</span>
            <span class="member-analytics-addon__cta-item-with-secondary-list-item-text">Impressions</span>
          </a>
        </li>
        <li class="list-style-none">
          <a class="member-analytics-addon__mini-update-item" href="/feed/update/urn:li:activity:7436834189745983488/">
            <span aria-label="Another post about tech">link</span>
            <img class="feed-mini-update-commentary__image" src="https://media.licdn.com/dms/videocover-low/456">
          </a>
          <a class="member-analytics-addon__cta-item-with-secondary-anchor" href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7436834189745983488">
            <span class="member-analytics-addon__cta-item-with-secondary-list-item-title">500</span>
            <span class="member-analytics-addon__cta-item-with-secondary-list-item-text">Impressions</span>
          </a>
        </li>
      </ul>
    `);

    const posts = scrapeTopPosts(doc);
    expect(posts).toHaveLength(2);

    expect(posts[0].id).toBe("7437529606678802433");
    expect(posts[0].content_preview).toBe("Hello world this is my post");
    expect(posts[0].impressions).toBe(2002);
    expect(posts[0].content_type).toBe("image");
    expect(posts[0].published_at).toBeDefined();

    expect(posts[1].id).toBe("7436834189745983488");
    expect(posts[1].content_preview).toBe("Another post about tech");
    expect(posts[1].impressions).toBe(500);
    expect(posts[1].content_type).toBe("video");
  });

  it("returns empty array when no post items found", () => {
    const doc = createDoc("<div>No posts here</div>");
    expect(scrapeTopPosts(doc)).toEqual([]);
  });
});

describe("scrapePostDetail", () => {
  it("extracts all metrics from a post detail page", () => {
    const doc = createDoc(`
      <div>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Discovery</h2>
          <ul class="list-style-none">
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Impressions</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>2,003</strong></div>
            </li>
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Members reached</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>1,500</strong></div>
            </li>
          </ul>
        </section>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Social engagement</h2>
          <ul class="list-style-none">
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Reactions</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>26</strong></div>
            </li>
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Comments</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>4</strong></div>
            </li>
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Reposts</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>2</strong></div>
            </li>
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Saves</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>5</strong></div>
            </li>
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Sends on LinkedIn</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>1</strong></div>
            </li>
          </ul>
        </section>
      </div>
    `);

    const metrics = scrapePostDetail(doc);
    expect(metrics.impressions).toBe(2003);
    expect(metrics.members_reached).toBe(1500);
    expect(metrics.reactions).toBe(26);
    expect(metrics.comments).toBe(4);
    expect(metrics.reposts).toBe(2);
    expect(metrics.saves).toBe(5);
    expect(metrics.sends).toBe(1);
    expect(metrics.video_views).toBeNull();
  });

  it("extracts video metrics when present", () => {
    const doc = createDoc(`
      <div>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Discovery</h2>
          <ul class="list-style-none">
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Impressions</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>500</strong></div>
            </li>
          </ul>
        </section>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Video performance</h2>
          <ul class="member-analytics-addon-summary">
            <li class="member-analytics-addon-summary__list-item">
              <p class="text-heading-large">608</p>
              <p class="member-analytics-addon-list-item__description">Video Views</p>
            </li>
            <li class="member-analytics-addon-summary__list-item">
              <p class="text-heading-large">3h 14m 9s</p>
              <p class="member-analytics-addon-list-item__description">Watch time</p>
            </li>
            <li class="member-analytics-addon-summary__list-item">
              <p class="text-heading-large">19s</p>
              <p class="member-analytics-addon-list-item__description">Average watch time</p>
            </li>
          </ul>
        </section>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Social engagement</h2>
          <ul class="list-style-none">
            <li class="member-analytics-addon__cta-list-item">
              <span class="text-body-small t-black--light">Reactions</span>
              <div class="member-analytics-addon__cta-list-item-text"><strong>20</strong></div>
            </li>
          </ul>
        </section>
      </div>
    `);

    const metrics = scrapePostDetail(doc);
    expect(metrics.impressions).toBe(500);
    expect(metrics.video_views).toBe(608);
    expect(metrics.watch_time_seconds).toBe(3 * 3600 + 14 * 60 + 9);
    expect(metrics.avg_watch_time_seconds).toBe(19);
    expect(metrics.reactions).toBe(20);
  });
});

describe("scrapeAudience", () => {
  it("extracts total followers", () => {
    const doc = createDoc(`
      <ul class="member-analytics-addon-summary">
        <li class="member-analytics-addon-summary__list-item">
          <p class="text-heading-large">4,848</p>
          <p class="member-analytics-addon-list-item__description">Total followers</p>
        </li>
      </ul>
    `);

    const result = scrapeAudience(doc);
    expect(result.total_followers).toBe(4848);
  });

  it("returns null when no follower count found", () => {
    const doc = createDoc("<div>Empty page</div>");
    const result = scrapeAudience(doc);
    expect(result.total_followers).toBeNull();
  });
});

describe("scrapeProfileViews", () => {
  it("extracts profile view count", () => {
    const doc = createDoc(`
      <ul class="member-analytics-addon-summary">
        <li class="member-analytics-addon-summary__list-item">
          <p class="text-heading-large">1,023</p>
          <p class="member-analytics-addon-list-item__description">Profile viewers</p>
        </li>
      </ul>
    `);

    const result = scrapeProfileViews(doc);
    expect(result.profile_views).toBe(1023);
  });
});

describe("scrapeSearchAppearances", () => {
  it("extracts all appearances and search appearances", () => {
    const doc = createDoc(`
      <ul class="member-analytics-addon-summary">
        <li class="member-analytics-addon-summary__list-item">
          <p class="text-heading-large">8,042</p>
          <p class="member-analytics-addon-list-item__description">All appearances</p>
        </li>
        <li class="member-analytics-addon-summary__list-item">
          <p class="text-heading-large">300</p>
          <p class="member-analytics-addon-list-item__description">Search appearances</p>
        </li>
      </ul>
    `);

    const result = scrapeSearchAppearances(doc);
    expect(result.all_appearances).toBe(8042);
    expect(result.search_appearances).toBe(300);
  });
});

describe("Zod validation of scraped data", () => {
  it("top posts data passes Zod validation", () => {
    const doc = createDoc(`
      <ul>
        <li class="list-style-none">
          <a class="member-analytics-addon__mini-update-item" href="/feed/update/urn:li:activity:7437529606678802433/">
            <span aria-label="Test post">link</span>
          </a>
          <a class="member-analytics-addon__cta-item-with-secondary-anchor" href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7437529606678802433">
            <span class="member-analytics-addon__cta-item-with-secondary-list-item-title">100</span>
          </a>
        </li>
      </ul>
    `);
    const posts = scrapeTopPosts(doc);
    const result = z.array(scrapedPostSchema).safeParse(posts);
    expect(result.success).toBe(true);
  });

  it("post detail data passes Zod validation", () => {
    const doc = createDoc(`
      <div>
        <section class="member-analytics-addon-card__base-card">
          <h2 class="member-analytics-addon-header__title">Discovery</h2>
          <ul><li class="member-analytics-addon__cta-list-item">
            <span class="text-body-small t-black--light">Impressions</span>
            <div class="member-analytics-addon__cta-list-item-text"><strong>100</strong></div>
          </li></ul>
        </section>
      </div>
    `);
    const metrics = scrapePostDetail(doc);
    const result = scrapedPostMetricsSchema.safeParse(metrics);
    expect(result.success).toBe(true);
  });

  it("audience data passes Zod validation", () => {
    const doc = createDoc(`
      <ul class="member-analytics-addon-summary">
        <li class="member-analytics-addon-summary__list-item">
          <p class="text-heading-large">1,000</p>
          <p class="member-analytics-addon-list-item__description">Total followers</p>
        </li>
      </ul>
    `);
    const result = scrapedAudienceSchema.safeParse(scrapeAudience(doc));
    expect(result.success).toBe(true);
  });
});
