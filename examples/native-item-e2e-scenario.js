'use strict'

// P2.9: One controlled test-server run covers the entire native item path.
// Only equip/unequip/reequip are performed. Never activate, consume, drop, or
// fabricate a Mod item. Does not claim a server-authoritative action ACK.
const { EventEmitter } = require('node:events')
const { normalizedName } = require('../src/runtime/native-inventory-observer')

const MOD_ITEM = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const STAGES = [
  'play_and_spawn', 'forge_registry', 'item_wire', 'native_inventory',
  'equip', 'unequip', 'reequip', 'inventory_integrity'
]
const MAX_STEP_MS = 8000

class ScenarioFailure extends Error {
  constructor (code) { super(code); this.code = code }
}

function requireCondition (condition, code) {
  if (!condition) throw new ScenarioFailure(code)
}
function itemMatches (item, name, id) {
  return Boolean(item && item.type === id && normalizedName(item.name) === name &&
    Number.isSafeInteger(item.count) && item.count > 0)
}
function boundedWait (check, emitter, event, timeoutMs, onDestroy) {
  return new Promise((resolve, reject) => {
    let done = false
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      emitter.removeListener(event, inspect)
      onDestroy.delete(cancel)
    }
    const finish = (ok, value) => {
      if (done) return
      done = true
      cleanup()
      if (ok) resolve(value)
      else reject(new ScenarioFailure(value))
    }
    const inspect = () => {
      let value
      try { value = check() } catch { finish(false, 'native_inventory_inspection_failed'); return }
      if (value) finish(true, value)
    }
    const cancel = () => finish(false, 'scenario_disposed')
    emitter.on(event, inspect)
    onDestroy.add(cancel)
    timer = setTimeout(() => finish(false, 'expected_item_not_received'), timeoutMs)
    inspect()
  })
}

class NativeItemE2EScenario extends EventEmitter {
  constructor ({ bot, runtime, itemName, itemWaitMs = 20000, operationTimeoutMs = MAX_STEP_MS } = {}) {
    super()
    if (!bot || typeof bot.on !== 'function' || !runtime || typeof runtime.on !== 'function') {
      throw new TypeError('scenario_requires_bot_and_runtime')
    }
    if (typeof itemName !== 'string' || !MOD_ITEM.test(itemName) || itemName.startsWith('minecraft:')) {
      throw new TypeError('scenario_requires_namespaced_mod_item')
    }
    this.bot = bot
    this.runtime = runtime
    this.itemName = itemName
    this.itemWaitMs = Number.isInteger(itemWaitMs) && itemWaitMs >= 100 && itemWaitMs <= 90000 ? itemWaitMs : 20000
    this.operationTimeoutMs = Number.isInteger(operationTimeoutMs) && operationTimeoutMs >= 100 && operationTimeoutMs <= 30000 ? operationTimeoutMs : MAX_STEP_MS
    this.started = false
    this.completed = false
    this.startedAt = null
    this.outcome = 'waiting_for_spawn'
    this.failedStage = null
    this.failureCode = null
    this.steps = []
    this._cancel = new Set()
    this._spawnListener = () => this._begin()
    this._spawnAttached = false
    this._destroyed = false
  }

  start () {
    if (this.started || this._destroyed) return this
    this.started = true
    this.startedAt = Date.now()
    this.bot.on('spawn', this._spawnListener)
    this._spawnAttached = true
    // Can attach after a bot is already spawned (e.g., plugin loaded late).
    if (this.bot.entity && this.runtime.protocol?.state === 'play') queueMicrotask(() => this._begin())
    return this
  }

  _inventory () {
    const items = this.bot.inventory?.items?.()
    if (!Array.isArray(items)) throw new ScenarioFailure('native_inventory_unavailable')
    return items
  }

  _registered () {
    const record = this.runtime.nativeRegistry?.resolve('item', this.itemName)
    requireCondition(record && record.nativeItemIndexInstalled && Number.isSafeInteger(record.id), 'forge_item_registry_missing')
    return record
  }

  _findItem (record) {
    return this._inventory().find(item => itemMatches(item, this.itemName, record.id)) || null
  }

  _itemCount (record) {
    return this._inventory().reduce((sum, item) => sum + (itemMatches(item, this.itemName, record.id) ? item.count : 0), 0)
  }

  async _stage (name, action) {
    if (this._destroyed) throw new ScenarioFailure('scenario_disposed')
    const step = { stage: name, status: 'running', tMs: Date.now() - this.startedAt }
    this.steps.push(step)
    this.emit('stage', { ...step })
    try {
      const value = await action()
      step.status = 'passed'
      step.durationMs = Date.now() - this.startedAt - step.tMs
      this.emit('stage', { ...step })
      return value
    } catch (error) {
      step.status = 'failed'
      step.durationMs = Date.now() - this.startedAt - step.tMs
      const knownCodes = new Set([
        'not_in_play', 'not_spawned', 'forge_item_registry_missing', 'expected_item_not_received',
        'item_not_seen_on_wire', 'native_inventory_unavailable', 'native_item_not_in_inventory',
        'native_item_not_verified', 'native_equip_not_confirmed', 'native_unequip_not_confirmed',
        'native_item_lost_after_unequip', 'native_reequip_not_confirmed', 'native_item_count_changed',
        'native_inventory_inspection_failed', 'operation_timed_out', 'scenario_disposed'
      ])
      step.code = knownCodes.has(error?.code) ? error.code : 'native_api_operation_failed'
      this.failedStage = name
      this.failureCode = step.code
      this.emit('stage', { ...step })
      throw error
    }
  }

  async _withTimeout (promise) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ScenarioFailure('operation_timed_out')), this.operationTimeoutMs) })
      ])
    } finally { clearTimeout(timer) }
  }

  _begin () {
    if (this.completed || this.outcome !== 'waiting_for_spawn' || this._destroyed) return
    this.outcome = 'running'
    this.bot.removeListener('spawn', this._spawnListener)
    this._spawnAttached = false
    this._run().then(() => this._complete('passed'), () => this._complete('failed'))
  }

  async _run () {
    await this._stage('play_and_spawn', () => {
      requireCondition(this.runtime.protocol?.state === 'play', 'not_in_play')
      requireCondition(Boolean(this.bot.entity), 'not_spawned')
    })
    const record = await this._stage('forge_registry', () => this._registered())
    const firstItem = await this._stage('item_wire', async () => {
      // Wait for the *native* observation; the wire check below deliberately
      // remains independent to expose a lost raw packet observer.
      const received = await boundedWait(
        () => this._findItem(record), this.runtime, 'modItemObserved', this.itemWaitMs, this._cancel)
      requireCondition(this.runtime.nativeInventory?.getReport()?.expectedItem?.wireObserved === true, 'item_not_seen_on_wire')
      return received
    })
    await this._stage('native_inventory', () => {
      const report = this.runtime.nativeInventory?.getReport()
      requireCondition(report?.expectedItem?.nativeObserved === true, 'native_item_not_verified')
      requireCondition(this._findItem(record) !== null, 'native_item_not_in_inventory')
    })
    const startCount = this._itemCount(record)
    await this._stage('equip', async () => {
      requireCondition(typeof this.bot.equip === 'function', 'native_equip_not_confirmed')
      await this._withTimeout(this.bot.equip(this._findItem(record), 'hand'))
      requireCondition(itemMatches(this.bot.heldItem, this.itemName, record.id), 'native_equip_not_confirmed')
    })
    await this._stage('unequip', async () => {
      requireCondition(typeof this.bot.unequip === 'function', 'native_unequip_not_confirmed')
      await this._withTimeout(Promise.resolve().then(() => this.bot.unequip('hand')))
      requireCondition(!itemMatches(this.bot.heldItem, this.itemName, record.id), 'native_unequip_not_confirmed')
      requireCondition(this._findItem(record) !== null, 'native_item_lost_after_unequip')
    })
    await this._stage('reequip', async () => {
      await this._withTimeout(this.bot.equip(this._findItem(record), 'hand'))
      requireCondition(itemMatches(this.bot.heldItem, this.itemName, record.id), 'native_reequip_not_confirmed')
    })
    await this._stage('inventory_integrity', () => {
      requireCondition(this._itemCount(record) === startCount, 'native_item_count_changed')
      requireCondition(itemMatches(this.bot.heldItem, this.itemName, record.id), 'native_reequip_not_confirmed')
    })
    // Locally verified round-trip only; no generic server acknowledgement.
    this.initialCount = startCount
    this.finalCount = this._itemCount(record)
    this.itemId = record.id
    this.startSlot = Number.isInteger(firstItem.slot) ? firstItem.slot : null
  }

  _complete (outcome) {
    if (this.completed || this._destroyed) return
    this.completed = true
    this.outcome = outcome
    this.completedAt = Date.now()
    this.emit('complete', this.getReport())
  }

  abort (code = 'scenario_interrupted') {
    if (this.completed) return
    const current = this.steps.find(s => s.status === 'running')
    this.failedStage = current?.stage ?? 'play_and_spawn'
    this.failureCode = code
    if (current) { current.status = 'failed'; current.code = code; current.durationMs = Date.now() - this.startedAt - current.tMs }
    else this.steps.push({ stage: 'play_and_spawn', status: 'failed', code, tMs: Date.now() - (this.startedAt || Date.now()) })
    this.completed = true
    this.outcome = 'failed'
    this.completedAt = Date.now()
  }

  getReport () {
    const knownSteps = new Set(this.steps.map(s => s.stage))
    return {
      schema: 'mineflayer-mod-support/item-e2e/v1', item: this.itemName,
      outcome: this.outcome, completed: this.completed,
      elapsedMs: this.startedAt === null ? 0 : (this.completedAt ?? Date.now()) - this.startedAt,
      failedStage: this.failedStage, failureCode: this.failureCode,
      steps: [
        ...this.steps.map(s => ({ ...s })),
        ...STAGES.filter(name => !knownSteps.has(name)).map(stage => ({ stage, status: 'not_run' }))
      ],
      itemId: this.itemId ?? this.runtime.nativeRegistry?.resolve('item', this.itemName)?.id ?? null,
      inventory: {
        initialCount: this.initialCount ?? null, finalCount: this.finalCount ?? null,
        observedSlot: this.startSlot ?? null
      },
      evidence: {
        wireObserved: this.runtime.nativeInventory?.getReport()?.expectedItem?.wireObserved === true,
        nativeObserved: this.runtime.nativeInventory?.getReport()?.expectedItem?.nativeObserved === true
      },
      serverAuthoritativeActionVerified: false,
      modItemBehaviorVerified: false,
      notes: ['No item use, consumption, drop or Mod-specific action', 'Only a client-side held item and inventory round-trip are verified']
    }
  }

  destroy () {
    this._destroyed = true
    if (this._spawnAttached) this.bot.removeListener('spawn', this._spawnListener)
    for (const cancel of [...this._cancel]) cancel()
    this._cancel.clear()
  }
}

module.exports = { NativeItemE2EScenario }
