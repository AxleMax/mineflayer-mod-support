'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { WireWriter } = require('../src/protocol/forge/wire')
const { packSimpleChannel } = require('../src/protocol/forge/simple-channel')
const { decodeConfigPayload, ConfigSyncMirror, extractConfigSchemas } = require('../src/runtime/config-sync-mirror')

function exampleSchema () {
  return { roots: new Map([['enabled', 'boolean']]), groups: new Map([
    ['combat', new Map([['delay', 'int'], ['scale', 'double'], ['mode', 'enum_ordinal_int'], ['owner', 'resource_location']])],
    ['visual', new Map([['title', 'string'], ['ticks', 'long'], ['rate', 'float'], ['tiny', 'byte'], ['shortValue', 'short']])]
  ]), fieldCount: 10 }
}
function exampleBody () {
  const w = new WireWriter().identifier('examplenet:common').count(1).string('enabled').byte(1)
  w.count(2)
  const double = Buffer.alloc(8); double.writeDoubleBE(1.25)
  w.string('combat').count(4).string('delay').bytes(Buffer.from([0, 0, 0, 30]))
    .string('scale').bytes(double).string('mode').bytes(Buffer.from([0, 0, 0, 2]))
    .string('owner').identifier('examplenet:test')
  const long = Buffer.alloc(8); long.writeBigInt64BE(5000000000n)
  const float = Buffer.alloc(4); float.writeFloatBE(0.5)
  w.string('visual').count(5).string('title').string('Hello!').string('ticks').bytes(long)
    .string('rate').bytes(float).string('tiny').byte(7)
    .string('shortValue').bytes(Buffer.from([0, 42]))
  return w.finish()
}
function manifest () {
  return { messages: [{ codecStatus: 'unresolved', id: 'transport:config', direction: 'clientbound', predictedChannel: 'transport:network', predictedDiscriminator: 0 }] }
}

test('P3.1 typed config decodes primitives, categories, root fields and exact byte roundtrip', () => {
  const decoded = decodeConfigPayload(exampleBody(), exampleSchema())
  assert.equal(decoded.id, 'examplenet:common')
  assert.equal(decoded.propertyCount, 10)
  assert.equal(decoded.categoryCount, 2)
  assert.equal(decoded.roots.enabled, true)
  assert.equal(decoded.categories.combat.delay, 30)
  assert.equal(decoded.categories.combat.scale, 1.25)
  assert.equal(decoded.categories.combat.mode, 2)
  assert.equal(decoded.categories.combat.owner, 'examplenet:test')
  assert.equal(decoded.categories.visual.title, 'Hello!')
  assert.equal(decoded.categories.visual.ticks, '5000000000')
  assert.equal(decoded.categories.visual.rate, 0.5)
  assert.equal(decoded.categories.visual.tiny, 7)
  assert.equal(decoded.categories.visual.shortValue, 42)
  assert.equal(decoded.roundTripExact, true)
})
test('P3.1 malformed and truncated config fails closed', () => {
  const body = exampleBody()
  assert.throws(() => decodeConfigPayload(body.subarray(0, body.length - 1), exampleSchema()), /wire_length|truncated|invalid/)
  assert.throws(() => decodeConfigPayload(Buffer.concat([body, Buffer.from([0])]), exampleSchema()), /wire_trailing_bytes/)
  assert.throws(() => decodeConfigPayload(body, null), /invalid_config_body/)
  assert.throws(() => decodeConfigPayload(Buffer.alloc(32768), exampleSchema()), /invalid_config_body/)
  const dangerous = new WireWriter().identifier('examplenet:common').count(1).string('__proto__').byte(1).count(0).finish()
  assert.throws(() => decodeConfigPayload(dangerous, exampleSchema()), /config_property_not_in_schema/)
})
test('P3.1 config mirror keeps separate independent typed snapshots without Mod advertisement', () => {
  const mirror = new ConfigSyncMirror({ runtime: { emit () {} }, manifest: manifest() })
  mirror.schemas.set('examplenet', exampleSchema())
  const raw = packSimpleChannel(0, exampleBody())
  const result = mirror.observe({ channel: 'transport:network', direction: 'inbound', phase: 'play', data: raw })
  assert.equal(result.status, 'config-decoded')
  assert.equal(result.propertyCount, 10)
  assert.equal(mirror.get('examplenet:common').roundTripExact, true)
  assert.equal(mirror.get('examplenet:common').appliedToJava, false)
  assert.equal(mirror.getReport().configs.length, 1)
  assert.equal(mirror.getReport().counts.decoded, 1)
  assert.equal(new ConfigSyncMirror({ runtime: { emit () {} }, manifest: manifest() }).get('examplenet:common'), null)
  assert.equal(mirror.observe({ channel: 'unknown:network', direction: 'inbound', phase: 'play', data: raw }).status, 'ignored')
  assert.equal(mirror.observe({ channel: 'transport:network', direction: 'outbound', phase: 'play', data: raw }).status, 'ignored')
  assert.equal(mirror.observe({ channel: 'transport:network', direction: 'inbound', phase: 'login', data: raw }).status, 'ignored')
})
test('P3.1 unrecognized config namespace preserves envelope-only instead of claiming decode', () => {
  const mirror = new ConfigSyncMirror({ runtime: { emit () {} }, manifest: manifest() })
  const result = mirror.observe({ channel: 'transport:network', direction: 'inbound', phase: 'play', data: packSimpleChannel(0, exampleBody()) })
  assert.equal(result.status, 'envelope-only')
  assert.equal(mirror.getReport().counts.opaque, 1)
  assert.equal(mirror.getReport().counts.stored, 0)
  assert.equal(mirror.getReport().counts.decoded, 0)
})
test('P3.1 decoder rejects corrupt type values without poisoning subsequent valid packet', () => {
  const mirror = new ConfigSyncMirror({ runtime: { emit () {} }, manifest: manifest() })
  mirror.schemas.set('examplenet', exampleSchema())
  const invalid = exampleBody()
  const i = invalid.indexOf(Buffer.from('enabled')) + 'enabled'.length
  invalid[i] = 2 // invalid boolean
  const bad = mirror.observe({ channel: 'transport:network', direction: 'inbound', phase: 'play', data: packSimpleChannel(0, invalid) })
  assert.equal(bad.status, 'rejected')
  assert.equal(mirror.getReport().counts.rejected, 1)
  const ok = mirror.observe({ channel: 'transport:network', direction: 'inbound', phase: 'play', data: packSimpleChannel(0, exampleBody()) })
  assert.equal(ok.status, 'config-decoded')
  assert.equal(mirror.getReport().counts.stored, 1)
})
test('P3.1 empty JAR directory produces no config schema claims', t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-empty-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(extractConfigSchemas(dir).size, 0)
})
