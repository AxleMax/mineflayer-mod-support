'use strict'

// P2.7: inventory *evidence*, not a fabricated inventory. Observe both the
// decoded NMP slot packets and Mineflayer/prismarine-windows' constructed Item
// objects. A Registry lookup alone must never be reported as a received item.
// NBT, item components and original packet payloads are never retained.
const { EventEmitter } = require('node:events')

const ITEM_RE = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const PACKETS = new Set(['window_items', 'set_slot'])
const MAX_SLOTS_PER_PACKET = 2048
const MAX_UNIQUE = 32
const MAX_HISTORY = 48

function asInt (value, min = 0, max = 2147483647) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

// These are the *decoded* protocol slot shapes supported by prismarine-item;
// no attempt is made to deserialize NBT or infer an item from arbitrary bytes.
function extractWireStack (slot) {
  if (!slot || typeof slot !== 'object' || slot.present === false) return null
  const itemId = asInt(slot.itemId ?? slot.type ?? slot.network_id)
  const count = asInt(slot.itemCount ?? slot.count, 1, 127)
  if (itemId === null || count === null) return null
  return { type: itemId, count }
}

function normalizedName (name) {
  if (typeof name !== 'string') return null
  return name.includes(':') ? name : `minecraft:${name}`
}

class NativeInventoryObserver extends EventEmitter {
  constructor ({ bridge, enabled = false, expectedItem = null } = {}) {
    super()
    if (!bridge || typeof bridge.resolve !== 'function') throw new TypeError('NativeInventoryObserver requires NativeRegistryBridge')
    if (expectedItem !== null && (typeof expectedItem !== 'string' || !ITEM_RE.test(expectedItem))) {
      throw new TypeError('invalid_expected_item_identifier')
    }
    this.bridge = bridge
    this.enabled = enabled === true
    this.expectedItem = expectedItem
    this.bot = null
    this.inventory = null
    this._listeners = []
    this._inventoryListener = null
    this._wire = new Map()
    this._native = new Map()
    this._history = []
    this.counts = {
      packets: 0, setSlotPackets: 0, windowItemsPackets: 0,
      wireStacks: 0, modWireStacks: 0, nativeSlotUpdates: 0,
      nativeModObservations: 0, nameMismatches: 0,
      inventoryAttached: 0, snapshots: 0
    }
  }

  attachBot (bot) {
    if (!bot || typeof bot !== 'object') throw new TypeError('invalid_mineflayer_bot')
    if (this.bot && this.bot !== bot) throw new Error('native_inventory_observer_is_per_bot')
    if (!this.enabled) return this
    if (typeof bot.on !== 'function') throw new TypeError('invalid_mineflayer_bot')
    if (this.bot) return this
    this.bot = bot
    const attach = () => this.attachInventory()
    for (const event of ['inject_allowed', 'login', 'spawn', 'windowOpen']) {
      bot.on(event, attach)
      this._listeners.push([event, attach])
    }
    this.attachInventory()
    return this
  }

  // May be called more than once; no duplicate listeners, no stale windows.
  attachInventory () {
    if (!this.enabled || !this.bot) return false
    const inventory = this.bot.inventory
    if (!inventory || typeof inventory.on !== 'function') return false
    if (inventory === this.inventory) return true
    if (this.inventory && this._inventoryListener) this.inventory.removeListener('updateSlot', this._inventoryListener)
    this.inventory = inventory
    this._inventoryListener = (slot, previousItem, currentItem) => this.observeNativeSlot(slot, currentItem)
    inventory.on('updateSlot', this._inventoryListener)
    this.counts.inventoryAttached++
    this.observeSnapshot()
    return true
  }

  observeSnapshot () {
    if (!this.enabled || !this.inventory || typeof this.inventory.items !== 'function') return
    let items
    try { items = this.inventory.items() } catch { return }
    if (!Array.isArray(items)) return
    this.counts.snapshots++
    for (const item of items.slice(0, MAX_SLOTS_PER_PACKET)) this._observeNative(item, 'snapshot', asInt(item?.slot, 0, 4095))
  }

  observePacket (packet) {
    if (!this.enabled || packet?.direction !== 'inbound' || packet?.phase !== 'play' || !PACKETS.has(packet.name)) return false
    const data = packet.data || {}
    const slots = packet.name === 'window_items' ? data.items : [data.item]
    if (!Array.isArray(slots)) return false
    this.counts.packets++
    if (packet.name === 'set_slot') this.counts.setSlotPackets++
    else this.counts.windowItemsPackets++
    const windowId = asInt(data.windowId, 0, 255)
    for (let index = 0; index < Math.min(slots.length, MAX_SLOTS_PER_PACKET); index++) {
      const stack = extractWireStack(slots[index])
      if (!stack) continue
      this.counts.wireStacks++
      const record = this.bridge.resolve('item', stack.type)
      if (!record || record.name.startsWith('minecraft:')) continue
      this.counts.modWireStacks++
      this._remember(this._wire, record.name, {
        id: record.id, name: record.name, count: stack.count,
        slot: packet.name === 'set_slot' ? asInt(data.slot, 0, 4095) : index,
        windowId, source: packet.name
      })
      this.emit('wireItemObserved', { id: record.id, name: record.name, count: stack.count, source: packet.name })
    }
    return true
  }

  observeNativeSlot (slot, item) {
    if (!this.enabled) return false
    this.counts.nativeSlotUpdates++
    return this._observeNative(item, 'updateSlot', asInt(slot, 0, 4095))
  }

  _observeNative (item, source, slot) {
    if (!item || !Number.isSafeInteger(item.type)) return false
    const record = this.bridge.resolve('item', item.type)
    if (!record || record.name.startsWith('minecraft:')) return false
    const actualName = normalizedName(item.name)
    const nameMatches = actualName === record.name
    const entry = {
      id: record.id, name: record.name,
      nativeName: typeof item.name === 'string' ? item.name.slice(0, 128) : null,
      nameMatches, count: asInt(item.count, 0, 127), slot,
      source
    }
    if (!nameMatches) this.counts.nameMismatches++
    else this.counts.nativeModObservations++
    this._remember(this._native, record.name, entry)
    // Emitted ONLY when Mineflayer supplied a real constructed Item object.
    // A wrong name is not a successful bridge verification.
    this.emit(nameMatches ? 'modItemObserved' : 'modItemNameMismatch', entry)
    return nameMatches
  }

  _remember (map, key, value) {
    if (map.has(key)) map.delete(key)
    map.set(key, value)
    if (map.size > MAX_UNIQUE) map.delete(map.keys().next().value)
    this._history.push({ source: value.source, name: value.name, id: value.id, nameMatches: value.nameMatches ?? null })
    if (this._history.length > MAX_HISTORY) this._history.shift()
  }

  getReport () {
    const expectedId = this.expectedItem === null ? null : this.bridge.resolve('item', this.expectedItem)?.id ?? null
    const expectedWire = this.expectedItem !== null && this._wire.has(this.expectedItem)
    const expectedNative = this.expectedItem !== null && this._native.get(this.expectedItem)?.nameMatches === true
    const nativeRecognized = [...this._native.values()].some(x => x.nameMatches)
    const status = !this.enabled ? 'disabled'
      : this.expectedItem && expectedNative ? 'expected_item_native_verified'
        : this.expectedItem && expectedWire ? 'expected_item_wire_only'
          : nativeRecognized ? 'mod_item_native_verified'
            : this.counts.modWireStacks ? 'mod_item_wire_only'
              : 'not_exercised_no_mod_item_observed'
    return {
      schema: 'mineflayer-mod-support/native-inventory-observation/v1',
      enabled: this.enabled,
      state: status,
      counts: { ...this.counts },
      inventoryListenerAttached: Boolean(this.inventory && this._inventoryListener),
      expectedItem: this.expectedItem ? {
        name: this.expectedItem, registryId: expectedId,
        wireObserved: expectedWire, nativeObserved: expectedNative
      } : null,
      wireModItems: [...this._wire.values()],
      nativeModItems: [...this._native.values()],
      // Bounded, metadata-only history; NEVER stores NBT or raw packet bytes.
      recentEvents: this._history.slice(-16),
      modItemOperationsVerified: false,
      limitation: 'Registry names + native Item construction do not prove mod item behavior, NBT semantics or safe use/stacking.'
    }
  }

  destroy () {
    if (this.bot) for (const [event, listener] of this._listeners) this.bot.removeListener(event, listener)
    if (this.inventory && this._inventoryListener) this.inventory.removeListener('updateSlot', this._inventoryListener)
    this._listeners.length = 0
    this.inventory = null
    this._inventoryListener = null
    this.bot = null
  }
}

module.exports = { NativeInventoryObserver, extractWireStack, normalizedName }
