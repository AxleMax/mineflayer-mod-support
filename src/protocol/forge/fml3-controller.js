'use strict'

const { inspectFml3LoginWrapper } = require('./login-wrapper')
const { createHash } = require('node:crypto')
const { encodeC2SModListReply, wrapFml3Reply, encodeFml3Acknowledge } = require('./fml3-client-wire')

// Opt-in, controlled FML3 login transaction controller for Forge 1.20.1.
// It never claims that any statically inspected .jar has executed in this process.
// S2CModData is informational rather than a Mod execution request. In the
// Forge registers S2CModData with noResponse(). Observe it without sending
// a login response, including in the progression flow.
class Fml3ControlledProbe {
  constructor (config = false) {
    const options = typeof config === 'boolean' ? { enabled: config } : (config || {})
    this.enabled = options.enabled === true
    this.experimentalRegistryFlow = options.experimentalRegistryFlow === true
    this.experimentalTrialChannels = validateTrialChannels(options.experimentalTrialChannels || [])
    this.serverPrimaryChannels = options.serverPrimaryChannels === true
    this.applyRegistry = () => { throw new Error('registry_mapping_handler_unavailable') }
    this.applyConfig = () => { throw new Error('config_store_handler_unavailable') }
    this.pending = new Map()
    this._lastObserved = new Map()
    this.prepared = 0
    this.replaced = 0
    this.suppressed = 0
    this.passthrough = 0
    this.handled = []
    this.events = []
    this.warnings = []
    this.getNativeAdvertisedChannels = () => []
    this.getNativeAdvertisedMods = () => []
    this.getNativeAdvertisedRegistries = () => []
    this.assumptions = [
      'S2CModData is informational and registered by Forge with noResponse; no client ACK is sent',
      'Only explicitly registered Node Mod adapters supply Mod identities; an empty adapter registry keeps the Mod identity list empty independently of channel negotiation',
      'Server-declared channels may supplement login negotiation; this never installs codecs, advertises Java Mod identities or proves behavior',
      'Registry ACK requires successful internal mapping installation; only the per-bot item index is projected into Mineflayer, while block/entity state remains data-only',
      'S2CConfigData is retained as bounded opaque bytes in memory before ACK; Java Mod config behavior is not executed',
      'Trial channel declarations are explicit diagnostic overrides and DO NOT guarantee mod support'
    ]
  }

  prepare (request) {
    if (!this.enabled || request?.channel !== 'fml:loginwrapper' ||
        !Number.isInteger(request.messageId) || request.messageId < 0 ||
        !Buffer.isBuffer(request.payload)) return false
    // NMP may emit both named and generic packet events for the same request;
    // the generic event can arrive *after* the auto reply has already been sent.
    // Deduplicate those observations without rejecting a reused transaction
    // ID carrying different handshake content.
    const fingerprint = createHash('sha256').update(request.payload).digest('hex')
    if (this._lastObserved.get(request.messageId) === fingerprint) return true
    const inspected = inspectFml3LoginWrapper(request.payload)
    if (!inspected.parsed || inspected.error || inspected.outerChannel !== 'fml:handshake') {
      this.warnings.push('unrecognized_or_malformed_request:' + request.messageId)
      return false
    }
    const kind = inspected.type
    // A live server may reuse a transaction ID after an earlier reply.
    // Accept the new request only after the prior one was consumed.
    if (this.pending.has(request.messageId)) {
      this.warnings.push('concurrent_request_id:' + request.messageId)
      return false
    }
    // Bound outstanding requests in a broken/malicious handshake.
    if (this.pending.size >= 32) {
      this.warnings.push('pending_limit_reached')
      return false
    }
    this.pending.set(request.messageId, { kind, packetId: inspected.packetId, details: inspected.details })
    this._lastObserved.set(request.messageId, fingerprint)
    if (this._lastObserved.size > 64) this._lastObserved.delete(this._lastObserved.keys().next().value)
    this.prepared++
    this.events.push('prepared:' + request.messageId + ':' + kind)
    return true
  }

  inspectNamedRequest (data) {
    if (!data || typeof data !== 'object') return false
    const channel = [data.channel, data.identifier, data.tag].find(v => typeof v === 'string')
    const messageId = [data.messageId, data.message_id, data.transactionId, data.transaction_id].find(Number.isInteger)
    const payload = [data.data, data.payload, data.contents].find(Buffer.isBuffer)
    return this.prepare({ channel, messageId, payload })
  }

  // Called synchronously from the wrapped minecraft-protocol Client.write().
  // Return action='suppress' ONLY for recognized FML3 requests. Never interfere
  // with unrelated login plugins or non-1.20.1 sessions.
  interceptAutoReply (name, data, state, version) {
    if (!this.enabled || name !== 'login_plugin_response' ||
        String(state).toLowerCase() !== 'login' || version !== '1.20.1' ||
        !data || typeof data !== 'object') return { action: 'passthrough' }
    const messageId = [data.messageId, data.message_id, data.transactionId, data.transaction_id].find(Number.isInteger)
    if (!this.pending.has(messageId)) {
      this.passthrough++
      return { action: 'passthrough' }
    }
    const { kind, details } = this.pending.get(messageId)
    this.pending.delete(messageId)
    if (kind === 'S2CModData') {
      this.suppressed++
      this.handled.push({ messageId, kind, action: 'suppress', bytes: 0, status: 'informational-no-response' })
      this.events.push('no_response_required:' + messageId + ':' + kind)
      return { action: 'suppress' }
    }
    if (kind === 'S2CModList') {
      // Mod identities still require adapters. Full runtime mode negotiates
      // server-declared channels independently of local codec discovery.
      const mods = this.getNativeAdvertisedMods()
      const channels = [...this.getNativeAdvertisedChannels()]
      const trials = this.experimentalRegistryFlow ? this.experimentalTrialChannels : []
      channels.push(...(this.serverPrimaryChannels ? trials.filter(trial=>!channels.some(channel=>channel.id===trial.id)) : trials))
      const registries = this.getNativeAdvertisedRegistries()
      if (new Set(mods).size !== mods.length || new Set(channels.map(x => x.id)).size !== channels.length || new Set(registries.map(x => x.id)).size !== registries.length) {
        this.warnings.push('duplicate_experimental_channel_in_reply')
        this.suppressed++
        this.handled.push({ messageId, kind, action: 'suppress', bytes: 0 })
        return { action: 'suppress' }
      }
      const payload = wrapFml3Reply(encodeC2SModListReply({ mods, channels, registries }))
      this.replaced++
      this.handled.push({ messageId, kind, action: 'replace', bytes: payload.length })
      this.events.push(mods.length || channels.length || registries.length ? 'replaced_with_native_profile:' + messageId : 'replaced_with_empty_mod_list:' + messageId)
      return { action: 'replace', data: { ...data, successful: true, data: payload } }
    }
    if (this.experimentalRegistryFlow && (kind === 'S2CRegistry' || kind === 'S2CConfigData')) {
      try {
        let receipt
        if (kind === 'S2CRegistry') {
          receipt = this.applyRegistry(details, messageId)
          if (!receipt || receipt.applied !== true) throw new Error('registry_mapping_not_installed')
        } else if (kind === 'S2CConfigData') {
          receipt = this.applyConfig(details, messageId)
          if (!receipt || receipt.stored !== true) throw new Error('config_payload_not_stored')
        }
        const payload = encodeFml3Acknowledge()
        this.replaced++
        this.handled.push({ messageId, kind, action: 'acknowledge', bytes: payload.length, status: receipt.status })
        this.events.push('acknowledged:' + messageId + ':' + kind)
        return { action: 'replace', data: { ...data, successful: true, data: payload } }
      } catch (error) {
        this.warnings.push('ack_blocked:' + kind + ':' + String(error.message).slice(0, 80))
        // Never send a fake ACK on an incomplete or malformed snapshot.
      }
    }
    // Upstream NMP emits a negative/empty response for every login plugin
    // message by default. For recognized Forge handshake messages, suppress
    // the fallback unless the opt-in flow above safely prepared a real ACK.
    // For registry/config, no ACK is possible until the payload has been safely
    // installed in the corresponding data-only runtime store.
    if (kind === 'S2CModData' || kind === 'S2CChannelMismatchData' ||
        kind === 'S2CRegistry' || kind === 'S2CConfigData' || kind === 'unknown') {
      this.suppressed++
      this.handled.push({ messageId, kind, action: 'suppress', bytes: 0 })
      this.events.push('suppressed_auto_reply:' + messageId + ':' + kind)
      if (kind === 'S2CRegistry' || kind === 'S2CConfigData') this.warnings.push('no_registry_or_config_ack_sent:' + messageId)
      return { action: 'suppress' }
    }
    this.passthrough++
    return { action: 'passthrough' }
  }

  getReport () {
    return {
      enabled: this.enabled,
      mode: !this.enabled ? 'passive' : this.experimentalRegistryFlow && this.getNativeAdvertisedMods().length ? 'fml3-runtime-with-node-adapters' : this.experimentalRegistryFlow ? 'experimental-registry-progression' : this.getNativeAdvertisedMods().length ? 'controlled-native-adapters' : this.getNativeAdvertisedChannels().length ? (this.getNativeAdvertisedChannels().every(c => c.id === 'forge:tier_sorting') ? 'controlled-native-tier-diagnostic' : 'controlled-native-channel-diagnostic') : 'controlled-empty-client-diagnostic',
      experimentalRegistryFlow: this.experimentalRegistryFlow,
      experimentalTrialChannels: this.experimentalRegistryFlow ? this.experimentalTrialChannels.map(c => ({ ...c })) : [],
      prepared: this.prepared, replaced: this.replaced,
      suppressed: this.suppressed, passthrough: this.passthrough,
      pendingTransactions: [...this.pending.entries()].map(([messageId, value]) => ({ messageId, type: value.kind })),
      handled: this.handled.slice(-64).map(x => ({ ...x })),
      warnings: this.warnings.slice(-64), events: this.events.slice(-64),
      assumptions: [...this.assumptions],
      advertisesJars: false, nativeModsAdvertised: this.getNativeAdvertisedMods(), nativeChannelsAdvertised: this.getNativeAdvertisedChannels(), nativeRegistriesAdvertised: this.getNativeAdvertisedRegistries(), canJoinModded: false
    }
  }
}

function validateTrialChannels (channels) {
  if (!Array.isArray(channels) || channels.length > 16) throw new Error('invalid_experimental_channel_list')
  const seen = new Set()
  return channels.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/.test(item.id) ||
        typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 64 || seen.has(item.id)) throw new Error('invalid_experimental_channel')
    seen.add(item.id)
    return { id: item.id, version: item.version }
  })
}

module.exports = { Fml3ControlledProbe, validateTrialChannels }
