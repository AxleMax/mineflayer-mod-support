'use strict'

// P2.5: import the existing P2.4 decoded state report and materialize
// data-only collections/objects derived from the *local JAR* Codec IR.
// No server connection and no Java execution. Optional prior P2.1 Registry
// report supplies read-only server ID/name mappings for demonstration.
const fs = require('node:fs')
const path = require('node:path')
const { CompatibilityRuntime } = require('../src/runtime/compatibility')
const { GenericModDataRuntime } = require('../src/runtime/mod-data')
const { ServerRegistryMappings } = require('../src/runtime/registry-mappings')

function loadJson (p, limit = 10 * 1024 * 1024) {
  const bytes = fs.readFileSync(p)
  if (bytes.length > limit) throw new Error('input_report_too_large')
  return JSON.parse(bytes)
}
function projectData (report, modsDir, registryReport = null) {
  if (!Array.isArray(report?.modState?.entries)) throw new Error('invalid_state_replay_report')
  const compatibility = new CompatibilityRuntime({ modsDir })
  const mappings = new ServerRegistryMappings()
  let importedRegistries = 0
  // Optional derived report: report entries are not raw wire proof.
  if (registryReport) {
    for (const entry of registryReport.evidence?.fmlHandshake || []) {
      if (entry.type !== 'S2CRegistry' || entry.parsed !== true || !entry.details) continue
      try { mappings.install(entry.details, entry.messageId); importedRegistries++ } catch { /* do not ACK anything offline */ }
    }
  }
  const data = new GenericModDataRuntime({ manifest: compatibility._manifest, registryMappings: mappings })
  let imported = 0
  for (const entry of report.modState.entries.slice(0, 128)) {
    if (data.observe(entry)) imported++
  }
  const output = data.getReport({ includeValues: true })
  return { schema: 'mineflayer-mod-support/generic-data-replay/v1', source: 'imported-decoded-state-report',
    sourceStateVersion: report.modState.version ?? null, localSource: compatibility.source,
    counts: { receivedStateEntries: Math.min(report.modState.entries.length, 128), projected: imported, importedRegistries },
    registryImport: { previousRuntimeInstalled: registryReport?.runtime?.registryMappings?.mappingInstalledCount ?? null,
      capturedSnapshots: importedRegistries, reportMayBeTruncated: Number.isInteger(registryReport?.runtime?.registryMappings?.mappingInstalledCount) && registryReport.runtime.registryMappings.mappingInstalledCount > importedRegistries },
    modData: output, canAdvertiseModChannels: false,
    caveat: 'Observed objects are not Java Mod client behavior, not an authoritative world-state mutation, and do not modify Mineflayer registry internals' }
}
if (require.main === module) {
  const input = path.resolve(process.argv[2] || 'forge-p24-state-replay.json')
  const mods = path.resolve(process.argv[3] || process.env.MC_MODS_DIR || 'mods')
  const registry = process.argv[4] ? path.resolve(process.argv[4]) : null
  try {
    const output = projectData(loadJson(input), mods, registry ? loadJson(registry) : null)
    const target = path.resolve(process.env.MC_DATA_REPORT || 'forge-p25-data-replay.json')
    fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ counts: output.counts, projections: output.modData.projections.map(({ channel, discriminator, kind, entityKey, itemCount }) => ({ channel, discriminator, kind, entityKey, itemCount })), output: target }, null, 2))
  } catch (error) { console.error('Data projection replay failed:', error.message); process.exitCode = 1 }
}
module.exports = { projectData }
