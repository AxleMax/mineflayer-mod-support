'use strict'

const { inspectFml3LoginWrapper } = require('./login-wrapper')
const { encodeC2SModListReply, wrapFml3Reply } = require('./fml3-client-wire')
const { WireReader } = require('./wire')

// Opt-in wire-only test. Sends a truthful *empty* client capability claim, NEVER
// server-provided Mod IDs or claims from static JAR analysis. This usually
// results in a server kick. It is not a Forge compatibility implementation.
// It relies on an upstream minecraft-protocol login_plugin_response to replace;
// it does not write a second reply or take ownership of the login state.
class Fml3EmptyCapabilityProbe {
  constructor (enabled = false) {
    this.enabled = enabled === true
    this.pending = new Map()
    this.prepared = 0
    this.replaced = 0
    this.events = []
  }
  prepare (request) {
    if (!this.enabled || request?.channel !== 'fml:loginwrapper' || !Number.isInteger(request.messageId) || request.messageId < 0) return false
    if (this.pending.has(request.messageId)) return true
    const parsed = inspectFml3LoginWrapper(request.payload)
    if (!parsed.parsed || parsed.trailingBytes !== 0 || parsed.type !== 'S2CModList') return false
    // All three lists empty: do NOT report Forge, Waystones, Balm or KumaAPI as
    // installed/executable. They remain candidates from static JAR inspection.
    const body = wrapFml3Reply(encodeC2SModListReply({ mods: [], channels: [], registries: [] }))
    if (this.pending.size >= 32) return false
    this.pending.set(request.messageId, body)
    this.prepared++
    this.events.push('prepared_mod_list_reply:' + request.messageId)
    return true
  }
  inspectNamedRequest (data) {
    if (!this.enabled || !data || typeof data !== 'object') return false
    const channel = [data.channel, data.identifier, data.tag].find(v => typeof v === 'string')
    const messageId = [data.messageId, data.message_id, data.transactionId, data.transaction_id].find(Number.isInteger)
    const payload = [data.data, data.payload, data.contents].find(Buffer.isBuffer)
    return this.prepare({ messageId, channel, payload })
  }
  replaceAutoReply (name, data, state, version) {
    if (!this.enabled || name !== 'login_plugin_response' || String(state).toLowerCase() !== 'login' || version !== '1.20.1' || !data || typeof data !== 'object') return null
    const messageId = [data.messageId, data.message_id, data.transactionId, data.transaction_id].find(Number.isInteger)
    if (!this.pending.has(messageId)) return null
    const pending = this.pending.get(messageId)
    this.pending.delete(messageId)
    // Preserve the upstream packet's messageId and other version-specific keys.
    // minecraft-protocol 1.20.1 responds with 'data' as its optional bytes.
    this.replaced++
    this.events.push('replaced_empty_auto_reply:' + messageId)
    return { ...data, data: pending, successful: true }
  }
  getReport () {
    return { enabled: this.enabled, mode: this.enabled ? 'empty-client-capabilities' : 'passive', prepared: this.prepared, replaced: this.replaced, waitingForUpstreamAutoReply: this.pending.size, events: [...this.events.slice(-64)], advertisesJars: false, canJoinModded: false }
  }
}
module.exports = { Fml3EmptyCapabilityProbe }
