'use strict'

const { compileCodecPlan, flatSchemaToPlan } = require('../analyzer/codec-ir')
const { unpackSimpleChannel } = require('../protocol/forge/simple-channel')
const { WireReader } = require('../protocol/forge/wire')
const { safeClone } = require('./mod-state')

const CHANNEL = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
// A reusable Forge SimpleChannel data dispatcher. Static JAR candidates are
// read-only observations; registering one NEVER grants an advertised channel.
class GenericPacketDispatcher {
  constructor (runtime, options = {}) {
    this.runtime = runtime
    this.candidates = new Map()
    this.blockedKeys = new Set()
    this.handlers = new Map()
    this.codecHandlers = new Map()
    this.codecHandlerErrors = 0
    this.observedMessageKeys = new Set()
    this.opaqueMessageKeys = new Set()
    this.wireMatches = new Map()
    this.counts = { candidate: 0, structural: 0, envelope: 0, handled: 0, rejected: 0, ignored: 0 }
    this.maxBytes = Math.min(options.maxPayloadBytes ?? 1024 * 1024, 1024 * 1024)
    this.errors = []
  }
  _key (channel, discriminator) {
    if (typeof channel !== 'string' || !CHANNEL.test(channel) || channel.length > 256 ||
        !Number.isInteger(discriminator) || discriminator < 0 || discriminator > 255) throw new Error('invalid_channel_registration')
    return channel + '\u0000' + discriminator
  }
  registerCandidate (message) {
    if (!message || message.direction !== 'clientbound' || !['candidate-codec', 'structural-candidate'].includes(message.codecStatus)) return false
    let key; let codec; let plan
    try {
      key = this._key(message.predictedChannel, message.predictedDiscriminator)
      plan = message.codecPlan || flatSchemaToPlan(message.codecSchema)
      codec = compileCodecPlan(plan)
    } catch (error) { this._error('registration', error.message); return false }
    if (this.blockedKeys.has(key)) return false
    if (this.candidates.has(key)) { this.candidates.delete(key); this.blockedKeys.add(key); this._error('registration', 'duplicate_message_mapping:' + key); return false }
    // Derive a stable entity key only when the JAR-derived IR proves a
    // leading ResourceLocation/UUID field. No hard-coded mod/message names.
    const first = plan.root?.type === 'struct' ? plan.root.fields?.[0] : null
    const entityField = ['resource_location', 'uuid'].includes(first?.codec?.type) ? first.name : null
    this.candidates.set(key, { id: message.id, channel: message.predictedChannel, discriminator: message.predictedDiscriminator, codec, entityField, source: message.codecStatus === 'structural-candidate' ? 'bytecode-structure' : 'static-candidate' })
    return true
  }
  // Only exact unresolved message discriminators may receive an opaque
  // envelope classification. Unknown indices continue to fail closed.
  registerObservedMessage (message) {
    if (!message || message.direction !== 'clientbound' || !['unresolved', 'schema-only'].includes(message.codecStatus)) return false
    try {
      const key = this._key(message.predictedChannel, message.predictedDiscriminator)
      this.observedMessageKeys.add(key)
      if (message.opaqueEnvelope === true) this.opaqueMessageKeys.add(key)
      return true
    } catch { return false }
  }
  // Framework or user provided, real Node implementation. Message handlers
  // are local only: no implicit FML version negotiation or module identity.
  registerHandler ({ channel, discriminator, decode, onMessage, direction = 'clientbound' } = {}) {
    const key = this._key(channel, discriminator)
    if (direction !== 'clientbound' || typeof decode !== 'function' || typeof onMessage !== 'function' || this.handlers.has(key) || this.codecHandlers.has(key)) throw new Error('invalid_native_handler')
    const handler = { channel, discriminator, decode, onMessage }
    this.handlers.set(key, handler)
    return () => this.handlers.get(key) === handler && this.handlers.delete(key)
  }
  registerCodecHandler ({ channel, discriminator, id, onMessage } = {}) {
    const key = this._key(channel, discriminator)
    const candidate = this.candidates.get(key)
    if (!candidate || candidate.id !== id || typeof onMessage !== 'function' ||
        this.handlers.has(key) || this.codecHandlers.has(key)) throw new Error('invalid_codec_handler')
    const handler = { channel, id, onMessage }
    this.codecHandlers.set(key, handler)
    return () => this.codecHandlers.get(key) === handler && this.codecHandlers.delete(key)
  }
  hasChannel (channel) {
    for (const item of this.candidates.values()) if (item.channel === channel) return true
    for (const item of this.handlers.values()) if (item.channel === channel) return true
    return [...this.observedMessageKeys].some(key => key.startsWith(channel + '\u0000'))
  }
  observe (event) {
    if (!event || event.direction !== 'inbound' || String(event.phase).toLowerCase() !== 'play' || !Buffer.isBuffer(event.data)) return { status: 'ignored' }
    if (!this.hasChannel(event.channel)) return { status: 'ignored' }
    let discriminator = null
    try {
      const packet = unpackSimpleChannel(event.data, this.maxBytes)
      discriminator = packet.discriminator
      const key = this._key(event.channel, discriminator)
      const handler = this.handlers.get(key)
      if (handler) {
        const data = handler.decode(packet.payload)
        handler.onMessage(data, { channel: event.channel, discriminator })
        this.counts.handled++
        this.runtime?.emit('genericModMessage', { channel: event.channel, discriminator, data, status: 'handled' })
        return { status: 'handled', channel: event.channel, discriminator, data }
      }
      const candidate = this.candidates.get(key)
      if (!candidate) {
        if (!this.observedMessageKeys.has(key)) throw new Error('missing_candidate_decoder')
        if (this.opaqueMessageKeys.has(key)) {
          this.counts.envelope++
          const data = { opaqueBytes: packet.payload.length, decodedBody: false, reason: 'unsupported_registered_codec' }
          this.runtime?.emit('nativeChannelEnvelope', { channel: event.channel, discriminator, data, status: 'envelope-only' })
          return { status: 'envelope-only', channel: event.channel, discriminator, data }
        }
        // Resource-location prefix is independently recognizable, even for
        // messages whose remainder cannot yet be decoded. Never consume or
        // apply the opaque remainder as configuration/client behavior.
        let identifier = null
        let opaqueBytes = packet.payload.length
        try {
          const reader = new WireReader(packet.payload)
          identifier = reader.identifier()
          opaqueBytes = reader.remaining
        } catch { throw new Error('unrecognized_unresolved_message_envelope') }
        this.counts.envelope++
        const data = { resourceLocation: identifier, opaqueBytes, decodedBody: false }
        this.runtime?.emit('nativeChannelEnvelope', { channel: event.channel, discriminator, data, status: 'envelope-only', entityKey: identifier })
        return { status: 'envelope-only', channel: event.channel, discriminator, data }
      }
      const data = candidate.codec.decode(packet.payload)
      // Re-encode the decoded value as an additional wire consistency check.
      // Equal bytes only establish parity for this sample, not that all
      // branches, nonempty collections or Java side effects are implemented.
      const encoded = candidate.codec.encode(data)
      const roundTripExact = Buffer.isBuffer(encoded) && encoded.equals(packet.payload)
      if (!roundTripExact) throw new Error('candidate_wire_roundtrip_mismatch')
      const keyStats = this.wireMatches.get(key) || { observed: 0, exact: 0 }
      keyStats.observed++; keyStats.exact++
      this.wireMatches.set(key, keyStats)
      const structural = candidate.source === 'bytecode-structure'
      const status = structural ? 'structural-only' : 'candidate-only'
      const message = { channel: event.channel, discriminator, id: candidate.id, data, status, roundTripExact,
        entityKey: candidate.entityField ? data[candidate.entityField] : null }
      const codecHandler = this.codecHandlers.get(key)
      if (codecHandler?.id === candidate.id) {
        let handled = false
        try {
          const result = codecHandler.onMessage(safeClone(data), {
            channel: message.channel, discriminator, id: message.id, entityKey: message.entityKey,
            codecStatus: status, roundTripExact: true
          })
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {})
            throw new Error('codec_handler_must_be_synchronous')
          }
          handled = result !== false
        } catch {
          this.codecHandlerErrors++
          this.runtime?.emit('modCodecHandlerError', { channel: message.channel, discriminator, id: message.id })
        }
        if (handled) {
          this.counts.handled++
          message.status = 'handled'
          this.runtime?.emit('genericModMessage', message)
          return { ...message, serverVerified: false }
        }
      }
      if (structural) this.counts.structural++
      else this.counts.candidate++
      this.runtime?.emit('nativeChannelCandidate', message)
      return { status, channel: event.channel, discriminator, id: candidate.id, data, roundTripExact, serverVerified: false }
    } catch (error) {
      this.counts.rejected++
      this._error(event.channel, error.message, discriminator)
      this.runtime?.emit('nativeChannelDecodeError', { channel: event.channel, discriminator, reason: error.message })
      return { status: 'rejected', reason: error.message, discriminator }
    }
  }
  _error (channel, reason, discriminator = null) {
    this.errors.push({ channel, discriminator, reason })
    if (this.errors.length > 32) this.errors.shift()
  }
  report () {
    return { candidates: [...this.candidates.values()].map(({ id, channel, discriminator }) => ({ id, channel, discriminator, serverVerified: false })),
      observedUnresolvedMessageCount: this.observedMessageKeys.size, wireMatches: [...this.wireMatches].map(([key, v]) => ({ channel: key.split('\u0000')[0], discriminator: Number(key.split('\u0000')[1]), ...v, serverVerified: false })),
      handlerCount: this.handlers.size, codecHandlerCount: this.codecHandlers.size, codecHandlerErrors: this.codecHandlerErrors,
      blockedKeys: this.blockedKeys.size, counters: { ...this.counts }, errors: this.errors.map(x => ({ ...x })) }
  }
}
module.exports = { GenericPacketDispatcher }
