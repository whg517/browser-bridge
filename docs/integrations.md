# Integrating with Various AI Agents

> After installing browser-bridge, how to let your Agent **discover** and **use** these 15 tools.

## Core mechanism: register once, auto-discover

Mainstream Agents (Claude Code, Codex, OpenClaw, Cursor, Windsurf, Cline, and so on) **are all MCP hosts**.
The mechanism boils down to two steps:

1. **Let the Agent know it exists**: register browser-bridge as an MCP server (pointing at the installed
   binary by its **absolute path**, with **no arguments**).
2. **The Agent auto-discovers capabilities**: it spawns this binary, runs `initialize` + `tools/list`, and all
   15 tools show up together with their parameter schemas — **without you writing any wrapper**.

browser-bridge itself is already a compliant MCP stdio server, so **discovery needs no changes at all**; all you
have to do is **register it once** in your Agent. The installer can auto-register Claude Code / Codex / OpenClaw
(see below).

**Binary absolute path** (the `<BIN>` referenced below):

| Platform | Path |
|---|---|
| macOS | `~/.browser-bridge/browser-bridge` |
| Linux | `~/.local/share/browser-bridge/browser-bridge` |
| Windows | `%LOCALAPPDATA%\browser-bridge\browser-bridge.exe` |

## Those with a CLI: one command (the installer can do it for you)

| Agent | Register | Verify | Installer auto-registration |
|---|---|---|---|
| **Claude Code** | `claude mcp add browser-bridge -- "<BIN>"` | `claude mcp list` / in-session `/mcp` | `./install.sh --register-claude-code` |
| **Codex** | `codex mcp add browser-bridge -- "<BIN>"` | `codex mcp list` / `/mcp` | `./install.sh --register-codex` |
| **OpenClaw** | `openclaw mcp add browser-bridge --command "<BIN>"` | `openclaw mcp probe browser-bridge` | `./install.sh --register-openclaw` |

> OpenClaw note: **do not** add `--transport stdio` (its CLI has a known bug, and stdio is the default).

Remove symmetrically when uninstalling: `./install.sh --uninstall --unregister-codex --unregister-openclaw` (or
`<cli> mcp remove browser-bridge` for each).

## Those using a JSON config file: paste in one `mcpServers` entry

The entry body is identical; only the file path differs:

```json
{
  "mcpServers": {
    "browser-bridge": { "command": "<BIN>", "args": [] }
  }
}
```

| Agent | Config file | How it takes effect |
|---|---|---|
| **Cursor** | `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` | Loaded automatically |
| **Windsurf / Cascade** | `~/.codeium/windsurf/mcp_config.json` | Click **Refresh** in the MCP panel |
| **Cline** (VS Code extension) | The extension's `cline_mcp_settings.json` | Loaded automatically after saving |
| **Claude Desktop** | `claude_desktop_config.json` | **Fully quit and restart** Claude Desktop |

## Codex hand-written TOML (equivalent to `codex mcp add`)

```toml
# ~/.codex/config.toml
[mcp_servers.browser-bridge]
command = "<BIN>"
args = []
# Optional: startup_timeout_sec = 20, tool_timeout_sec = 60
```

## Hermes Agent (Nous Research)

[Hermes Agent](https://hermes-agent.nousresearch.com/) is also an **MCP host**: when started in client mode it
discovers MCP servers and registers their tools alongside its built-in tools in the same registry. Two ways to
register:

```sh
# CLI (goes through the "discover first, then pick tools" interactive checklist; select which tools to expose to the agent)
hermes mcp add browser-bridge --command "<BIN>"
```

Or edit `~/.hermes/config.yaml` directly (`mcp_servers` is a **map indexed by name**, not a list):

```yaml
mcp_servers:
  browser-bridge:
    command: "<BIN>"        # the installed absolute path
    args: []
    tools:
      include: [tab_list, tab_open, page_snapshot, page_click, page_fill, page_text]
      # Omit include to expose all 15; Hermes supports on-demand filtering to avoid "tool bloat"
```

- **Take effect**: run `/reload-mcp` in-session, or restart Hermes.
- **Uninstall**: delete the `browser-bridge:` block from `~/.hermes/config.yaml` (Hermes has no `mcp remove` /
  `mcp list` subcommands).
- **Note**: browser-bridge's installer **does not auto-register Hermes** — `hermes mcp add` is interactive (it
  wants you to select tools), and Hermes has no `mcp list` (an unknown subcommand may drop into the interactive
  selector and hang), so run this step manually.

> Don't confuse them: **Hermes Agent** (the product above, an MCP host) ≠ **Hermes format** (next section, Nous's
> function-calling **prompt format**).

## LangChain / LangGraph

LangChain's core is not MCP-native, but there is an official bridge, `langchain-mcp-adapters` (PyPI):

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain.agents import create_agent

client = MultiServerMCPClient({
    "browser-bridge": {"command": "<BIN>", "args": [], "transport": "stdio"},
})
tools = await client.get_tools()          # runs initialize + tools/list, getting all 15 tools
agent = create_agent("openai:gpt-4.1", tools)
```

## Hermes / harmony **format** (≠ the Hermes Agent product): it's a format, not an MCP client → use the CLI

This refers to **function-calling prompt formats**: the **Hermes format** (Nous's `<tools>`/`<tool_call>`) and
**harmony** (OpenAI, the functions namespace used by gpt-oss/Codex). They themselves don't understand MCP and don't
do discovery. (Distinguish this from the **Hermes Agent product** above — that one is an MCP host, just register it
per the previous section.) There are two cases:

- **The model runs inside some MCP host** (Codex, OpenClaw, etc.) → just register the MCP server as above, and the
  host handles everything.
- **Your harness drives a Hermes/harmony-format model directly** (no MCP client) → use browser-bridge's
  **non-MCP CLI** to fill in "discovery + invocation":

  ```sh
  browser-bridge tools --json    # Discovery: {tools:[{name,description,inputSchema}]}; turn each tool
                                 # into Hermes's <tools> / harmony's functions namespace and inject it into the system prompt
  browser-bridge call <tool> '<json-args>'   # Invocation: when the model emits a tool call, the harness runs this and feeds the raw JSON result back
  ```

  Each entry from `tools --json` is `{name, description, inputSchema}`, the same shape as MCP `tools/list`, so
  converting it into any function-calling format is straightforward. See [cli.md](./cli.md) for details.

## General rules

- **Is an MCP host** → register an MCP server (above), auto-discover, preferred.
- **Not an MCP host / a bare script** → `browser-bridge tools --json` (discovery) + `browser-bridge call`
  (invocation).
- Either way, the browser-bridge side **needs no changes** — it is both an MCP server and a self-describing CLI.

## See Also

- The CLI and `tools`/`call`: [cli.md](./cli.md)
- Installation and client registration: [../install/install.sh](../install/install.sh) · [../README.md](../README.md)
