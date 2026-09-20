---
name: jev-score
description: Store, evaluate, and compare text or Markdown revisions against context and reusable criteria with Jev through OpenRouter. Use for iterative work on resumes, essays, specifications, cover letters, webpages, and similar documents. The coding agent owns editing and iteration; Jev Score is the system of record and evaluator.
---

# Jev Score

Use the CLI as the agent interface. It prints JSON and shares its SQLite database with the localhost UI. Do not edit the database directly.

## General workflow

1. Reuse a suitable evaluation group from `jev-score group list`, or create one. Phrase questions clearly and label each one as higher-is-better or lower-is-better. Higher is the default; prefix a plain-text question with `[lower]` when lower is better.
2. Reuse or create a context-centered workspace. Attach the group and make it primary.
3. Save the original document first. The first document in a workspace is marked original automatically.
4. Ask Jev Score to evaluate it. Read individual question scores as well as the overall score.
5. Make one coherent revision, save it with a short change summary and parent, then evaluate it.
6. Use `rank` to compare revisions. Stop based on the user's goal and judgment; Jev Score does not edit or decide when to stop.
7. Run `jev-score ui` when the user wants to inspect progress or work in the interface.

Repeated evaluations of identical content create separate runs but not duplicate documents. Rankings default to the best observed score: highest for higher-is-better metrics and lowest for lower-is-better metrics. Use median mode when the user wants repeated-run stability. Always preserve meaningful user facts and voice while editing.

## CLI

Inspect available state before creating duplicates:

```bash
jev-score group list
jev-score workspace list
```

Create a group and workspace:

```bash
jev-score group create --name "Resume review" --questions ./questions.txt
jev-score workspace create --name "Acme role" --context ./job.md --context-title "Job posting" --group "Resume review"
```

Score a file directly. Jev Score stores it before calling the API:

```bash
jev-score score "Acme role" ./resume.md --title "Original resume"
```

Save and score later revisions:

```bash
jev-score document add "Acme role" ./resume-v2.md --title "Outcome-focused" --summary "Quantified recent work" --parent "Original resume"
jev-score score "Acme role" "Outcome-focused" --note "iteration 2"
```

Compare documents overall or by one question key:

```bash
jev-score rank "Acme role"
jev-score rank "Acme role" --question strong-fit
jev-score workspace mode "Acme role" median
```

Retrieve a stored draft or open the UI:

```bash
jev-score document get "Acme role" "Outcome-focused" --out ./restored.md
jev-score ui
```

Run `jev-score --help` for the complete command list. Names and IDs are accepted as references.

## Evaluation group rules

Questions and custom scorer code are immutable after a group's first run. Rename is allowed. Deleting a group deletes every run and score created with it. Create a new group when criteria or scorer behavior must change.

Custom scorer files export one synchronous default function that receives raw `{ question_key: normalizedScore }` values and returns a finite 0–100 number. A custom scorer replaces the automatic direction-aware mean, so its code must invert lower-is-better inputs when desired. Treat scorer files as trusted local code.

## Credentials and data

Keep `OPENROUTER_API_KEY` in `.env.local` or the environment. Never put credentials in documents, contexts, evaluation metadata, logs, or source control. Documents and context are stored locally and sent to OpenRouter only when an evaluation runs.
