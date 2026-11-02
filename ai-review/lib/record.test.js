const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { record, pending, designBody, verdictBody, angleNames } = require('./record.js')

const SHA = 'f'.repeat(40)
const URL = 'https://github.com/o/r/actions/runs/1'

test('verdictBody lists blocking findings only when there are some', () => {
  assert.equal(
    verdictBody({ sha: SHA, verdict: 'approve', summary: 'Fine.', findings: [], url: URL }),
    `### AI review: approve for \`fffffff\`\n\nFine.\n\n[Review run](${URL})\n<!-- ai-review sha=${SHA} -->`
  )
  assert.equal(
    verdictBody({ sha: SHA, verdict: 'request_changes', summary: 'No.', findings: [{ file: 'a.go', line: 0, description: 'x' }, { file: 'b.go', description: 'y' }], url: URL }),
    `### AI review: request changes for \`fffffff\`\n\nNo.\n\n**Blocking findings**\n\n- \`a.go:0\`: x\n- \`b.go\`: y\n\n[Review run](${URL})\n<!-- ai-review sha=${SHA} -->`
  )
})

test('designBody ends with the advisory footer', () => {
  assert.match(designBody({ sha: SHA, summary: 'S.', url: URL }), /^### AI design review: `fffffff`\n\nS\.\n\nAdvisory: .*\n\n\[Review run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)$/)
})

test('angleNames strips paths and extensions, then sorts and dedupes', () => {
  assert.deepEqual(angleNames(['quality.md', './ai-review-context/angles/correctness.md', 'safety', 'quality']), ['correctness', 'quality', 'safety'])
})

// Runs record with a fake Octokit; angles are the angle files the run wrote.
async function runRecord ({ phase = 'cleanup', result, angles = ['review'], commentId = '7', updateFails = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-'))
  fs.mkdirSync(path.join(root, 'ai-review-context', 'angles'), { recursive: true })
  for (const a of angles) fs.writeFileSync(path.join(root, 'ai-review-context', 'angles', `${a}.md`), '')
  const calls = []
  const call = (name, fail) => async (args) => { calls.push([name, args]); if (fail) throw new Error(name) }
  const github = {
    rest: {
      repos: { createCommitStatus: call('status') },
      issues: { updateComment: call('update', updateFails), createComment: call('create') }
    }
  }
  const failed = []
  const core = { setFailed: (m) => failed.push(m), warning: () => {} }
  const env = {
    PHASE: phase, SHA, PR_NUMBER: '5', STATUS_CONTEXT: 'ai-review', RESULT: typeof result === 'string' ? result : JSON.stringify(result),
    COMMENT_ID: commentId, GITHUB_WORKSPACE: root,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1'
  }
  let error = null
  try {
    await record({ github, context: { repo: { owner: 'o', repo: 'r' } }, core, env })
  } catch (err) {
    error = err
  }
  const statuses = calls.filter(([n]) => n === 'status').map(([, a]) => a.state)
  return { calls, statuses, failed, error }
}

const approve = { verdict: 'approve', summary: 'ok', blocking_findings: [], angles: ['review'] }

test('an approval edits the summary and sets success', async () => {
  const { calls, statuses, failed, error } = await runRecord({ result: approve })
  assert.equal(error, null)
  assert.deepEqual(statuses, ['success'])
  assert.deepEqual(calls.map(([n]) => n), ['update', 'status'])
  assert.equal(calls[0][1].comment_id, 7)
  assert.deepEqual(failed, [])
})

test('blocking findings set failure and fail the step', async () => {
  const { statuses, failed } = await runRecord({ result: { ...approve, verdict: 'request_changes' } })
  assert.deepEqual(statuses, ['failure'])
  assert.deepEqual(failed, ['Claude found blocking issues'])
})

test('a new summary is posted when there is none or the edit fails', async () => {
  for (const opts of [{ commentId: '' }, { updateFails: true }]) {
    const { calls } = await runRecord({ result: approve, ...opts })
    assert.equal(calls.filter(([n]) => n === 'create').length, 1)
  }
})

test('a missing verdict, bad JSON or missing angle sets error', async () => {
  for (const opts of [
    { result: '' },
    { result: 'not json' },
    { result: { ...approve, verdict: 'maybe' } },
    { result: { ...approve, angles: [] } },
    { result: approve, angles: ['correctness', 'safety'] },
    { result: approve, angles: [] }
  ]) {
    const { statuses, error } = await runRecord(opts)
    assert.deepEqual(statuses, ['error'], JSON.stringify(opts))
    assert.ok(error)
  }
})

test('a design review posts its summary and sets no status', async () => {
  const { calls, error } = await runRecord({ phase: 'design', result: { summary: 'S' } })
  assert.equal(error, null)
  assert.deepEqual(calls.map(([n]) => n), ['update'])
})

test('a design review with no summary fails without a status', async () => {
  const { statuses, error } = await runRecord({ phase: 'design', result: {} })
  assert.deepEqual(statuses, [])
  assert.match(error.message, /no summary/)
})

test('pending sets the pending status on the head', async () => {
  const calls = []
  await pending({
    github: { rest: { repos: { createCommitStatus: async (a) => calls.push(a) } } },
    context: { repo: { owner: 'o', repo: 'r' } },
    env: { SHA, STATUS_CONTEXT: 'ai-review', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' }
  })
  assert.deepEqual(calls, [{ owner: 'o', repo: 'r', sha: SHA, state: 'pending', context: 'ai-review', description: 'Claude is reviewing this commit', target_url: URL }])
})
