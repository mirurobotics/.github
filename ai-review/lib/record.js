// Records a review round: the summary comment for both phases, and the
// commit status for the required review.

const fs = require('fs')
const path = require('path')
const { summaryPrefix, shaMarker } = require('./summary.js')

const DESIGN_FOOTER = 'Advisory: design comments don\'t block a draft. Each push to the draft gets a new design review; once the PR is ready, the required review blocks on high-severity design findings.'

const runUrl = (env) => `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`

function parseResult (text) {
  try {
    return JSON.parse(text || '{}') ?? {}
  } catch {
    return {}
  }
}

// Bare angle names, sorted and deduplicated, from files or replies.
const angleNames = (names) => [...new Set(names.map((n) => n.replace(/[\r\n]/g, ' ').replace(/.*\//, '').replace(/\.md$/, '')))].sort()

function designBody ({ sha, summary, url }) {
  return `${summaryPrefix('design')} \`${sha.slice(0, 7)}\`\n\n${summary}\n\n${DESIGN_FOOTER}\n\n[Review run](${url})`
}

function verdictBody ({ sha, verdict, summary, findings, url }) {
  const lines = findings.map((f) => `- \`${f.file}${f.line != null ? `:${f.line}` : ''}\`: ${f.description}`)
  const blocking = lines.length ? `**Blocking findings**\n\n${lines.join('\n')}\n\n` : ''
  return `${summaryPrefix('review')} ${verdict.replace('_', ' ')} for \`${sha.slice(0, 7)}\`\n\n${summary}\n\n${blocking}[Review run](${url})\n${shaMarker(sha)}`
}

async function setStatus (github, context, env, state, description) {
  await github.rest.repos.createCommitStatus({
    ...context.repo, sha: env.SHA, state, context: env.STATUS_CONTEXT, description, target_url: runUrl(env)
  })
}

// Edits the phase's summary comment, or posts one if there is none or
// the edit fails.
async function upsertSummary (github, context, env, body) {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body + '\n')
  if (env.COMMENT_ID) {
    try {
      await github.rest.issues.updateComment({ ...context.repo, comment_id: Number(env.COMMENT_ID), body })
      return
    } catch {}
  }
  await github.rest.issues.createComment({ ...context.repo, issue_number: Number(env.PR_NUMBER), body })
}

const pending = ({ github, context, env = process.env }) =>
  setStatus(github, context, env, 'pending', 'Claude is reviewing this commit')

async function recordDesign ({ github, context, env }) {
  const { summary } = parseResult(env.RESULT)
  if (!summary) throw new Error('Design review produced no summary')
  await upsertSummary(github, context, env, designBody({ sha: env.SHA, summary, url: runUrl(env) }))
}

async function recordVerdict ({ github, context, core, env }) {
  const result = parseResult(env.RESULT)
  const state = { approve: 'success', request_changes: 'failure' }[result.verdict]
  if (!state) throw new Error('AI review produced no verdict')

  const dir = path.join(env.GITHUB_WORKSPACE, 'ai-review-context', 'angles')
  const want = angleNames(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []).join(',')
  const got = angleNames(Array.isArray(result.angles) ? result.angles : []).join(',')
  if (!want || got !== want) throw new Error(`Reviewers that replied (${got}) don't match the angles run (${want})`)

  await upsertSummary(github, context, env, verdictBody({
    sha: env.SHA, verdict: result.verdict, summary: result.summary, findings: result.blocking_findings ?? [], url: runUrl(env)
  }))
  await setStatus(github, context, env, state, state === 'success' ? 'Approved by Claude' : 'Claude found blocking issues')
  if (state !== 'success') core.setFailed('Claude found blocking issues')
}

// Fail closed: any error, timeout, missing angle or missing verdict
// leaves the required status non-green.
async function record ({ github, context, core, env = process.env }) {
  if (env.PHASE === 'design') return recordDesign({ github, context, env })
  try {
    await recordVerdict({ github, context, core, env })
  } catch (err) {
    await setStatus(github, context, env, 'error', 'Review did not complete; see the run log').catch(() => {})
    throw err
  }
}

module.exports = { pending, record, designBody, verdictBody, angleNames }
