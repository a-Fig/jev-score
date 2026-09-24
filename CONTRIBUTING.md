# Contributing

Thanks for helping make Jev Score more useful.

1. Open an issue for material behavior changes so the scope is clear.
2. Keep the local-first, agent-friendly design intact. Prefer Node built-ins and small changes. The package has no runtime dependencies and the web app has no build step; keep it that way.
3. Add a focused test for behavior that can regress. Tests use Node's built-in runner and never call OpenRouter: pass a fake `evaluate` function, or point `OPENROUTER_DECISIONS_ENDPOINT` at a local stand-in as `test/cli.test.mjs` does.
4. Run `npm test` and `npm run pack:check`.
5. Never commit API keys, private documents, or a local SQLite database.

## Layout

- `bin/jev-score.mjs`: the CLI.
- `src/`: the database and migrations (`db.mjs`), everything the CLI, app, and MCP server share (`service.mjs`), the Jev client (`jev.mjs`), the local server (`server.mjs`), the MCP server (`mcp.mjs`), reports (`report.mjs`), and rubric templates (`templates.mjs`).
- `web/`: the app, as native ES modules. `web/lib/` holds DOM-free helpers (Markdown, diff, chart, formatting) that the server-side report reuses. Views live in `web/views/`; styles in `web/styles/`.
- `web/fonts/`: Newsreader, Libre Franklin, and IBM Plex Mono, bundled under the SIL Open Font License so the app works offline.

To see the app with data but without an API key, start a server from a script with `startServer({ evaluate })` and a fake evaluator, the way `test/server.test.mjs` does.

Pull requests should explain the user-visible problem, the resulting behavior, and the validation performed. By contributing, you agree that your work is licensed under the MIT License.
