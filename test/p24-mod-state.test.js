'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { ModStateStore } = require('../src/runtime/mod-state')
const { ModSupportRuntime } = require('../src/core/runtime')
const { buildStateFromReplay } = require('../examples/forge-p24-state-replay')
const { GenericPacketDispatcher } = require('../src/runtime/packet-dispatcher')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')

function record(store, channel, discriminator, entityKey, data, status = 'structural-only') {
  return store.record({ channel, discriminator, entityKey, id: channel.replace(':wire', ':update'), status, data })
}

test('P2.4 resource-indexed state retains two messages with one discriminator', () => {
  const s = new ModStateStore()
  record(s, 'alpha:wire', 7, 'alpha:one', { slot_0: 'alpha:one', slot_1: [] })
  record(s, 'alpha:wire', 7, 'alpha:two', { slot_0: 'alpha:two', slot_1: [] })
  assert.deepEqual(s.getKeys('alpha:wire', 7), ['alpha:one', 'alpha:two'])
  assert.equal(s.getLatest('alpha:wire', 7, 'alpha:one').data.slot_0, 'alpha:one')
  assert.equal(s.getLatest('alpha:wire', 7).data.slot_0, 'alpha:two')
  assert.equal(s.getApplied('alpha:wire', 7, 'alpha:one'), null)
  assert.equal(s.getReport().counts.observed, 2)
  assert.equal(s.getReport().modChannelsAdvertisable, false)
})

test('P2.4 decoded state is detached; external mutation cannot poison store', () => {
  const s = new ModStateStore()
  const value = { details: ['a', 'b'] }
  record(s, 'alpha:wire', 2, null, value)
  value.details[0] = 'changed'
  const entry = s.getLatest('alpha:wire', 2)
  entry.data.details.push('external')
  assert.deepEqual(s.getLatest('alpha:wire', 2).data.details, ['a', 'b'])
  assert.equal(s.getReport({ includeValues: true }).entries.length, 1)
})

test('P2.4 limits and payload safety fail locally without raising a network exception', () => {
  const s = new ModStateStore({ maxEntries: 2 })
  assert.ok(record(s, 'alpha:wire', 1, null, { a: 1 }))
  assert.ok(record(s, 'alpha:wire', 2, null, { a: 2 }))
  assert.ok(record(s, 'alpha:wire', 3, null, { a: 3 }))
  assert.equal(s.getLatest('alpha:wire', 1), null)
  assert.equal(s.getReport().counts.evicted, 1)
  assert.equal(record(s, 'alpha:wire', 3, null, { dangerous: Buffer.alloc(7) }), null)
  assert.equal(s.getLatest('alpha:wire', 3).data.a, 3)
  assert.equal(s.getReport().counts.rejected, 1)
  assert.throws(() => new ModStateStore({ maxBytes: NaN }), /invalid_state_byte_limit/)
  assert.throws(() => new ModStateStore({ maxEntries: -1 }), /invalid_state_entry_limit/)
})

test('P2.4 rejects untrusted getters and reserved keys without executing them', () => {
  const s = new ModStateStore()
  let invoked = false
  const v = {}
  Object.defineProperty(v, 'attack', { enumerable: true, get () { invoked = true; return 1 } })
  assert.equal(record(s, 'alpha:wire', 2, null, v), null)
  assert.equal(invoked, false)
  const poison = JSON.parse('{"__proto__":{"polluted":true}}')
  assert.equal(record(s, 'alpha:wire', 3, null, poison), null)
  assert.equal({}.polluted, undefined)
})

test('P2.4 BigInt is preserved for programmatic queries and serialized as decimal in report', () => {
  const s = new ModStateStore()
  record(s, 'alpha:wire', 9, null, { n: 9223372036854775807n }, 'candidate-only')
  assert.equal(s.getLatest('alpha:wire', 9).data.n, 9223372036854775807n)
  assert.equal(s.getReport({ includeValues: true }).entries[0].data.n, '9223372036854775807')
})

test('P2.4 observed candidates are not applied; actual Node handler is applied', () => {
  const r = new ModSupportRuntime()
  r.nativeChannels.dispatcher.registerCandidate({ id: 'alpha:message', direction: 'clientbound', codecStatus: 'candidate-codec',
    predictedChannel: 'alpha:wire', predictedDiscriminator: 9, codecSchema: [{ field: 'number', type: 'long' }] })
  let observed = 0; let applied = 0
  r.on('modStateObserved', () => observed++)
  r.on('modStateApplied', () => applied++)
  r.emit('payload', { channel: 'alpha:wire', phase: 'play', direction: 'inbound', data: Buffer.from('090000000000000009', 'hex') })
  assert.equal(r.modState.getLatest('alpha:wire', 9).data.number, 9n)
  assert.equal(r.modState.getApplied('alpha:wire', 9), null)
  const handled = []
  r.nativeChannels.registerHandler({ channel: 'beta:wire', discriminator: 3, decode (buf) { return { value: buf[0] } }, onMessage (data) { handled.push(data) } })
  r.emit('payload', { channel: 'beta:wire', phase: 'play', direction: 'inbound', data: Buffer.from([3, 42]) })
  assert.equal(r.modState.getApplied('beta:wire', 3).data.value, 42)
  assert.equal(r.modState.getReport().counts.handled, 1)
  assert.equal(observed, 1)
  assert.equal(applied, 1)
  assert.equal(r.snapshot().modState.entryCount, 2)
  r.destroy()
})

test('P2.4 dynamic schema detects a ResourceLocation key without a Mod-specific branch', () => {
  const r = new EventEmitter()
  const state = new ModStateStore()
  r.on('nativeChannelCandidate', entry => state.record(entry))
  const d = new GenericPacketDispatcher(r)
  const plan = { schema: 'mineflayer-mod-support/codec-ir/v1', root: { type: 'struct', fields: [
    { name: 'type', codec: { type: 'resource_location' } },
    { name: 'list', codec: { type: 'list', lengthType: 'short', maxItems: 10, element: { type: 'varint' } } }
  ] }, definitions: {} }
  const codec = compileCodecPlan(plan)
  for (const channel of ['alpha:wire', 'beta:wire']) {
    assert.equal(d.registerCandidate({ id: channel.replace(':wire', ':message'), direction: 'clientbound', codecStatus: 'structural-candidate', predictedChannel: channel, predictedDiscriminator: 7, codecPlan: plan }), true)
    for (const id of ['gamma:a', 'gamma:b']) {
      const p = Buffer.concat([Buffer.from([7]), codec.encode({ type: id, list: [] })])
      assert.equal(d.observe({ channel, direction: 'inbound', phase: 'play', data: p }).status, 'structural-only')
    }
  }
  assert.deepEqual(state.getKeys('alpha:wire', 7), ['gamma:a', 'gamma:b'])
  assert.deepEqual(state.getKeys('beta:wire', 7), ['gamma:a', 'gamma:b'])
  assert.equal(state.getReport().entryCount, 4)
})

test('P2.4 imported replay report can be consumed without raw bytes/JARs and never claims runtime support', () => {
  const p = '/mnt/data/forge-p23-replay.json'
  if (!fs.existsSync(p)) return
  const report = JSON.parse(fs.readFileSync(p))
  const state = buildStateFromReplay(report)
  assert.equal(state.counts.imported, 4)
  assert.equal(state.counts.skipped, 0)
  assert.equal(state.modState.entryCount, 4)
  assert.equal(state.modState.entries.filter(x => x.discriminator === 7).length, 2)
  assert.equal(state.modState.entries.filter(x => x.appliedToModRuntime).length, 0)
  assert.equal(state.canAdvertiseModChannels, false)
  assert.equal(state.modState.entries[0].decoded, false)
  assert.ok(state.modState.entries.every(x => x.evidence === 'imported-replay-report'))
})
