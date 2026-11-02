// The one summary comment each phase keeps on a PR: how collect finds it
// and record writes it.

const PREFIXES = { cleanup: '### AI review:', design: '### AI design review:' }
const SHA_MARKER = /<!-- ai-review sha=([0-9a-f]{40}) -->/g

const summaryPrefix = (phase) => PREFIXES[phase]

const shaMarker = (sha) => `<!-- ai-review sha=${sha} -->`

// The head a summary last reviewed. The last marker wins, since the
// model writes the text above it.
function lastReviewedSha (body) {
  const marks = [...body.matchAll(SHA_MARKER)]
  return marks.length ? marks[marks.length - 1][1] : ''
}

module.exports = { summaryPrefix, shaMarker, lastReviewedSha }
