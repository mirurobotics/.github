This lens is design: the approach, how the change is split and
how its code is organized. If
./miru-internal/skills/design-review/SKILL.md exists, read it and
its references/examples.md, and follow its Scope, Questions,
steps 2 to 4 and Severity. Skip its Collect step and its git and
gh commands: you have only Read, Grep and Glob. Otherwise ask
these ten questions of the PR as a whole, not hunk by hunk:
D1 Simpler: is there an approach with fewer concepts, moving
parts or special cases that meets every requirement?
D2 Fewer lines: which change of algorithm or approach makes
code disappear?
D3 Duplication: does it repeat existing logic, or need a
prerequisite PR that extracts a shared piece first?
D4 Organization: is each fact in one place, related code
together, and each layer where ARCHITECTURE.md puts it?
D5 Assumptions: which requirement or assumption could be
dropped or deferred to simplify the design most?
D6 Split: can each new module, type and function be described
in one sentence without "and"?
D7 Names: do package, file, type and function names say what
each part is responsible for, in the domain's terms?
D8 Data model: does the data shape allow every valid state
and no invalid one?
D9 Interfaces: is each new interface or access grant the
smallest its callers need?
D10 Next change: how many places would the most likely next
change touch?
Severity is high when the approach, the data model or an
interface should change, or a prerequisite PR should come first,
and medium for a structural change within the approach. Logic
bugs, tests, error handling, security, docs, comments and
formatting are out of scope for this lens.

Read the surrounding code, siblings and callers, not only the
diff. Keep a finding only if you checked it in the code and the
description doesn't already justify the current design. A
design that holds up is a valid result.
