---
name: jev-score
description: Store, score, and compare revisions of a text or Markdown document against a context (job posting, essay prompt, brief) and reusable questions, using Jev through OpenRouter. Use for iterative work on resumes, cover letters, essays, emails, READMEs, landing pages, specs, and similar documents. The coding agent writes the revisions; Jev Score is the system of record and the evaluator.
---

# Jev Score

Use the CLI (or the `jev-score mcp` tools, if they are connected) as your interface. The CLI prints JSON when its output is piped; pass `--json` to be sure. It shares one SQLite database with the local app, so the user can watch every draft and score arrive live in `jev-score ui`. Never edit the database directly.

## The loop

1. **Set up once.** Check `jev-score workspace list` and `jev-score group list` before creating anything. For a new workspace, start from a template unless the user has their own questions: `jev-score group templates` lists them.
2. **Save and score the original first.** The first draft in a workspace becomes the original, the baseline for every comparison.
3. **Read the feedback.** `score` returns `overallScore`, `rank`, `vsParent`, `vsBest`, per-question `scores`, and the three `weakest` questions. Every delta is signed so that positive means better, including for lower-is-better questions.
4. **Revise boldly.** Make one substantive revision aimed at the weakest questions: restructure, add concrete evidence, cut what doesn't serve the reader. Small word swaps move scores by less than Jev's run-to-run variation (one or two points) and teach you nothing.
5. **Save and score the revision** with a short title, a one-line `--summary` of what changed, and `--parent` set to the draft you revised.
6. **Repeat** from the best draft. Stop when the user's goal is met or two or three bold revisions in a row fail to beat the best.

Score each draft once. Use `--runs 3` only to decide between the top two drafts when they are within about two points, then compare medians (`jev-score rank <ws> --mode median`). Always preserve the user's facts and voice: never invent experience, numbers, or claims.

## CLI

Set up:

```bash
jev-score group templates
jev-score workspace create --name "Acme role" --context ./job.md --template resume
# or, with your own questions (one per line; prefix [lower] when lower is better):
jev-score group create --name "Acme review" --questions ./questions.txt
jev-score workspace create --name "Acme role" --context ./job.md --context-title "Job posting" --group "Acme review"
```

Score a file directly; Jev Score saves it before scoring:

```bash
jev-score score "Acme role" ./resume.md --title "Original resume" --json
jev-score score "Acme role" ./resume-v2.md --title "Outcome-first" --summary "Led every bullet with a result" --parent "#0" --json
```

Reference drafts by ID, title, or version number (`"#3"`). Version numbers are never reused.

Compare and inspect:

```bash
jev-score rank "Acme role" --json
jev-score rank "Acme role" --question evidence --json       # keys: jev-score group show <group>
jev-score document get "Acme role" "#4" --out ./restored.md
jev-score score "Acme role" "#4" --runs 3 --json            # tie-breaks only
```

Share results:

```bash
jev-score report "Acme role" --out ./report.md    # or .html
jev-score ui                                      # open the app
```

Run `jev-score --help` for every command and `jev-score doctor` if scoring fails.

## Rules worth knowing

- **Questions lock after the first scored run.** Names and descriptions can always change. To change questions afterwards, fork the group (`jev-score group fork <group>`) and attach the fork.
- **Changing the context marks older runs stale.** `jev-score workspace context <ws> --file <file>` keeps every run, but rankings only count runs scored against the current context. Re-score the drafts that matter.
- **A spend limit may be set.** If scoring fails with "Spend limit reached", stop and tell the user; do not try to raise or reset it yourself.
- **Custom scorer files** export one synchronous default function that receives `{ question_key: score }` and returns 0 to 100. It replaces the direction-aware mean, so it must invert lower-is-better questions itself. Treat scorer files as trusted local code.

## Credentials and data

Keep `OPENROUTER_API_KEY` in `.env.local` or the environment. Never put credentials in drafts, contexts, notes, logs, or commits. Drafts and contexts are stored locally and sent to OpenRouter only when a draft is scored.
