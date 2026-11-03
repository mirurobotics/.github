const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { changes, parseNumstat, capFileDiffs } = require('./diff.js')

// A repo with a base commit and a head commit that touches every kind of
// file change. Returns a git runner for it and both SHAs.
function repoWithChanges () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'))
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  const write = (f, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), content)
  }
  write('keep.txt', 'a\nb\n')
  write('gone.txt', 'bye\n')
  write('old-name.txt', 'same content that stays\nacross the rename\n')
  write('hidden.txt', 'secret: old\n')
  run('add', '-A')
  run('commit', '-qm', 'base')
  const base = run('rev-parse', 'HEAD').trim()

  write('keep.txt', 'a\nB\n')
  write('new.txt', 'hi\n')
  fs.rmSync(path.join(dir, 'gone.txt'))
  run('mv', 'old-name.txt', 'new-name.txt')
  write('image.bin', Buffer.from([0, 1, 2, 0, 255]))
  write('big.txt', 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(6000))
  // The head tries to hide a change by marking the file binary.
  write('.gitattributes', 'hidden.txt -diff\n')
  write('hidden.txt', 'secret: new\n')
  run('add', '-A')
  run('commit', '-qm', 'head')
  const head = run('rev-parse', 'HEAD').trim()
  return { git: async (args) => run(...args), base, head }
}

test('changes diffs every kind of file change with real headers', async () => {
  const { git, base, head } = await repoWithChanges()
  const { diff, files } = await changes(git, { from: base, to: head, attrs: base })

  assert.match(diff, /^diff --git a\/keep\.txt b\/keep\.txt\n.*\n--- a\/keep\.txt\n\+\+\+ b\/keep\.txt\n@@ .* @@\n a\n-b\n\+B\n/m)
  assert.match(diff, /^diff --git a\/new\.txt b\/new\.txt\nnew file mode 100644\n/m)
  assert.match(diff, /^diff --git a\/gone\.txt b\/gone\.txt\ndeleted file mode 100644\n/m)
  assert.match(diff, /^rename from old-name\.txt\nrename to new-name\.txt\n/m)
  assert.match(diff, /^Binary files \/dev\/null and b\/image\.bin differ\n/m)
  // Attributes come from the base, so the head's -diff doesn't hide it.
  assert.match(diff, /^-secret: old\n\+secret: new\n/m)
  // The oversized file keeps its header and loses its body.
  assert.match(diff, /^diff --git a\/big\.txt b\/big\.txt\nnew file mode 100644\n(?:.*\n){3}\(diff over 500 KB left out; compare the file yourself if it matters\)\n/m)
  assert.ok(Buffer.byteLength(diff) < 100 * 1024)

  const byName = Object.fromEntries(files.map((f) => [f.filename, f]))
  assert.deepEqual(byName['keep.txt'], { filename: 'keep.txt', additions: 1, deletions: 1 })
  assert.deepEqual(byName['new-name.txt'], { filename: 'new-name.txt', previous_filename: 'old-name.txt', additions: 0, deletions: 0 })
  assert.deepEqual(byName['image.bin'], { filename: 'image.bin', additions: 0, deletions: 0 })
  assert.equal(byName['gone.txt'].deletions, 1)
  assert.equal(byName['big.txt'].additions, 6001)
  assert.equal(files.length, 8)
})

test('changes with the head\'s attributes would hide the change', async () => {
  // Shows what attrs guards against.
  const { git, base, head } = await repoWithChanges()
  const { diff } = await changes(git, { from: base, to: head, attrs: head })
  assert.match(diff, /^Binary files a\/hidden\.txt and b\/hidden\.txt differ\n/m)
})

test('parseNumstat reads renames, binaries and names with tabs', () => {
  assert.deepEqual(parseNumstat('3\t1\ta\tb.go\0-\t-\tlogo.png\0' + '0\t0\t\0old\tname\0new name\0'), [
    { filename: 'a\tb.go', additions: 3, deletions: 1 },
    { filename: 'logo.png', additions: 0, deletions: 0 },
    { filename: 'new name', previous_filename: 'old\tname', additions: 0, deletions: 0 }
  ])
  assert.deepEqual(parseNumstat(''), [])
})

test('capFileDiffs leaves small diffs and the empty diff alone', () => {
  const small = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n'
  assert.equal(capFileDiffs(small + small), small + small)
  assert.equal(capFileDiffs(''), '')
})
