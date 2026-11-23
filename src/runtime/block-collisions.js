'use strict'
const { validateCollisionShape } = require('./block-definitions')

class BlockCollisions {
  constructor () { this.entries = new Map() }
  register (name, provider, source) {
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name || '') || typeof provider !== 'function' || this.entries.has(name)) throw new Error('invalid_or_duplicate_collision_provider')
    const entry = { provider, source }; this.entries.set(name, entry)
    return () => { if (this.entries.get(name) !== entry) return false; this.entries.delete(name); return true }
  }
  getReport () { return { providers: [...this.entries].map(([name, entry]) => ({ name, source: entry.source })), automaticDataAvailabilityClaimed: false } }
}

// Read-only data projection. Native physics calls bot.blockAt; gameplay APIs
// and the upstream physics algorithm are left intact. Neighbour reads use the
// original reader so provider dependencies cannot recursively call themselves.
class NativeBlockReader {
  constructor (rules, onError, onUnknown) { this.rules = rules; this.onError = onError; this.onUnknown = onUnknown; this.bot = null; this.projected = 0; this.unknown = new Map(); this.unknownReads = 0 }
  attachBot (bot) {
    if (this.bot === bot) return
    if (this.bot) throw new Error('native_block_reader_is_per_bot')
    const descriptor = Object.getOwnPropertyDescriptor(bot, 'blockAt')
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) throw new Error('native_block_reader_property_unavailable')
    this.bot = bot; this.originalDescriptor = descriptor
    const assign = reader => {
      this.reader = reader
      this.wrapped = typeof reader !== 'function' ? reader : (...args) => {
        const block = reader.apply(bot, args)
        if (block && (!block.name || !Array.isArray(block.shapes)) && Number.isInteger(block.stateId)) {
          this.unknownReads++
          if (!this.unknown.has(block.stateId)) {
            const event = { stateId: block.stateId, name: block.name || null, position: block.position ? { ...block.position } : null, collisionKnown: false,
              impact: 'native block identity or collision is unavailable; upstream fallback is not authoritative' }
            if (this.unknown.size >= 128) this.unknown.delete(this.unknown.keys().next().value)
            this.unknown.set(block.stateId, event); this.onUnknown?.(structuredClone(event))
          }
        } else if (block) this.unknown.delete(block.stateId)
        if (!block?.name) return block
        const name = block.name.includes(':') ? block.name : 'minecraft:' + block.name, entry = this.rules.entries.get(name)
        if (!entry) return block
        const player = bot.entity ? { position: bot.entity.position ? { ...bot.entity.position } : null, onGround: bot.entity.onGround, metadata: structuredClone(bot.entity.metadata || {}) } : null
        try {
          const shape = entry.provider(block, Object.freeze({ getBlock: (...params) => reader.apply(bot, params), player, source: entry.source }))
          validateCollisionShape(shape)
          block.shapes = structuredClone(shape); this.projected++
          return block
        } catch (error) {
          this.onError?.({ name, stateId: block.stateId, source: entry.source, reason: error.message })
          throw error
        }
      }
    }
    this.getter = () => this.wrapped
    Object.defineProperty(bot, 'blockAt', { configurable: true, enumerable: true, get: this.getter, set: assign })
    assign(descriptor?.value)
  }
  getReport () { return { projectedReads: this.projected, unknownReads: this.unknownReads, unresolvedStates: [...this.unknown.values()].map(value => structuredClone(value)), physicsOwner: 'prismarine-physics', providers: this.rules.getReport().providers } }
  destroy () {
    if (this.bot && Object.getOwnPropertyDescriptor(this.bot, 'blockAt')?.get === this.getter) Object.defineProperty(this.bot, 'blockAt', { ...(this.originalDescriptor || { configurable: true, enumerable: true, writable: true }), value: this.reader })
    this.bot = null; this.reader = null; this.wrapped = null
  }
}
module.exports = { BlockCollisions, NativeBlockReader }
