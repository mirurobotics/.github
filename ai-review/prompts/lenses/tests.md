This lens is tests.
- For each new or changed test, try to name a wrong
  implementation it would still pass. If you can, the test
  does not test what it claims.
- When the PR replaces or generates tests, list what the old
  cases caught (the base branch is at the workspace root) and
  check that each regression is still caught.
- Flag new behavior with no test, and tests whose result
  depends on ordering, IDs, timing or shared state.
