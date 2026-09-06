# Installing mcp-spreadsheet (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Spreadsheet** (@theluckystrike/mcp-spreadsheet)
What it does: Open, inspect, filter, edit and convert xlsx and csv files. Processing happens on the local machine.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/spreadsheet
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-spreadsheet` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`. Everything else on this page is unchanged.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native build tools. The package is pure JavaScript.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-spreadsheet
```

The server speaks MCP over stdio. It prints one readiness line to stderr and nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`.
Merge this entry into the existing `mcpServers` object; do not overwrite the file.

```json
{
  "mcpServers": {
    "spreadsheet": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-spreadsheet"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add spreadsheet -- npx -y @theluckystrike/mcp-spreadsheet
```

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Same entry as Claude Desktop.

### Cline

File: `cline_mcp_settings.json` (VS Code: Cline panel -> MCP Servers -> Configure MCP Servers). Merge:

```json
{
  "mcpServers": {
    "spreadsheet": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-spreadsheet"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Step 3 - restart the client and verify

Restart the client, then call `license_status`. A successful call returns the current mode (free or pro) and proves the transport works. `tools/list` must show the tool table from the server README.

## Optional - Pro key

A Pro key removes the free-tier limits listed in the README. Either add it to the config:

```json
"env": { "MCP_LICENSE_KEY": "MCPL1..." }
```

or call the `license_activate` tool once with the key. Keys are verified offline; nothing is sent anywhere. Keys: https://mcp.zovo.one/buy/spreadsheet

## Alternative A - .mcpb bundle (Claude Desktop one-click)

Download `spreadsheet.mcpb` from https://github.com/theluckystrike/mcp-servers/releases and open it, or drag it onto the Claude Desktop Extensions pane. This installs the server without editing JSON and without Node on PATH assumptions.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build
```

Then use `"command": "node", "args": ["<abs path>/mcp-servers/servers/spreadsheet/dist/index.js"]`.

## Alternative C - Docker

```sh
docker buildx build -f servers/spreadsheet/Dockerfile -t mcp-spreadsheet .
```

The build context is the repository root. Run with `docker run -i --rm -v mcp-spreadsheet-data:/root/.local/share/mcp-servers mcp-spreadsheet`.

## Troubleshooting

- `command not found: npx` - install Node.js 18+.
- Tools missing after config edit - the client only reads the config at startup; restart it fully.
- Data location: `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/spreadsheet/`. Deleting that directory resets the server.

Built by theluckystrike (https://github.com/theluckystrike).
