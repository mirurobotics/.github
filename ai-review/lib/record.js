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

// Where this round's findings came from, when the OpenAI reviewer
// replied: how many each reviewer raised, and by whom the final session's
// posted findings were raised.
function sources ({ env, kept }) {
  const dir = path.join(env.GITHUB_WORKSPACE, 'ai-review-context', 'findings')
  if (!fs.existsSync(path.join(dir, 'openai.json'))) return null
  const read = (name) => parseResult(fs.readFileSync(path.join(dir, name), 'utf8'))
  const claude = read('claude.json')
  const openai = read('openai.json')
  return {
    raised: {
      claude: Array.isArray(claude) ? claude.reduce((n, r) => n + (r.findings?.length ?? 0), 0) : null,
      openai: Array.isArray(openai) ? openai.length : null
    },
    kept: kept ?? null
  }
}

function sourcesLine ({ raised, kept }) {
  const openai = raised.openai === null ? 'OpenAI\'s reply wasn\'t a JSON array' : `OpenAI raised ${raised.openai}`
  const posted = kept
    ? `posted ${kept.claude} from Claude only, ${kept.openai} from OpenAI only, ${kept.both} from both and ${kept.verifier} found while checking`
    : 'no count of posted findings'
  return `Sources: Claude raised ${raised.claude ?? '?'} findings and ${openai}; ${posted}.`
}

function designBody ({ sha, summary, url }) {
  return `${summaryPrefix('design')} \`${sha.slice(0, 7)}\`\n\n${summary}\n\n${DESIGN_FOOTER}\n\n[Review run](${url})`
}

function verdictBody ({ sha, verdict, summary, findings, sources, url }) {
  const lines = findings.map((f) => `- \`${f.file}${f.line != null ? `:${f.line}` : ''}\`: ${f.description}`)
  const blocking = lines.length ? `**Blocking findings**\n\n${lines.join('\n')}\n\n` : ''
  const origin = sources ? `${sourcesLine(sources)}\n<!-- ai-review-sources ${JSON.stringify(sources)} -->\n\n` : ''
  return `${summaryPrefix('review')} ${verdict.replace('_', ' ')} for \`${sha.slice(0, 7)}\`\n\n${summary}\n\n${blocking}${origin}[Review run](${url})\n${shaMarker(sha)}`
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
  await upsertSummary(github, context, env, verdictBody({
    sha: env.SHA,
    verdict: result.verdict,
    summary: result.summary,
    findings: result.blocking_findings ?? [],
    sources: sources({ env, kept: result.kept }),
    url: runUrl(env)
  }))
  await setStatus(github, context, env, state, state === 'success' ? 'Approved by Claude' : 'Claude found blocking issues')
  if (state !== 'success') core.setFailed('Claude found blocking issues')
}

// Fail closed: any error, timeout or missing verdict
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

module.exports = { pending, record, designBody, verdictBody }
