'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { compileCodecPlan, flatSchemaToPlan } = require('../src/analyzer/codec-ir')
const { inferCallGraphPlan } = require('../src/analyzer/codec-inference')
const { GenericPacketDispatcher } = require('../src/runtime/packet-dispatcher')
const { validateManifest } = require('../src/runtime/compatibility')
const { ModSupportRuntime } = require('../src/core/runtime')
const { packSimpleChannel } = require('../src/protocol/forge/simple-channel')
const { analyzeJars } = require('../src/analyzer/mod-jar')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')

function nestedPlan () {
  return {
    schema: 'mineflayer-mod-support/codec-ir/v1',
    definitions: { Entry: { type: 'struct', fields: [
      { name: 'id', codec: { type: 'uuid' } },
      { name: 'priority', codec: { type: 'varint' } },
      { name: 'status', codec: { type: 'enum', ordinalType: 'varint', values: ['NEW', 'ACTIVE', 'DONE'] } },
      { name: 'label', codec: { type: 'optional', value: { type: 'utf' } } }
    ] } },
    root: { type: 'struct', fields: [
      { name: 'dimension', codec: { type: 'resource_location' } },
      { name: 'entries', codec: { type: 'list', lengthType: 'short', maxItems: 64, element: { type: 'ref', name: 'Entry' } } },
      { name: 'sequence', codec: { type: 'long' } }
    ] }
  }
}
const UID = '12345678-1234-1234-1234-123456789abc'
function value () { return { dimension: 'test:plane', entries: [
  { id: UID, priority: 99, status: 'ACTIVE', label: 'Hello' },
  { id: UID, priority: -5, status: 'DONE', label: null }
], sequence: -9007199254740993n } }

test('generic IR roundtrips nested refs, bounded short lists, enums, optional fields, signed long', () => {
  const codec = compileCodecPlan(nestedPlan())
  const buffer = codec.encode(value())
  const decoded = codec.decode(buffer)
  assert.equal(decoded.entries.length, 2)
  assert.equal(decoded.entries[1].label, null)
  assert.equal(decoded.entries[1].status, 'DONE')
  assert.equal(decoded.sequence, -9007199254740993n)
  assert.deepEqual(codec.encode(decoded), buffer)
})

test('IR rejects deeply nested schemas, prototype keys, cycles and external types', () => {
  const plan = nestedPlan()
  plan.definitions.Entry.fields[0].name = '__proto__'
  assert.throws(() => compileCodecPlan(plan), /invalid_struct_field_name/)
  plan.definitions.Entry.fields[0].name = 'id'
  plan.definitions.Entry.fields[0].codec = { type: 'ref', name: 'Entry' }
  assert.throws(() => compileCodecPlan(plan), /invalid_codec_reference/)
  plan.definitions.Entry.fields[0].codec = { type: 'eval', source: 'throw new Error()' }
  assert.throws(() => compileCodecPlan(plan), /unsupported_codec_node/)
})

test('IR enforces count, truncation, trailing bytes, invalid UTF-8, and enum bounds', () => {
  const codec = compileCodecPlan(nestedPlan())
  const buffer = codec.encode(value())
  assert.throws(() => codec.decode(buffer.subarray(0, -1)), /truncated_codec_payload/)
  assert.throws(() => codec.decode(Buffer.concat([buffer, Buffer.from([1])])), /codec_trailing_bytes/)
  assert.throws(() => codec.encode({ ...value(), entries: Array(65).fill(value().entries[0]) }), /invalid_list_value/)
  assert.throws(() => codec.encode({ ...value(), entries: [{ ...value().entries[0], status: 'UNKNOWN' }] }), /invalid_enum_value/)
  const utfCodec = compileCodecPlan(flatSchemaToPlan([{ field:'name', type:'utf' }]))
  assert.throws(() => utfCodec.decode(Buffer.from([2, 0xc3, 0x28])), /encoded data was not valid|valid UTF-8|utf-8/i)
  const enumCodec = compileCodecPlan({ schema: 'mineflayer-mod-support/codec-ir/v1', root: { type: 'enum', ordinalType: 'byte', values: ['A','B'] } })
  assert.throws(() => enumCodec.decode(Buffer.from([2])), /invalid_enum_ordinal/)
})

test('two unrelated namespaces use the exact same generic dispatch path', () => {
  const emitter = new EventEmitter()
  const dispatch = new GenericPacketDispatcher(emitter)
  const decoded = []
  emitter.on('nativeChannelCandidate', x => decoded.push(x))
  for (const [name, index] of [['apples:network', 8], ['robots:network', 3]]) {
    assert.equal(dispatch.registerCandidate({ id: name + ':test', direction: 'clientbound', codecStatus: 'candidate-codec',
      predictedChannel: name, predictedDiscriminator: index,
      codecSchema: [{ field: 'pos', type: 'blockpos' }] }), true)
    const buf = compileCodecPlan(flatSchemaToPlan([{ field: 'pos', type: 'blockpos' }])).encode({ pos: { x: 11, y: 65, z: -4 } })
    assert.equal(dispatch.observe({ channel: name, direction: 'inbound', phase: 'play', data: packSimpleChannel(index, buf) }).status, 'candidate-only')
  }
  assert.equal(decoded.length, 2)
  assert.deepEqual(decoded.map(x => x.channel), ['apples:network', 'robots:network'])
  assert.equal(dispatch.report().counters.candidate, 2)
})

test('dispatcher is fail-closed: duplicates, unsupported indexes, non-Play and malformed wire', () => {
  const emitter = new EventEmitter(); const dispatch = new GenericPacketDispatcher(emitter)
  const msg = { id:'a:m', direction:'clientbound', codecStatus:'candidate-codec', predictedChannel:'a:network', predictedDiscriminator:5, codecSchema: [] }
  assert.equal(dispatch.registerCandidate(msg), true)
  assert.equal(dispatch.registerCandidate(msg), false)
  assert.equal(dispatch.report().candidates.length, 0)
  assert.equal(dispatch.report().blockedKeys, 1)
  assert.equal(dispatch.registerCandidate(msg), false)
  assert.equal(dispatch.observe({ channel:'a:network', direction:'inbound', phase:'play', data:Buffer.from([5]) }).status, 'ignored')
  const observed = []
  const cleanup = dispatch.registerHandler({ channel:'b:network', discriminator:2, decode: b => b.length, onMessage:n => observed.push(n) })
  assert.equal(dispatch.observe({ channel:'b:network', direction:'inbound', phase:'login', data:Buffer.from([2]) }).status, 'ignored')
  assert.equal(dispatch.observe({ channel:'b:network', direction:'inbound', phase:'play', data:Buffer.from([2, 4, 3]) }).status, 'handled')
  assert.deepEqual(observed, [2])
  assert.equal(dispatch.observe({ channel:'b:network', direction:'inbound', phase:'play', data:Buffer.from([3]) }).status, 'rejected')
  cleanup()
})

test('cross-class inference yields positional structures without claiming wire compliance', () => {
  const operation = type => ({ kind:'buffer-operation', type })
  const graph = { encode: { steps: [{ kind:'static-call', target: { steps: [operation('uuid'),operation('varint')], hasBranch:false } }], hasBranch:false },
    decode: { steps: [{ kind:'static-call', target: { steps: [operation('uuid'),operation('varint')], hasBranch:false } }], hasBranch:false } }
  const out = inferCallGraphPlan(graph)
  assert.equal(out.status, 'structural-candidate')
  assert.equal(out.executable, false)
  assert.equal(out.nestedCalls, 1)
  assert.deepEqual(compileCodecPlan(out.plan).decode(compileCodecPlan(out.plan).encode({ slot_0: { slot_0: UID, slot_1: 7 } })).slot_0.slot_1, 7)
  graph.encode.steps[0].target.hasBranch = true
  assert.equal(inferCallGraphPlan(graph).status, 'blocked')
  const blocked = inferCallGraphPlan({ encode: { steps:[operation('enum')] }, decode: { steps:[operation('enum')] } })
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.reasons.some(x => x.includes('enum')))
})

test('runtime coverage is generic and never turns JAR fields into advertised Mod capabilities', () => {
  const base = {
    schema:'mineflayer-mod-support/compatibility-manifest/v1', execution:'node-only',
    generatedFrom:[{file:'x.jar',sha256:'a'.repeat(64)}],
    dependencies:[{id:'apples',version:'1.0'}],
    messages:[
      { id:'apples:update', direction:'clientbound', predictedChannel:'apples:network', predictedDiscriminator:0,
        codec:{status:'candidate-codec',candidateSchema:[{field:'pos',type:'blockpos'}]} },
      { id:'apples:config', direction:'clientbound', predictedChannel:'apples:network', predictedDiscriminator:1,
        codec:{status:'unresolved',candidateSchema:null} }
    ]
  }
  assert.equal(validateManifest(base).messages.length, 2)
  const runtime = new ModSupportRuntime({ compatibilityManifest: base })
  const cover = runtime.snapshot().nativeChannels.genericChannelCoverage
  assert.equal(cover[0].total, 2)
  assert.equal(cover[0].candidateDecoders, 1)
  assert.equal(cover[0].unresolved, 1)
  assert.equal(cover[0].canAdvertise, false)
  assert.deepEqual(runtime.nativeChannels.getAdvertisedChannels(), [])
  runtime.destroy()
})

test('real JARs: general inference surfaces unresolved cross-class reasons without fake authorization',
  { skip: !(process.env.MMR_BALM_JAR && process.env.MMR_WAYSTONES_JAR) }, () => {
    const report = analyzeJars([process.env.MMR_BALM_JAR, process.env.MMR_WAYSTONES_JAR])
    const manifest = createCompatibilityManifest(report)
    assert.equal(report.summary.networkRegistrations, 12)
    assert.equal(report.summary.candidateCodecs, 8)
    assert.equal(report.summary.crossClassCodecs, 3)
    const inferred = report.artifacts.flatMap(a => a.network.registrations).filter(r => r.codec.callGraph)
    assert.equal(inferred.length, 3)
    assert.ok(inferred.every(r => r.codec.inference && r.codec.inference.executable === false))
    const runtime = new ModSupportRuntime({ compatibilityManifest: manifest })
    assert.equal(runtime.snapshot().nativeChannels.candidateDecoders.length, 2)
    assert.ok(runtime.snapshot().nativeChannels.genericChannelCoverage.every(x => x.canAdvertise === false))
    assert.equal(runtime.snapshot().compatibility.capabilities.canJoinModded, false)
    runtime.destroy()
  })
