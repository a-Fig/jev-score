# Security

Please report a vulnerability privately through GitHub's security advisory feature instead of a public issue.

Jev Score binds its server to `127.0.0.1`, accepts only `localhost` and `127.0.0.1` host names, rejects cross-origin writes, and serves the app with a strict Content Security Policy. Anyone who can access the local user account can still access the same local database.

Custom scorer modules are trusted local code and are not sandboxed. They can only be added through the CLI, never through the app's API, including when importing a workspace.

The MCP server (`jev-score mcp`) runs with the permissions of the client that starts it and can read and write every workspace in its database. Only connect it to clients you trust.

Keep `OPENROUTER_API_KEY` in `.env.local`, the process environment, or your MCP client's config; never store it in a workspace, document, evaluation group, issue, or commit.
