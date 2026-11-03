// Diffs in the PR head checkout with git, so the review sees every file
// with its real headers (modes, renames, symlinks), however large the PR.

// One file's diff over this size is left out, as GitHub does.
const MAX_FILE_DIFF = 500 * 1024
const TOO_LARGE = '(diff over 500 KB left out; compare the file yourself if it matters)\n'

// Runs git in cwd and returns its output, throwing on a non-zero exit.
function gitClient ({ exec, cwd }) {
  return async (args) => {
    const out = await exec.getExecOutput('git', args, { cwd, silent: true, ignoreReturnCode: true })
    if (out.exitCode !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-'))} failed: ${out.stderr.trim()}`)
    return out.stdout
  }
}

// Each file's line counts, shaped like the files API's. Binary files
// count as 0, and a rename keeps its old name.
function parseNumstat (out) {
  const fields = out.split('\0')
  const files = []
  for (let i = 0; i < fields.length - 1; i++) {
    const [additions, deletions, ...rest] = fields[i].split('\t')
    const name = rest.join('\t')
    const count = (n) => (n === '-' ? 0 : Number(n))
    if (name === '') {
      files.push({ filename: fields[i + 2], previous_filename: fields[i + 1], additions: count(additions), deletions: count(deletions) })
      i += 2
    } else {
      files.push({ filename: name, additions: count(additions), deletions: count(deletions) })
    }
  }
  return files
}

// Replaces any one file's diff over MAX_FILE_DIFF with a note. A line
// starting "diff --git " is always a file header: content lines start
// with a space, "+" or "-".
function capFileDiffs (diff) {
  return diff
    .split(/(?=^diff --git )/m)
    .map((d) => {
      if (Buffer.byteLength(d) <= MAX_FILE_DIFF) return d
      const body = d.search(/^(@@|Binary files )/m)
      return (body < 0 ? '' : d.slice(0, body)) + TOO_LARGE
    })
    .join('')
}

// The diff from one commit to another, and each changed file's line
// counts. .gitattributes comes from attrs, a base commit, so a PR can't
// hide its own changes by marking them binary or giving them a driver.
async function changes (git, { from, to, attrs }) {
  const flags = [`--attr-source=${attrs}`, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M']
  const diff = await git([...flags, from, to])
  const files = parseNumstat(await git([...flags, '--numstat', '-z', from, to]))
  return { diff: capFileDiffs(diff), files }
}

const mergeBase = async (git, a, b) => (await git(['merge-base', a, b])).trim()

module.exports = { gitClient, changes, mergeBase, parseNumstat, capFileDiffs }
