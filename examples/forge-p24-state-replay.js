'use strict'
// Convert a P2.3 replay report into typed generic state records without
// connecting to a server or requiring raw Play packet capture again.
// The replay report is not the wire oracle; provenance remains explicit.
const fs = require('node:fs')
const path = require('node:path')
const { ModStateStore } = require('../src/runtime/mod-state')
function buildStateFromReplay (report) {
  if (report?.schema !== 'mineflayer-mod-support/play-wire-replay/v1' || !Array.isArray(report.frames)) throw new Error('invalid_replay_report')
  if (report.frames.length > 128) throw new Error('too_many_frames')
  const store = new ModStateStore()
  const counts = { imported: 0, skipped: 0 }
  for (const frame of report.frames) {
    if (!['candidate-only', 'structural-only', 'envelope-only'].includes(frame.status) ||
        (frame.status !== 'envelope-only' && frame.roundTripExact !== true)) { counts.skipped++; continue }
    const entityKey = frame.status === 'envelope-only' ? frame.data?.resourceLocation :
      frame.status === 'structural-only' && typeof frame.data?.slot_0 === 'string' && /^(?:[a-z0-9_.-]+):[a-z0-9_./-]+$/.test(frame.data.slot_0) ? frame.data.slot_0 : null
    const result = store.record({ channel: frame.channel, discriminator: frame.discriminator,
      id: frame.id || null, status: frame.status, data: frame.data, entityKey,
      evidence: 'imported-replay-report' })
    result ? counts.imported++ : counts.skipped++
  }
  return { schema: 'mineflayer-mod-support/state-replay/v1', source: 'imported-replay-report',
    counts, modState: store.getReport({ includeValues: true }),
    canAdvertiseModChannels: false, caveat: 'A decoded replay report is a derived artifact, not raw wire verification; observed values are NOT executed Mod client logic' }
}
function replayState (filePath) {
  const bytes = fs.readFileSync(filePath)
  if (bytes.length > 10 * 1024 * 1024) throw new Error('report_too_large')
  return buildStateFromReplay(JSON.parse(bytes))
}
if (require.main === module) {
  try {
    const input = path.resolve(process.argv[2] || 'forge-p23-replay.json')
    const output = path.resolve(process.env.MC_STATE_REPORT || 'forge-p24-state-replay.json')
    const result = replayState(input)
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ counts: result.counts, entryCount: result.modState.entryCount, output }))
  } catch (error) { console.error('State replay failed:', error.message); process.exitCode = 1 }
}
module.exports = { buildStateFromReplay, replayState }
