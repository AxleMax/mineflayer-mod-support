'use strict'
const { EventEmitter } = require('node:events')
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const { validateBlockDefinition } = require('../runtime/block-definitions')
const { validateMenu } = require('../runtime/menu-rules')

// Explicit adapter data supplements identity-only server registries. These
// definitions never allocate server IDs, infer block states, or perform actions.
class ContentDefinitions extends EventEmitter {
  constructor () { super(); this.entries = new Map() }
  register (kind, id, data, source) {
    if (!['item', 'entity', 'menu', 'block'].includes(kind) || !ID.test(id || '') || !data || typeof data !== 'object') throw new Error('invalid_content_definition')
    if (kind === 'block') validateBlockDefinition(data)
    const fields = { item: ['displayName', 'stackSize', 'maxDurability'], entity: ['displayName', 'width', 'height'], menu: ['containerSlots', 'playerInventory', 'standardClick', 'slots', 'inventoryStart', 'inventoryEnd', 'craftingResultSlot', 'requiresConfirmation'] }[kind]
    if (kind !== 'block' && Object.keys(data).some(key => !fields?.includes(key))) throw new Error('unsupported_content_definition_field')
    if (data.displayName !== undefined && (typeof data.displayName !== 'string' || data.displayName.length > 256)) throw new Error('invalid_display_name')
    if (data.stackSize !== undefined && (!Number.isInteger(data.stackSize) || data.stackSize < 1 || data.stackSize > 127)) throw new Error('invalid_item_stack_size')
    if (data.maxDurability !== undefined && (!Number.isSafeInteger(data.maxDurability) || data.maxDurability < 0)) throw new Error('invalid_item_durability')
    for (const key of ['width', 'height']) if (data[key] !== undefined && (!Number.isFinite(data[key]) || data[key] < 0 || data[key] > 1024)) throw new Error('invalid_entity_dimensions')
    if (kind === 'menu') validateMenu(data)
    const key = kind + ':' + id
    if (this.entries.has(key)) throw new Error('duplicate_content_definition:' + key)
    const entry = { kind, id, source, data: structuredClone(data) }
    this.entries.set(key, entry)
    try { this.emit('changed', { kind, id }) } catch (error) {
      this.entries.delete(key)
      this.emit('changed', { kind, id })
      throw error
    }
    return () => {
      if (this.entries.get(key) !== entry) return false
      this.entries.delete(key); this.emit('changed', { kind, id }); return true
    }
  }
  get (kind, id) { const entry = this.entries.get(kind + ':' + id); return entry ? structuredClone(entry) : null }
  getReport () { return { definitions: [...this.entries.values()].map(({ kind, id, source, data }) => ({ kind, id, source, fields: Object.keys(data) })) } }
}
module.exports = { ContentDefinitions }
