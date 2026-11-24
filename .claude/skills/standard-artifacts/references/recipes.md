# Recipes

Run `stdartifacts` with `STDARTIFACTS_AS=agent` in dev. `stdartifacts ops` applies raw ops and stops at the first failure, keeping the ones before it.

## Set up a table in one call

Get the column and row ids first:

```sh
stdartifacts new table "Pages"
stdartifacts read t_abc --json     # state.columns[].id, state.rowIds
```

Then remove the blank rows, reshape the starter columns and add yours in one batch. Use ids you make up (`c_…`, `r_…`) for anything new:

```sh
stdartifacts ops t_abc <<'JSON'
[
  { "type": "removeRows", "rowIds": ["r_1", "r_2", "r_3", "r_4", "r_5"] },
  { "type": "updateColumn", "id": "c_website", "patch": { "name": "URL" } },
  { "type": "updateColumn", "id": "c_status", "patch": { "name": "Fetch", "options": ["ok", "failed"] } },
  { "type": "addColumn", "column": { "id": "c_summary", "name": "Summary", "type": "text" } }
]
JSON
```

Other ops: `{ "type": "removeColumn", "id": "c_…" }` and `{ "type": "moveColumn", "id": "c_…", "index": 1 }`.

With MCP only, you can't rename or remove columns:

1. `read_artifact` to get the blank row ids.
2. `remove_items` with those ids.
3. Reuse Name and Website, and avoid the name Status.
4. `table_add_column` for the rest, then `table_add_rows` once.

Writing more than 500 cells at once? `stdartifacts ops` also takes a single all-or-nothing `setCells` op, up to 5,000 cells:

```json
[{ "type": "setCells", "cells": [{ "rowId": "r_1", "colId": "c_summary", "value": "…" }] }]
```

## Recover a lost run

If the MCP session ended, `complete_run` replies "No open run" and the run stays Running. Close it directly, then put the issue in the right status:

```sh
stdartifacts ops i_abc <<'JSON'
[{ "type": "update", "id": "r_run", "patch": { "state": "failed", "endedAt": "2026-11-06T21:00:00Z", "summary": "Lost the MCP session. What's done so far is in the comments." } }]
JSON
stdartifacts issue set i_abc 12 --status todo
```

Get the run id from `stdartifacts read i_abc`.

## Move a board shape from the CLI

```sh
stdartifacts ops b_abc <<'JSON'
[{ "type": "update", "id": "s_abc", "patch": { "x": 0, "y": 400 } }]
JSON
```

Over MCP, use `board_update` with `{ "shapes": [{ "id": "s_abc", "x": 0, "y": 400 }] }`.

## Change a frame without losing edits

Prefer a patch. It changes one layer and leaves the rest alone:

```sh
stdartifacts board design get b_abc s_abc --outline
stdartifacts board design patch b_abc s_abc n_title --text "Ship it" --style color=#e5484d
```

If you must replace the whole frame, compare first:

```sh
stdartifacts board design get b_abc s_abc > current.html
diff last-written.html current.html     # any difference is someone's edit: merge it into your new version
stdartifacts board design set b_abc s_abc new.html
```

Someone can still edit between the `get` and the `set`, because nothing checks for conflicts.

## Ask a person something without stopping

```json
{
  "artifact": "i_abc",
  "title": "Which pricing tier should the memo lead with?",
  "description": "**Question:** Team or Enterprise?\n\n**Why it matters:** the memo's first section depends on it. I drafted it for Team and kept going.",
  "priority": "high",
  "labels": ["needs-person"],
  "links": ["d_memo"]
}
```

Send that to `create_issue`, then put the question and its link (`/issues/i_abc/13`) in your final message. Nobody is notified otherwise. To set an owner, `owner` must name someone already on an issue in that tracker.

## Read structured data

```sh
stdartifacts read t_abc --json
curl -s "$STDARTIFACTS_URL/api/v1/artifacts/i_abc/content" -H "x-dev-as: agent"   # dev; live uses Authorization: Bearer $STDARTIFACTS_TOKEN
curl -s "$STDARTIFACTS_URL/api/v1/workspace" -H "x-dev-as: agent"
```

Use `.state` for data and `.text` for the compact form. On trackers, `.state.items` holds `issue`, `run` and `comment` records; a run's `issueId` points at its issue.
