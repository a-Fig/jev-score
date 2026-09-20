# Jev Score

**A local workspace where coding agents measure every draft with Jev.**

Jev Score keeps the context, every document revision, reusable evaluation questions, and score history in one local SQLite database. Codex or Claude Code drives it through the CLI; you can watch progress, compare drafts, and run evaluations from a clean localhost interface.

It works for resumes against job postings, essays against prompts, specs against requirements, landing pages against positioning, and any other text you want to improve against explicit criteria.

> Jev Score is an independent open-source project. It calls [TypeSafe's Jev model](https://www.typesafe.ai/) through OpenRouter.

## Why it is useful

- **Built for coding agents.** Every UI operation has a CLI equivalent with structured JSON output.
- **Local first.** Documents, contexts, groups, and run history live in SQLite on your machine.
- **Every draft survives.** Content is deduplicated by SHA-256, while repeated evaluations remain separate runs.
- **Honest score summaries.** See the median, minimum, maximum, spread, run count, and either highest-ever or median ranking.
- **Reusable rubrics.** Define an evaluation group once, then attach it to any workspace.
- **Visible progress.** Compare every run and the best-so-far frontier as change from the original.
- **Extensible aggregation.** Use the arithmetic mean or a small JavaScript function for weights and lower-is-better criteria.

## Install

Jev Score requires Node.js 22.13 or newer and an OpenRouter API key with access to Jev.

```bash
git clone https://github.com/a-Fig/jev-score.git
cd jev-score
npm install
cp .env.example .env.local
```

On PowerShell, use `Copy-Item .env.example .env.local`. Add your key to `.env.local`:

```dotenv
OPENROUTER_API_KEY=your_key_here
OPENROUTER_JEV_MODEL=typesafe/jev-1.13
```

Install the command globally from the checkout if you want to use it anywhere:

```bash
npm install --global .
jev-score --help
```

The package is ready for npm publishing, but the source checkout is the supported install path for the first release.

## Quick start

Create a reusable group of questions:

```bash
jev-score group create \
  --name "Resume review" \
  --questions ./examples/resume/questions.txt
```

Create a workspace around a context, then evaluate the first document:

```bash
jev-score workspace create \
  --name "Product writer" \
  --context ./examples/resume/job-posting.md \
  --context-title "Job posting" \
  --group "Resume review"

jev-score score "Product writer" ./examples/resume/resume.md \
  --title "Original resume"
```

`score` accepts a saved document name/ID or a file. A file is saved to SQLite before the network call and deduplicated if its normalized content already exists.

Open the interface:

```bash
jev-score ui
```

The app binds to `127.0.0.1:4317`. The UI can upload and download documents, create evaluation groups, change the primary group or ranking metric, and run new evaluations.

## Agent workflow

The coding agent owns the edits and the loop. Jev Score stores and evaluates what the agent gives it.

```bash
# Save a new revision with provenance
jev-score document add "Product writer" ./resume-v2.md \
  --title "Stronger outcomes" \
  --summary "Quantified impact and tightened the summary" \
  --parent "Original resume"

# Evaluate it
jev-score score "Product writer" "Stronger outcomes" --note "iteration 2"

# Compare it with every other draft
jev-score rank "Product writer"

# Rank by one stable question key instead
jev-score rank "Product writer" \
  --question does-the-resume-demonstrate-strong-fit-for
```

Use `jev-score workspace mode "Product writer" median` when repeated sampling matters more than a single peak. The workspace toggle in the UI controls the same setting.

## Core commands

```text
jev-score workspace create|list|show|delete|primary|mode
jev-score group create|list|show|rename|delete|attach
jev-score document add|list|get
jev-score score <workspace> <document-or-file>
jev-score rank <workspace>
jev-score ui
jev-score serve
jev-score db path|reset
```

Run `jev-score --help` for arguments. References accept IDs or case-insensitive names. All data commands print JSON so agents can reliably inspect their results.

## Evaluation groups

A group contains ordered questions and an overall scorer. Questions and scorer code become immutable after the first run, which keeps historical scores comparable. The group can still be renamed. Deleting it also deletes its runs and scores.

The default overall score is the arithmetic mean. For weighted criteria or a question where lower is better, supply a JavaScript module:

```bash
jev-score group create \
  --name "Weighted hiring review" \
  --questions ./examples/custom-questions.json \
  --scorer ./examples/custom-scorer.mjs
```

See [Custom scorers](./docs/custom-scorers.md) for the contract and failure behavior.

## Data and privacy

The database path is platform-specific:

- Windows: `%LOCALAPPDATA%\jev-score\jev-score.db`
- macOS: `~/Library/Application Support/jev-score/jev-score.db`
- Linux: `$XDG_DATA_HOME/jev-score/jev-score.db` or `~/.local/share/jev-score/jev-score.db`

Set `JEV_SCORE_DB` to choose an exact database file, or `JEV_SCORE_DATA_DIR` to move the data directory. SQLite runs in WAL mode so the CLI and UI can use the same database safely.

Documents, context, and evaluation questions are sent to OpenRouter when you run an evaluation. They are otherwise served only on loopback and stored locally. Delete one workspace with `workspace delete --yes`, or wipe the active database with `db reset --yes`.

## Development

The application intentionally uses Node's built-in HTTP server, SQLite module, test runner, and browser APIs. There are no runtime dependencies.

```bash
npm test
npm run pack:check
npm start
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before sending a pull request. Jev Score is available under the [MIT License](./LICENSE).
