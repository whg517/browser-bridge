# 接入各家 AI Agent

> 装完 browser-bridge 后,怎么让你的 Agent **发现**并**使用**这 15 个工具。

## 核心机制:注册一次,自动发现

主流 Agent(Claude Code、Codex、OpenClaw、Cursor、Windsurf、Cline……)**都是 MCP host**。
机制统一成两步:

1. **让 Agent 知道它存在**:把 browser-bridge 注册成一个 MCP server(指向安装好的**绝对路径**、
   **无参数**的二进制)。
2. **Agent 自动发现能力**:它 spawn 这个二进制、跑 `initialize` + `tools/list`,15 个工具连同
   参数 schema 就都出现了——**不需要你写任何 wrapper**。

browser-bridge 本身已经是合规的 MCP stdio server,所以**发现这一环无需任何改动**;你要做的只是
在你的 Agent 里**注册一次**。安装器可自动注册 Claude Code / Codex / OpenClaw(见下)。

**二进制绝对路径**(下文的 `<BIN>`):

| 平台 | 路径 |
|---|---|
| macOS | `~/.browser-bridge/browser-bridge` |
| Linux | `~/.local/share/browser-bridge/browser-bridge` |
| Windows | `%LOCALAPPDATA%\browser-bridge\browser-bridge.exe` |

## 有 CLI 的:一条命令(可让安装器代劳)

| Agent | 注册 | 验证 | 安装器自动注册 |
|---|---|---|---|
| **Claude Code** | `claude mcp add browser-bridge -- "<BIN>"` | `claude mcp list` / 会话内 `/mcp` | `./install.sh --register-claude-code` |
| **Codex** | `codex mcp add browser-bridge -- "<BIN>"` | `codex mcp list` / `/mcp` | `./install.sh --register-codex` |
| **OpenClaw** | `openclaw mcp add browser-bridge --command "<BIN>"` | `openclaw mcp probe browser-bridge` | `./install.sh --register-openclaw` |

> OpenClaw 注意:**不要**加 `--transport stdio`(其 CLI 有已知 bug,stdio 是默认)。

卸载时对称移除:`./install.sh --uninstall --unregister-codex --unregister-openclaw`(或各自
`<cli> mcp remove browser-bridge`)。

## 用 JSON 配置文件的:粘一个 `mcpServers` 条目

条目体都一样,只有文件路径不同:

```json
{
  "mcpServers": {
    "browser-bridge": { "command": "<BIN>", "args": [] }
  }
}
```

| Agent | 配置文件 | 生效方式 |
|---|---|---|
| **Cursor** | `~/.cursor/mcp.json`(全局)或 `<项目>/.cursor/mcp.json` | 自动加载 |
| **Windsurf / Cascade** | `~/.codeium/windsurf/mcp_config.json` | 点 MCP 面板的 **Refresh** |
| **Cline**(VS Code 扩展) | 扩展的 `cline_mcp_settings.json` | 保存后自动加载 |
| **Claude Desktop** | `claude_desktop_config.json` | **完全退出并重启** Claude Desktop |

## Codex 手写 TOML(等价于 `codex mcp add`)

```toml
# ~/.codex/config.toml
[mcp_servers.browser-bridge]
command = "<BIN>"
args = []
# 可选: startup_timeout_sec = 20, tool_timeout_sec = 60
```

## LangChain / LangGraph

LangChain 核心不是 MCP-native,但有官方桥接 `langchain-mcp-adapters`(PyPI):

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain.agents import create_agent

client = MultiServerMCPClient({
    "browser-bridge": {"command": "<BIN>", "args": [], "transport": "stdio"},
})
tools = await client.get_tools()          # 跑 initialize + tools/list,拿到全部 15 个工具
agent = create_agent("openai:gpt-4.1", tools)
```

## Hermes / harmony:是**格式**,不是 MCP 客户端 → 用 CLI

**Hermes**(Nous Research)和 **harmony**(OpenAI,gpt-oss/Codex 用)都是**工具调用的提示词格式**,
本身不懂 MCP、不做发现。分两种情况:

- **模型跑在某个 MCP host 里**(Codex、OpenClaw 等)→ 按上面注册 MCP server 即可,host 负责一切。
- **你的 harness 直接驱动一个 Hermes/harmony 格式的模型**(没有 MCP 客户端)→ 用 browser-bridge 的
  **非 MCP CLI** 补上"发现 + 调用":

  ```sh
  browser-bridge tools --json    # 发现:{tools:[{name,description,inputSchema}]},把每个工具
                                 # 转成 Hermes 的 <tools> / harmony 的 functions 命名空间,注入系统提示
  browser-bridge call <tool> '<json-args>'   # 调用:模型发出工具调用时,harness 跑这条,把原始 JSON 结果喂回
  ```

  `tools --json` 的每条是 `{name, description, inputSchema}`,与 MCP `tools/list` 同形,转成任意
  函数调用格式都很直接。详见 [cli.md](./cli.md)。

## 通用规律

- **是 MCP host** → 注册 MCP server(上面),自动发现,首选。
- **不是 MCP host / 裸脚本** → `browser-bridge tools --json`(发现)+ `browser-bridge call`(调用)。
- 无论哪种,browser-bridge 端都**不用改**——它同时是 MCP server 和自描述 CLI。

## 相关

- CLI 与 `tools`/`call`:[cli.md](./cli.md)
- 安装与客户端注册:[../install/install.sh](../install/install.sh) · [../README.md](../README.md)
