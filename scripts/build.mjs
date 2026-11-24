import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from '../package.json' with { type: 'json' }
import { loadSamplePack } from '../src/host/samples.mjs'

const output = new URL('../lib/', import.meta.url)
const previews = new URL('../assets/voice-previews/', import.meta.url)
const catalog = JSON.parse((await readFile(new URL('manifest.json', previews), 'utf8')).replace(/^\uFEFF/u, ''))
if (!catalog.voices.length || new Set(catalog.voices.map(voice => voice.id)).size !== catalog.voices.length) throw new Error('Invalid voice preview catalog')
for (const { file, sha256 } of catalog.voices) {
  if (!/^[a-z0-9_]+\.wav$/u.test(file)) throw new Error('Invalid voice preview path')
  const data = await readFile(new URL(file, previews))
  if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Invalid voice preview checksum: ' + file)
}
const samplesManifest = new URL('../assets/samples/manifest.json', import.meta.url)
if (existsSync(samplesManifest)) {
  await loadSamplePack(fileURLToPath(new URL('../assets/samples/', import.meta.url)))
}
await mkdir(output, { recursive: true })
await writeFile(new URL('index.mjs', output), "export { apply, inject, name } from '../src/host/index.mjs'\n")
const result = await build({
  entryPoints: ['src/client/index.jsx'],
  platform: 'browser',
  format: 'cjs',
  loader: { '.css': 'text' },
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  bundle: true,
  write: false,
})
await writeFile(new URL('client.js', output),
  'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) +
  ', factory: (require) => { const module = { exports: {} };\n' +
  result.outputFiles[0].text + '\nreturn module.exports; } });\n')

// The Edge client (msedge-tts with axios, ws and the rest) bundled into one
// file. msedge-tts declares an install script, and DSH's pnpm refuses to run
// it, which fails the whole plugin install; shipped bundled, the package has
// no such dependency. The bundled packages' license texts go alongside.
const vendor = new URL('vendor/', output)
await mkdir(vendor, { recursive: true })
const edge = await build({
  stdin: { contents: "module.exports = require('msedge-tts')", resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'msedge-tts-entry.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
  outfile: fileURLToPath(new URL('msedge-tts.cjs', vendor)),
  // ws loads these optional native helpers inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
})
await writeFile(new URL('msedge-tts.licenses.txt', vendor), await bundledLicenses(edge.metafile))

async function bundledLicenses(metafile) {
  const roots = new Set()
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf('node_modules/')
    if (at < 0) continue
    const rest = input.slice(at + 'node_modules/'.length).split('/')
    roots.add(input.slice(0, at) + 'node_modules/' + rest.slice(0, rest[0].startsWith('@') ? 2 : 1).join('/'))
  }
  const sections = []
  for (const root of [...roots].sort()) {
    const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const names = await readdir(root)
    const licenseFile = names.find(name => /^(?:license|licence|copying)(?:\.|$)/iu.test(name))
    let text = ''
    if (licenseFile) text = (await readFile(join(root, licenseFile), 'utf8')).trim()
    else {
      const readmeName = names.find(name => /^readme(?:\.md|\.txt)?$/iu.test(name))
      const readme = readmeName ? await readFile(join(root, readmeName), 'utf8') : ''
      const start = readme.search(/^(?:#{1,3}\s+)?licen[cs]e\s*$/imu)
      if (start >= 0) {
        const rest = readme.slice(start)
        const next = rest.slice(1).search(/^#{1,3}\s+\S/mu)
        const section = (next >= 0 ? rest.slice(0, next + 1) : rest).trim()
        if (/copyright/iu.test(section)) text = section
      }
    }
    if (!text) throw new Error('THIRD_PARTY_NOTICES: no license text for ' + info.name)
    sections.push(info.name + '@' + info.version + ' — ' + (info.license ?? 'see text') + '\n\n' + text)
  }
  return 'Third-party packages bundled into msedge-tts.cjs\n\n' + sections.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n'
}
