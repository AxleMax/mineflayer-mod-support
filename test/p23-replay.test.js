'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { GenericPacketDispatcher } = require('../src/runtime/packet-dispatcher')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')
const { replay } = require('../examples/forge-p23-replay')
const { analyzeJars } = require('../src/analyzer/mod-jar')
const { validateManifest } = require('../src/runtime/compatibility')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')

const boundedPlan = { schema: 'mineflayer-mod-support/codec-ir/v1', root: { type: 'struct', fields: [
  { name: 'id', codec: { type: 'resource_location' } },
  { name: 'values', codec: { type: 'list', lengthType: 'short', maxItems: 10, element: { type: 'varint' } } }
] }, definitions: {} }
const packet = (channel, data) => ({ channel, data: Buffer.from(data), direction: 'inbound', phase: 'play' })

test('P2.3 generic structural candidate supports unrelated namespaces without claiming mod compatibility', () => {
  const d = new GenericPacketDispatcher({ emit () {} })
  const c = compileCodecPlan(boundedPlan)
  const payload = c.encode({ id: 'alpha:stone', values: [] })
  for (const channel of ['alpha:net', 'beta:net']) {
    assert.equal(d.registerCandidate({ id: channel, direction: 'clientbound', codecStatus: 'structural-candidate',
      predictedChannel: channel, predictedDiscriminator: 7, codecPlan: boundedPlan }), true)
    const r = d.observe(packet(channel, Buffer.concat([Buffer.from([7]), payload])))
    assert.equal(r.status, 'structural-only')
    assert.equal(r.roundTripExact, true)
    assert.equal(r.serverVerified, false)
    assert.deepEqual([...r.data.values], [])
  }
  assert.equal(d.report().counters.structural, 2)
  assert.equal(d.report().handlerCount, 0)
})

test('unknown channel message retains only validated envelope and never claims it is decoded', () => {
  const d = new GenericPacketDispatcher({ emit () {} })
  d.registerObservedMessage({ direction: 'clientbound', predictedChannel: 'alpha:net', predictedDiscriminator: 0, codecStatus: 'unresolved' })
  const raw = Buffer.concat([Buffer.from([0]), Buffer.from([11]), Buffer.from('alpha:stone'), Buffer.from([0, 255, 1])])
  const result = d.observe(packet('alpha:net', raw))
  assert.equal(result.status, 'envelope-only')
  assert.equal(result.data.resourceLocation, 'alpha:stone')
  assert.equal(result.data.opaqueBytes, 3)
  assert.equal(result.data.decodedBody, false)
  assert.equal(d.observe(packet('alpha:unknown', raw)).status, 'ignored')
})

test('truncated structural packets fail closed', () => {
  const d = new GenericPacketDispatcher({ emit () {} })
  d.registerCandidate({ id: 'alpha:list', direction: 'clientbound', codecStatus: 'structural-candidate',
    predictedChannel: 'alpha:net', predictedDiscriminator: 7, codecPlan: boundedPlan })
  const c = compileCodecPlan(boundedPlan)
  const full = Buffer.concat([Buffer.from([7]), c.encode({ id: 'alpha:stone', values: [100] })])
  assert.equal(d.observe(packet('alpha:net', full.subarray(0, full.length - 1))).status, 'rejected')
  assert.equal(d.report().counters.structural, 0)
})

test('candidate decoder uses the same replay path with long primitives', () => {
  const d = new GenericPacketDispatcher({ emit () {} })
  d.registerCandidate({ id: 'alpha:cooldown', direction: 'clientbound', codecStatus: 'candidate-codec',
    predictedChannel: 'alpha:net', predictedDiscriminator: 9, codecSchema: [{ field: 'first', type: 'long' }, { field: 'second', type: 'long' }] })
  const r = d.observe(packet('alpha:net', Buffer.concat([Buffer.from([9]), Buffer.alloc(16)])))
  assert.equal(r.status, 'candidate-only')
  assert.equal(r.roundTripExact, true)
  assert.equal(r.data.first, 0n)
  assert.equal(r.data.second, 0n)
})

test('P2.3 manifest carries structural IR from real JAR (when fixture present)', () => {
  const file = process.env.MMR_WAYSTONES_JAR || '/mnt/data/waystones-forge-1.20.1-14.1.21.jar'
  const balm = process.env.MMR_BALM_JAR || '/mnt/data/balm-forge-1.20.1-7.3.44.jar'
  if (!fs.existsSync(file) || !fs.existsSync(balm)) return
  const report = analyzeJars([balm, file])
  const manifest = validateManifest(createCompatibilityManifest(report))
  const item = manifest.messages.find(m => m.id === 'waystones:known_waystones')
  assert.equal(item.codecStatus, 'structural-candidate')
  assert.ok(item.codecPlan)
  const d = new GenericPacketDispatcher({ emit () {} })
  assert.equal(d.registerCandidate(item), true)
  const hex = '071277617973746f6e65733a77617973746f6e650000'
  const result = d.observe(packet('waystones:network', Buffer.from(hex, 'hex')))
  assert.equal(result.status, 'structural-only')
  assert.equal(result.roundTripExact, true)
  assert.equal(result.data.slot_0, 'waystones:waystone')
  assert.equal(result.data.slot_1.length, 0)
})

test('offline replay checks captured hashes before decoding and never claims support', () => {
  const jar = process.env.MMR_WAYSTONES_JAR || '/mnt/data/waystones-forge-1.20.1-14.1.21.jar'
  const balm = process.env.MMR_BALM_JAR || '/mnt/data/balm-forge-1.20.1-7.3.44.jar'
  if (!fs.existsSync(jar) || !fs.existsSync(balm)) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmr-p23-'))
  const mods = path.join(dir, 'mods');fs.mkdirSync(mods)
  fs.copyFileSync(jar, path.join(mods, path.basename(jar)))
  fs.copyFileSync(balm, path.join(mods, path.basename(balm)))
  const hex = '071277617973746f6e65733a77617973746f6e650000'
  const buf = Buffer.from(hex, 'hex')
  const sample = { channel: 'waystones:network', direction: 'inbound', phase: 'play', payloadBytes: buf.length, hex, sha256: crypto.createHash('sha256').update(buf).digest('hex'), firstByte: 7, truncated: false }
  const report = { environment: { modSupport: '0.0.17' }, runtime: { playWire: { samples: [sample, { ...sample, sha256: '0'.repeat(64) }] } } }
  const file = path.join(dir, 'capture.json'); fs.writeFileSync(file, JSON.stringify(report))
  try {
    const result = replay(file, mods)
    assert.equal(result.frames[0].status, 'structural-only')
    assert.equal(result.frames[1].status, 'digest_mismatch')
    assert.equal(result.canAdvertiseModChannels, false)
    assert.equal(result.dispatcher.handlerCount, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
