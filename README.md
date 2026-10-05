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
| `join_game`   | Must be called first. Opens the Socket.IO connection, returns `player_id` and world dimensions. |
| `observe`     | Compact JSON view of nearby world: own cells, nearest threats and prey, viruses, map edges, food hint. |
| `set_heading` | Steer the cell to an angle or point.                                      |
| `split`       | Native `split` action.                                                    |
| `eject`       | Native `fire food` action.                                                |

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
| `CELLAGENTS_MCP_CONFIG` | absolute path to an alternate config file |

## Running

Node 22+. Point at a running `cells-game` server on
`http://127.0.0.1:3000`:

```bash
npm install
npm run build
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
