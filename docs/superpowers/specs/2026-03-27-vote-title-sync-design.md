# Vote System: Stable IDs + FPPC API Endpoint

**Date:** 2026-03-27
**Status:** Approved
**Problem:** Vote titles on the EA dashboard differ from the FPPC dashboard because votes are keyed by array index and titles are stored at vote-time in Google Sheets.

---

## Problem Summary

Three interconnected issues:

1. **Vote keys use array indices** (e.g., `curated-sfEvents-0`). Deleting or archiving events shifts indices, causing votes to point at the wrong event.
2. **Titles in Google Sheets go stale.** The title stored at vote-time never updates if the event is renamed on the FPPC dashboard.
3. **EA dashboard has no live FPPC data.** `DATA.fppcEvents` is an empty array — the FPPC widget never fetches vote data.

## Solution Overview

- Give every event a stable, unique ID
- Use the ID as the vote key instead of array index
- Migrate existing votes from old index-based keys to new ID-based keys
- Add a `/api/fppc-votes` endpoint on the FPPC server that joins current event data with vote counts
- Wire the EA dashboard to fetch from that endpoint

---

## Section 1: Stable Event IDs

Every event gets an `id` field — a short, human-readable slug derived from its title at creation time. The ID never changes, even if the title is edited later.

### Examples

```javascript
{ id: "st-patricks-pub-crawl", title: "St. Patrick's 3-Day Pub Crawl", ... }
{ id: "park-cleanup-gg", title: "Park Cleanup — Golden Gate", ... }
{ id: "escape-room-mission", title: "Escape Room — Mission District", ... }
```

### ID Generation

A `slugify` function: lowercase, replace spaces and special characters with hyphens, collapse consecutive hyphens, truncate to ~50 chars.

```javascript
function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
```

### Where IDs Are Set

| Event type | ID format | When assigned |
|------------|-----------|---------------|
| Curated events (sfEvents, volunteerEvents, teamEvents, sportsGames) | Slugified title, e.g., `st-patricks-pub-crawl` | Added to hardcoded arrays now |
| Suggestions | `sug-` + timestamp, e.g., `sug-1711567200` | At submission time |
| Approved suggestions | Same ID as when it was a suggestion | Unchanged on approval |

### Vote Key Format

- **Old:** `curated-sfEvents-0` (index-based, fragile)
- **New:** `st-patricks-pub-crawl` (the event ID itself — unique across all arrays)

No prefix needed since IDs are globally unique.

---

## Section 2: Vote Key Migration

A one-time migration that runs on page load to convert existing index-based vote keys to stable IDs.

### Migration Logic

1. On page load, after events and votes are both loaded, check if `voteData` contains any old-format keys (keys starting with `curated-` or `suggestion-` or `approved-`)
2. Build a mapping from old key to new ID using the current array order:
   - `curated-sfEvents-0` → `sfEvents[0].id`
   - `curated-volunteerEvents-2` → `volunteerEvents[2].id`
   - `suggestion-3` → `suggestions[3].id`
   - `approved-1` → `suggestions.filter(s => s.approved)[1].id`
3. For each old key with voters:
   - Copy voters to `voteData[newId]` (merge and deduplicate if new key already has voters)
   - Delete the old key
4. Save migrated `voteData` to both:
   - Server: `POST /api/store/votes`
   - Google Sheets: re-sync via `syncVoteToSheets`
5. Migration only runs once — after completion, no old-format keys remain

### Edge Cases

- **Orphaned votes** (old key index exceeds current array length): Skip — those votes are already lost from a prior delete/archive
- **Duplicate voters** after merge: Deduplicate by lowercase name comparison
- **Migration idempotency**: If no old-format keys exist, migration is a no-op

---

## Section 3: FPPC API Endpoint

A new read-only endpoint on the FPPC server that returns event details joined with vote counts.

### Endpoint

```
GET /api/fppc-votes
```

**No authentication required** (same as existing `/api/quotes` — read-only summary data, no sensitive information).

### Response Format

```json
{
  "events": [
    {
      "id": "st-patricks-pub-crawl",
      "title": "St. Patrick's 3-Day Pub Crawl",
      "date": "Mar 13–17",
      "location": "Multiple bars citywide",
      "type": "social",
      "votes": 6,
      "voters": ["Alice", "Bob", "Charlie", "Dana", "Eve", "Frank"]
    }
  ],
  "updatedAt": "2026-03-27T18:30:00.000Z"
}
```

### Server Implementation

The endpoint reads from the server's data files:
1. Load all event arrays from `DATA_DIR` (`sfEvents.json`, `volunteerEvents.json`, `teamEvents.json`)
2. Load `votes.json`
3. For each event, look up `votes[event.id]` to get voter list and count
4. Return combined list sorted by vote count descending
5. Also include suggestion-sourced events that have votes

### Why This Fixes Titles

Titles are resolved at read-time from the current event data. The API never returns a stale title because it always reads the latest event objects, not stored vote metadata.

---

## Section 4: EA Dashboard Integration

The sophie-dashboard (`/Users/sophieweiler/New Claude/sophie-dashboard/`) fetches from the new endpoint to populate its FPPC widget.

### Changes to `sophie-dashboard/public/dashboard.html`

1. **Add fetch on page load:**
   ```javascript
   fetch('https://fppc-dashboard-production-52d3.up.railway.app/api/fppc-votes')
     .then(r => r.json())
     .then(data => {
       DATA.fppcEvents = (data.events || []).map(e => ({
         name: e.title,
         votes: e.votes,
         type: e.type,
         date: e.date,
         location: e.location
       }));
       // Re-render FPPC widget
       document.querySelector('[data-widget="fppc"]')... // or re-call render
     })
     .catch(() => {}); // Graceful fallback — empty array stays
   ```

2. **Update dashboard link** from local `file:///` path to:
   ```
   https://fppc-dashboard-production-52d3.up.railway.app/
   ```

3. **Field consistency:** `renderFPPC()` uses `e.name` — the fetch maps `title` → `name` to match existing render code (no render changes needed).

### Fallback Behavior

If the fetch fails, `DATA.fppcEvents` remains `[]`, and the widget shows "No events at 4+ votes yet" — identical to current behavior.

---

## Section 5: Cleanup

### Remove `refreshVoteTitlesInSheets()`

The function added at lines 3098-3113 of `index.html` is a premature fix that fires `updateTitle` requests to Google Sheets on every page load. Remove it — the API endpoint approach makes it unnecessary.

### Google Sheets Title Updates

When `syncVoteToSheets()` is called on vote/unvote, it still sends `eventTitle` for human readability in the Sheet. But Sheets is no longer the source of truth for titles — the API endpoint is. Stale titles in Sheets become cosmetic only.

### Update `getVoteKey` and Callers

- `getVoteKey()` is no longer needed — vote keys are just `event.id`
- All callers of `vote()`, `hasVoted()`, `getVoteEntry()` updated to use `event.id` directly
- `syncVoteToSheets()` sends `event.id` as `eventKey`

---

## Files Modified

| File | Changes |
|------|---------|
| `fppc-dashboard-work/index.html` | Add `id` to all event objects, update vote functions to use IDs, add migration logic, remove `refreshVoteTitlesInSheets` |
| `fppc-dashboard-work/server.js` | Add `GET /api/fppc-votes` endpoint |
| `sophie-dashboard/public/dashboard.html` | Add fetch to FPPC endpoint, update dashboard link |

## Migration Safety

- Existing votes are preserved by mapping old keys → new IDs
- Migration runs client-side on first page load after deploy
- Server-side vote data (`votes.json`) is updated after migration
- Google Sheets is re-synced with new keys
- If anything fails, old vote data is untouched (migration reads before writing)
