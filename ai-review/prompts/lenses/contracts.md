This lens is how the change fits the rest of the system.
- Skills, prompts, CLAUDE.md, AGENTS.md and workflow files
  are programs that agents run. Walk each changed step as the
  agent would, including the no-auth, no-CI, capped and retry
  paths. A step an agent can't complete, one that contradicts
  another skill, or frontmatter that doesn't parse is a bug.
- For code, find every caller, config, migration, API spec
  and doc that depends on what changed, including files the
  PR doesn't touch, and check each still holds.
- Flag changes to CI, deploy config, access control or data
  retention that a reviewer should notice.
