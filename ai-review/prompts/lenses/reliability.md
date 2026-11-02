This lens is reliability (the reliability skill, if
available): what happens when things fail or run long.
- Error handling: errors swallowed, retried forever, or
  retried when they can't succeed.
- Resource lifecycle: files, connections, goroutines, tasks
  and locks that leak or are never cleaned up, and cleanup
  that is skipped on the error path.
- Timeouts, cancellation, backoff and crash recovery: work
  that can hang, double-run or lose data after a restart, and
  queues or retries that one bad item can block.
