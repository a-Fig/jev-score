# Custom overall scorers

An evaluation group normally computes a direction-aware mean of its normalized 0–100 question scores. Higher-is-better scores are used directly; lower-is-better scores become `100 - score` before averaging. A custom scorer lets a group use weights or apply another small formula.

Create a JavaScript module with one default function:

```js
export default function score(scores) {
  return scores.fit * 0.7 + (100 - scores.red_flags) * 0.3;
}
```

`scores` maps each stable question key to its raw normalized 0–100 value. The function must return a finite number from 0 through 100 synchronously. It cannot accept additional arguments. A custom scorer replaces the automatic direction-aware mean, so invert lower-is-better values in the formula when needed.

Pass the file when the group is created:

```bash
jev-score group create \
  --name "Hiring review" \
  --questions ./questions.json \
  --scorer ./scorer.mjs
```

Jev Score stores the source and SHA-256 hash with the group. It executes the function in a short-lived Node worker with a three-second timeout. This protects the app from accidental infinite loops; it is not a security sandbox, so only use scorer code you trust.

Questions and scorer code become immutable after the group's first evaluation. If the scorer throws, times out, or returns an invalid value, the run keeps its individual Jev scores with an `aggregation_error` status and is excluded from overall rankings. Create a new group to change the formula.
