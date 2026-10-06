# 4.0 — Dual protocol mode

Short-lived branch tracking cells-mcp's part of the cells-game 4.0
release. The authoritative plan lives in `cells-game`:

**→ ../cells-game/PLAN.md** (feat/4.0-protocol branch)

## What this branch does

cells-mcp learns to speak both the pre-4.0 and the 4.0 cells-game
protocol in one build:

1. On connect, probe 4.0 by emitting the new `subscribe` payload.
2. If `welcome` with `protocol: '4.0'` arrives: 4.0 mode confirmed.
3. If `reject` arrives, or the probe times out, or `welcome`
   arrives without the version field: disconnect, reconnect with
   the pre-4.0 `?type=player` query + legacy `gotit`, and flag the
   socket as legacy for its lifetime.

The pre-4.0 implementation is the existing `GameClient` renamed to
`LegacyGameClient`; no fixes to it. The 4.0 implementation is new,
built against the published `@cellagents/game-protocol` types.

## Scope

- No MCP tool surface changes.
- No new features.
- No fixes to legacy-mode behaviour. If it works today, it works
  on this branch. If it doesn't, it doesn't; both are fine because
  the fix lives in the post-archival `mcp` repo.

## Why this is a cells-mcp 2.0.0

Even though the external MCP tool surface is unchanged, the socket
layer has a new runtime shape (dual-mode) that external integrators
could depend on. Bumping majors makes the archival boundary legible.

## Review

Read `../cells-game/PLAN.md` for the full spec and ping the
cells-game review checklist. Nothing to review on this branch yet
beyond that pointer.
