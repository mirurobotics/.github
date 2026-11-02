This lens is correctness: logic errors, broken edge cases,
regressions and concurrency bugs in the code the PR changes.
- For each changed function, open what it calls and what
  calls it, including files the PR doesn't touch, and check
  the change still fits them: defaults, preconditions,
  ordering, shared state.
- Walk the edge paths: empty and very large inputs,
  pagination limits, non-ASCII text, events that arrive while
  other work is in flight.
