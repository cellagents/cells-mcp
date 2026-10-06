# TODO

cells-mcp is scheduled for public archival after the 2.0.0 release.
Work continues in the post-archival `mcp` repo. Nothing new ships
here.

## 2.0.0 scope (shipped)

- Dual-mode game-client factory. `createGameClient` probes the game
  server's `GET /protocol` route: 200 (cells-game 4.0+) picks the
  new `GameClient`; 404 or any failure picks `LegacyGameClient`
  (pre-fork `agar.io-clone` + archived cells-game 3.x).
- New `GameClient` consumes `@cellagents/game-protocol` and speaks
  the capability-based handshake.
- `LegacyGameClient` is the pre-2.0 implementation renamed. One
  behaviour change: honors `session.viewport` instead of advertising
  a 1x1 screen; that was the one bug the plan allowed us to fix in
  legacy mode because the 1x1 made `observe` nearly blind.
- Both clients expose the same public API so `session.ts` consumes
  them through `AnyGameClient = GameClient | LegacyGameClient` and
  never branches on wire version.
- Zod bumped to v4 to align with `@cellagents/game-protocol`.
- Dockerfile adds `git` so `npm ci` can resolve the GitHub-tag dep.
- New config knob: `session.viewport` (default `1920x1920`), used
  by both clients.

## Known gaps worth remembering

- **No new tests.** The dual-mode layer isn't test-covered in this
  repo; the handshake grammar is tested in `@cellagents/game-protocol`
  itself and the end-to-end integration in cells-game. The post-
  archival `mcp` can build a proper suite from scratch.
- **Pre-fork compatibility is best-effort.** The legacy client is
  frozen; any bug it has against upstream `agar.io-clone` is a
  known deficiency, fix lives in post-archival `mcp`.
