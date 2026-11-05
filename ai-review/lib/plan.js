// Plans a review round: the phase's prompt and Claude arguments and, for
// the required review, which reviewers run and which lenses each covers.

const fs = require('fs')
const path = require('path')

const PROMPTS = path.join(__dirname, '..', 'prompts')

// What differs between the phases. Both deny ./.git (the action writes
// github.token into its config), /proc (the session's own key), Bash,
// file edits and web access. Skill is denied because --add-dir can load
// the PR's commands under any skill's name, so reviewers read the
// miru-internal skills as files.
const PHASES = {
  // The required review: a coordinator with read-only reviewer agents.
  review: {
    prompt: 'review.md',
    maxTurns: 150,
    agents: {
      reviewer: {
        description: 'Reviews the PR from one angle and replies with its findings as JSON. Posts nothing.',
        prompt: 'You review one pull request from one angle. First read ./ai-review-context/reviewer.md and follow it. Your task names the file that describes your angle.',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'inherit',
        maxTurns: 100
      }
    },
    allowedTools: 'Read,Grep,Glob,Agent,Task,mcp__github_inline_comment__create_inline_comment',
    disallowedTools: 'Read(./.git/**),Read(//proc/**),Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Skill',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'request_changes'] },
        summary: { type: 'string' },
        blocking_findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { file: { type: 'string' }, line: { type: 'integer' }, description: { type: 'string' } },
            required: ['file', 'description']
          }
        },
        angles: { type: 'array', items: { type: 'string' } }
      },
      required: ['verdict', 'summary', 'blocking_findings', 'angles']
    }
  },
  // Drafts: one session, no sub-agents, posting its own comments.
  design: {
    prompt: 'design.md',
    maxTurns: 100,
    allowedTools: 'Read,Grep,Glob,mcp__github_inline_comment__create_inline_comment',
    disallowedTools: 'Read(./.git/**),Read(//proc/**),Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Skill,Agent,Task',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
  }
}

const TEST_FILE = /(_tests?|_spec|\.test|\.spec|Tests?)\.|(^|\/)(test_|tests?[./]|__tests__\/|spec\/|testdata\/|conftest\.py$)/

// The author's working notes, which don't count toward the PR's size.
const PLAN_FILE = /^plans\//

// Reviewer name -> lenses. The whole PR's size picks the lenses. Up to
// 100 reviewed lines (the delta's, on later rounds) get one reviewer;
// more get three. A design reviewer always runs too.
function reviewers ({ total, lines, tests }) {
  let safety = ['security']
  let quality = []
  if (total > 100) safety = ['security', 'reliability']
  if (total > 100 || tests) quality = ['tests']
  if (total >= 401) quality = ['tests', 'documentation', 'questions']
  const design = ['design']
  if (lines <= 100) return { review: ['correctness', 'contracts', ...safety, ...quality], design }
  return { correctness: ['correctness', 'contracts'], safety, ...(quality.length ? { quality } : {}), design }
}

// The phase's arguments that claude_args adds to the shared ones.
function claudeArgs (phase) {
  const p = PHASES[phase]
  return [
    `--max-turns ${p.maxTurns}`,
    ...(p.agents ? [`--agents '${JSON.stringify(p.agents)}'`] : []),
    `--allowedTools "${p.allowedTools}"`,
    `--disallowedTools "${p.disallowedTools}"`,
    `--json-schema '${JSON.stringify(p.schema)}'`
  ].join('\n')
}

// Copies reviewer.md for the reviewers, and writes each reviewer's
// angle file listing its lenses.
function writeReviewers (dir, plan) {
  fs.mkdirSync(path.join(dir, 'angles'), { recursive: true })
  fs.cpSync(path.join(PROMPTS, 'reviewer.md'), path.join(dir, 'reviewer.md'))
  for (const [name, lenses] of Object.entries(plan)) {
    const list = lenses.map((l) => `- ./ai-review-context/lenses/${l}.md\n`).join('')
    fs.writeFileSync(path.join(dir, 'angles', `${name}.md`), `Your angle covers these lenses. Read each file and review from all of them:\n${list}`)
  }
}

// Sets the prompt and claude_args outputs, copies the lenses, which
// both phases read, and, for the required review, writes the
// reviewers' instructions. files and delta come from collect.
function plan ({ core, files, delta, env = process.env }) {
  const phase = env.PHASE
  const dir = path.join(env.GITHUB_WORKSPACE, 'ai-review-context')
  core.setOutput('prompt', fs.readFileSync(path.join(PROMPTS, PHASES[phase].prompt), 'utf8').replace(/\n$/, ''))
  core.setOutput('claude_args', claudeArgs(phase))
  fs.cpSync(path.join(PROMPTS, 'lenses'), path.join(dir, 'lenses'), { recursive: true })
  if (phase !== 'review') return

  const changed = (list) => list.filter((f) => !PLAN_FILE.test(f.filename)).reduce((n, f) => n + f.additions + f.deletions, 0)
  const total = changed(files)
  const lines = delta === null ? total : changed(delta.files)
  const tests = files.some((f) => [f.filename, f.previous_filename].some((name) => name && TEST_FILE.test(name)))
  core.info(`${total} changed lines, ${lines} to review; test files changed: ${tests}`)
  const chosen = reviewers({ total, lines, tests })
  writeReviewers(dir, chosen)
  core.info(JSON.stringify(chosen))
}

module.exports = { plan, reviewers, claudeArgs, PHASES }
