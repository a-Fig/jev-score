// Question keys are shown by `jev-score group show <group>`.
// Jev Score snapshots this source when the group is created.
export default function score(scores) {
  return (
    scores.role_fit * 0.5 +
    scores.clarity * 0.3 +
    (100 - scores.red_flags) * 0.2
  );
}
