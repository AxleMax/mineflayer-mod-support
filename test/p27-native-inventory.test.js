'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ServerRegistryMappings } = require('../src/runtime/registry-mappings')
const { NativeRegistryBridge } = require('../src/runtime/native-registry-bridge')
const { NativeInventoryObserver, extractWireStack } = require('../src/runtime/native-inventory-observer')
const { ModSupportRuntime } = require('../src/core/runtime')

const itemDetails = (ids) => ({
  registryName: 'minecraft:item', hasSnapshot: true, entriesDecoded: true,
  snapshot: { ids, aliases: [], overrides: [], blocked: [] }
})
function fixture (expectedItem = 'test:gem') {
  const mappings = new ServerRegistryMappings()
  const bot = new EventEmitter()
  bot.registry = { version: { minecraftVersion: '1.20.1' }, supportFeature: () => false,
    items: [], itemsByName: {}, itemsById: {}, itemsArray: [] }
  const window = new EventEmitter()
  let items = []
  window.items = () => items
  bot.inventory = window
  mappings.install(itemDetails([{ name: 'minecraft:stone', id: 1 }, { name: 'test:gem', id: 1500 }]))
  const bridge = new NativeRegistryBridge({ mappings }).attachBot(bot)
  const observer = new NativeInventoryObserver({ bridge, enabled: true, expectedItem }).attachBot(bot)
  return { bot, window, bridge, observer, setItems (value) { items = value }, cleanup () { observer.destroy(); bridge.destroy() } }
}

test('P2.7 decoded slot shapes ignore empty items and never inspect NBT', () => {
  assert.deepEqual(extractWireStack({ present: true, itemId: 1500, itemCount: 3, nbtData: { secret: 'do not retain' } }), { type: 1500, count: 3 })
  assert.equal(extractWireStack({ present: false, itemId: 1500, itemCount: 3 }), null)
  assert.equal(extractWireStack({ present: true, itemId: -1, itemCount: 1 }), null)
  assert.equal(extractWireStack({ present: true, itemId: 1500, itemCount: 0 }), null)
})

test('P2.7 real wire packet alone does not certify native Mineflayer Item', () => {
  const f = fixture()
  const ok = f.observer.observePacket({ direction: 'inbound', phase: 'play', name: 'set_slot', data: {
    windowId: 0, slot: 36, item: { present: true, itemId: 1500, itemCount: 2, nbtData: { private: 'must never retain' } }
  } })
  assert.equal(ok, true)
  const r = f.observer.getReport()
  assert.equal(r.state, 'expected_item_wire_only')
  assert.equal(r.expectedItem.nativeObserved, false)
  assert.equal(r.expectedItem.wireObserved, true)
  assert.equal(r.wireModItems[0].id, 1500)
  assert.equal(JSON.stringify(r).includes('must never retain'), false)
  f.cleanup()
})

test('P2.7 real Mineflayer slot event with matching name emits the per-bot event', () => {
  const f = fixture()
  const received = []
  f.observer.on('modItemObserved', e => received.push(e))
  f.window.emit('updateSlot', 36, null, { type: 1500, name: 'test:gem', count: 2, nbt: { secret: 'hidden' } })
  assert.equal(received.length, 1)
  assert.equal(received[0].source, 'updateSlot')
  assert.equal(f.observer.getReport().state, 'expected_item_native_verified')
  assert.equal(JSON.stringify(f.observer.getReport()).includes('hidden'), false)
  f.cleanup()
})

test('P2.7 mismatched built Item names are reported as failures, not as supported items', () => {
  const f = fixture()
  let observed = false; let mismatch = false
  f.observer.on('modItemObserved', () => { observed = true })
  f.observer.on('modItemNameMismatch', () => { mismatch = true })
  f.window.emit('updateSlot', 36, null, { type: 1500, name: 'unknown', count: 1 })
  assert.equal(observed, false)
  assert.equal(mismatch, true)
  const r = f.observer.getReport()
  assert.equal(r.counts.nameMismatches, 1)
  assert.equal(r.expectedItem.nativeObserved, false)
  f.cleanup()
})

test('P2.7 vanilla inventory stacks and login packets are not considered Mod proof', () => {
  const f = fixture()
  f.observer.observePacket({ direction: 'inbound', phase: 'login', name: 'set_slot', data: { item: { present: true, itemId: 1500, itemCount: 1 } } })
  f.window.emit('updateSlot', 7, null, { type: 1, name: 'stone', count: 1 })
  assert.equal(f.observer.getReport().state, 'not_exercised_no_mod_item_observed')
  assert.equal(f.observer.getReport().counts.packets, 0)
  f.cleanup()
})

test('P2.7 bounded window_items capture, tracks only modded entries and never serializes raw item objects', () => {
  const f = fixture()
  f.observer.observePacket({ direction: 'inbound', phase: 'play', name: 'window_items', data: {
    windowId: 0, items: [{ present: true, itemId: 1, itemCount: 1 }, { present: true, itemId: 1500, itemCount: 4 }, null]
  } })
  const r = f.observer.getReport()
  assert.equal(r.counts.windowItemsPackets, 1)
  assert.equal(r.counts.wireStacks, 2)
  assert.equal(r.counts.modWireStacks, 1)
  assert.deepEqual(r.wireModItems.map(x => x.name), ['test:gem'])
  f.cleanup()
})

test('P2.7 lazy inventory attachment snapshots existing constructed items without a forged packet', () => {
  const f = fixture()
  f.observer.destroy()
  const observer = new NativeInventoryObserver({ bridge: f.bridge, enabled: true }).attachBot(f.bot)
  const newer = new EventEmitter()
  newer.items = () => [{ type: 1500, count: 1, name: 'test:gem' }]
  f.bot.inventory = newer
  f.bot.emit('spawn')
  assert.equal(observer.getReport().state, 'mod_item_native_verified')
  assert.equal(observer.getReport().inventoryListenerAttached, true)
  assert.equal(observer.getReport().nativeModItems[0].source, 'snapshot')
  observer.destroy(); f.bridge.destroy()
})

test('P2.7 runtime event projection starts only with an actual Item supplied by inventory', () => {
  const bot = new EventEmitter()
  bot.registry = { version: { minecraftVersion: '1.20.1' }, supportFeature: () => false, items: [], itemsByName: {} }
  const inventory = new EventEmitter(); inventory.items = () => []
  bot.inventory = inventory
  const runtime = new ModSupportRuntime({ nativeInventory: { observe: true, expectedItem: 'test:gem' } })
  runtime.attachBot(bot)
  runtime.fml3Controller.applyRegistry(itemDetails([{ name: 'test:gem', id: 1500 }]), 7)
  const received = []
  runtime.on('modItemObserved', e => received.push(e))
  runtime.nativeInventory.observePacket({ direction: 'inbound', phase: 'play', name: 'set_slot', data: { item: { present: true, itemId: 1500, itemCount: 1 } } })
  assert.equal(received.length, 0)
  inventory.emit('updateSlot', 36, null, { type: 1500, name: 'test:gem', count: 1 })
  assert.equal(received.length, 1)
  assert.equal(runtime.snapshot().nativeInventory.state, 'expected_item_native_verified')
  runtime.destroy()
  assert.equal(inventory.listenerCount('updateSlot'), 0)
})

test('P2.7 disabled by default, does not listen or capture any user inventory data', () => {
  const mappings = new ServerRegistryMappings()
  const bot = new EventEmitter(); const inv = new EventEmitter()
  inv.items = () => []
  bot.inventory = inv
  const bridge = new NativeRegistryBridge({ mappings })
  const observer = new NativeInventoryObserver({ bridge }).attachBot(bot)
  assert.equal(observer.getReport().state, 'disabled')
  assert.equal(inv.listenerCount('updateSlot'), 0)
  assert.deepEqual(observer.getReport().wireModItems, [])
  observer.destroy()
})
