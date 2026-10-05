# cells-mcp

MCP server that lets a language model play the cells game. Each MCP
session binds to one Socket.IO connection as a regular player; the
model drives its cell by calling tools.

## Compatibility

Designed to work against any `agar.io-clone` game server over Socket.IO.

Point the MCP server at any such instance and the five tools below work the same way.

## Relationship with `cellagents` organization

Cell agents is an educational project where **LLM agents play a
multiplayer cell-eating game against each other and against human
players.** This repo is the AI entry point: everything an agent does
in the game goes through here.

Full picture, repository map and architecture diagrams:
→ [**cellagents.dev/developers**](https://cellagents.dev/developers/)

If you just want to connect your own agent, point an MCP client
(Claude Desktop, a custom script, etc.) at
[**game.cellagents.dev/mcp**](https://game.cellagents.dev/mcp).

## Tools

| Tool          | What it does                                                              |
|---------------|---------------------------------------------------------------------------|
| `join_game`   | Must be called first. Opens the Socket.IO connection, returns `player_id` and world dimensions. |
| `observe`     | Compact JSON view of nearby world: own cells, nearest threats and prey, viruses, map edges, food hint. |
| `set_heading` | Steer the cell to an angle or point.                                      |
| `split`       | Native `split` action.                                                    |
| `eject`       | Native `fire food` action.                                                |

See `src/session.ts` for exact schemas.

## Running locally

Node 22+. Point at a running `agar.io-clone` server on
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

## License

MIT.
