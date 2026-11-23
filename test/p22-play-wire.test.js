'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PlayWireRecorder } = require('../src/runtime/play-wire-recorder')
const { ModSupportRuntime } = require('../src/core/runtime')

const packet = (channel, data, phase = 'play', direction = 'inbound') => ({
  channel, data: Buffer.from(data), phase, direction, packetName: 'custom_payload'
})

test('P2.2 wire capture is disabled by default and stores no payload', () => {
  const capture = new PlayWireRecorder()
  assert.equal(capture.observe(packet('example:network', [8, 1, 2])), false)
  assert.equal(capture.getReport().samples.length, 0)
  assert.equal(capture.getReport().enabled, false)
})

test('captures arbitrary mod namespaces, exact bytes, digest and honest dispatcher status', () => {
  const c = new PlayWireRecorder({ enabled: true })
  const raw = Buffer.from([8, 0, 255, 9])
  assert.equal(c.observe(packet('alpha:network', raw), { status: 'ignored' }), true)
  raw[0] = 1
  const sample = c.getReport().samples[0]
  assert.equal(sample.channel, 'alpha:network')
  assert.equal(sample.firstByte, 8)
  assert.equal(sample.firstByteIsDiscriminator, 'unverified')
  assert.equal(sample.hex, '0800ff09')
  assert.equal(sample.payloadBytes, 4)
  assert.equal(sample.dispatcherStatus, 'ignored')
  assert.match(sample.sha256, /^[a-f0-9]{64}$/)
  assert.equal(c.observe(packet('beta:other', [0])), true)
  assert.equal(c.getReport().captured, 2)
})

test('modded selection excludes core and outbound/non-Play payloads', () => {
  const c = new PlayWireRecorder({ enabled: true })
  for (const name of ['minecraft:brand', 'fml:handshake', 'forge:tier_sorting']) {
    assert.equal(c.observe(packet(name, [1])), false)
  }
  assert.equal(c.observe(packet('other:channel', [1], 'login')), false)
  assert.equal(c.observe(packet('other:channel', [1], 'play', 'outbound')), false)
  assert.equal(c.observe(packet('other:channel', [1], 'play')), true)
  assert.equal(c.getReport().captured, 1)
})

test('explicit allowlist can capture core channels without injecting mod ID rules', () => {
  const c = new PlayWireRecorder({ enabled: true, channels: 'forge:tier_sorting,example:channel' })
  assert.equal(c.observe(packet('forge:tier_sorting', [0, 1])), true)
  assert.equal(c.observe(packet('other:channel', [0, 1])), false)
  assert.equal(c.observe(packet('example:channel', [8])), true)
  assert.deepEqual(c.getReport().selection.channels, ['forge:tier_sorting', 'example:channel'])
})

test('unique samples obey per-channel and total byte bounds', () => {
  const c = new PlayWireRecorder({ enabled: true, maxPerChannel: 1, maxSampleBytes: 16, maxTotalBytes: 128 })
  assert.equal(c.observe(packet('a:net', Buffer.alloc(80, 3))), true)
  assert.equal(c.observe(packet('a:net', Buffer.alloc(80, 4))), false)
  assert.equal(c.observe(packet('b:net', Buffer.alloc(80, 4))), true)
  const r = c.getReport()
  assert.equal(r.captured, 2)
  assert.equal(r.bytesCaptured, 32)
  assert.equal(r.droppedByLimits, 1)
  assert.equal(r.samples[0].truncated, true)
  assert.equal(r.samples[0].capturedBytes, 16)
  assert.equal(r.channelCounts[0].received, 2)
})

test('repeated identical frames are counted but not duplicated', () => {
  const c = new PlayWireRecorder({ enabled: true })
  assert.equal(c.observe(packet('abc:def', [0, 1, 2])), true)
  assert.equal(c.observe(packet('abc:def', [0, 1, 2])), false)
  assert.equal(c.getReport().channelCounts[0].received, 2)
  assert.equal(c.getReport().captured, 1)
})

test('invalid channel selections are rejected', () => {
  assert.throws(() => new PlayWireRecorder({ channels: 'bad channel', enabled: true }), /invalid_play_capture/)
  assert.throws(() => new PlayWireRecorder({ channels: ['a:b', 12], enabled: true }), /invalid_play_capture/)
})

test('P2.2 runtime attaches bounded capture to actual inbound Play payload events', () => {
  const runtime = new ModSupportRuntime({ experimental: { playWireCapture: true, playWireCaptureChannels: 'modded' } })
  runtime.emit('payload', packet('fictitious:network', [9, 2, 3]))
  runtime.emit('payload', packet('forge:tier_sorting', [0, 0]))
  const report = runtime.snapshot()
  assert.equal(report.playWire.captured, 1)
  assert.equal(report.playWire.samples[0].dispatcherStatus, 'ignored')
  assert.equal(report.playWire.samples[0].hex, '090203')
  runtime.destroy()
})
