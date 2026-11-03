const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, renderThreads, renderConversation, findSummary, quote } = require('./collect.js')

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const BASE = 'd'.repeat(40)
const MERGE_BASE = 'e'.repeat(40)

test('quote prefixes every line and leaves an empty body empty', () => {
  assert.equal(quote('one\ntwo'), '> one\n> two')
  assert.equal(quote(''), '')
  assert.equal(quote(null), '')
})

const comment = (over) => ({
  path: 'f.go', line: 3, original_line: 3, original_commit_id: SHA_A, subject_type: 'line',
  user: { login: 'alice' }, author_association: 'MEMBER', body: 'hi', ...over
})

test('renderThreads groups replies under the oldest thread first', () => {
  const md = renderThreads([
    comment({ id: 20, created_at: '2026-01-02T00:00:00Z', body: 'second thread' }),
    comment({ id: 10, created_at: '2026-01-01T00:00:00Z', line: null, original_line: 7, body: 'first\nthread' }),
    comment({ id: 11, in_reply_to_id: 10, created_at: '2026-01-03T00:00:00Z', user: { login: 'bob' }, body: 'reply' }),
    comment({ id: 30, created_at: '2026-01-04T00:00:00Z', subject_type: 'file', body: '' })
  ], { 10: true })
  assert.equal(md, [
    `## f.go:7 (outdated) (resolved) at aaaaaaa\n\n**alice** (MEMBER, 2026-01-01T00:00:00Z):\n\n> first\n> thread\n\n**bob** (MEMBER, 2026-01-03T00:00:00Z):\n\n> reply\n\n`,
    `## f.go:3 at aaaaaaa\n\n**alice** (MEMBER, 2026-01-02T00:00:00Z):\n\n> second thread\n\n`,
    `## f.go (file comment) at aaaaaaa\n\n**alice** (MEMBER, 2026-01-04T00:00:00Z):\n\n\n\n`
  ].join(''))
})

test('renderConversation quotes each comment, including a deleted account\'s', () => {
  assert.equal(
    renderConversation([
      { user: { login: 'bob' }, author_association: 'NONE', created_at: 't', body: 'x\ny' },
      { user: null, author_association: 'NONE', created_at: 'u', body: 'gone' }
    ]),
    '## bob (NONE, t)\n\n> x\n> y\n\n## null (NONE, u)\n\n> gone\n\n'
  )
})

test('findSummary takes the last bot summary of the phase and its last marker', () => {
  const bot = { login: 'github-actions[bot]' }
  const comments = [
    { id: 1, user: bot, body: `### AI review: old\n<!-- ai-review sha=${SHA_A} -->` },
    { id: 2, user: { login: 'mallory' }, body: `### AI review: fake\n<!-- ai-review sha=${SHA_C} -->` },
    { id: 3, user: bot, body: `### AI review: new\n<!-- ai-review sha=${SHA_C} -->\n<!-- ai-review sha=${SHA_B} -->` },
    { id: 4, user: bot, body: '### AI design review: x' }
  ]
  assert.deepEqual(findSummary(comments, 'review'), { id: '3', lastSha: SHA_B })
  assert.deepEqual(findSummary(comments, 'design'), { id: '4', lastSha: '' })
  assert.deepEqual(findSummary([], 'review'), { id: '', lastSha: '' })
})

// A fake Octokit serving one PR's comments.
function fakeGithub ({ issueComments = [] }) {
  const route = (name) => () => name
  const lists = { listReviewComments: [], listComments: issueComments }
  return {
    rest: { pulls: { listReviewComments: route('listReviewComments') }, issues: { listComments: route('listComments') } },
    paginate: async (fn, args) => lists[fn(args)],
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } })
  }
}

// A fake git over a clone where BASE and SHA_B meet at MERGE_BASE and
// SHA_A is an ancestor of SHA_B unless notAncestor. Diffs name their
// endpoints.
function fakeGit ({ noMergeBase = false, notAncestor = false } = {}) {
  const calls = []
  const git = async (args) => {
    calls.push(args)
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      if (notAncestor) throw new Error('git merge-base failed')
      return ''
    }
    if (args[0] === 'merge-base') {
      if (noMergeBase) throw new Error('git merge-base failed: no merge base')
      return MERGE_BASE + '\n'
    }
    const [from, to] = args.slice(-2)
    return args.includes('--numstat') ? '1\t0\ta\0' : `diff --git a/a b/a\n${from}..${to}\n`
  }
  return { git, calls }
}

async function runCollect ({ phase = 'review', issueComments, ...gitOpts } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-'))
  const outputs = {}
  const core = { setOutput: (k, v) => { outputs[k] = v }, info: () => {} }
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 5, title: 'T', body: null, base: { sha: BASE } } } }
  const { git, calls } = fakeGit(gitOpts)
  const result = await collect({ github: fakeGithub({ issueComments }), context, core, git, env: { PHASE: phase, SHA: SHA_B, GITHUB_WORKSPACE: root } })
  const read = (p) => (fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null)
  return { outputs, read, result, calls }
}

const summary = [{ id: 9, user: { login: 'github-actions[bot]' }, body: `### AI review: approve\n<!-- ai-review sha=${SHA_A} -->` }]
const files = [{ filename: 'a', additions: 1, deletions: 0 }]

test('collect diffs the PR from its merge base, with the base\'s attributes', async () => {
  const { outputs, read, result, calls } = await runCollect()
  assert.equal(read('ai-review-context/pr-description.md'), '# T\n\n\n')
  assert.equal(read('ai-review-context/pr.diff'), `diff --git a/a b/a\n${MERGE_BASE}..${SHA_B}\n`)
  assert.deepEqual(result, { files, delta: null })
  assert.deepEqual(calls[0], ['merge-base', BASE, SHA_B])
  assert.ok(calls.slice(1).every((args) => args[0] === `--attr-source=${MERGE_BASE}`))
  assert.equal(read('ai-review-history/review-threads.md'), '')
  assert.equal(outputs.comment_id, '')
  assert.equal(read('ai-review-context/delta.diff'), null)
})

test('collect fails when git finds no merge base', async () => {
  await assert.rejects(runCollect({ noMergeBase: true }), /no merge base/)
})

test('collect writes the delta since the last reviewed head', async () => {
  const { outputs, read, result, calls } = await runCollect({ issueComments: summary })
  const diff = `diff --git a/a b/a\n${SHA_A}..${SHA_B}\n`
  assert.ok(calls.filter((args) => args[0] !== 'merge-base').every((args) => args[0] === `--attr-source=${MERGE_BASE}`))
  assert.equal(outputs.comment_id, '9')
  assert.deepEqual(result.delta, { diff, files })
  assert.equal(read('ai-review-context/delta.diff'), diff)
  assert.equal(read('ai-review-history/delta.diff'), diff)
})

test('collect reviews the whole PR after a force-push or in design', async () => {
  for (const opts of [{ notAncestor: true }, { phase: 'design' }]) {
    const { read, result } = await runCollect({ issueComments: summary, ...opts })
    assert.equal(result.delta, null, JSON.stringify(opts))
    assert.equal(read('ai-review-context/delta.diff'), null)
  }
})
