'use strict'
const { parse } = require('smol-toml')

// Parse the actual TOML document, including comments, multiline strings and
// quoted tables. Text within a description is never another Mod declaration.
function parseToml (text) {
  const document = parse(text)
  const mods = document.mods || []
  if (!Array.isArray(mods) || mods.some(mod => !mod || typeof mod !== 'object' || typeof mod.modId !== 'string')) throw new Error('invalid_mods_toml_mod_table')
  const deps = []
  for (const [owner, entries] of Object.entries(document.dependencies || {})) {
    if (!Array.isArray(entries)) throw new Error('invalid_mods_toml_dependency_table:' + owner)
    for (const entry of entries) {
      if (!entry || typeof entry.modId !== 'string') throw new Error('invalid_mods_toml_dependency')
      deps.push({ ...entry, owner })
    }
  }
  return { mods, deps }
}

// JAR manifest continuation lines are joined before UTF-8 decoding. Only the
// main section supplies Implementation-Version; entry sections cannot replace it.
function parseManifestMain (input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '', 'utf8')
  const logical = []; let start = 0
  for (let cursor = 0; cursor <= bytes.length; cursor++) {
    if (cursor < bytes.length && bytes[cursor] !== 10) continue
    let line = bytes.subarray(start, cursor); start = cursor + 1
    if (line.at(-1) === 13) line = line.subarray(0, -1)
    if (!line.length) break
    if (line[0] === 32) {
      if (!logical.length) throw new Error('orphan_manifest_continuation')
      logical[logical.length - 1] = Buffer.concat([logical.at(-1), line.subarray(1)])
    } else logical.push(Buffer.from(line))
  }
  const headers = Object.create(null)
  for (const line of logical) {
    const text = line.toString('utf8'), match = /^([A-Za-z0-9_-]+): (.*)$/.exec(text)
    if (!match) throw new Error('invalid_manifest_header')
    headers[match[1].toLowerCase()] = match[2]
  }
  return headers
}

function resolveMods (mods, manifest) {
  const warnings = []
  const implementation = manifest['implementation-version']
  const resolved = mods.map(mod => {
    const declared = mod.version ?? '1'
    if (typeof declared !== 'string') throw new Error('invalid_mod_version:' + mod.modId)
    const version = implementation ? declared.replaceAll('${file.jarVersion}', implementation) : declared
    const versionResolved = !/\$\{[^}]+\}/.test(version)
    if (!versionResolved) warnings.push('Unresolved Mod version substitution: ' + mod.modId + ' = ' + version)
    return { id: mod.modId, version, displayName: mod.displayName || mod.modId,
      versionResolved, versionSource: declared !== version ? 'jar-manifest/Implementation-Version' : mod.version == null ? 'forge-default' : versionResolved ? 'mods.toml' : 'unresolved-substitution' }
  })
  return { mods: resolved, warnings }
}
module.exports = { parseToml, parseManifestMain, resolveMods }
