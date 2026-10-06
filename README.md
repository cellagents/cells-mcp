# cells-mcp

MCP server that binds each session to a Socket.IO connection as a
regular player, so a language model can play any `agar.io-clone` game
by calling tools.

## `cellagents` project

Cell agents is an educational project where **LLM agents play this
game against each other and against human players.** This repo is one
of several key components in that stack; its job is to provide tools
so that AI agents can join the game sessions.

Visit [**cellagents.dev**](https://cellagents.dev/) for overview of the full project.

## Compatibility

Designed to work against any upstream `agar.io-clone` game server over Socket.IO.

Point the MCP server at any such instance and the five tools below work the same way.

## Connecting a client

Any MCP client with HTTP Streamable transport. Example for Claude
Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cells": {
      "url": "http://127.0.0.1:4000/mcp"
    }
  }
}
```

## Tools

| Tool          | What it does                                                              |
|---------------|---------------------------------------------------------------------------|
| `join_game`   | Must be called first (and again after any game-session termination). Opens the Socket.IO connection, returns `player_id` and world dimensions. |
| `observe`     | Compact JSON view of nearby world: own cells, nearest threats and prey, viruses, map edges, food hint. |
| `move_to`     | Head toward world coordinates `{x, y}`. The MCP steers each tick and stops the cell on arrival. |
| `set_heading` | Steer the cell at a fixed `angle` (radians) indefinitely until overridden or until the arena edge. |
| `stop`        | Clear any active movement and halt in place.                              |
| `split`       | Native `split` action.                                                    |
| `eject`       | Native `fire food` action.                                                |
| `quit_game`   | Leave the current game. MCP session stays open; call `join_game` to rejoin. No-op if not currently in a game. |

See `src/session.ts` for exact schemas.

## Technical overview

TypeScript Node.js server. One MCP session = one Socket.IO
connection to the game server, playing as a regular named player.
Tool calls over the Model Context Protocol translate to the native
Socket.IO events the game server already understands.

Configuration lives in `config.json` at the repo root (copy of
`config.example.json`). The loader searches, in order:
`$CELLAGENTS_MCP_CONFIG`, `./config.json`, `./config.example.json`.
A handful of fields can also be overridden via environment variables
without editing the file, useful for Docker, CI and test harnesses:

| Variable | Overrides |
|---|---|
| `GAME_SERVER_URL` | `gameServer.url` (the Socket.IO endpoint of the game server) |
| `MCP_PORT` | `mcp.port` |
| `MCP_PATH` | `mcp.path` (defaults to `/mcp`) |
| `SESSION_HEARTBEAT_HZ` | `session.heartbeatHz` (defaults to `1`) |
| `SESSION_TIMEOUT_MS` | `session.sessionTimeoutMs` (defaults to `60000`) |
| `CELLAGENTS_MCP_CONFIG` | absolute path to an alternate config file |

## Session lifecycle

Two distinct sessions matter here. Don't conflate them:

- **MCP session** — one HTTP streamable transport. Lives as long as
  the client (harness) keeps using it. The client sees a session-id
  returned on the first request and resends it on every subsequent
  one.
- **Game session** — one Socket.IO connection as a `player`. Lives
  only while the player is in the game. Established by `join_game`,
  ended by in-game kick, raw disconnect, or RIP.

The two have different termination paths on purpose, so an agent
doesn't need to reconnect to the MCP server just because its player
died.

### Keeping the game session alive

The MCP server re-emits the player's current steering intent at
`session.heartbeatHz` (default 1 Hz), well below cells-game's
idle-kick threshold. An agent that pauses between tool calls doesn't
get kicked by the game server.

### Game-session termination (kick / disconnect / RIP)

If cells-game ends the player (admin kick, socket drop, player
eaten), the MCP session **stays open**. The next tool that needs the
game (observe, move_to, set_heading, stop, split, eject) returns an
MCP tool error with text explaining the reason and instructing the
agent to call `join_game` again. The MCP session-id does not change;
the agent just resumes on the same transport.

### MCP-session termination (inactivity, explicit close, shutdown)

The whole MCP session goes away in these cases:

- **Inactivity.** No MCP request (tool call or raw transport ping)
  for `session.sessionTimeoutMs` (default 60 s).
- **Explicit close.** The transport reports its own close event.
- **Shutdown.** The MCP server is terminating.

After full teardown, any subsequent HTTP request using that
session-id returns `HTTP 410 Gone` with a JSON body naming the
reason. Session-ids are tombstoned for ten minutes; after the TTL
they look like any unknown session-id and a new session is created
on the next request.

## Running

Node 22+. Point at a running `cells-game` server on
`http://127.0.0.1:3000`:

```bash
npm install
cp config.example.json config.json      # edit if needed
npm start
```

Or in watch mode during development:

```bash
npm run dev
```

MCP streams at `http://127.0.0.1:4000/mcp` by default.

Or with Docker:

```bash
docker build -t cells-mcp .
docker run --rm -p 4000:4000 \
  -e GAME_SERVER_URL=http://host.docker.internal:3000 \
  cells-mcp
```

## License

MIT.
