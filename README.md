# Social Audience Opportunity — data-layer POC

Takes a company website URL, finds its official LinkedIn / Instagram / X / Facebook /
TikTok profiles, and tries to retrieve **publicly visible, sourced** follower counts.
It never fabricates, estimates, or infers a number.

```bash
node bin/research.js https://www.beehiiv.com          # human-readable report
node bin/research.js https://www.beehiiv.com --json   # structured output
npm test                                              # offline tests (synthetic fixtures)
```

## Web app

```bash
npm start                      # http://127.0.0.1:3000/  (PORT / HOST env vars to change)
BRAVE_SEARCH_API_KEY=... npm start   # enables the search fallback, server-side only
```

`bin/server.js` serves the UI (`public/`) and a JSON API (`src/server.js`) around the same
engine. The browser never calls Brave and never receives the key.

| Endpoint | Purpose |
|---|---|
| `POST /api/analyze` `{ "website": "https://www.beehiiv.com/" }` | Run research; returns `{ analysisId, report, newsletter }` |
| `GET /api/analyses/:id` | Current view of an analysis |
| `PUT /api/analyses/:id/user-counts/:platform` `{ "count": "71,000" }` | Add or edit a user-provided count (422 with a reason code if invalid or not eligible) |
| `DELETE /api/analyses/:id/user-counts/:platform` | Remove a user-provided count |

The server keeps each automated report plus the user's raw entries in memory (2 h TTL)
and recomputes the view with `applyUserProvidedCounts()` on every change. The client
never submits provenance or totals. `report.site` carries the homepage's own name and
description; `newsletter` (`src/newsletter.js`) is built only from research facts, and
sections that need content analysis come back as `NOT_GENERATED`.

## CLI

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
   as `sourceType: "SEARCH_DERIVED"` with lower confidence.
4. **Build result** (`src/research.js` `buildResult`): the one place statuses and
   confidence are assigned for automated findings.
5. **User fallback** (`src/audience.js`): where the profile was found but no count could
   be obtained (`needsUserInput: true`), a caller may supply one with
   `applyUserProvidedCount(result, input)` / `applyUserProvidedCounts(report, { linkedin: "71,000" })`.
6. **Audience summary** (`report.audience`, `summarizeAudience`): totals by provenance
   plus planning scenarios.

## Provenance (`sourceType`)

Every non-null `followerCount` carries exactly one `sourceType`:

| sourceType | Meaning | status | confidence |
|---|---|---|---|
| `AUTO_VERIFIED` | Read directly from the public official profile page | `VERIFIED_COUNT` | `HIGH` |
| `SEARCH_DERIVED` | Read from a search snippet for the exact profile URL | `VERIFIED_COUNT` | `MEDIUM` |
| `USER_PROVIDED` | Entered by the user; not observed by the system | `USER_PROVIDED_COUNT` | `UNVERIFIED` |
| `null` | No count | `PROFILE_FOUND_COUNT_UNAVAILABLE` / `PROFILE_NOT_FOUND` | `NOT_AVAILABLE` |

`followerCountDisplay` keeps the value as shown or typed ("22K", "71,000");
`followerCount` is the number used for arithmetic; `followerCountPrecision` is `EXACT`,
`ROUNDED_BY_SOURCE` (e.g. "22K" -> 22000, not exactly 22,000) or `AS_PROVIDED_BY_USER`.

User input must be a positive whole number of at most 1,000,000,000, typed as digits with
optional comma thousands separators. Shorthand ("22K"), decimals, negatives, zero and
text are rejected with a reason code. User input can only fill a
`PROFILE_FOUND_COUNT_UNAVAILABLE` row (or correct an earlier user value); it never
replaces an automated count. A batch is all-or-nothing.

`report.audience`:

- `publiclySourced`: `AUTO_VERIFIED` + `SEARCH_DERIVED` (`bySourceType` splits them)
- `userProvided`: `USER_PROVIDED`
- `totalAudienceFootprint`: all of the above, labelled "Total Social Audience". It is
  never called "verified".
- `needsUserInput`, `profileNotFound`: platform names
- `planningScenarios`: 1% / 3% / 5% of the Total Social Audience, rounded half-up to
  whole numbers and labelled "Planning scenarios — not predictions". They are not
  estimates of subscribers.

Each bucket has `total`, `platformCount`, `platforms` and `includesRoundedValues`.

## Integrity guarantees (enforced in code and tests)

| Situation | status | followerCount | confidence |
|---|---|---|---|
| Count read on the official profile page | `VERIFIED_COUNT` | number | `HIGH` |
| Count only in a search snippet | `VERIFIED_COUNT` | number | `MEDIUM` (`sourceType: SEARCH_DERIVED`) |
| Either of the above, but the profile was found only via search | `VERIFIED_COUNT` | number | one level lower |
| Profile known, count not reliably readable | `PROFILE_FOUND_COUNT_UNAVAILABLE` | `null` | `NOT_AVAILABLE` |
| No official profile identified | `PROFILE_NOT_FOUND` | `null` | `NOT_AVAILABLE` |
| Count entered by the user | `USER_PROVIDED_COUNT` | number | `UNVERIFIED` |

- robots.txt is checked before every request, including every redirect hop. A
  disallowed page is not fetched.
- Login walls (e.g. `/authwall`, `/accounts/login`), HTTP 401/403/429/999, and CAPTCHA
  pages are reported, never bypassed. Nothing is retried. No cookies or credentials are
  sent.
- Abbreviated counts ("71K") are kept as displayed with
  `followerCountPrecision: "ROUNDED_BY_SOURCE"`. Missing digits are never filled in.
- The combined total is only printed when at least 2 counts are verified. It is labelled
  "Combined Verified Social Following" and is not a count of unique people. It only
  includes automated counts; user-provided counts appear separately under
  "Total Social Audience".

## Known limitations

- The web app stores analyses in memory: restarting the server discards them.
- Major platforms commonly restrict anonymous automated access to profile pages (login
  walls, bot challenges, restrictive robots.txt). When that happens this tool reports
  `PROFILE_FOUND_COUNT_UNAVAILABLE` by design. Reliable counts at scale need official
  APIs used with the company's own authorisation, or a licensed data provider.
- The extractors match current public page markup, which platforms change without
  notice. The fixtures in `test/fixtures/` are synthetic.
