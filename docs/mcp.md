# MCP server

`jev-score mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It exposes Jev Score as tools, so an agent can save drafts, score them, and read feedback without writing temporary files or shell commands. It shares the database with the CLI and the app, so anything an agent scores shows up in `jev-score ui` as it happens.

Claude Code and Codex can already use the CLI, so the MCP server is optional for them. It helps most in three cases:

- **Chat apps without a shell**, such as Claude Desktop. MCP is the only way to use Jev Score from them.
- **Fewer permission prompts.** You approve the tools once instead of each new shell command.
- **No quoting or temporary files.** The agent passes the draft text directly.

## Set up

The server needs `OPENROUTER_API_KEY` in its environment. MCP clients start the server themselves, often from a different directory, so pass the key in the client config instead of relying on `.env.local`.

**Claude Code**

```bash
claude mcp add --scope user -e OPENROUTER_API_KEY=your_key jev-score -- jev-score mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "jev-score": {
      "command": "jev-score",
      "args": ["mcp"],
      "env": { "OPENROUTER_API_KEY": "your_key" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.jev-score]
command = "jev-score"
args = ["mcp"]
env = { OPENROUTER_API_KEY = "your_key" }
```

If `jev-score` is not on the client's `PATH`, use the absolute path to `bin/jev-score.mjs` with `node` as the command. Set `JEV_SCORE_DB` in `env` to point several clients at one database.

## Tools

| Tool | What it does |
| --- | --- |
| `list_workspaces` | Every workspace with its best draft and change from the original. |
| `get_workspace` | The context, the evaluation group's questions, and every draft ranked with per-question scores. |
| `get_document` | One draft's full text and recent runs. Reference drafts by ID, title, or version such as `#3`. |
| `score_document` | Save a new draft (`content`) or pick one (`document`), score it, and return feedback. |
| `add_document` | Save a draft without scoring it. |
| `rank_documents` | Rank drafts overall or by one question key. |
| `list_groups` | Evaluation groups and the starter templates. |
| `create_group` | Create a group from a template or your own questions. |
| `create_workspace` | Create a workspace around a context, with an existing group or a template. |

`score_document` returns the same feedback as `jev-score score`: the overall score, rank, `vsParent`, `vsBest`, and `vsOriginal` deltas, every question's score and deltas, and the three `weakest` questions. Every delta is signed so that positive means better, including for lower-is-better questions.

The server's instructions ask agents to make bold, substantive revisions, score each draft once, and use `runs: 3` only to decide between two top drafts that are within about two points.

## Protocol notes

The server speaks JSON-RPC 2.0, one message per line, and negotiates protocol versions `2025-06-18`, `2025-03-26`, and `2024-11-05`. It writes nothing but protocol messages to stdout. Tool failures, such as an unknown workspace or a reached spend limit, come back as tool results with `isError: true` so the agent can read the message and recover.
