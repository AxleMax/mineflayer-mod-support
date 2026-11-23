'use strict'
// P2.3: replay *previously captured* Play packets through the same generic
// runtime used online. Does not contact the server or execute any Java/JVM.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { CompatibilityRuntime } = require('../src/runtime/compatibility')
const { NativeChannelRuntime } = require('../src/runtime/native-channels')
const { ModStateStore } = require('../src/runtime/mod-state')

function compact (value, depth = 0) {
  if (depth > 5) return '[depth-limit]'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.length > 160 ? value.slice(0, 160) + '…' : value
  if (Array.isArray(value)) return value.length > 16
    ? { count: value.length, first: value.slice(0, 2).map(x => compact(x, depth + 1)) }
    : value.map(x => compact(x, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 16).map(([k, v]) => [k, compact(v, depth + 1)]))
  return value
}
function replay (reportPath, modsDir) {
  const bytes = fs.readFileSync(reportPath)
  if (bytes.length > 10 * 1024 * 1024) throw new Error('report_too_large')
  const report = JSON.parse(bytes)
  if (!Array.isArray(report?.runtime?.playWire?.samples)) throw new Error('missing_play_wire_samples')
  const compatibility = new CompatibilityRuntime({ modsDir })
  const modState = new ModStateStore()
  const runtime = { emit (name, entry) {
    if (name === 'nativeChannelCandidate' || name === 'nativeChannelEnvelope' || name === 'genericModMessage') {
      modState.record({ ...entry, evidence: 'offline-wire-replay',
        status: name === 'genericModMessage' ? 'handled' : entry.status })
    }
  } }
  const native = new NativeChannelRuntime(runtime, {}, compatibility)
  const frames = []
  for (const sample of report.runtime.playWire.samples.slice(0, 96)) {
    if (sample.truncated || sample.direction !== 'inbound' || sample.phase !== 'play' ||
        !Number.isSafeInteger(sample.payloadBytes) || sample.payloadBytes < 0 || sample.payloadBytes > 1024 * 1024 ||
        typeof sample.hex !== 'string' || sample.hex.length !== sample.payloadBytes * 2 || !/^[0-9a-f]*$/i.test(sample.hex)) {
      frames.push({ channel: sample.channel, status: 'unusable_or_truncated' }); continue
    }
    const payload = Buffer.from(sample.hex, 'hex')
    const digest = crypto.createHash('sha256').update(payload).digest('hex')
    if (digest !== sample.sha256) {
      frames.push({ channel: sample.channel, status: 'digest_mismatch' }); continue
    }
    const result = native.observe({ channel: sample.channel, direction: 'inbound', phase: 'play', data: payload })
    frames.push({ channel: sample.channel, discriminator: sample.firstByte, payloadBytes: sample.payloadBytes,
      status: result.status, id: result.id || null, roundTripExact: result.roundTripExact === true,
      data: compact(result.data || null), reason: result.reason || null })
  }
  return {
    schema: 'mineflayer-mod-support/play-wire-replay/v1', nodeOnly: true,
    sourceModdedVersion: report.environment?.modSupport || null,
    localSource: compatibility.source, local: compatibility.getReport().local,
    frames, dispatcher: native.getReport().genericNetwork, modState: modState.getReport({ includeValues: true }),
    canAdvertiseModChannels: false,
    caveat: 'Full-byte parity on individual samples is not proof of nonempty list codec behavior, Mod client semantics, or Forge registration compatibility'
  }
}
if (require.main === module) {
  const input = path.resolve(process.argv[2] || 'forge-p22-play-wire-probe.json')
  const dir = path.resolve(process.argv[3] || process.env.MC_MODS_DIR || 'mods')
  try {
    const result = replay(input, dir)
    const target = path.resolve(process.env.MC_REPLAY_REPORT || 'forge-p23-replay.json')
    fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ frames: result.frames, source: result.localSource, output: target }, null, 2))
  } catch (error) { console.error('Offline replay failed:', error.message); process.exitCode = 1 }
}
module.exports = { replay }
