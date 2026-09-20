# Security

Please report a vulnerability privately through GitHub's security advisory feature instead of a public issue.

Jev Score binds its server to `127.0.0.1`, but anyone who can access the local user account can access the same local database. Custom scorer modules are trusted local code and are not sandboxed. Keep `OPENROUTER_API_KEY` in `.env.local` or the process environment; never store it in a workspace, document, evaluation group, issue, or commit.
