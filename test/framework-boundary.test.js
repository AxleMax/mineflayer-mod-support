'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const plugin = require('..')
const { ModSupportRuntime } = plugin
const { WireWriter } = require('../src/protocol/forge/wire')

function client () {
  const c = new EventEmitter(); c.version = '1.20.1'; c.state = 'play'; c.writes = []
  c.write = (name, data) => c.writes.push({ name, data })
  return c
}
function botFor (runtime, nativeInventory = false) {
  const bot = new EventEmitter()
  bot.registry = require('prismarine-registry')('1.20.1'); bot.version = '1.20.1'
  bot.supportFeature = bot.registry.supportFeature; bot._client = client()
  bot.QUICK_BAR_START = 36; bot.QUICK_BAR_END = 44; bot.entity = { id: 1 }; bot.game = { gameMode: 'survival' }
  runtime.attachBot(bot); runtime.attachClient(bot._client)
  if (nativeInventory) require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  return bot
}
function adapter (setup, extra = {}) { return { id: 'holdout', apiVersion: 1, setup, ...extra } }

test('plugin exposes data/protocol support without a duplicate native gameplay API', () => {
  const r = new ModSupportRuntime(), bot = botFor(r)
  const equip = async () => {}; bot.equip = equip
  assert.equal(plugin.NativeItemOperations, undefined); assert.equal(r.itemOperations, undefined)
  assert.equal(r.forgeContainers.close, undefined); assert.equal(bot.equip, equip)
  assert.equal(bot._client.writes.length, 0)
  r.destroy(); r.destroy()
  assert.equal(bot.equip, equip)
  assert.throws(() => new ModSupportRuntime({ nativeItemOperations: { enabled: true } }), /use native bot.equip/)
})

test('independent loader module owns its hooks and installs normalized registry data without Forge runtime', () => {
  const log = [], definition = { id: 'holdout-protocol', apiVersion: 1, create: () => ({
    id: 'holdout-protocol', apiVersion: 1,
    onState: state => log.push(state),
    transformOutgoing: (name, data) => name === 'fixture' ? { action: 'replace', data: { ...data, transformed: true } } : { action: 'passthrough' },
    observeInbound: packet => log.push(packet.name),
    destroy: () => log.push('disposed')
  }) }
  const r = new ModSupportRuntime({ loaderProtocol: definition }), bot = botFor(r)
  assert.equal(r.fml3, undefined); assert.equal(r.nativeChannels, undefined)
  r.installRegistry({ name: 'minecraft:item', entries: [{ id: 60000, name: 'holdout:gem' }], source: 'fixture-protocol' })
  assert.equal(bot.registry.items[60000].name, 'holdout:gem')
  assert.equal(r.nativeRegistry.resolve('item', 60000).source, 'fixture-protocol')
  assert.equal(r.modData.resolveRegistry('minecraft:item', 60000).source, 'fixture-protocol')
  bot._client.write('fixture', { value: 2 })
  assert.deepEqual(bot._client.writes[0].data, { value: 2, transformed: true })
  bot._client.emit('packet', {}, { name: 'fixture_received', state: 'play' })
  r.captureProtocolState('login', 'handshaking')
  assert.ok(log.includes('fixture_received')); assert.ok(log.includes('login'))
  assert.throws(() => r.registerModAdapter({}), /capability_unavailable/)
  r.captureEnd('test'); r.destroy()
  assert.equal(log.filter(v => v === 'disposed').length, 1)
})

test('Fabric and NeoForge are not advertised as implemented modules', () => {
  for (const loaderProtocol of ['fabric', 'neoforge', { id: 'bad', apiVersion: 2, create () {} }]) {
    assert.throws(() => new ModSupportRuntime({ loaderProtocol }), /unsupported_loader_protocol/)
  }
})

test('scoped adapter data does not fabricate server IDs or advertise installed Java Mods', () => {
  const r = new ModSupportRuntime({ experimental: { fml3Runtime: true } }), bot = botFor(r)
  const off = r.use(adapter(ctx => {
    assert.equal(ctx.bot, undefined); assert.equal(ctx.equip, undefined)
    ctx.defineItem('holdout:gem', { stackSize: 64, displayName: 'Gem' })
    ctx.defineEntity('holdout:actor', { width: 0.4, height: 1.2 })
  }))
  assert.equal(r.nativeRegistry.resolve('item', 'holdout:gem'), null)
  assert.deepEqual(r.nativeChannels.getAdvertisedMods(), [])
  r.installRegistry({ name: 'minecraft:item', entries: [{ id: 60000, name: 'holdout:gem' }] })
  r.installRegistry({ name: 'minecraft:entity_type', entries: [{ id: 60000, name: 'holdout:actor' }] })
  assert.equal(bot.registry.items[60000].stackSize, 64)
  assert.equal(bot.registry.items[60000]._modSupport.metadataSource, 'adapter:holdout')
  assert.equal(bot.registry.entities[60000].height, 1.2)
  off(); off()
  assert.equal(bot.registry.items[60000].stackSize, 1)
  assert.equal(bot.registry.entities[60000].height, undefined)
  r.destroy()
})

test('adapter setup failure rolls back definitions, codecs and event handlers', () => {
  const r = new ModSupportRuntime(), before = r.listenerCount('probe')
  assert.throws(() => r.use(adapter(ctx => {
    ctx.defineItem('holdout:gem', { stackSize: 64 })
    ctx.registerProtocolCodec('recipe', 'holdout:recipe', 'varint')
    ctx.on('probe', () => {})
    throw new Error('setup failed')
  })), /setup failed/)
  assert.equal(r.contentDefinitions.get('item', 'holdout:gem'), null)
  assert.equal(r.protocolCodecs.recipes.has('holdout:recipe'), false)
  assert.equal(r.listenerCount('probe'), before)
  assert.deepEqual(r.adapters.getReport().active, [])
  r.destroy()
})

test('adapter end cleanup runs once and detached contexts cannot register or send', () => {
  const r = new ModSupportRuntime(); let context, cleanups = 0, events = 0
  const off = r.use(adapter(ctx => {
    context = ctx; ctx.on('probe', () => events++)
    ctx.onChannel('holdout:wire', () => {})
    return () => cleanups++
  }))
  r.emit('probe'); r.captureEnd('test'); r.emit('probe'); r.destroy(); off()
  assert.equal(cleanups, 1); assert.equal(events, 1)
  assert.throws(() => context.defineItem('holdout:gem', { stackSize: 64 }), /scope_disposed/)
  assert.throws(() => context.sendMessage('holdout:wire', 0, {}), /scope_disposed/)
})

test('adapter cleanup errors remain observable while other registrations are released', () => {
  const r = new ModSupportRuntime(); let observed
  r.on('adapterCleanupError', event => { observed = event })
  r.use(adapter(ctx => { ctx.on('probe', () => {}); return () => { throw Error('cleanup failed') } }))
  r.destroy()
  assert.equal(observed.id, 'holdout'); assert.equal(r.listenerCount('probe'), 0)
  assert.equal(r.adapters.getReport().cleanupFailures, 1)
})

test('async adapter setup is rejected and its already-created resources are rolled back', async () => {
  const r = new ModSupportRuntime()
  assert.throws(() => r.use(adapter(async ctx => {
    ctx.defineItem('holdout:gem', { stackSize: 64 })
  })), /setup_must_be_synchronous/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.contentDefinitions.getReport().definitions.length, 0)
  assert.deepEqual(r.adapters.getReport().active, [])
  r.destroy()
})

test('adapter loader/version constraints and malformed metadata fail before registration', () => {
  const r = new ModSupportRuntime(), bot = botFor(r)
  assert.throws(() => r.use(adapter(() => {}, { loaderProtocols: ['other'] })), /loader_protocol_mismatch/)
  assert.throws(() => r.use(adapter(() => {}, { minecraftVersions: ['1.21'] })), /version_mismatch/)
  assert.throws(() => r.use(adapter(ctx => ctx.defineItem('holdout:gem', { stackSize: 0 }))), /invalid_item_stack_size/)
  assert.throws(() => r.use(adapter(ctx => ctx.defineMenu('holdout:menu', { containerSlots: 9 }))), /unsupported_menu_layout/)
  assert.equal(r.contentDefinitions.getReport().definitions.length, 0)
  assert.equal(bot._client.writes.length, 0)
  r.destroy()
})

test('native window split keeps Mod identity, count and NBT using the per-bot Item class', () => {
  const r = new ModSupportRuntime(), bot = botFor(r, true)
  const globalRegistry = require('prismarine-registry')('1.20.1'), globalItem = globalRegistry.items[60000]
  r.installRegistry({ name: 'minecraft:item', entries: [{ id: 60000, name: 'holdout:gem' }] })
  const Item = require('prismarine-item')(bot.registry)
  const nbt = { type: 'compound', name: '', value: { probe: { type: 'string', value: 'unaltered' } } }
  bot.inventory.updateSlot(9, new Item(60000, 7, 0, nbt))
  const originalItem = bot.inventory.slots[9]
  assert.equal(originalItem.stackSize, 1)
  r.use(adapter(ctx => { ctx.defineItem('holdout:gem', { stackSize: 64 }) }))
  assert.equal(bot.inventory.slots[9], originalItem); assert.equal(originalItem.stackSize, 64)
  bot.inventory.acceptClick({ mode: 0, slot: 9, mouseButton: 1, item: bot.inventory.slots[9] })
  assert.equal(bot.inventory.selectedItem.name, 'holdout:gem')
  assert.equal(bot.inventory.selectedItem.count, 4); assert.equal(bot.inventory.slots[9].count, 3)
  assert.equal(bot.inventory.selectedItem.stackSize, 64); assert.deepEqual(bot.inventory.selectedItem.nbt, nbt)
  assert.equal(globalRegistry.items[60000], globalItem)
  assert.equal(r.nativeWindows.getReport().projectedWindows, 1)
  r.destroy(); assert.equal(r.nativeWindows.getReport().projectedWindows, 0)
  assert.equal(Object.getOwnPropertyDescriptor(bot, 'inventory').get, undefined)
})

test('declared Mod menu data opens through native Mineflayer and closes via bot.closeWindow', async () => {
  const r = new ModSupportRuntime({ experimental: { fml3Runtime: true } }), bot = botFor(r, true)
  r.installRegistry({ name: 'minecraft:menu', entries: [{ id: 90, name: 'holdout:machine' }] })
  r.use(adapter(ctx => { ctx.defineMenu('holdout:machine', { containerSlots: 9, playerInventory: 'appended-36', standardClick: true }) }))
  const payload = new WireWriter().byte(1).varInt(90).varInt(5).string('{"text":"Machine"}').varInt(0).finish()
  const opened = new Promise(resolve => bot.once('windowOpen', resolve))
  r.emit('payload', { channel: 'fml:play', direction: 'inbound', phase: 'play', data: payload })
  bot._client.emit('window_items', { windowId: 5, stateId: 1, items: new Array(45).fill({ present: false }), carriedItem: { present: false } })
  const window = await opened
  assert.equal(window.type, 'holdout:machine'); assert.equal(window.inventoryStart, 9); assert.equal(window.slots.length, 45)
  await bot.closeWindow(window)
  assert.equal(bot._client.writes.at(-1).name, 'close_window'); assert.equal(bot.currentWindow, null)
  assert.equal(r.forgeContainers.getCurrent(), null); assert.equal(r.nativeWindows.getReport().projectedWindows, 1)
  r.destroy()
})

test('repeated native window replacement releases old projections and leaves other bots unchanged', () => {
  const r = new ModSupportRuntime(), bot = botFor(r, true)
  const upstream = require('prismarine-windows')('1.20.1')
  for (let i = 0; i < 100; i++) {
    const window = upstream.createWindow(i + 1, 'minecraft:generic_9x3', 'Probe')
    const original = Object.getPrototypeOf(window)
    bot.currentWindow = window
    assert.notEqual(Object.getPrototypeOf(window), original)
    assert.equal(r.nativeWindows.getReport().projectedWindows, 2)
    bot.currentWindow = null
    assert.equal(Object.getPrototypeOf(window), original)
    assert.equal(r.nativeWindows.getReport().projectedWindows, 1)
  }
  assert.equal(Object.getPrototypeOf(upstream.createWindow(200, 'minecraft:generic_9x3', 'Other')), upstream.Window.prototype)
  r.destroy()
})
