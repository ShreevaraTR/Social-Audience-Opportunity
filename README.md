# Social Audience Opportunity — data-layer POC

Takes a company website URL, finds its official LinkedIn / Instagram / X / Facebook /
TikTok profiles, and tries to retrieve **publicly visible, sourced** follower counts.
It never fabricates, estimates, or infers a number.

```bash
node bin/research.js https://www.beehiiv.com          # human-readable report
node bin/research.js https://www.beehiiv.com --json   # structured output
npm test                                              # offline tests (synthetic fixtures)
```

Zero dependencies. Requires Node ≥ 20. Behind an HTTP proxy, run with
`NODE_USE_ENV_PROXY=1` (Node ≥ 22.21 / 24).

Optional: set `BRAVE_SEARCH_API_KEY` (your own key for the official Brave Search API).
Search is then used for profile discovery when the company site doesn't link a
platform, and for secondary follower-count snippets. Search-engine HTML pages are never
scraped.

## Pipeline

1. **Discover** (`src/discover.js`): fetch the company homepage and collect profile
   links from `<a href>` and JSON-LD `sameAs`. Share/intent/post/personal links are
   ignored. A link on the company's own site counts as official. Search hits are marked
   `official: false`.
2. **Observe** (`src/http.js`, `src/extractors.js`): fetch each profile page server-side
   and read only an explicit *followers* field:
   - LinkedIn: meta description "N followers on LinkedIn"
   - Instagram: `og:description` "N Followers, …"
   - X: embedded `followers_count` for the matching `screen_name`
   - Facebook: "N followers" only. **Likes are never used.**
   - TikTok: `userInfo.stats.followerCount` for the matching `uniqueId`
3. **Secondary** (optional): a search-index snippet for the exact profile URL, recorded
   as `SECONDARY_SEARCH_SNIPPET` with lower confidence.
4. **Build result** (`src/research.js` `buildResult`): the one place statuses and
   confidence are assigned.

## Integrity guarantees (enforced in code and tests)

| Situation | status | followerCount | confidence |
|---|---|---|---|
| Count read on the official profile page | `VERIFIED_COUNT` | number | `HIGH` |
| Count only in a search snippet | `VERIFIED_COUNT` | number | `MEDIUM` (`sourceType` marks it secondary) |
| Either of the above, but the profile was found only via search | `VERIFIED_COUNT` | number | one level lower |
| Profile known, count not reliably readable | `PROFILE_FOUND_COUNT_UNAVAILABLE` | `null` | `NOT_AVAILABLE` |
| No official profile identified | `PROFILE_NOT_FOUND` | `null` | `NOT_AVAILABLE` |

- robots.txt is checked before every request, including every redirect hop. A
  disallowed page is not fetched.
- Login walls (e.g. `/authwall`, `/accounts/login`), HTTP 401/403/429/999, and CAPTCHA
  pages are reported, never bypassed. Nothing is retried. No cookies or credentials are
  sent.
- Abbreviated counts ("71K") are kept as displayed with
  `followerCountPrecision: "ROUNDED_BY_SOURCE"`. Missing digits are never filled in.
- The combined total is only printed when at least 2 counts are verified. It is labelled
  "Combined Verified Social Following" and is not a count of unique people.

## Known limitations

- Major platforms commonly restrict anonymous automated access to profile pages (login
  walls, bot challenges, restrictive robots.txt). When that happens this tool reports
  `PROFILE_FOUND_COUNT_UNAVAILABLE` by design. Reliable counts at scale need official
  APIs used with the company's own authorisation, or a licensed data provider.
- The extractors match current public page markup, which platforms change without
  notice. The fixtures in `test/fixtures/` are synthetic.
