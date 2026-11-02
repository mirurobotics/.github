This lens is the six review questions. Ask them of each new
or changed file, function, field, helper and test:
1. Do we need this? Would deleting it break a requirement of this PR?
2. Why is this optional? Is it a parameter every caller passes, or a field that always exists?
3. What does the closest sibling do? Match its layout, harness and tests.
4. Is it in the right layer and file (ARCHITECTURE.md), or does a shared helper already exist?
5. Does the name say exactly what it does, with one name per concept and no clash with an existing meaning?
6. Is each comment short, and will it stay true?
For question 3, find the closest existing sibling in
./pr-head and compare folder layout, file split, harnesses
and test set. If the PR description has a Precedent table,
check that each new file really mirrors the file it names.
For question 4, look in core, shared packages and siblings
for code the PR re-implements. If
./miru-internal/skills/self-review/references/examples.md
exists, it holds real maintainer comments grouped by
question: use them to calibrate what is worth raising.
Report a question only where you have checked the answer and
it would change the code, as severity "nit", naming the
question and what you found (for example the sibling's path
and how it differs). The PR description may end with a
"## Reviewer notes" section of bullets like
"- Q2 `path/file.go:42`: why it stays optional". Skip a
question that a note already answers for that spot, unless
the code changed so the note no longer holds.
