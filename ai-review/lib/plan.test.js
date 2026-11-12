const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { plan, reviewers, claudeArgs, addFindings, angleNames, SESSIONS } = require('./plan.js')

const design = ['design']

test('reviewers: up to 100 reviewed lines get one reviewer, plus design', () => {
  assert.deepEqual(reviewers({ total: 50, lines: 50, tests: false }), { review: ['correctness', 'contracts', 'security'], design })
  assert.deepEqual(reviewers({ total: 100, lines: 100, tests: false }), { review: ['correctness', 'contracts', 'security'], design })
  assert.deepEqual(reviewers({ total: 50, lines: 50, tests: true }), { review: ['correctness', 'contracts', 'security', 'tests'], design })
  // A small delta on a large PR keeps the large PR's lenses.
  assert.deepEqual(reviewers({ total: 500, lines: 20, tests: false }), {
    review: ['correctness', 'contracts', 'security', 'reliability', 'tests', 'documentation', 'questions'], design
  })
})

test('reviewers: more than 100 reviewed lines get three, plus design', () => {
  assert.deepEqual(reviewers({ total: 150, lines: 150, tests: false }), {
    correctness: ['correctness', 'contracts'], safety: ['security', 'reliability'], quality: ['tests'], design
  })
  assert.deepEqual(reviewers({ total: 400, lines: 400, tests: false }).quality, ['tests'])
  assert.deepEqual(reviewers({ total: 401, lines: 401, tests: false }).quality, ['tests', 'documentation', 'questions'])
  // A delta can outgrow the PR after a base merge; quality then has no lenses.
  assert.deepEqual(reviewers({ total: 80, lines: 150, tests: false }), { correctness: ['correctness', 'contracts'], safety: ['security'], design })
})

test('claudeArgs quotes each session\'s JSON safely', () => {
  for (const session of Object.keys(SESSIONS)) {
    for (const value of [SESSIONS[session].agents, SESSIONS[session].schema].filter(Boolean)) {
      assert.ok(!JSON.stringify(value).includes("'"), `${session} JSON must not contain a single quote`)
    }
  }
  assert.match(claudeArgs('reviewers'), /^--max-turns 50\n--agents '\{"reviewer":/)
  assert.doesNotMatch(claudeArgs('reviewers'), /inline_comment/)
  for (const session of ['review', 'design']) {
    assert.doesNotMatch(claudeArgs(session), /--agents/)
    assert.match(claudeArgs(session), /--disallowedTools "[^"]*,Agent,Task"/)
  }
})

function runPlan (phase, files, delta = null, session = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'))
  const outputs = {}
  plan({ core: { setOutput: (k, v) => { outputs[k] = v }, info: () => {} }, files, delta, env: { PHASE: phase, SESSION: session, GITHUB_WORKSPACE: root } })
  const dir = path.join(root, 'ai-review-context')
  const read = (p) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : null)
  return { root, outputs, read }
}

const prompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'prompts', name), 'utf8').replace(/\n$/, '')

const file = (filename, lines, over = {}) => ({ filename, additions: lines, deletions: 0, ...over })

test('plan writes the reviewers\' instructions for the required review', () => {
  const { outputs, read } = runPlan('review', [file('src/a.go', 60), file('src/a_test.go', 10)])
  assert.equal(outputs.prompt, prompt('review.md'))
  assert.equal(outputs.claude_args, claudeArgs('review'))
  assert.equal(read('angles/review.md'), [
    'Your angle covers these lenses. Read each file and review from all of them:',
    ...['correctness', 'contracts', 'security', 'tests'].map((l) => `- ./ai-review-context/lenses/${l}.md`)
  ].join('\n') + '\n')
  assert.ok(read('reviewer.md'))
  assert.ok(read('lenses/questions.md'))
  assert.match(read('angles/design.md'), /lenses\/design\.md\n$/)
})

test('plan leaves plans out of the PR\'s size', () => {
  const { read } = runPlan('review', [file('src/a.go', 50), file('plans/active/20261105-a.md', 300)])
  assert.equal(read('angles/correctness.md'), null)
  assert.match(read('angles/review.md'), /security\.md\n$/)
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
  assert.ok(read('lenses/design.md'))
  assert.equal(outputs.prompt, prompt('design.md'))
})

test('SESSION picks the reviewers\' session and keeps the review\'s reviewers', () => {
  const { outputs, read } = runPlan('review', [file('src/a.go', 60)], null, 'reviewers')
  assert.equal(outputs.prompt, prompt('reviewers.md'))
  assert.equal(outputs.claude_args, claudeArgs('reviewers'))
  assert.ok(read('angles/review.md'))
})

test('angleNames strips paths and extensions, then sorts and dedupes', () => {
  assert.deepEqual(angleNames(['quality.md', './ai-review-context/angles/correctness.md', 'safety', 'quality']), ['correctness', 'quality', 'safety'])
})

// Plans a 150-line review (angles correctness, safety, quality and
// design), then adds the given findings.
function runAddFindings (claude, openai = '') {
  const { root, read } = runPlan('review', [file('src/a.go', 150)])
  const env = { GITHUB_WORKSPACE: root, CLAUDE_FINDINGS: typeof claude === 'string' ? claude : JSON.stringify(claude), OPENAI_FINDINGS: openai }
  let error = null
  try {
    addFindings({ env })
  } catch (err) {
    error = err
  }
  return { error, read }
}

const review = (angle) => ({ angle, findings: [{ file: 'src/a.go', line: 1, severity: 'nit', description: angle }] })
const allReviews = { reviews: ['quality', 'correctness', 'safety', 'design'].map(review) }

test('addFindings writes both reviewers\' findings', () => {
  const { error, read } = runAddFindings(allReviews, '[{"file": "src/a.go"}]')
  assert.equal(error, null)
  assert.deepEqual(JSON.parse(read('findings/claude.json')), allReviews.reviews)
  assert.equal(read('findings/openai.json'), '[{"file": "src/a.go"}]\n')
})

test('addFindings needs no OpenAI findings', () => {
  const { error, read } = runAddFindings(allReviews)
  assert.equal(error, null)
  assert.equal(read('findings/openai.json'), null)
})

test('addFindings fails when a Claude reviewer\'s findings are missing', () => {
  for (const claude of ['', 'not json', 'null', {}, { reviews: [] }, { reviews: allReviews.reviews.slice(1) }, { reviews: [...allReviews.reviews, review('extra')] }]) {
    const { error, read } = runAddFindings(claude)
    assert.match(error?.message ?? '', /don't match the angles run \(correctness,design,quality,safety\)/, JSON.stringify(claude))
    assert.equal(read('findings/claude.json'), null)
  }
})
