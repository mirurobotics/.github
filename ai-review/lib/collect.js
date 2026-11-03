// Collects what the review reads: the PR description and diff, earlier
// review rounds, the summary comment to edit and the head it last
// reviewed. Run here so Claude never gets a token that can post statuses.
// Returns the PR's files and the delta (null when reviewing the whole PR).
// Throws on any error: missing context would quietly weaken the review.

const fs = require('fs')
const path = require('path')
const { summaryPrefix, lastReviewedSha } = require('./summary.js')
const { gitClient, changes, fetchCommit } = require('./diff.js')

// Line breaks in paths become spaces, so a name can't fake a header.
const oneLine = (s) => s.replace(/[\r\n]/g, ' ')

// A deleted account's comments have no user; jq printed "null" for them.
const login = (c) => c.user?.login ?? 'null'

// Quotes untrusted text with "> " so it can't pass for the surrounding
// structure.
const quote = (body) => (body ? body.split('\n').map((l) => '> ' + l).join('\n') : '')

// Inline threads, oldest first, each marked outdated or resolved.
// resolved maps a thread's first comment id to whether it's resolved.
function renderThreads (comments, resolved) {
  const threads = new Map()
  for (const c of [...comments].sort((a, b) => (a.in_reply_to_id ?? a.id) - (b.in_reply_to_id ?? b.id))) {
    const key = c.in_reply_to_id ?? c.id
    if (!threads.has(key)) threads.set(key, [])
    threads.get(key).push(c)
  }
  const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
  return [...threads.values()]
    .map((t) => t.sort(byTime))
    .sort((a, b) => byTime(a[0], b[0]))
    .map((t) => {
      const root = t[0]
      let where
      if (root.subject_type === 'file') where = ' (file comment)'
      else if (root.line) where = `:${root.line}`
      else where = `:${root.original_line} (outdated)`
      const state = resolved[String(root.id)] ? ' (resolved)' : ''
      const replies = t.map((c) => `**${login(c)}** (${c.author_association}, ${c.created_at}):\n\n${quote(c.body)}`)
      return `## ${oneLine(root.path)}${where}${state} at ${root.original_commit_id.slice(0, 7)}\n\n${replies.join('\n\n')}\n\n`
    })
    .join('')
}

// The PR conversation (issue comments), oldest first.
function renderConversation (comments) {
  return comments
    .map((c) => `## ${login(c)} (${c.author_association}, ${c.created_at})\n\n${quote(c.body)}\n\n`)
    .join('')
}

// The phase's summary comment, which each round edits, and the head it
// last reviewed.
function findSummary (comments, phase) {
  const prefix = summaryPrefix(phase)
  const mine = comments.filter((c) => login(c) === 'github-actions[bot]' && (c.body ?? '').startsWith(prefix))
  const summary = mine[mine.length - 1]
  if (!summary) return { id: '', lastSha: '' }
  return { id: String(summary.id), lastSha: lastReviewedSha(summary.body ?? '') }
}

async function resolvedThreads (github, owner, repo, number) {
  const query = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved comments(first: 1) { nodes { databaseId } } }
        }
      }
    }
  }`
  const resolved = {}
  let cursor = null
  do {
    const page = (await github.graphql(query, { owner, repo, number, cursor })).repository.pullRequest.reviewThreads
    for (const t of page.nodes) resolved[String(t.comments.nodes[0]?.databaseId ?? null)] = t.isResolved
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return resolved
}

// Changes from lastSha to sha, or null when lastSha isn't an ancestor
// (after a force-push or rebase) or can't be fetched.
async function deltaDiff ({ github, git, owner, repo, lastSha, sha, attrs }) {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${lastSha}...${sha}`, per_page: 1 })
    if (data.status !== 'ahead' && data.status !== 'identical') return null
    await fetchCommit(git, lastSha)
    return (await changes(git, { from: lastSha, to: sha, attrs })).diff
  } catch {
    return null
  }
}

async function collect ({ github, context, core, exec, env = process.env, git }) {
  const { owner, repo } = context.repo
  const pr = context.payload.pull_request
  const phase = env.PHASE
  const dir = path.join(env.GITHUB_WORKSPACE, 'ai-review-context')
  const history = path.join(env.GITHUB_WORKSPACE, 'ai-review-history')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(history, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pr-description.md'), `# ${pr.title}\n\n${pr.body ?? ''}\n`)

  // The PR's diff from the merge base GitHub uses for it, built with git
  // in the PR head checkout.
  git ??= gitClient({ exec, cwd: path.join(env.GITHUB_WORKSPACE, 'pr-head'), token: env.GITHUB_TOKEN })
  const { data: { merge_base_commit: { sha: mergeBase } } } = await github.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${pr.base.sha}...${env.SHA}`, per_page: 1
  })
  await fetchCommit(git, mergeBase)
  const { diff, files } = await changes(git, { from: mergeBase, to: env.SHA, attrs: mergeBase })
  fs.writeFileSync(path.join(dir, 'pr.diff'), diff)

  // Earlier rounds, kept apart from the reviewers' inputs.
  const resolved = await resolvedThreads(github, owner, repo, pr.number)
  const threads = await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })
  fs.writeFileSync(path.join(history, 'review-threads.md'), renderThreads(threads, resolved))
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 })
  fs.writeFileSync(path.join(history, 'conversation.md'), renderConversation(comments))

  const summary = findSummary(comments, phase)
  core.setOutput('comment_id', summary.id)

  // Later review rounds review only the changes since the last reviewed
  // head. Design reviews always read the whole PR.
  const delta = summary.lastSha && phase === 'review'
    ? await deltaDiff({ github, git, owner, repo, lastSha: summary.lastSha, sha: env.SHA, attrs: mergeBase })
    : null
  if (delta !== null) {
    fs.writeFileSync(path.join(history, 'delta.diff'), delta)
    fs.writeFileSync(path.join(dir, 'delta.diff'), delta)
    core.info(`Reviewing changes since ${summary.lastSha.slice(0, 7)}`)
  } else {
    core.info('Reviewing the whole PR')
  }
  return { files, delta }
}

module.exports = { collect, renderThreads, renderConversation, findSummary, quote }
