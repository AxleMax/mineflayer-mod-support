'use strict'
const { EventEmitter } = require('node:events')
function menuLayout (data) {
  if (data.playerInventory === 'appended-36') return { slots: data.containerSlots + 36, inventoryStart: data.containerSlots, inventoryEnd: data.containerSlots + 36, craftingResultSlot: data.craftingResultSlot ?? -1 }
  return { slots: data.slots, inventoryStart: data.inventoryStart, inventoryEnd: data.inventoryEnd, craftingResultSlot: data.craftingResultSlot ?? -1 }
}
function validateMenu (data) {
  const layout = menuLayout(data)
  if (data.standardClick !== true || !Number.isInteger(layout.slots) || layout.slots < 1 || layout.slots > 1024 || !Number.isInteger(layout.inventoryStart) || layout.inventoryStart < 0 || !Number.isInteger(layout.inventoryEnd) || layout.inventoryEnd > layout.slots || layout.inventoryEnd - layout.inventoryStart !== 36 || !Number.isInteger(layout.craftingResultSlot) || layout.craftingResultSlot < -1 || layout.craftingResultSlot >= layout.slots) throw new Error('unsupported_menu_layout')
  if (data.requiresConfirmation !== undefined && typeof data.requiresConfirmation !== 'boolean') throw new Error('invalid_menu_confirmation_flag')
  return layout
}
class MenuRules extends EventEmitter {
  constructor () { super(); this.entries = new Map() }
  register (id, configure, source) {
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id || '') || typeof configure !== 'function' || this.entries.has(id)) throw new Error('invalid_or_duplicate_menu_rules')
    const entry = { configure, source }
    this.entries.set(id, entry)
    try { this.emit('changed', id) } catch (error) { this.entries.delete(id); this.emit('changed', id); throw error }
    return () => { if (this.entries.get(id) !== entry) return false; this.entries.delete(id); this.emit('changed', id); return true }
  }
  get (id) { return this.entries.get(id) || null }
  getReport () { return { registered: [...this.entries].map(([id, entry]) => ({ id, source: entry.source })), executor: 'explicit adapter on native Window; no core click algorithm' } }
}
module.exports = { MenuRules, menuLayout, validateMenu }
