'use strict'
const { menuLayout } = require('./menu-rules')

// Mineflayer creates windows from bot.version, whereas its packet Item class
// comes from bot.registry. Rebind only each instance's upstream Window class
// to the same per-bot registry, preserving native click/move/drop algorithms.
class NativeWindowBridge {
  constructor (registryBridge, options = {}) {
    this.registryBridge = registryBridge; this.options = options; this.bot = null; this.properties = []; this.windows = new Map(); this.factory = null; this.view = null
    this.onRules = id => { for (const window of this.windows.keys()) if (window.type === id) this.applyRules(window) }
    options.rules?.on('changed', this.onRules)
  }
  attachBot (bot) {
    if (!this.registryBridge.itemOverlay) return
    if (this.bot === bot) return
    if (this.bot) throw new Error('native_window_bridge_is_per_bot')
    for (const key of ['inventory', 'currentWindow']) {
      const descriptor = Object.getOwnPropertyDescriptor(bot, key)
      if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) throw new Error('native_window_property_unavailable:' + key)
    }
    this.bot = bot
    for (const key of ['inventory', 'currentWindow']) {
      const original = Object.getOwnPropertyDescriptor(bot, key)
      let value = bot[key]
      const get = () => value
      const set = next => { if (value !== next) this.restore(value); value = next; this.project(next) }
      Object.defineProperty(bot, key, { configurable: true, enumerable: true, get, set })
      this.properties.push({ key, original, get })
      this.project(value)
    }
  }
  project (window) {
    if (!window || typeof window.acceptClick !== 'function' || typeof window.updateSlot !== 'function' || this.windows.has(window)) return
    const view = this.registryBridge.view
    if (!view || !this.registryBridge.itemOverlay) return
    if (this.view !== view) { this.factory = require('prismarine-windows')(view); this.view = view }
    this.windows.set(window, { original: Object.getPrototypeOf(window), projected: this.factory.Window.prototype })
    Object.setPrototypeOf(window, this.factory.Window.prototype)
    const definition = this.options.definitions?.get('menu', window.type)
    if (definition) {
      const layout = menuLayout(definition.data)
      if (window.slots.length !== layout.slots) window.slots = Array.from({ length: layout.slots }, (_, i) => window.slots[i] ?? null)
      Object.assign(window, { inventoryStart: layout.inventoryStart, inventoryEnd: layout.inventoryEnd,
        hotbarStart: layout.inventoryEnd - 9, craftingResultSlot: layout.craftingResultSlot })
      if (definition.data.requiresConfirmation !== undefined) window.requiresConfirmation = definition.data.requiresConfirmation
    }
    this.applyRules(window)
  }
  applyRules (window) {
    const entry = this.windows.get(window)
    if (!entry) return
    if (entry.ruleDispose) { const dispose = entry.ruleDispose; delete entry.ruleDispose; dispose() }
    const rule = this.options.rules?.get(window.type)
    if (!rule) return
    const dispose = rule.configure(window, { ...(this.options.context?.(window) || {}), source: rule.source })
    if (dispose !== undefined && typeof dispose !== 'function') throw new Error('menu_rules_must_return_disposer')
    entry.ruleDispose = dispose
  }
  getReport () { return { perBot: true, projectedWindows: this.windows.size, operationsOwner: 'mineflayer/prismarine-windows' } }
  restore (window) {
    const entry = this.windows.get(window)
    if (!entry) return
    if (entry.ruleDispose) entry.ruleDispose()
    if (Object.getPrototypeOf(window) === entry.projected) Object.setPrototypeOf(window, entry.original)
    this.windows.delete(window)
  }
  destroy () {
    this.options.rules?.removeListener('changed', this.onRules)
    for (const window of this.windows.keys()) this.restore(window)
    if (this.bot) for (const { key, original, get } of this.properties) {
      if (Object.getOwnPropertyDescriptor(this.bot, key)?.get !== get) continue
      const value = this.bot[key]
      Object.defineProperty(this.bot, key, { ...(original || { configurable: true, enumerable: true, writable: true }), value })
    }
    this.properties = []; this.bot = null; this.factory = null; this.view = null
  }
}
module.exports = { NativeWindowBridge }
