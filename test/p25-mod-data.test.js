'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { analyzeJars } = require('../src/analyzer/mod-jar')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')
const { validateManifest } = require('../src/runtime/compatibility')
const { EventEmitter } = require('node:events')
const { GenericModDataRuntime, buildProjectionSpec } = require('../src/runtime/mod-data')
const { ServerRegistryMappings } = require('../src/runtime/registry-mappings')
const { GenericPacketDispatcher } = require('../src/runtime/packet-dispatcher')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')
const { ModSupportRuntime } = require('../src/core/runtime')
const { CompatibilityRuntime } = require('../src/runtime/compatibility')
const { projectData } = require('../examples/forge-p25-data-replay')

const element = { type: 'struct', fields: [
  { name: 'uid', codec: { type: 'uuid' } },
  { name: 'title', codec: { type: 'utf' } },
  { name: 'position', codec: { type: 'blockpos' } },
  { name: 'origin', codec: { type: 'enum', values: ['WORLD', 'PLAYER'], ordinalType: 'varint' } }
] }
const plan = { schema: 'mineflayer-mod-support/codec-ir/v1', root: { type: 'struct', fields: [
  { name: 'group', codec: { type: 'resource_location' } },
  { name: 'entries', codec: { type: 'list', lengthType: 'short', maxItems: 20, element: { type: 'ref', name: 'Entry' } } }
] }, definitions: { Entry: element } }
const message = (channel = 'alpha:wire') => ({ id: channel.replace(':wire', ':group'), direction: 'clientbound', codecStatus: 'structural-candidate', predictedChannel: channel, predictedDiscriminator: 7, codecPlan: plan })
const uuid1 = '00000000-0000-0000-0000-000000000001'
const uuid2 = '00000000-0000-0000-0000-000000000002'
const sample = (uid = uuid1) => ({ uid, title: 'A', position: { x: 20, y: 64, z: -3 }, origin: 'PLAYER' })

function ingest (model, channel, group, entries, status = 'structural-only') {
  return model.observe({ channel, discriminator: 7, id: channel.replace(':wire', ':group'), status, decoded: true,
    evidence: 'offline-wire-replay', appliedToModRuntime: false, entityKey: group, data: { group, entries } })
}

test('P2.5 generic IR derives collection and object descriptions without Mod IDs', () => {
  assert.equal(buildProjectionSpec(message()).kind, 'collection')
  assert.equal(buildProjectionSpec(message()).itemKeyField, 'uid')
  const refPlan = { schema: plan.schema, root: { type: 'struct', fields: [{ name: 'item', codec: { type: 'ref', name: 'Entry' } }] }, definitions: { Entry: element } }
  assert.equal(buildProjectionSpec({ ...message(), codecPlan: refPlan }).kind, 'object')
})

test('P2.5 two namespaces retain independent nonempty collection snapshots and stable UUID access', () => {
  const manifest = { messages: [message('alpha:wire'), message('beta:wire')] }
  const model = new GenericModDataRuntime({ manifest })
  const codec = compileCodecPlan(plan)
  for (const channel of ['alpha:wire', 'beta:wire']) {
    const emitter = new EventEmitter()
    const dispatcher = new GenericPacketDispatcher(emitter)
    emitter.on('nativeChannelCandidate', e => model.observe({ ...e, decoded: true, evidence: 'offline-wire-replay' }))
    assert.equal(dispatcher.registerCandidate(message(channel)), true)
    const input = { group: 'test:group', entries: [sample(), sample(uuid2)] }
    const bytes = Buffer.concat([Buffer.from([7]), codec.encode(input)])
    const result = dispatcher.observe({ channel, direction: 'inbound', phase: 'play', data: bytes })
    assert.equal(result.roundTripExact, true)
    assert.equal(result.status, 'structural-only')
    const collection = model.getCollection(channel, 7, 'test:group')
    assert.equal(collection.itemCount, 2)
    assert.equal(model.getCollectionItem(channel, 7, 'test:group', uuid1).position.y, 64)
    assert.equal(model.getCollectionItem(channel, 7, 'test:group', uuid2).origin, 'PLAYER')
    assert.equal(collection.appliedToModRuntime, false)
  }
  assert.equal(model.getReport().projectionCount, 2)
  assert.equal(model.getReport().canAdvertiseModChannels, false)
})

test('P2.5 new observations replace the same collection without claiming Mod client application', () => {
  const model = new GenericModDataRuntime({ manifest: { messages: [message()] } })
  ingest(model, 'alpha:wire', 'test:group', [sample()])
  ingest(model, 'alpha:wire', 'test:group', [])
  assert.equal(model.getCollection('alpha:wire', 7, 'test:group').value.length, 0)
  assert.equal(model.getCollectionItem('alpha:wire', 7, 'test:group', uuid1), null)
  assert.equal(model.getReport().projectionCount, 1)
  assert.equal(model.getReport().counts.observedCollections, 2)
})

test('P2.5 getters are detached and unknown/unresolved messages fail closed', () => {
  const model = new GenericModDataRuntime({ manifest: { messages: [message()] } })
  const first = ingest(model, 'alpha:wire', 'test:group', [sample()])
  first.value[0].title = 'mutated'
  assert.equal(model.getCollectionItem('alpha:wire', 7, 'test:group', 0).title, 'A')
  assert.equal(ingest(model, 'alpha:wire', 'test:group', Array.from({length: 257}, (_,i) => sample(uuid1))), null)
  assert.equal(model.getReport().counts.rejected, 1)
  assert.equal(model.getCollection('alpha:wire', 7, 'test:group').itemCount, 1)
  const falseSpec = { ...message(), codecStatus: 'unresolved' }
  assert.equal(buildProjectionSpec(falseSpec), null)
  assert.equal(model.observe({ channel: 'bad:wire', discriminator: 7, id: 'bad:group', status: 'envelope-only', decoded: false, data: { resourceLocation: 'x:y' } }), null)
  assert.equal(model.getReport().counts.skipped, 1)
})

test('P2.5 object observations remain separate from collections and are keyed by nested UUID', () => {
  const refPlan = { schema: plan.schema, root: { type: 'struct', fields: [{ name: 'item', codec: { type: 'ref', name: 'Entry' } }] }, definitions: { Entry: element } }
  const objectMessage = { ...message('gamma:wire'), predictedDiscriminator: 6, codecPlan: refPlan }
  const model = new GenericModDataRuntime({ manifest: { messages: [objectMessage] } })
  const saved = model.observe({ channel: 'gamma:wire', discriminator: 6, id: 'gamma:group', status: 'structural-only', decoded: true, entityKey: null, data: { item: sample() } })
  assert.equal(saved.kind, 'object')
  assert.equal(model.getObject('gamma:wire', 6, uuid1).value.title, 'A')
  assert.equal(model.getObject('gamma:wire', 6, uuid2), null)
})

test('P2.5 Registry view provides real name/ID overlay without mutating Mineflayer metadata', () => {
  const registry = new ServerRegistryMappings()
  registry.install({ registryName: 'minecraft:item', hasSnapshot: true, entriesDecoded: true, snapshot: {
    ids: [{ name: 'alpha:gem', id: 10042 }], aliases: [{ from: 'alpha:old_gem', to: 'alpha:gem' }], overrides: [], blocked: []
  } })
  const model = new GenericModDataRuntime({ registryMappings: registry })
  assert.deepEqual(model.resolveRegistry('minecraft:item', 'alpha:old_gem'), { registry: 'minecraft:item', id: 10042, name: 'alpha:gem', source: 'server-registry', appliedToMineflayer: false })
  assert.deepEqual(model.resolveRegistry('minecraft:item', 10042).name, 'alpha:gem')
  assert.equal(model.resolveRegistry('minecraft:item', 15), null)
  assert.equal(model.getReport().registryView.appliedToMineflayer, false)
})

test('P2.5 runtime wires known decoded events to the generic data layer', () => {
  const runtime = new ModSupportRuntime()
  const spec = buildProjectionSpec(message())
  runtime.modData._specs.set('alpha:wire\0' + spec.discriminator, spec)
  let emitted = 0
  runtime.on('modDataObserved', e => { emitted++; assert.equal(e.kind, 'collection') })
  runtime.emit('nativeChannelCandidate', { channel: 'alpha:wire', discriminator: 7, id: 'alpha:group', status: 'structural-only', entityKey: 'test:group', data: { group: 'test:group', entries: [sample()] } })
  assert.equal(runtime.modData.getCollection('alpha:wire', 7, 'test:group').itemCount, 1)
  assert.equal(runtime.modData.getReport().counts.observedCollections, 1)
  assert.equal(emitted, 1)
  assert.equal(runtime.snapshot().modData.projectionCount, 1)
  runtime.destroy()
})

test('P2.5 real-JAR-generated nested Waystone IR handles synthetic nonempty object lists', () => {
  const balm = process.env.MMR_BALM_JAR || '/mnt/data/balm-forge-1.20.1-7.3.44.jar'
  const waystones = process.env.MMR_WAYSTONES_JAR || '/mnt/data/waystones-forge-1.20.1-14.1.21.jar'
  if (!fs.existsSync(balm) || !fs.existsSync(waystones)) return
  const manifest = validateManifest(createCompatibilityManifest(analyzeJars([balm, waystones])))
  const msg = manifest.messages.find(m => m.id === 'waystones:known_waystones')
  assert.ok(msg?.codecPlan)
  const codec = compileCodecPlan(msg.codecPlan)
  const object = { slot_0: uuid1, slot_1: 'waystones:waystone', slot_2: 'test', slot_3: false,
    slot_4: 'minecraft:overworld', slot_5: { x: 1, y: 72, z: -6 }, slot_6: 'PLAYER' }
  const input = { slot_0: 'waystones:waystone', slot_1: [object] }
  const decoded = codec.decode(codec.encode(input))
  assert.equal(decoded.slot_1.length, 1)
  assert.equal(decoded.slot_1[0].slot_5.z, -6)
  const model = new GenericModDataRuntime({ manifest })
  const observed = model.observe({ channel: msg.predictedChannel, discriminator: msg.predictedDiscriminator, id: msg.id,
    status: 'structural-only', decoded: true, entityKey: input.slot_0, evidence: 'offline-wire-replay', data: decoded })
  assert.equal(observed.itemCount, 1)
  assert.equal(model.getCollectionItem(msg.predictedChannel, msg.predictedDiscriminator, input.slot_0, uuid1).slot_6, 'PLAYER')
  assert.equal(model.getReport().canAdvertiseModChannels, false)
})

test('P2.5 imported P2.4 report projects two distinct observed list namespaces with real JARs', () => {
  const source = '/mnt/data/forge-p24-state-replay.json'
  const balm = process.env.MMR_BALM_JAR || '/mnt/data/balm-forge-1.20.1-7.3.44.jar'
  const waystones = process.env.MMR_WAYSTONES_JAR || '/mnt/data/waystones-forge-1.20.1-14.1.21.jar'
  if (!fs.existsSync(source) || !fs.existsSync(balm) || !fs.existsSync(waystones)) return
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmr-p25-'))
  const mods = path.join(tmp, 'mods'); fs.mkdirSync(mods)
  fs.copyFileSync(balm, path.join(mods, path.basename(balm)))
  fs.copyFileSync(waystones, path.join(mods, path.basename(waystones)))
  try {
    const result = projectData(JSON.parse(fs.readFileSync(source, 'utf8')), mods)
    assert.equal(result.counts.receivedStateEntries, 4)
    assert.equal(result.counts.projected, 2)
    assert.equal(result.modData.projectionCount, 2)
    assert.equal(result.modData.projections.filter(x => x.appliedToModRuntime).length, 0)
    assert.equal(result.canAdvertiseModChannels, false)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('P2.5 previously captured Forge item Registry offers real modded numeric ID/name lookup', () => {
  const file = '/mnt/data/forge-p21-config-sync-probe.json'
  if (!fs.existsSync(file)) return
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const mapping = new ServerRegistryMappings()
  const registry = (report.evidence?.fmlHandshake || []).find(x => x.type === 'S2CRegistry' && x.details?.registryName === 'minecraft:item')
  assert.ok(registry?.details?.snapshot)
  mapping.install(registry.details, registry.messageId)
  const model = new GenericModDataRuntime({ registryMappings: mapping })
  assert.deepEqual(model.resolveRegistry('minecraft:item', 'waystones:warp_stone'), {
    registry: 'minecraft:item', id: 1283, name: 'waystones:warp_stone',
    source: 'server-registry', appliedToMineflayer: false
  })
  assert.equal(model.getRegistryName('minecraft:item', 1283), 'waystones:warp_stone')
})
