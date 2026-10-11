# TODO

cells-mcp is scheduled for public archival after the 2.0.x line.
Work continues in the post-archival `mcp` repo. Nothing new ships
here.

## 2.0.0 scope (shipped)

- Dual-mode game-client factory. `createGameClient` probes the game
  server's `GET /protocol` route: a `{ protocol, server }` body
  (cells-game 4.0+) picks the new `GameClient`; 404, a non-200, or
  any probe failure picks `LegacyGameClient` (pre-fork
  `agar.io-clone` + archived cells-game 3.x).
- New `GameClient` consumes `@cellagents/game-protocol` v1.0.0 and
  subscribes with capability set `{presence, steer, act}`. The
  user-agent is read from this package's `package.json` at module
  load, so a version bump never requires a code edit. The MCP
  session id is forwarded as `subscribe.clientId` so one agent run
  stays coherent in the server's admin audit across reconnects.
- Actions use the generic `action { type }` client event (`split`
  and `eject`). The client tracks `welcome.actions` and
  `actionsChanged`; the MCP `split`/`eject` tools refuse with a
  clear error when the server has not granted the action.
- `observe()` surfaces per-player and per-cell `effects` from the
  server (so a bot sees spawn-grace `invulnerable` and freshly-
  split `noMerge` state), reports `mass` on every entity (food,
  ejected, viruses, cells), and reads `rules.eatRatio` from
  `welcome.rules` instead of hardcoding `1.1`.
- `LegacyGameClient` is the pre-2.0 implementation renamed. One
  behaviour change: honors `session.viewport` instead of
  advertising a 1x1 screen; that was the one bug the plan allowed
  us to fix in legacy mode because the 1x1 made `observe` nearly
  blind.
- Both clients expose the same public API so `session.ts` consumes
  them through `AnyGameClient = GameClient | LegacyGameClient` and
  never branches on wire version.
- Zod bumped to v4 to align with `@cellagents/game-protocol`.
- Dockerfile adds `git` so `npm ci` can resolve the GitHub-tag dep.
- Config knob: `session.viewport` (default `1920x1920`), used by
  both clients.

## Known gaps worth remembering

- **No in-repo tests.** The dual-mode layer isn't test-covered
  here; the handshake grammar is tested in
  `@cellagents/game-protocol` and the end-to-end integration in
  cells-game. The post-archival `mcp` can build a proper suite
  from scratch.
- **Pre-fork compatibility is best-effort.** The legacy client is
  frozen; any bug it has against upstream `agar.io-clone` is a
  known deficiency, fix lives in post-archival `mcp`.
