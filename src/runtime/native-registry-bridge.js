'use strict'

// P2.6: An isolated, per-bot registry bridge. Forge's registry IDs are *not*
// Minecraft block state IDs. Only the item lookup tables have enough wire
// metadata to be overlaid into prismarine-item's actual constructor path.
// Entities project type identity; unknown dimensions/metadata stay unknown.
// Block states/collision require explicit definitions; never infer them from
// the block type IDs or manufacture unknown geometry.
const { EventEmitter } = require('node:events')
const { NativeBlockProjection } = require('./native-block-projection')

const REGISTRIES = Object.freeze({ item: 'minecraft:item', block: 'minecraft:block', entity: 'minecraft:entity_type' })
const IDENTIFIER = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const ITEM_LIMIT = 65536

function validateRegistry (v) {
  if (!v || typeof v !== 'object' || typeof v.supportFeature !== 'function' || !v.version) return false
  return true
}

function copyBaseItem (base, name, id) {
  const bare = name.slice('minecraft:'.length)
  const item = base?.itemsByName?.[bare] || base?.itemsByName?.[name]
  if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id)) return null
  return { ...item, id, name: item.name || bare, _modSupport: { source: 'minecraft-data-metadata+server-id', metadataComplete: true, canonicalName: name } }
}

function createItemRecord (name, id, base) {
  if (!IDENTIFIER.test(name) || !Number.isSafeInteger(id) || id < 0 || id >= ITEM_LIMIT) throw new Error('invalid_native_item_registration')
  if (name.startsWith('minecraft:')) {
    const fromBase = copyBaseItem(base, name, id)
    if (fromBase) return fromBase
  }
  // Registry snapshots only contain names and numeric IDs. Stack limits,
  // durability, tags, recipes, models and components cannot be inferred.
  // For prismarine-item's Item constructor use a conservative maximum of 1.
  // Never expose this fallback as an authoritative Java item definition.
  return { id, name, displayName: name, stackSize: 1,
    _modSupport: { source: 'server-id-only', metadataComplete: false, canonicalName: name } }
}

function createEntityRecord (name, id, base) {
  if (!IDENTIFIER.test(name) || !Number.isSafeInteger(id) || id < 0 || id >= ITEM_LIMIT) throw new Error('invalid_native_entity_registration')
  const vanilla = name.startsWith('minecraft:') ? base?.entitiesByName?.[name.slice(10)] : null
  if (vanilla) return { ...vanilla, id, internalId: id,
    metadataKeys: vanilla.metadataKeys ? [...vanilla.metadataKeys] : undefined,
    _modSupport: { source: 'minecraft-data-metadata+server-id', metadataComplete: true, canonicalName: name } }
  return { id, internalId: id, name, displayName: name, type: 'other', category: 'unknown',
    _modSupport: { source: 'server-id-only', metadataComplete: false, canonicalName: name } }
}

class NativeRegistryBridge extends EventEmitter {
  constructor ({ mappings, definitions, itemOverlay = true, entityOverlay = true, blockOverlay = true } = {}) {
    super()
    if (!mappings || typeof mappings.getId !== 'function' || typeof mappings.getName !== 'function' || typeof mappings.getEntries !== 'function') {
      throw new TypeError('NativeRegistryBridge requires a ServerRegistryMappings instance')
    }
    this.mappings = mappings
    this.definitions = definitions
    this.blockOverlay = blockOverlay !== false
    this.blocks = new NativeBlockProjection(this)
    this._onDefinition = ({kind,id}) => {
      if (kind === 'block' && this.blockOverlay) this.blocks.sync()
      if (kind === 'item') {
        this.syncItemRegistry()
        // Existing native Item instances cache display/stack metadata. Refresh
        // only those fields; counts, slot identity and NBT remain authoritative.
        for (const window of [this.bot?.inventory, this.bot?.currentWindow]) {
          for (const item of [...(window?.slots || []), window?.selectedItem]) {
            if (!this._Item || !item || this.mappings.getName(REGISTRIES.item,item.type) !== id) continue
            const refreshed = new this._Item(item.type,item.count,item.metadata,item.nbt)
            for (const key of ['name','displayName','stackSize','maxDurability']) item[key] = refreshed[key]
          }
        }
      }
      if (kind === 'entity') {
        this.syncEntityRegistry()
        for (const entity of Object.values(this.bot?.entities || {})) {
          if (this.mappings.getName(REGISTRIES.entity,entity.entityType) !== id) continue
          const record = this.view?.entities?.[entity.entityType]
          if (record) for (const key of ['width','height']) entity[key] = record[key]
        }
      }
    }
    definitions?.on('changed', this._onDefinition)
    this.itemOverlay = itemOverlay !== false
    this.entityOverlay = entityOverlay !== false
    this.bot = null
    this.base = null
    this.view = null
    this.itemVersion = 0
    this.entityVersion = 0
    this.entityEntries = 0
    this._entitySlots = new Map()
    this._entityItemMethods = new Map()
    this._Item = null
    this.counts = { itemEntries: 0, unknownItemMetadata: 0, itemUpdates: 0 }
    this.syncedRegistries = new Map()
    this._listeners = []
    this._clientListeners = []
    this._worldName = null
    this.entityResets = 0
    this.transportEnded = false
    this._active = false
  }

  attachBot (bot) {
    if (!bot || typeof bot !== 'object') throw new TypeError('invalid_mineflayer_bot')
    if (this.bot && this.bot !== bot) throw new Error('native_registry_bridge_is_per_bot')
    if (this.bot) return this
    this.bot = bot
    // `inject_allowed` is emitted after Mineflayer assigns bot.registry and
    // before internal plugins (including inventory) create their Item class.
    const onInject = () => this.ensureOverlay()
    const onLogin = () => this.ensureOverlay()
    const onEntitySpawn = entity => {
      if (this.transportEnded) return
      const type = this.describeEntity(entity)
      if (!type || !entity || typeof entity !== 'object') return
      try { Object.defineProperty(entity, 'modSupportRegistryType', { value: type, configurable: true, writable: true }) } catch {}
      if (this._Item && !this._entityItemMethods.has(entity)) {
        const methods = ['setEquipment', 'getDroppedItem']
        this._entityItemMethods.set(entity, Object.fromEntries(methods.map(name => [name,Object.getOwnPropertyDescriptor(entity,name)])))
        const Item = this._Item; const originalSet = entity.setEquipment
        if (typeof originalSet === 'function') Object.defineProperty(entity,'setEquipment',{configurable:true,value:function (slot,item) {
          return originalSet.call(this,slot,item ? new Item(item.type,item.count,item.metadata,item.nbt) : item)
        }})
        if (type.name === 'minecraft:item') {
          const index = this.view.supportFeature('metadataIxOfItem')
          Object.defineProperty(entity,'getDroppedItem',{configurable:true,value:function () { return Item.fromNotch(this.metadata[index]) }})
        }
      }
    }
    const onEntityGone = entity => this._restoreEntityItemMethods(entity)
    if (typeof bot.on === 'function') {
      if (typeof bot.prependListener === 'function') bot.prependListener('inject_allowed', onInject)
      else bot.on('inject_allowed', onInject)
      bot.on('login', onLogin)
      bot.prependListener('entitySpawn', onEntitySpawn)
      bot.on('entityGone',onEntityGone)
      this._listeners.push(['inject_allowed', onInject], ['login', onLogin], ['entitySpawn', onEntitySpawn], ['entityGone',onEntityGone])
    }
    if (validateRegistry(bot.registry)) this.ensureOverlay()
    return this
  }

  ensureOverlay () {
    if (!this.bot || (!this.itemOverlay && !this.entityOverlay && !this.blockOverlay)) return false
    const existing = this.bot.registry
    if (!validateRegistry(existing)) return false
    if (this.view === existing) return true
    // No writes to the shared prismarine-registry or minecraft-data objects.
    this.base = existing
    this.view = Object.create(existing)
    this.view._modSupportRegistryOverlay = true
    this.bot.registry = this.view
    this._active = true
    if (this.blockOverlay) this.blocks.prepare()
    this._Item = this.itemOverlay ? require('prismarine-item')(this.view) : null
    if (this.entityOverlay) {
      // Mineflayer caches entitiesArray records at plugin initialization.
      // Clone them before injection, then update stable slots in place so
      // its player/type classifier cannot retain stale vanilla identities.
      this._entitySlots = new Map((existing.entitiesArray || []).map(record => [record.id, { ...record }]))
      const entities = []; const byName = Object.create(null)
      for (const record of this._entitySlots.values()) { entities[record.id] = record; byName[record.name] = record }
      Object.assign(this.view, { entities, entitiesArray: [...this._entitySlots.values()], entitiesByName: byName })
    }
    this.syncItemRegistry()
    this.syncEntityRegistry()
    return true
  }

  syncRegistry (registry) {
    if (registry === REGISTRIES.block && this.blockOverlay) this.blocks.sync()
    if (registry === REGISTRIES.item) this.syncItemRegistry()
    if (registry === REGISTRIES.entity) this.syncEntityRegistry()
    const entries = this.mappings.getEntries(registry) || []
    const summary = {
      registry,
      entries: entries.length,
      lookupAvailable: entries.length > 0,
      itemOverlayInstalled: registry === REGISTRIES.item && this._active && this.counts.itemEntries > 0,
      entityOverlayInstalled: registry === REGISTRIES.entity && this._active && this.entityEntries > 0,
      blockStateIdsAvailable: registry === REGISTRIES.block && this.blocks.applied.length > 0,
      entityAttributesAvailable: false
    }
    this.syncedRegistries.set(registry, { entries: entries.length, itemOverlayInstalled: summary.itemOverlayInstalled })
    this.emit('registrySync', summary)
    return summary
  }

  getRegistryId (registry, identifier) { return this.mappings.getId(registry, identifier) }
  getRegistryName (registry, id) { return this.mappings.getName(registry, id) }
  getRegistryEntries (registry) { return this.mappings.getEntries(registry) }

  attachClient (client) {
    for (const [source,event,handler] of this._clientListeners) source.removeListener(event,handler)
    this._clientListeners = []
    this.transportEnded = false
    const reset = (packet, initial) => {
      const world = packet.worldName
      const changed = typeof world === 'string' && this._worldName !== null && world !== this._worldName
      if (initial || changed) {
        for (const entity of this._entityItemMethods.keys()) this._restoreEntityItemMethods(entity)
        this.entityResets++
      }
      if (changed && this.bot?.entities) {
        // A new dimension/world replaces the client entity scene. Keep the
        // local player object; remote actors must arrive through fresh spawns.
        for (const [id,entity] of Object.entries(this.bot.entities)) if (entity !== this.bot.entity) {
          this.bot.emit('entityGone',entity)
          if (entity.username && this.bot.players?.[entity.username]?.entity === entity) this.bot.players[entity.username].entity = null
          entity.isValid=false;delete this.bot.entities[id]
        }
      }
      if (typeof world === 'string') this._worldName = world
    }
    const listeners = [['login',p=>reset(p,true)], ['respawn',p=>reset(p,false)], ['end',()=>{
      this.transportEnded = true
      for (const entity of this._entityItemMethods.keys()) this._restoreEntityItemMethods(entity)
      this.entityResets++
    }]]
    for (const [event,handler] of listeners) { client.prependListener(event,handler);this._clientListeners.push([client,event,handler]) }
  }

  _restoreEntityItemMethods (entity) {
    const methods = this._entityItemMethods.get(entity)
    if (!methods) return
    for (const [name,descriptor] of Object.entries(methods)) {
      if (descriptor) Object.defineProperty(entity,name,descriptor)
      else delete entity[name]
    }
    this._entityItemMethods.delete(entity)
  }

  syncEntityRegistry () {
    const entries = this.mappings.getEntries(REGISTRIES.entity)
    if (!entries || !this.view || !this.entityOverlay) return false
    if (entries.some(e => !Number.isSafeInteger(e.id) || e.id < 0 || e.id >= ITEM_LIMIT)) throw new Error('entity_id_outside_safe_index_range')
    const entities = []; const byName = Object.create(null)
    const records = entries.map(({name,id}) => this._supplement('entity', name, createEntityRecord(name,id,this.base)))
    for (const [id, slot] of this._entitySlots) {
      for (const key of Object.keys(slot)) delete slot[key]
      Object.assign(slot, { id, internalId: id, name: 'unknown', type: 'other', category: 'unknown' })
    }
    for (const recordData of records) {
      const { id } = recordData; const name = recordData._modSupport.canonicalName
      const record = this._entitySlots.get(id) || {}
      Object.assign(record,recordData); this._entitySlots.set(id,record)
      entities[id] = record; byName[name] = record
      if (name.startsWith('minecraft:')) byName[name.slice(10)] = record
    }
    Object.defineProperties(this.view, {
      entities: { value: entities, configurable: true, writable: true, enumerable: true },
      entitiesByName: { value: byName, configurable: true, writable: true, enumerable: true },
      entitiesArray: { value: entries.map(({ id }) => entities[id]), configurable: true, writable: true, enumerable: true }
    })
    this.entityEntries = entries.length; this.entityVersion++
    this.emit('entitiesUpdated', { entries: entries.length, version: this.entityVersion })
    return true
  }

  syncItemRegistry () {
    const entries = this.mappings.getEntries(REGISTRIES.item)
    if (!entries || !this.view || !this.itemOverlay) return false
    // A malformed/sparse Forge index must not allocate an enormous JS Array.
    // Keep the name/ID registry mappings but disable native item projection.
    if (entries.some(e => !Number.isSafeInteger(e.id) || e.id < 0 || e.id >= ITEM_LIMIT)) {
      Object.defineProperties(this.view, {
        items: { value: [], configurable: true, writable: true, enumerable: true },
        itemsByName: { value: Object.create(null), configurable: true, writable: true, enumerable: true },
        itemsById: { value: Object.create(null), configurable: true, writable: true, enumerable: true },
        itemsArray: { value: [], configurable: true, writable: true, enumerable: true }
      })
      this.counts = { ...this.counts, itemEntries: 0, unknownItemMetadata: 0 }
      this.emit('overlayRejected', { reason: 'item_id_outside_safe_index_range', limit: ITEM_LIMIT })
      return false
    }
    // A complete Forge snapshot is authoritative for ID indexing. Never mix
    // stale vanilla IDs from a different registry into the numeric array.
    const items = []
    const byName = Object.create(null)
    const byId = Object.create(null)
    let unknown = 0
    for (const { name, id } of entries) {
      const record = this._supplement('item', name, createItemRecord(name, id, this.base))
      if (!record._modSupport.metadataComplete) unknown++
      items[id] = record
      byId[id] = record
      byName[name] = record
      // Keep the conventional minecraft-data bare vanilla name lookup.
      if (name.startsWith('minecraft:')) byName[name.slice(10)] = record
    }
    // All three tables commit together on the per-bot view; objects created by
    // prismarine-item retain the VIEW reference and see the new ID array.
    Object.defineProperties(this.view, {
      items: { value: items, configurable: true, writable: true, enumerable: true },
      itemsByName: { value: byName, configurable: true, writable: true, enumerable: true },
      itemsById: { value: byId, configurable: true, writable: true, enumerable: true },
      itemsArray: { value: entries.map(({ id }) => items[id]), configurable: true, writable: true, enumerable: true }
    })
    this.counts = { ...this.counts, itemEntries: entries.length, unknownItemMetadata: unknown, itemUpdates: this.counts.itemUpdates + 1 }
    this.itemVersion++
    this.emit('itemsUpdated', { entries: entries.length, unknownItemMetadata: unknown, version: this.itemVersion })
    return true
  }

  resolve (kind, nameOrId) {
    const registry = REGISTRIES[kind]
    if (!registry) return null
    const id = typeof nameOrId === 'string' ? this.mappings.getId(registry, nameOrId) : nameOrId
    if (!Number.isSafeInteger(id) || id < 0) return null
    const name = this.mappings.getName(registry, id)
    if (!name) return null
    const item = kind === 'item' ? this.view?.items?.[id] : null
    const baseMeta = item?._modSupport
    return { kind, registry, id, name,
      source: this.mappings.getSource?.(registry) || 'server-registry',
      nativeItemIndexInstalled: kind === 'item' && this._active && Boolean(item),
      metadataComplete: kind === 'item' ? Boolean(baseMeta?.metadataComplete) : false,
      stateIdsKnown: kind === 'block' && this.blocks.applied.some(block => block.name === name),
      clientBehaviorImplemented: false }
  }

  _supplement (kind, name, record) {
    const definition = this.definitions?.get(kind, name)
    if (!definition) return record
    return { ...record, ...definition.data, _modSupport: { ...record._modSupport,
      metadataSource: definition.source, supplementedFields: Object.keys(definition.data) } }
  }

  // Gives callers a reliable name for a real ItemStack's numeric type; does
  // not modify the object or its (possibly custom) NBT.
  describeItemStack (stack) {
    if (!stack || !Number.isSafeInteger(stack.type)) return null
    const registry = this.resolve('item', stack.type)
    if (!registry) return null
    return { ...registry, count: Number.isSafeInteger(stack.count) ? stack.count : null,
      // Metadata complete ONLY if we could match vanilla minecraft-data.
      stackOperationsVerified: false }
  }

  describeInventory () {
    const items = this.bot?.inventory?.items
    if (typeof items !== 'function') return []
    return items.call(this.bot.inventory).map(item => this.describeItemStack(item)).filter(Boolean)
  }

  // The entity_type registry maps numeric TYPES, not runtime entity IDs.
  describeEntity (entity) {
    const numericType = entity?.entityType
    return Number.isSafeInteger(numericType) ? this.resolve('entity', numericType) : null
  }

  getReport () {
    const registries = Object.fromEntries(Object.entries(REGISTRIES).map(([kind, registry]) => [kind, this.mappings.getEntries(registry)?.length || 0]))
    return { schema: 'mineflayer-mod-support/native-registry-bridge/v1',
      perBot: true, botAttached: Boolean(this.bot), nativeItemOverlayActive: this._active,
      itemVersion: this.itemVersion, entityVersion: this.entityVersion, counts: { ...this.counts }, registries,
      entityLifecycle: { patchedEntityCount: this._entityItemMethods.size, resets: this.entityResets, transportEnded: this.transportEnded, worldName: this._worldName },
      blockProjection: this.blocks.getReport(),
      registryViews: {
        item: { entries: registries.item, lookupAvailable: registries.item > 0, appliedToMineflayer: this._active && this.counts.itemEntries > 0, index: 'itemsById/itemsByName' },
        block: { entries: registries.block, lookupAvailable: registries.block > 0, appliedToMineflayer: this.blocks.applied.length > 0, index: this.blocks.applied.length ? 'blocksByStateId' : null },
        entity: { entries: registries.entity, lookupAvailable: registries.entity > 0, appliedToMineflayer: this._active && this.entityEntries > 0, index: 'entities/entitiesByName/entitiesArray' }
      },
      syncedRegistries: [...this.syncedRegistries.entries()].map(([registry, value]) => ({ registry, ...value })),
      blockStateIdsInstalled: this.blocks.applied.length > 0, allModBlockStatesKnown: false, entityMetadataInstalled: false,
      javaItemPropertiesKnown: false, modClientSemanticsImplemented: false,
      warnings: ['Forge block registry IDs are not Minecraft block state IDs', 'Forge entity type IDs do not include runtime entity metadata or attributes', 'Modded item stackSize=1 is a conservative placeholder, not authoritative metadata', 'No global minecraft-data/prismarine-registry mutations'] }
  }

  destroy () {
    this.definitions?.removeListener('changed', this._onDefinition)
    if (this.bot) {
      if (typeof this.bot.removeListener === 'function') for (const [event, listener] of this._listeners) this.bot.removeListener(event, listener)
      if (this.bot.registry === this.view) this.bot.registry = this.base
    }
    this._listeners.length = 0
    for (const [source,event,handler] of this._clientListeners) source.removeListener(event,handler)
    this._clientListeners = []
    for (const entity of this._entityItemMethods.keys()) this._restoreEntityItemMethods(entity)
    this._Item = null
    this._entitySlots.clear()
    this.bot = null
    this.view = null
    this.base = null
    this._active = false
  }
}

module.exports = { NativeRegistryBridge, createItemRecord, createEntityRecord }
