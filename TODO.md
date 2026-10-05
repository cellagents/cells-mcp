# TODO: MCP server

Scope and architecture live in `../../SW_PROJECT.md`, section "Komponenta 3". New Node 20 app. MCP over HTTP Streamable Transport. One MCP session = one player = one Socket.IO connection to the game server.

Can start as soon as `apps/agar.io-clone` items 2 (join token) and 5 (spectator viewport) are available.

## Milestone 2: MCP server

- [x] **1. Skeleton.** `apps/mcp-server/` with `package.json`, TypeScript, MCP SDK, HTTP Streamable transport, `socket.io-client`. Single process, config via env + `config.json`.
- [x] **2. Session binding + `join_game`.** MCP session → one Socket.IO connection as a player. Auto-resolve nickname collisions by index suffix (`Alice`, `Alice2`, ...). Return `{player_id, world: {width, height}}`. Must be called first.
- [x] **3. Movement tools.** `set_heading({angle} | {x, y})`, `split({})`, `eject({})`. Thin wrappers over the native protocol (`'0'`, `'1'`, `'2'`).
- [x] **4. `observe` tool.** Compact JSON from the spectator viewport channel keyed by own `player_id`. v1 schema: own cells, nearest 5 threats, nearest 5 prey, nearest viruses, map edges, round phase. Compact for tokens, readable for the model.
- [x] **5. `status` tool.** `{phase, time_remaining, leaderboard_top}` from the cached `roundState`.
- [x] **6. `heartbeat` tool.** Accept `{cost, model, prompt_tokens}`. Clamp to `[-honest_max × 0.5, honest_max × 2]` (configurable). Compute `honest_estimate` from call frequency + input length + declared model. Log declared vs honest for the spectator overlay. Apply the clamped value via the game server's drain setter.
- [x] **7. Config file.** Clamp bounds, model tier table, game-server URL, admin fallback for "minimum drain if no heartbeat for N seconds" (off by default).

**Exit criteria.** Claude Desktop pointed at this MCP server can call `join_game`, read `observe`, move via `set_heading`, split/eject, and the character visibly moves in the game. Honest-vs-declared log reflects test calls.

**Deliberately out of scope.** Calling LLMs. Owning an agent loop. Tracking which model is really used (we trust the client's self-report, with clamp as the only control). See "Co MCP server nedělá" in SW_PROJECT.md.

## Open questions bubbled up from this component

- Concrete clamp bounds, calibrate during dress rehearsal.
- `observe` schema v1 shape, iterate under real play.
