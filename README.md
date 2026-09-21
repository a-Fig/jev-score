# Jev Score

[![CI](https://github.com/a-Fig/jev-score/actions/workflows/ci.yml/badge.svg)](https://github.com/a-Fig/jev-score/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/a-Fig/jev-score)](https://github.com/a-Fig/jev-score/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-339933)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Give your coding agent a scoreboard

Give Claude three files: your resume, the job posting, and an evaluation group you wrote. The group is a plain-text list of the questions you want every draft to answer:

```text
This resume is a strong fit for the job
This resume would land an interview
This resume would pass an ATS scan
This resume is clean and easy to scan
[lower] This resume has obvious red flags
This resume is at the right seniority level for the role
```

Claude rewrites the resume. Jev scores it against the job posting and those questions. Claude uses the weak scores as its next edit brief, then repeats.

```text
agent> Rewrote the resume.
you>   Better?
jev>   Evidence 76.0 -> 99.3. Authenticity 77.8 -> 96.3.
```

**Jev Score is a test suite for writing.** Your coding agent handles the edits; [TypeSafe's Jev model](https://www.typesafe.ai/) evaluates through OpenRouter; a local SQLite database keeps every draft and run.

The same loop works for an essay against its prompt, a spec against requirements, or a landing page against its positioning.

![Jev Score workspace showing a progress chart, current leader, and per-question scores for three README drafts](./docs/assets/workspace.png)

**Jump to:** [Install](#install) · [First score](#your-first-score) · [Concepts](#the-five-parts) · [Agent loop](#the-agent-loop) · [Limits](#data-privacy-and-limits)

## This README is one of the test subjects

The screenshot is a real Jev Score workspace containing three revisions of this README and fourteen evaluations. The "Open-source README quality" group asked whether each draft was engaging, clear within ten seconds, easy to use, and honest about its limits.

| Draft | Overall | Engaging? | Clear in 10s? |
| --- | ---: | ---: | ---: |
| [Original README](https://github.com/a-Fig/jev-score/blob/733cd5b6cdf2ed3125e39d434f4c1d570efb031d/README.md) | 85.5 | 75.5 | 90.3 |
| Benefit-led rewrite | 92.1 | 82.0 | 93.3 |
| Visual quick start | 92.7 | 81.3 | 93.8 |

One rewrite scored worse and remains in the chart. Regressions belong in the history too.

## Install

You need Node.js 22.13 or newer and an OpenRouter API key with access to Jev. There are no runtime dependencies.

```bash
git clone https://github.com/a-Fig/jev-score.git
cd jev-score
npm install --global .
cp .env.example .env.local      # PowerShell: Copy-Item .env.example .env.local
```

The global install links to this checkout, so keep the folder in place. Add your key to `.env.local`:

```dotenv
OPENROUTER_API_KEY=your_key_here
OPENROUTER_JEV_MODEL=typesafe/jev-1.13
```

`.env.local` is read from the directory where you run `jev-score`. Set `OPENROUTER_API_KEY` in your shell instead if you want to score from other directories.

## Your first score

Run these commands from the repository so the example paths resolve:

```bash
# 1. Define what a good resume means
jev-score group create --name "Resume review" \
  --questions ./examples/resume/questions.txt

# 2. Create a workspace around the job posting
jev-score workspace create --name "Product writer" \
  --context ./examples/resume/job-posting.md \
  --context-title "Job posting" \
  --group "Resume review"

# 3. Store and score the resume
jev-score score "Product writer" ./examples/resume/resume.md \
  --title "Original resume"
```

The third command prints JSON. This is a real run, trimmed to three questions:

```json
{
  "documentTitle": "Original resume",
  "status": "success",
  "overallScore": 83.2,
  "scores": [
    { "text": "Does the resume demonstrate strong fit for the role?", "score": 89.5 },
    { "text": "Does the resume use specific, credible evidence?", "score": 76 },
    { "text": "Does the resume feel authentic?", "score": 77.8 }
  ]
}
```

Evidence and authenticity are the next edit brief.

## The five parts

| Part | What it means | Resume example |
| --- | --- | --- |
| **Context** | The source the writing must satisfy | A job posting |
| **Evaluation group** | Reusable questions that define quality | Fit, evidence, authenticity |
| **Document** | One unique stored draft | Original or revised resume |
| **Run** | One probabilistic evaluation | Per-question and overall scores |
| **Workspace** | The context, drafts, groups, and run history | The full application effort |

The first document in a workspace becomes version `#0`. Later drafts can record a title, change summary, and parent. Identical content is stored once, while each evaluation remains a separate run.

Questions receive normalized scores from 0 to 100. Higher is better by default. Prefix a plain-text question with `[lower]` for the opposite direction:

```text
Does the document support important claims with specific evidence?
Is it easy to scan without losing essential detail?
[lower] Does it contain unsupported hype or vague superlatives?
```

A raw score of 8 on the last question contributes 92 to the default direction-aware mean. Questions and scorer code lock after a group's first run so historical results remain comparable. Create a new group when the rubric changes.

## The agent loop

Your agent stores one coherent revision, evaluates it, and uses the weakest questions as the next edit brief.

```bash
jev-score document add "Product writer" ./resume-v2.md \
  --title "Quantified outcomes" \
  --summary "Added measured outcomes and provenance" \
  --parent "Original resume"

jev-score score "Product writer" "Quantified outcomes" --note "run 1"
jev-score rank "Product writer"
```

Rank by one question when the aggregate hides the problem:

```bash
jev-score group show "Resume review"   # lists stable question keys
jev-score rank "Product writer" \
  --question does-the-resume-feel-authentic
```

On the bundled example, three runs of the targeted revision produced a 96.6 median, a 0.2-point spread, and a 13.2-point gain over the original. Evidence moved from 76 to 99.3; authenticity moved from 77.8 to 96.3.

Jev is probabilistic. `max` mode ranks each document by its best observed run. `median` favors repeatable results:

```bash
jev-score score "Product writer" "Quantified outcomes" --note "run 2"
jev-score score "Product writer" "Quantified outcomes" --note "run 3"
jev-score workspace mode "Product writer" median
jev-score rank "Product writer"
```

A one-point lead with a five-point spread is weak evidence.

## One database, two views

Every data command prints JSON for agents. The browser reads the same SQLite database and adds the chart, score matrix, rendered documents, and side-by-side or line-diff comparison.

```bash
jev-score ui                     # opens http://127.0.0.1:4317
jev-score ui --port 4400         # choose another port
jev-score serve                  # run without opening a browser
```

The repository also ships an [agent skill](./.agents/skills/jev-score/SKILL.md) that teaches the create, evaluate, inspect, and revise workflow.

## Data, privacy, and limits

- **Storage is local.** Workspaces, documents, questions, scores, and usage records live in SQLite. `jev-score db path` prints the location; `JEV_SCORE_DB` and `JEV_SCORE_DATA_DIR` can move it.
- **Evaluation is remote.** The document, workspace context, and questions go to OpenRouter when you score. Keep secrets out of all three.
- **The app is single-user.** It binds to `127.0.0.1`, has no authentication or hosted mode, and is readable by anyone with access to your OS account.
- **Input is text or Markdown.** Convert PDF and Word files first.
- **Custom scorers are trusted code.** They run in a short-lived worker with a timeout, not a security sandbox. See [custom scorers](./docs/custom-scorers.md).
- **Deletion is permanent.** `workspace delete --yes`, `group delete --yes`, and `db reset --yes` remove the selected data.
- **The project is independent.** Jev Score is not affiliated with TypeSafe or OpenRouter.

## Reference

```text
jev-score workspace create|list|show|delete|primary|mode
jev-score group create|list|show|rename|delete|attach
jev-score document add|list|get
jev-score score <workspace> <document-or-file>
jev-score rank <workspace>
jev-score usage
jev-score ui | serve
jev-score db path|reset
```

Run `jev-score --help` for every option. Names and IDs both work as references.

For development, run `npm test` and `npm run pack:check`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and [SECURITY.md](./SECURITY.md) for private vulnerability reporting. Jev Score is available under the [MIT License](./LICENSE).
