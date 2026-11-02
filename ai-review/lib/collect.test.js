const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, renderDiff, renderThreads, renderConversation, findSummary, quote } = require('./collect.js')

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

test('quote prefixes every line and leaves an empty body empty', () => {
  assert.equal(quote('one\ntwo'), '> one\n> two')
  assert.equal(quote(''), '')
  assert.equal(quote(null), '')
})

test('renderDiff writes a header per file and notes missing patches', () => {
  const diff = renderDiff([
    { filename: 'new.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+hi' },
    { filename: 'gone.txt', status: 'removed', patch: '@@ -1 +0,0 @@\n-bye' },
    { filename: 'b.txt', previous_filename: 'a.txt', status: 'renamed' },
    { filename: 'evil\ndiff --git a/x b/x', status: 'modified', patch: '' }
  ])
  assert.equal(diff, [
    'diff --git a/new.txt b/new.txt\nnew file\n@@ -0,0 +1 @@\n+hi\n',
    'diff --git a/gone.txt b/gone.txt\ndeleted file\n@@ -1 +0,0 @@\n-bye\n',
    'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n(no patch from GitHub: binary, only renamed or its mode changed, or too large to diff)\n',
    'diff --git a/evil diff --git a/x b/x b/evil diff --git a/x b/x\n\n'
  ].join(''))
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
  assert.deepEqual(findSummary(comments, 'cleanup'), { id: '3', lastSha: SHA_B })
  assert.deepEqual(findSummary(comments, 'design'), { id: '4', lastSha: '' })
  assert.deepEqual(findSummary([], 'cleanup'), { id: '', lastSha: '' })
})

// A fake Octokit serving one PR. compare is { status, diff } or throws.
function fakeGithub ({ files, changedFiles = files.length, issueComments = [], compare }) {
  const calls = []
  const route = (name) => (args) => { calls.push([name, args]); return name }
  const lists = { listFiles: files, listReviewComments: [], listComments: issueComments }
  return {
    calls,
    rest: {
      pulls: { listFiles: route('listFiles'), listReviewComments: route('listReviewComments'), get: async () => ({ data: { changed_files: changedFiles } }) },
      issues: { listComments: route('listComments') },
      repos: {
        compareCommitsWithBasehead: async () => {
          if (compare instanceof Error) throw compare
          return { data: { status: compare.status } }
        }
      }
    },
    paginate: async (fn, args) => lists[fn(args)],
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }),
    request: async () => ({ data: compare.diff })
  }
}

async function runCollect (opts, phase = 'cleanup') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-'))
  const outputs = {}
  const core = { setOutput: (k, v) => { outputs[k] = v }, info: () => {} }
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 5, title: 'T', body: null } } }
  await collect({ github: fakeGithub(opts), context, core, env: { PHASE: phase, SHA: SHA_B, GITHUB_WORKSPACE: root, RUNNER_TEMP: root } })
  const read = (p) => (fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null)
  return { outputs, read }
}

const files = [{ filename: 'a', status: 'modified', patch: '+x', additions: 1, deletions: 0 }]
const summary = [{ id: 9, user: { login: 'github-actions[bot]' }, body: `### AI review: approve\n<!-- ai-review sha=${SHA_A} -->` }]

test('collect writes the description, diff and history', async () => {
  const { outputs, read } = await runCollect({ files })
  assert.equal(read('ai-review-context/pr-description.md'), '# T\n\n\n')
  assert.equal(read('ai-review-context/pr.diff'), 'diff --git a/a b/a\n+x\n')
  assert.deepEqual(JSON.parse(read('pr-files.json')), files)
  assert.equal(read('ai-review-history/review-threads.md'), '')
  assert.equal(outputs.comment_id, '')
  assert.equal(read('ai-review-context/delta.diff'), null)
})

test('collect fails when GitHub lists fewer files than the PR changes', async () => {
  await assert.rejects(runCollect({ files, changedFiles: 2 }), /lists only 1 of this PR's 2 files/)
})

test('collect writes the delta since the last reviewed head', async () => {
  const { outputs, read } = await runCollect({ files, issueComments: summary, compare: { status: 'ahead', diff: 'DELTA' } })
  assert.equal(outputs.comment_id, '9')
  assert.equal(read('ai-review-context/delta.diff'), 'DELTA')
  assert.equal(read('ai-review-history/delta.diff'), 'DELTA')
})

test('collect reviews the whole PR after a force-push, a failed compare, or in design', async () => {
  for (const [compare, phase] of [[{ status: 'diverged' }, 'cleanup'], [new Error('404'), 'cleanup'], [{ status: 'ahead', diff: 'D' }, 'design']]) {
    const { read } = await runCollect({ files, issueComments: summary, compare }, phase)
    assert.equal(read('ai-review-context/delta.diff'), null)
  }
})
