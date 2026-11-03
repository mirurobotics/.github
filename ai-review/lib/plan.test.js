const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { plan, reviewers, claudeArgs, PHASES } = require('./plan.js')

test('reviewers: up to 100 reviewed lines get one reviewer', () => {
  assert.deepEqual(reviewers({ total: 50, lines: 50, tests: false }), { review: ['correctness', 'contracts', 'security'] })
  assert.deepEqual(reviewers({ total: 100, lines: 100, tests: false }), { review: ['correctness', 'contracts', 'security'] })
  assert.deepEqual(reviewers({ total: 50, lines: 50, tests: true }), { review: ['correctness', 'contracts', 'security', 'tests'] })
  // A small delta on a large PR keeps the large PR's lenses.
  assert.deepEqual(reviewers({ total: 500, lines: 20, tests: false }), {
    review: ['correctness', 'contracts', 'security', 'reliability', 'tests', 'documentation', 'questions']
  })
})

test('reviewers: more than 100 reviewed lines get three', () => {
  assert.deepEqual(reviewers({ total: 150, lines: 150, tests: false }), {
    correctness: ['correctness', 'contracts'], safety: ['security', 'reliability'], quality: ['tests']
  })
  assert.deepEqual(reviewers({ total: 400, lines: 400, tests: false }).quality, ['tests'])
  assert.deepEqual(reviewers({ total: 401, lines: 401, tests: false }).quality, ['tests', 'documentation', 'questions'])
  // A delta can outgrow the PR after a base merge; quality then has no lenses.
  assert.deepEqual(reviewers({ total: 80, lines: 150, tests: false }), { correctness: ['correctness', 'contracts'], safety: ['security'] })
})

test('claudeArgs quotes each phase\'s JSON safely', () => {
  for (const phase of Object.keys(PHASES)) {
    for (const value of [PHASES[phase].agents, PHASES[phase].schema].filter(Boolean)) {
      assert.ok(!JSON.stringify(value).includes("'"), `${phase} JSON must not contain a single quote`)
    }
  }
  assert.match(claudeArgs('review'), /^--max-turns 150\n--agents '\{"reviewer":/)
  assert.doesNotMatch(claudeArgs('design'), /--agents/)
  assert.match(claudeArgs('design'), /--disallowedTools "[^"]*,Agent,Task"/)
})

function runPlan (phase, files, delta = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'))
  const outputs = {}
  plan({ core: { setOutput: (k, v) => { outputs[k] = v }, info: () => {} }, files, delta, env: { PHASE: phase, GITHUB_WORKSPACE: root } })
  const dir = path.join(root, 'ai-review-context')
  const read = (p) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : null)
  return { outputs, read }
}

const file = (filename, lines, over = {}) => ({ filename, additions: lines, deletions: 0, ...over })

test('plan writes the reviewers\' instructions for the required review', () => {
  const { outputs, read } = runPlan('review', [file('src/a.go', 60), file('src/a_test.go', 10)])
  assert.equal(outputs.prompt, fs.readFileSync(path.join(__dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\n$/, ''))
  assert.equal(outputs.claude_args, claudeArgs('review'))
  assert.equal(read('angles/review.md'), [
    'Your angle covers these lenses. Read each file and review from all of them:',
    ...['correctness', 'contracts', 'security', 'tests'].map((l) => `- ./ai-review-context/lenses/${l}.md`)
  ].join('\n') + '\n')
  assert.ok(read('reviewer.md'))
  assert.ok(read('lenses/questions.md'))
})

test('plan sizes later rounds by the delta and spots renamed test files', () => {
  const delta = { diff: '', files: [file('a', 100, { deletions: 20 })] }
  const { read } = runPlan('review', [file('src/b.go', 30, { previous_filename: 'tests/b.go' })], delta)
  assert.match(read('angles/correctness.md'), /correctness\.md\n- .*contracts\.md\n$/)
  assert.match(read('angles/quality.md'), /tests\.md\n$/)
})

test('plan writes no reviewers for a design review', () => {
  const { outputs, read } = runPlan('design', [file('a', 1)])
  assert.equal(outputs.claude_args, claudeArgs('design'))
  assert.equal(read('angles/review.md'), null)
  assert.equal(outputs.prompt, fs.readFileSync(path.join(__dirname, '..', 'prompts', 'design.md'), 'utf8').replace(/\n$/, ''))
})
