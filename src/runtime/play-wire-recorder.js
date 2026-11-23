'use strict'

const { createHash } = require('node:crypto')

// Opt-in, bounded diagnostic capture for REAL Play custom-payload traffic.
// The recorder is agnostic to Mod IDs and does not assume that byte 0 is a
// SimpleChannel discriminator; it merely preserves it as a hypothesis.
const IDENTIFIER = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const CORE_NAMESPACES = new Set(['minecraft', 'fml', 'forge'])

function bound (value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}
function parseSelection (input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : ['modded']
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('invalid_play_capture_channel_selection')
  const channels = new Set()
  let modded = false
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('invalid_play_capture_channel_selection')
    const channel = item.trim()
    if (channel === 'modded') { modded = true; continue }
    if (channel.length > 256 || !IDENTIFIER.test(channel)) throw new Error('invalid_play_capture_channel_selection')
    channels.add(channel)
  }
  return { channels, modded }
}

class PlayWireRecorder {
  constructor (options = {}) {
    this.enabled = options.enabled === true
    const selection = parseSelection(options.channels === undefined ? 'modded' : options.channels)
    this.channels = selection.channels
    this.modded = selection.modded
    this.maxPerChannel = bound(options.maxPerChannel, 6, 1, 32)
    this.maxSamples = bound(options.maxSamples, 48, 1, 128)
    this.maxSampleBytes = bound(options.maxSampleBytes, 4096, 16, 8192)
    this.maxTotalBytes = bound(options.maxTotalBytes, 32768, 128, 65536)
    this.samples = []
    this.counts = new Map()
    this.capturedByChannel = new Map()
    this.totalCapturedBytes = 0
    this.dropped = 0
    this._seen = new Set()
  }

  _selected (channel) {
    if (typeof channel !== 'string' || !IDENTIFIER.test(channel) || channel.length > 256) return false
    if (this.channels.has(channel)) return true
    if (this.modded && !CORE_NAMESPACES.has(channel.split(':', 1)[0])) return true
    return false
  }

  observe (event, result = null) {
    if (!this.enabled || event?.direction !== 'inbound' ||
      String(event.phase).toLowerCase() !== 'play' ||
      !Buffer.isBuffer(event.data) || !this._selected(event.channel)) return false
    const channel = event.channel
    this.counts.set(channel, (this.counts.get(channel) || 0) + 1)
    if ((this.capturedByChannel.get(channel) || 0) >= this.maxPerChannel ||
        this.samples.length >= this.maxSamples || this.totalCapturedBytes >= this.maxTotalBytes) {
      this.dropped++
      return false
    }
    // Digest the full wire frame, even if the readable hex sample is truncated.
    const sha256 = createHash('sha256').update(event.data).digest('hex')
    const duplicateKey = channel + ':' + sha256
    if (this._seen.has(duplicateKey)) return false
    const n = Math.min(event.data.length, this.maxSampleBytes, this.maxTotalBytes - this.totalCapturedBytes)
    if (n < 0) { this.dropped++; return false }
    const sample = {
      channel,
      direction: 'inbound',
      phase: 'play',
      packetName: typeof event.packetName === 'string' ? event.packetName.slice(0, 80) : null,
      payloadBytes: event.data.length,
      sha256,
      firstByte: event.data.length > 0 ? event.data.readUInt8(0) : null,
      firstByteIsDiscriminator: 'unverified',
      hex: event.data.subarray(0, n).toString('hex'),
      capturedBytes: n,
      truncated: n !== event.data.length,
      dispatcherStatus: typeof result?.status === 'string' ? result.status : 'unobserved'
    }
    this.samples.push(sample)
    this._seen.add(duplicateKey)
    this.totalCapturedBytes += n
    this.capturedByChannel.set(channel, (this.capturedByChannel.get(channel) || 0) + 1)
    return true
  }

  getReport () {
    return {
      enabled: this.enabled,
      selection: { modded: this.modded, channels: [...this.channels] },
      mode: 'explicit-test-server-wire-capture',
      captured: this.samples.length,
      bytesCaptured: this.totalCapturedBytes,
      droppedByLimits: this.dropped,
      channelCounts: [...this.counts].map(([channel, received]) => ({ channel, received, sampled: this.capturedByChannel.get(channel) || 0 })),
      limits: { maxPerChannel: this.maxPerChannel, maxSamples: this.maxSamples, maxSampleBytes: this.maxSampleBytes, maxTotalBytes: this.maxTotalBytes },
      samples: this.samples.map(sample => ({ ...sample })),
      warning: this.enabled ? 'Samples contain REAL protocol bytes which might include private server/player information; review before sharing.' : 'Disabled; no Play bytes retained.'
    }
  }
}

module.exports = { PlayWireRecorder, parseSelection }
