'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { NativeItemE2EScenario } = require('../examples/native-item-e2e-scenario')

const ID = 1500, NAME = 'example:gem'
function fixture ({ wire = true, native = true, item = true, unequipFails = false,
  equipFails = false, unequipRemoves = false, heldNotCleared = false, hidden = false,
  register = true, spawn = true } = {}) {
  const bot = new EventEmitter()
  bot.entity = spawn ? { id: 99 } : null
  let items = item ? [{ name: NAME, type: ID, count: 1, slot: 37, nbt: { password: 'never-store' } }] : []
  bot.inventory = { items: () => items }
  bot.heldItem = null
  const runtime = new EventEmitter()
  runtime.protocol = { state: 'play' }
  runtime.nativeRegistry = {
    resolve: () => register ? { name: NAME, id: ID, nativeItemIndexInstalled: true } : null
  }
  runtime.nativeInventory = { getReport: () => ({ expectedItem: { wireObserved: wire, nativeObserved: native } }) }
  let calls = 0
  bot.equip = async () => {
      calls++
      if (equipFails) throw new Error('PRIVATE server data in exception')
      bot.heldItem = hidden ? null : items[0]
      return { localHeldConfirmed: !hidden }
  }
  bot.unequip = async () => {
    if (unequipFails) throw new Error('PRIVATE server data in exception')
    if (!heldNotCleared) bot.heldItem = null
    if (unequipRemoves) items = []
  }
  const scenario = new NativeItemE2EScenario({ bot, runtime, itemName: NAME, itemWaitMs: 150, operationTimeoutMs: 150 })
  const complete = new Promise(resolve => scenario.once('complete', resolve))
  const start = () => { scenario.start(); bot.emit('spawn'); return complete }
  return { bot, runtime, scenario, start, calls: () => calls, give () {
    items = [{ name: NAME, type: ID, count: 1, slot: 37 }]
    runtime.emit('modItemObserved', { name: NAME, id: ID, slot: 37 })
  } }
}

test('P2.9 closed-loop scenario succeeds in one sequence and restores the item', async () => {
  const f = fixture()
  const stages = []
  f.scenario.on('stage', x => stages.push(x))
  const result = await f.start()
  assert.equal(result.outcome, 'passed')
  assert.equal(result.failedStage, null)
  assert.equal(result.steps.length, 8)
  assert.ok(result.steps.every(s => s.status === 'passed'))
  assert.equal(f.calls(), 2)
  assert.equal(result.inventory.initialCount, 1)
  assert.equal(result.inventory.finalCount, 1)
  assert.equal(result.itemId, ID)
  assert.equal(result.serverAuthoritativeActionVerified, false)
  assert.equal(result.modItemBehaviorVerified, false)
  assert.equal(result.evidence.wireObserved, true)
  assert.ok(stages.some(s => s.stage === 'reequip' && s.status === 'passed'))
  assert.doesNotMatch(JSON.stringify(result), /never-store|password/)
  f.scenario.destroy()
})

test('P2.9 missing item waits for real inventory update then performs full sequence', async () => {
  const f = fixture({ item: false })
  const completion = f.start()
  setImmediate(() => f.give())
  assert.equal((await completion).outcome, 'passed')
  assert.equal(f.calls(), 2)
  f.scenario.destroy()
})

test('P2.9 missing item times out and does not mutate the inventory', async () => {
  const f = fixture({ item: false })
  const r = await f.start()
  assert.equal(r.outcome, 'failed')
  assert.equal(r.failedStage, 'item_wire')
  assert.equal(r.failureCode, 'expected_item_not_received')
  assert.equal(f.calls(), 0)
  assert.equal(r.steps.find(x => x.stage === 'unequip').status, 'not_run')
  f.scenario.destroy()
})

test('P2.9 missing wire observation is a real failure, not presumed success', async () => {
  const f = fixture({ wire: false })
  const r = await f.start()
  assert.equal(r.failedStage, 'item_wire')
  assert.equal(r.failureCode, 'item_not_seen_on_wire')
  assert.equal(f.calls(), 0)
  f.scenario.destroy()
})

test('P2.9 missing registry fails before any inventory action', async () => {
  const f = fixture({ register: false })
  const r = await f.start()
  assert.equal(r.failedStage, 'forge_registry')
  assert.equal(r.failureCode, 'forge_item_registry_missing')
  assert.equal(f.calls(), 0)
  f.scenario.destroy()
})

test('P2.9 missing native confirmation fails before equip', async () => {
  const f = fixture({ native: false })
  const r = await f.start()
  assert.equal(r.failedStage, 'native_inventory')
  assert.equal(r.failureCode, 'native_item_not_verified')
  assert.equal(f.calls(), 0)
  f.scenario.destroy()
})

test('P2.9 unequip failure stops before reequip with redacted error', async () => {
  const f = fixture({ unequipFails: true })
  const r = await f.start()
  assert.equal(r.failedStage, 'unequip')
  assert.equal(r.failureCode, 'native_api_operation_failed')
  assert.equal(f.calls(), 1)
  assert.equal(r.steps.find(x => x.stage === 'reequip').status, 'not_run')
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|server data in exception/)
  f.scenario.destroy()
})

test('P2.9 detects item loss after unequip', async () => {
  const f = fixture({ unequipRemoves: true })
  const r = await f.start()
  assert.equal(r.failedStage, 'unequip')
  assert.equal(r.failureCode, 'native_item_lost_after_unequip')
  assert.equal(f.calls(), 1)
  f.scenario.destroy()
})

test('P2.9 local held not cleared fails rather than reporting a round trip', async () => {
  const f = fixture({ heldNotCleared: true })
  const r = await f.start()
  assert.equal(r.failedStage, 'unequip')
  assert.equal(r.failureCode, 'native_unequip_not_confirmed')
  f.scenario.destroy()
})

test('P2.9 failed equip stops before unequip and redacts upstream exception', async () => {
  const f = fixture({ equipFails: true })
  const r = await f.start()
  assert.equal(r.failedStage, 'equip')
  assert.equal(r.failureCode, 'native_api_operation_failed')
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/)
  f.scenario.destroy()
})

test('P2.9 missing spawn is marked as failed on abort', () => {
  const f = fixture({ spawn: false })
  f.scenario.start()
  f.scenario.abort('scenario_global_timeout')
  const r = f.scenario.getReport()
  assert.equal(r.outcome, 'failed')
  assert.equal(r.failedStage, 'play_and_spawn')
  assert.equal(r.failureCode, 'scenario_global_timeout')
  f.scenario.destroy()
})

test('P2.9 two independent bot scenarios cannot share inventory outcomes', async () => {
  const a = fixture(), b = fixture({ item: false })
  const [x,y] = await Promise.all([a.start(), b.start()])
  assert.equal(x.outcome, 'passed')
  assert.equal(y.outcome, 'failed')
  assert.equal(a.calls(), 2)
  assert.equal(b.calls(), 0)
  a.scenario.destroy();b.scenario.destroy()
})

test('P2.9 rejects unsafe/minecraft identifiers', () => {
  const f = fixture()
  assert.throws(() => new NativeItemE2EScenario({ bot: f.bot, runtime: f.runtime, itemName: 'minecraft:stone' }), /namespaced_mod_item/)
  assert.throws(() => new NativeItemE2EScenario({ bot: f.bot, runtime: f.runtime, itemName: '../foo' }), /namespaced_mod_item/)
  f.scenario.destroy()
})
