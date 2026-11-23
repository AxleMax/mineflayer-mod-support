'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { ServerRegistryMappings } = require('../src/runtime/registry-mappings')
const { NativeRegistryBridge } = require('../src/runtime/native-registry-bridge')
const { ModSupportRuntime } = require('../src/core/runtime')

function install (mappings, registryName, ids, aliases = [], blocked = []) {
  return mappings.install({ registryName, hasSnapshot: true, entriesDecoded: true,
    snapshot: { ids, aliases, blocked, overrides: [] } })
}
const mockBase = () => ({
  version: { minecraftVersion: '1.20.1' },
  supportFeature: () => true,
  items: [{ id: 0, name: 'air', displayName: 'Air', stackSize: 64 }, { id: 1, name: 'stone', displayName: 'Stone', stackSize: 64 }],
  itemsByName: { air: { id: 0, name: 'air', displayName: 'Air', stackSize: 64 }, stone: { id: 1, name: 'stone', displayName: 'Stone', stackSize: 64 } },
  itemsById: {}, blocksByStateId: { 0: { id: 0, name: 'air' } },
  blocks: [{ id: 0, name: 'air' }], entitiesByName: { pig: { id: 1 } }
})
const mockBot = (base = mockBase()) => { const b = new EventEmitter(); b.registry = base; return b }

test('P2.6 overlays actual prismarine-item lookup tables without changing the shared base', () => {
  const mappings = new ServerRegistryMappings()
  const original = mockBase()
  const bot = mockBot(original)
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  assert.notEqual(bot.registry, original)
  install(mappings, 'minecraft:item', [
    { name: 'minecraft:stone', id: 13 }, { name: 'alpha:machine', id: 4001 }
  ])
  bridge.syncRegistry('minecraft:item')
  assert.equal(bot.registry.items[13].name, 'stone')
  assert.equal(bot.registry.items[13].stackSize, 64)
  assert.equal(bot.registry.itemsByName['minecraft:stone'].id, 13)
  assert.equal(bot.registry.itemsByName.stone.id, 13)
  assert.equal(bot.registry.items[4001].name, 'alpha:machine')
  assert.equal(bot.registry.itemsByName['alpha:machine'].id, 4001)
  assert.equal(bot.registry.items[4001].stackSize, 1)
  assert.equal(bot.registry.items[4001]._modSupport.metadataComplete, false)
  assert.equal(bot.registry.items[1], undefined) // no vanilla ID collision after server remap
  assert.equal(original.items[1].name, 'stone') // original object/arrays untouched
  assert.equal(original.items[13], undefined)
  assert.equal(original.itemsByName.stone.id, 1)
  assert.deepEqual(bridge.describeItemStack({ type: 4001, count: 7 }).name, 'alpha:machine')
  assert.equal(bridge.describeItemStack({ type: 4001, count: 7 }).stackOperationsVerified, false)
  bridge.destroy()
  assert.equal(bot.registry, original)
})

test('P2.6 per-bot isolation holds even when bots share the same base minecraft-data', () => {
  const base = mockBase()
  const mappings1 = new ServerRegistryMappings()
  const mappings2 = new ServerRegistryMappings()
  const bot1 = mockBot(base); const bot2 = mockBot(base)
  const p1 = new NativeRegistryBridge({ mappings: mappings1 }).attachBot(bot1)
  const p2 = new NativeRegistryBridge({ mappings: mappings2 }).attachBot(bot2)
  install(mappings1, 'minecraft:item', [{ name: 'alpha:gem', id: 35 }])
  install(mappings2, 'minecraft:item', [{ name: 'beta:gem', id: 35 }])
  p1.syncRegistry('minecraft:item'); p2.syncRegistry('minecraft:item')
  assert.equal(bot1.registry.items[35].name, 'alpha:gem')
  assert.equal(bot2.registry.items[35].name, 'beta:gem')
  assert.equal(base.items[35], undefined)
  assert.equal(p1.resolve('item', 35).name, 'alpha:gem')
  assert.equal(p2.resolve('item', 'alpha:gem'), null)
  p1.destroy(); p2.destroy()
})

test('P2.6 inject_allowed runs overlay before internal plugin Item factory initialization', () => {
  const mappings = new ServerRegistryMappings()
  const bot = new EventEmitter()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  const original = mockBase()
  bot.registry = original // Mineflayer loader's late assignment
  let loadedRegistry
  bot.on('inject_allowed', () => { loadedRegistry = bot.registry })
  install(mappings, 'minecraft:item', [{ name: 'alpha:foo', id: 1300 }])
  bot.emit('inject_allowed')
  assert.notEqual(loadedRegistry, original)
  assert.equal(loadedRegistry.items[1300].name, 'alpha:foo')
  assert.equal(bot.registry, loadedRegistry)
  bridge.destroy()
})

test('P2.6 emits updates in place: item factories retaining the view see subsequent Forge installs', () => {
  const mappings = new ServerRegistryMappings()
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  const capturedReference = bot.registry
  install(mappings, 'minecraft:item', [{ name: 'alpha:old', id: 1350 }])
  bridge.syncRegistry('minecraft:item')
  install(mappings, 'minecraft:item', [{ name: 'alpha:new', id: 1350 }])
  bridge.syncRegistry('minecraft:item')
  assert.equal(capturedReference, bot.registry)
  assert.equal(capturedReference.items[1350].name, 'alpha:new')
  assert.equal(capturedReference.itemsByName['alpha:old'], undefined)
  assert.equal(bridge.getReport().itemVersion, 2)
  bridge.destroy()
})

test('P2.6 aliases are resolvable but never fabricate duplicate numeric item IDs', () => {
  const mappings = new ServerRegistryMappings()
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  install(mappings, 'minecraft:item', [{ name: 'alpha:new_gem', id: 3900 }], [{ from: 'alpha:old_gem', to: 'alpha:new_gem' }])
  bridge.syncRegistry('minecraft:item')
  assert.equal(bridge.resolve('item', 'alpha:old_gem').id, 3900)
  assert.equal(bot.registry.itemsByName['alpha:old_gem'], undefined) // explicit mapping API only
  bridge.destroy()
})

test('P2.6 block and entity Registry IDs exposed as types, not as unknown block state IDs', () => {
  const mappings = new ServerRegistryMappings()
  const original = mockBase()
  const bot = mockBot(original)
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  install(mappings, 'minecraft:block', [{ name: 'alpha:machine_block', id: 1234 }])
  install(mappings, 'minecraft:entity_type', [{ name: 'alpha:robot', id: 72 }])
  bridge.syncRegistry('minecraft:block'); bridge.syncRegistry('minecraft:entity_type')
  assert.equal(bridge.resolve('block', 1234).name, 'alpha:machine_block')
  assert.equal(bridge.resolve('block', 1234).stateIdsKnown, false)
  assert.equal(bridge.describeEntity({ entityType: 72 }).name, 'alpha:robot')
  assert.equal(bridge.describeEntity({ id: 72 }), null) // numeric runtime entity ID is not a type ID
  assert.notEqual(bot.registry.blocksByStateId, original.blocksByStateId)
  assert.deepEqual(bot.registry.blocksByStateId[0], original.blocksByStateId[0])
  assert.notEqual(bot.registry.blocks, original.blocks)
  assert.equal(bot.registry.blocksByStateId[1234], undefined)
  assert.notEqual(bot.registry.entitiesByName, original.entitiesByName)
  assert.equal(bot.registry.entities[72].name, 'alpha:robot')
  assert.equal(original.entitiesByName['alpha:robot'], undefined)
  bridge.destroy()
})

test('P2.6 entitySpawn annotates safely when a numeric type ID is available', () => {
  const mappings = new ServerRegistryMappings()
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  install(mappings, 'minecraft:entity_type', [{ name: 'alpha:robot', id: 42 }])
  bridge.syncRegistry('minecraft:entity_type')
  const entity = { entityType: 42, id: 900, type: 'unknown' }
  bot.emit('entitySpawn', entity)
  assert.equal(entity.modSupportRegistryType.name, 'alpha:robot')
  assert.equal(entity.type, 'unknown') // no fake Mineflayer entity semantics
  assert.equal(entity.id, 900)
  const unknown = { entityType: 90, id: 41 }
  bot.emit('entitySpawn', unknown)
  assert.equal(unknown.modSupportRegistryType, undefined)
  bridge.destroy()
})

test('P2.6 extreme Registry item IDs disable native array overlay without rejecting FML3 Registry mapping', () => {
  const mappings = new ServerRegistryMappings()
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  install(mappings, 'minecraft:item', [{ name: 'alpha:huge_id', id: 2147483647 }])
  assert.equal(bridge.syncRegistry('minecraft:item').itemOverlayInstalled, false)
  assert.equal(bridge.resolve('item', 'alpha:huge_id').id, 2147483647)
  assert.equal(bridge.resolve('item', 'alpha:huge_id').nativeItemIndexInstalled, false)
  assert.equal(bot.registry.items[2147483647], undefined)
  bridge.destroy()
})

test('P2.6 invalid Registry snapshot cannot partially corrupt a previously installed item table', () => {
  const mappings = new ServerRegistryMappings()
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  install(mappings, 'minecraft:item', [{ name: 'alpha:first', id: 456 }])
  bridge.syncRegistry('minecraft:item')
  const prior = bot.registry.items
  assert.throws(() => install(mappings, 'minecraft:item', [{ name: 'alpha:second', id: 456 }, { name: 'alpha:second', id: 789 }]), /invalid_registry_id_entry/)
  assert.equal(bot.registry.items, prior)
  assert.equal(bridge.resolve('item', 456).name, 'alpha:first')
  bridge.destroy()
})

test('P2.6 real runtime installs item overlay on Forge Registry application, not on a fake login or discovery', () => {
  const runtime = new ModSupportRuntime()
  const bot = mockBot()
  runtime.attachBot(bot)
  runtime.fml3Controller.applyRegistry({ registryName: 'minecraft:item', hasSnapshot: true, entriesDecoded: true,
    snapshot: { ids: [{ name: 'alpha:gear', id: 9999 }], aliases: [], overrides: [], blocked: [] } }, 7)
  assert.equal(bot.registry.items[9999].name, 'alpha:gear')
  assert.equal(runtime.nativeRegistry.getReport().nativeItemOverlayActive, true)
  assert.equal(runtime.snapshot().nativeRegistry.counts.itemEntries, 1)
  runtime.destroy()
})

test('P2.6 native item overlay can be explicitly disabled without disabling numeric registry lookups', () => {
  const mappings = new ServerRegistryMappings()
  const base = mockBase()
  const bot = mockBot(base)
  const bridge = new NativeRegistryBridge({ mappings, itemOverlay: false, entityOverlay: false, blockOverlay: false }).attachBot(bot)
  install(mappings, 'minecraft:item', [{ name: 'alpha:gem', id: 800 }])
  bridge.syncRegistry('minecraft:item')
  assert.equal(bot.registry, base)
  assert.equal(bridge.resolve('item', 800).name, 'alpha:gem')
  assert.equal(bridge.resolve('item', 800).nativeItemIndexInstalled, false)
  bridge.destroy()
})

test('P2.6 reports actual historical Mohist item and entity names if the uploaded capture is present', () => {
  const source = '/mnt/data/forge-p21-config-sync-probe.json'
  if (!fs.existsSync(source)) return
  const report = JSON.parse(fs.readFileSync(source, 'utf8'))
  const mappings = new ServerRegistryMappings()
  for (const msg of report.evidence.fmlHandshake.filter(x => x.type === 'S2CRegistry' && x.details?.entriesDecoded)) {
    mappings.install(msg.details, msg.messageId)
  }
  const bot = mockBot()
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  assert.equal(bridge.resolve('item', 'waystones:warp_stone').id, 1283)
  assert.equal(bot.registry.items[1283].name, 'waystones:warp_stone')
  // The historical detailed report omits 1 of 19 registries: entity_type.
  // The bridge must NOT invent its missing entries.
  assert.equal(bridge.resolve('entity', 'minecraft:pig'), null)
  assert.equal(bridge.resolve('block', 'waystones:black_sharestone').id, 1027)
  assert.equal(bridge.getReport().registries.item, 1287)
  assert.equal(bridge.getReport().counts.unknownItemMetadata > 0, true)
  bridge.destroy()
})
