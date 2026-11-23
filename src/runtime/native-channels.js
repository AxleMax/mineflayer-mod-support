'use strict'

const { GenericPacketDispatcher } = require('./packet-dispatcher')
const { evaluateChannelCoverage } = require('./channel-coverage')
const { unpackSimpleChannel, packSimpleChannel, TierSortingState } = require('../protocol/forge/simple-channel')

const MOD_ID = /^[a-z0-9_.-]+$/
const CHANNEL_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const MAX_ADAPTERS = 128
const MAX_CHANNELS = 256
const MAX_MESSAGES_PER_CHANNEL = 256
const MAX_SERVERBOUND_PAYLOAD_BYTES = 32767

function validateAdapter (adapter) {
  if (!adapter || typeof adapter !== 'object' || !MOD_ID.test(adapter.id || '') ||
      typeof adapter.version !== 'string' || adapter.version.length < 1 || adapter.version.length > 128 ||
      adapter.advertise !== true || !Array.isArray(adapter.channels) || adapter.channels.length < 1 || adapter.channels.length > 32) {
    throw new Error('invalid_native_mod_adapter')
  }
  const seenChannels = new Set()
  const channels = adapter.channels.map(channel => {
    const framing = channel?.framing || 'forge-simple-channel'
    if (!channel || !CHANNEL_ID.test(channel.id || '') || typeof channel.version !== 'string' ||
        channel.version.length < 1 || channel.version.length > 64 || !Array.isArray(channel.messages) ||
        channel.messages.length < 1 || channel.messages.length > MAX_MESSAGES_PER_CHANNEL || seenChannels.has(channel.id) ||
        !['forge-simple-channel', 'raw'].includes(framing) || (framing === 'raw' && channel.messages.length !== 1)) {
      throw new Error('invalid_native_mod_channel')
    }
    seenChannels.add(channel.id)
    const seenDiscriminators = new Set()
    const messages = channel.messages.map(message => {
      const direction = message?.direction
      const discriminator = framing === 'raw' ? null : message?.discriminator
      if (!message || (framing === 'forge-simple-channel' && (!Number.isInteger(discriminator) || discriminator < 0 || discriminator > 255)) ||
          (framing === 'raw' && message.discriminator != null) ||
          !['clientbound', 'serverbound', 'bidirectional'].includes(direction) || seenDiscriminators.has(discriminator)) {
        throw new Error('invalid_native_mod_message')
      }
      const clientbound = direction === 'clientbound' || direction === 'bidirectional'
      const serverbound = direction === 'serverbound' || direction === 'bidirectional'
      if (clientbound && (typeof message.decode !== 'function' || typeof message.onMessage !== 'function')) throw new Error('native_clientbound_handler_required')
      if (serverbound && typeof message.encode !== 'function') throw new Error('native_serverbound_encoder_required')
      seenDiscriminators.add(discriminator)
      return { name:typeof message.name==='string'?message.name:null,discriminator, direction, decode: message.decode, encode: message.encode, onMessage: message.onMessage }
    })
    return { id: channel.id, version: channel.version, framing, messages }
  })
  return { id: adapter.id, version: adapter.version, advertise: true, channels }
}

// Native, JVM-free channel compatibility layer. JAR-derived candidates remain
// read-only. Explicit observation mode may negotiate traced local channels;
// sending Mod payloads still requires an explicitly registered Node adapter.
class NativeChannelRuntime {
  constructor (runtime, options = {}, compatibility = null) {
    this.runtime = runtime
    this.tier = new TierSortingState()
    this.standardSplitAdvertisement = options.experimental?.fml3Runtime === true
    this.experimentalTierAdvertisement = options.experimental?.nativeTierChannel === true
    this.dispatcher = new GenericPacketDispatcher(runtime, options)
    this.candidates = this.dispatcher.candidates
    this.adapters = new Map()
    this.adapterChannels = new Map()
    this.rawChannels = new Map()
    this.pendingRequests = new Map()
    this.messageEvidence = new Map()
    this._handlerDisposers = new Map()
    this._registeredPlayChannels = new Set()
    this._playRegistrationSent = false
    this._registrationCompleted = false
    this._firstServerPlayPacket = null
    this._serverPlayPacketObserved = false
    this._registerScheduled = false
    this._registerImmediate = null
    this._disposed = false
    this._transportEnded = false
    this._subscriptions = []
    this.tx = { messages: 0, bytes: 0, registrationPackets: 0, unregisterPackets: 0, failures: 0 }
    this.rx = { handled: 0, candidate: 0, structural: 0, envelope: 0, rejected: 0, ignored: 0 }
    this.failures = []
    this.observations = []
    this.warnings = []
    const manifest = compatibility?._manifest
    this._observedMessages = manifest?.messages || []
    for (const msg of manifest?.messages || []) {
      this.dispatcher.registerObservedMessage(msg)
      this.dispatcher.registerCandidate(msg)
    }
    // Constructor-scoped mappings remain opt-in observations. Channel
    // negotiation needs a separate explicit test-only flag; no Mod IDs,
    // Java behavior or serverbound encoders are inferred.
    this.forgeJarChannelObservation = options.experimental?.forgeJarChannelObservation === true && options.experimental?.fml3Runtime === true
    this.observationChannels = new Map()
    this.resolveChannelNegotiation = channels => ({ policy: 'local-only', channels, entries: [], versionConflicts: [] })
    this.wrapperObservationChannels = this.forgeJarChannelObservation ? compatibility?.wrapperChannels || [] : []
    this.forgeJarCodecObservation = options.experimental?.forgeJarCodecObservation === true || this.forgeJarChannelObservation
    if (this.forgeJarCodecObservation) for (const source of compatibility?.forgeChannels || []) for (const message of source.registrations) {
      const channel = message.channelBinding?.channel?.name?.resourceLocation
      if (!channel || !['PLAY_TO_CLIENT','UNRESTRICTED'].includes(message.direction) || message.constructorScopedDiscriminator == null) continue
      const candidate = { id: channel + '/' + message.className, direction: 'clientbound',
        predictedChannel: channel, predictedDiscriminator: message.constructorScopedDiscriminator,
        codecStatus: message.codecStatus === 'blocked' ? 'unresolved' : message.codecStatus, codecPlan: message.codec?.inference?.plan, opaqueEnvelope: true }
      this.dispatcher.registerObservedMessage(candidate)
      this.dispatcher.registerCandidate(candidate)
      const identity = message.channelIdentity
      if (this.forgeJarChannelObservation && identity?.id === channel && identity.policy === 'exact-equality') {
        const existing = this.observationChannels.get(channel)
        if (existing && existing.version !== identity.version) throw new Error('conflicting_observation_channel_version')
        this.observationChannels.set(channel, { id: channel, version: identity.version })
      }
    }
    if (typeof runtime.on === 'function') {
      // CRITICAL: a client-side transition to PLAY is not proof the server
      // has switched its inbound packet decoder to PLAY. A premature PLAY
      // custom_payload can be decoded as a LOGIN packet and disconnect the bot.
      // Only the real Join Game (PLAY login) packet establishes this barrier.
      // NMP playerJoin fires at login success, before a real server PLAY packet.
      const onPacket = packet => {
        if (packet?.direction === 'inbound' && String(packet.phase).toLowerCase() === 'play' && packet.name === 'login') {
          this._serverPlayPacketObserved = true
          if (this._firstServerPlayPacket === null) this._firstServerPlayPacket = String(packet.name || 'unknown').slice(0, 48)
          this._schedulePlayRegistration()
        }
      }
      const onEnd = () => {
        this._transportEnded = true
        this._cancelRequests('native_request_transport_ended')
        this._disposeMessageHandlers()
        if (this._registerImmediate) clearImmediate(this._registerImmediate)
        this._registerImmediate = null
        this._registerScheduled = false
      }
      runtime.on('packet', onPacket)
      runtime.on('end', onEnd)
      this._subscriptions.push(['packet', onPacket], ['end', onEnd])
    }
  }

  registerChannel (profile) {
    const id='channel-'+require('node:crypto').createHash('sha256').update(profile.id).digest('hex').slice(0,24)
    return this.registerModAdapter({id,version:'1',advertise:true,channels:[profile]},true)
  }

  registerModAdapter (input, channelOnly=false) {
    if (this.runtime.fml3Controller?.enabled !== true || this.runtime.fml3Controller?.experimentalRegistryFlow !== true) throw new Error('native_mod_adapter_requires_fml3_runtime')
    if (!channelOnly && (this.runtime.fml3?.modList || this.runtime.protocol?.state === 'play')) throw new Error('native_mod_adapter_registered_after_fml3_modlist')
    if (this.adapters.size >= MAX_ADAPTERS) throw new Error('native_mod_adapter_limit')
    const adapter = validateAdapter(input)
    adapter.channelOnly=channelOnly
    if(channelOnly)adapter.advertise=false
    if (this.adapters.has(adapter.id)) throw new Error('duplicate_native_mod_adapter')
    const channelCount = [...this.adapterChannels.keys()].length
    if (channelCount + adapter.channels.length > MAX_CHANNELS) throw new Error('native_mod_channel_limit')
    for (const channel of adapter.channels) {
      if (this.adapterChannels.has(channel.id)) throw new Error('duplicate_native_mod_channel')
      if (channel.framing === 'raw' && [...this.dispatcher.codecHandlers.values()].some(handler => handler.channel === channel.id)) throw new Error('raw_channel_conflicts_with_codec_handler')
    }

    const disposers = []
    try {
      for (const channel of adapter.channels) {
        for (const message of channel.messages) {
          if ((message.direction === 'clientbound' || message.direction === 'bidirectional') && channel.framing === 'forge-simple-channel') {
            disposers.push(this.dispatcher.registerHandler({
              channel: channel.id,
              discriminator: message.discriminator,
              decode: message.decode,
              onMessage: message.onMessage,
              direction: 'clientbound'
            }))
          }
        }
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
      throw error
    }

    this.adapters.set(adapter.id, adapter)
    for (const channel of adapter.channels) {
      this.adapterChannels.set(channel.id, { adapterId: adapter.id, channel })
      if (channel.framing === 'raw') this.rawChannels.set(channel.id, { adapterId: adapter.id, channel })
    }
    this._handlerDisposers.set(adapter.id, disposers)
    this.runtime.emit('nativeModAdapterRegistered', { id: adapter.id, version: adapter.version, channels: adapter.channels.map(c => c.id), advertised: adapter.advertise })
    if(channelOnly&&this._serverPlayPacketObserved){this._registrationCompleted=false;this._schedulePlayRegistration()}

    return () => this.unregisterModAdapter(adapter.id)
  }

  unregisterModAdapter (modId) {
    const adapter = this.adapters.get(modId)
    if (!adapter) return false
    const channelIds = adapter.channels.map(channel => channel.id)
    const disposers = this._handlerDisposers.get(modId) || []
    for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
    this._handlerDisposers.delete(modId)
    this.adapters.delete(modId)
    for (const id of channelIds) { this.adapterChannels.delete(id); this.rawChannels.delete(id) }
    for (const id of channelIds) this.pendingRequests.get(id)?.reject(new Error('native_request_adapter_removed'))
    const registeredIds = channelIds.filter(id => this._registeredPlayChannels.has(id))
    if (registeredIds.length) this._sendChannelRegistration('minecraft:unregister', registeredIds, 'unregisterPackets')
    for (const id of channelIds) this._registeredPlayChannels.delete(id)
    return true
  }

  getAdvertisedMods () {
    return [...this.adapters.values()].filter(adapter => adapter.advertise).map(adapter => adapter.id).sort()
  }

  getAdvertisedChannels () {
    return this.getChannelNegotiation().channels
  }

  getChannelNegotiation () { return this.resolveChannelNegotiation(this.getLocalAdvertisedChannels()) }

  getLocalAdvertisedChannels () {
    const channels = []
    if (this.standardSplitAdvertisement && this.runtime.client?.version === '1.20.1') channels.push({ id: 'forge:split', version: '1.1' })
    if (this.experimentalTierAdvertisement) channels.push({ id: 'forge:tier_sorting', version: '1.0' })
    for (const adapter of this.adapters.values()) {
      if (!adapter.advertise && !adapter.channelOnly) continue
      if(adapter.channelOnly&&!this.runtime.fml3?.modList?.channels?.some(peer=>peer.id===adapter.channels[0].id))continue
      for (const channel of adapter.channels) channels.push({ id: channel.id, version: channel.version })
    }
    for (const channel of this.observationChannels.values()) if (!this.adapterChannels.has(channel.id)) channels.push({ ...channel })
    for(const channel of this.wrapperObservationChannels) {
      // A local declaration is not a Mod/behavior claim. Admit only the exact
      // version also declared by the peer; never copy or guess the peer version.
      const peer=this.runtime.fml3?.modList?.channels?.find(peer=>peer.id===channel.id)
      if(channel.policy==='local-supplier-and-exact-peer-version' && peer?.version===channel.version && !channels.some(c=>c.id===channel.id))channels.push({id:channel.id,version:channel.version})
    }
    return channels.sort((a, b) => a.id.localeCompare(b.id))
  }

  getAdvertisedRegistries () { return [] }

  send (channelId, discriminator, value) {
    if (this._disposed || this._transportEnded) throw new Error('native_channel_transport_ended')
    const owner = this.adapterChannels.get(channelId)
    if (!owner) throw new Error('native_channel_not_registered')
    const framing = owner.channel.framing
    const messageDiscriminator = framing === 'raw' ? null : discriminator
    const message = owner.channel.messages.find(item => item.discriminator === messageDiscriminator)
    if (!message || (message.direction !== 'serverbound' && message.direction !== 'bidirectional')) throw new Error('native_serverbound_message_not_implemented')
    if (framing === 'raw' && discriminator != null) throw new Error('raw_channel_discriminator_must_be_null')
    if (this.runtime.protocol?.state !== 'play' || String(this.runtime.client?.state || '').toLowerCase() !== 'play') throw new Error('native_channel_send_requires_play')
    const serverChannel = this.runtime.fml3?.modList?.channels?.find(item => item.id === channelId)
    if (!serverChannel) throw new Error('server_channel_not_declared')
    if (!this._registeredPlayChannels.has(channelId)) throw new Error('native_channel_not_registered_in_play')
    if (serverChannel.version !== owner.channel.version) throw new Error('server_channel_version_mismatch')
    const payload = message.encode(value)
    if (!Buffer.isBuffer(payload)) throw new Error('native_channel_encoder_must_return_bounded_buffer')
    const data = framing === 'raw' ? payload : packSimpleChannel(discriminator, payload)
    if (data.length > MAX_SERVERBOUND_PAYLOAD_BYTES) throw new Error('native_channel_encoder_must_return_bounded_buffer')
    if (typeof this.runtime.client?.write !== 'function') throw new Error('minecraft_protocol_client_write_unavailable')
    this.runtime.client.write('custom_payload', { channel: channelId, data })
    this.tx.messages++
    this.tx.bytes += data.length
    this.recordMessageEvidence(channelId,discriminator,'sent')
    const result = { status: 'sent', channel: channelId, discriminator, bytes: data.length, serverConfirmed: false }
    this.runtime.emit('nativeChannelSent', result)
    return result
  }

  request (channel, discriminator, value, { responseDiscriminator, match, timeoutMs = 5000, signal } = {}) {
    if(signal?.aborted)return Promise.reject(new Error('native_request_aborted'))
    const messages = this.adapterChannels.get(channel)?.channel.messages
    if (!messages?.some(message => message.discriminator === responseDiscriminator && message.direction !== 'serverbound') ||
        typeof match !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      return Promise.reject(new Error('invalid_native_request_response'))
    }
    if (this.pendingRequests.has(channel)) return Promise.reject(new Error('native_request_already_pending'))
    return new Promise((resolve, reject) => {
      let settled = false
      let sent
      const finish = (error, response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort',onAbort)
        this.pendingRequests.delete(channel)
        if (error) reject(error)
        else resolve({ request: sent, response, serverEffectConfirmed: false })
      }
      const timer = setTimeout(() => finish(new Error('native_request_timeout')), timeoutMs)
      const onAbort=()=>finish(new Error('native_request_aborted'))
      signal?.addEventListener('abort',onAbort,{once:true})
      this.pendingRequests.set(channel, { responseDiscriminator, match, resolve: response => finish(null, response), reject: finish })
      try { sent = this.send(channel, discriminator, value) } catch (error) { finish(error) }
    })
  }

  _matchResponse (response) {
    const pending = this.pendingRequests.get(response.channel)
    if (!pending || pending.responseDiscriminator !== response.discriminator) return
    // Defer settlement until the transport write returns, including in-process transports.
    queueMicrotask(() => {
      if (this.pendingRequests.get(response.channel) !== pending) return
      try {
        const matched = pending.match(response.data)
        if (matched && typeof matched.then === 'function') Promise.resolve(matched).catch(() => {})
        if (matched === true) {this.recordMessageEvidence(response.channel,response.discriminator,'matchedResponses');pending.resolve(response)}
        else if (matched !== false) pending.reject(new Error('native_request_match_must_return_boolean'))
      } catch (error) { pending.reject(error) }
    })
  }

  _cancelRequests (reason) {
    for (const request of this.pendingRequests.values()) request.reject(new Error(reason))
  }

  recordMessageEvidence(channel,discriminator,kind){const key=channel+'\0'+(discriminator??-1);if(!this.messageEvidence.has(key)&&this.messageEvidence.size>=2048)return;const value=this.messageEvidence.get(key)||{sent:0,received:0,matchedResponses:0,serverEffectConfirmed:false};value[kind]++;this.messageEvidence.set(key,value)}

  _schedulePlayRegistration () {
    if (!this._serverPlayPacketObserved || this._registrationCompleted || this._registerScheduled || this._disposed || this._transportEnded) return
    this._registerScheduled = true
    // Wait until NMP/Mineflayer finishes dispatching the incoming packet.
    this._registerImmediate = setImmediate(() => {
      this._registerScheduled = false
      this._registerImmediate = null
      if (!this._disposed && !this._transportEnded) this.registerPlayChannels()
    })
  }

  registerPlayChannels () {
    if (this._disposed || this._transportEnded || this._registrationCompleted || !this._serverPlayPacketObserved) return false
    // The built-in tier channel already participates in FML3 negotiation and
    // has no registered Node Mod adapter. Do NOT send an unsolicited REGISTER
    // just to advertise a diagnostic clientbound-only handler.
    const ids = [...new Set([...this.adapterChannels.entries()]
      .filter(([id, owner]) => {const adapter=this.adapters.get(owner.adapterId);return adapter?.advertise===true || adapter?.channelOnly===true&&this.runtime.fml3?.modList?.channels?.some(peer=>peer.id===id&&peer.version===owner.channel.version)})
      .map(([id]) => id).concat([...this.observationChannels.keys()]))].sort()
    if (!ids.length) { this._registrationCompleted = true; return false }
    const serverSupportsRegister = this.runtime.fml3?.modList?.channels?.some(channel => channel.id === 'minecraft:register')
    if (!serverSupportsRegister) {
      this.warnings.push('server_did_not_declare_minecraft_register')
      this._registrationCompleted = true
      return false
    }
    const sent = this._sendChannelRegistration('minecraft:register', ids, 'registrationPackets')
    if (sent) {
      for (const id of ids) this._registeredPlayChannels.add(id)
      this._playRegistrationSent = true
      this._registrationCompleted = true
      this.runtime.emit('nativePlayChannelRegistered', { channels: [...ids] })
    }
    return sent
  }

  _sendChannelRegistration (packetChannel, ids, counterName) {
    if (this._disposed || this._transportEnded || !this._serverPlayPacketObserved) return false
    const filtered = [...new Set(ids)].filter(id => CHANNEL_ID.test(id))
    if (!filtered.length || this.runtime.protocol?.state !== 'play' || String(this.runtime.client?.state || '').toLowerCase() !== 'play') return false
    if (typeof this.runtime.client?.write !== 'function') {
      this.warnings.push('minecraft_protocol_client_write_unavailable')
      return false
    }
    const data = Buffer.from(filtered.join('\0'), 'utf8')
    if (data.length > MAX_SERVERBOUND_PAYLOAD_BYTES) { this.warnings.push('minecraft_channel_registration_payload_too_large'); return false }
    this.runtime.client.write('custom_payload', { channel: packetChannel, data })
    this.tx[counterName]++
    return true
  }

  observe (event) {
    if (this._disposed || this._transportEnded) return { status: 'ignored' }
    if (event?.direction !== 'inbound' || String(event?.phase).toLowerCase() !== 'play' || !Buffer.isBuffer(event?.data)) return { status: 'ignored' }
    const channel = event.channel
    const owner=this.adapterChannels.get(channel)
    if(owner&&this.adapters.get(owner.adapterId)?.channelOnly&&!this.runtime.fml3?.modList?.channels?.some(peer=>peer.id===channel&&peer.version===owner.channel.version))return{status:'envelope-only',channel,decodedBody:false,opaqueBytes:event.data.length,reason:'adapter_channel_not_matched'}
    if (this.getChannelNegotiation().versionConflicts.some(entry=>entry.id===channel)) {
      this.rx.envelope++
      this._failure(channel,null,'local_codec_channel_version_mismatch')
      return {status:'envelope-only',channel,decodedBody:false,opaqueBytes:event.data.length,reason:'local_codec_channel_version_mismatch'}
    }
    if (channel !== 'forge:tier_sorting') {
      const rawEntry = this.rawChannels.get(channel)
      if (rawEntry) {
        const maxPayloadBytes = this.runtime.options?.maxPayloadBytes ?? 1024 * 1024
        if (event.data.length > maxPayloadBytes) {
          this.rx.rejected++
          this._failure(channel, null, 'raw_channel_payload_too_large')
          return { status: 'rejected', reason: 'raw_channel_payload_too_large' }
        }
        const message = rawEntry.channel.messages[0]
        if (message.direction !== 'clientbound' && message.direction !== 'bidirectional') return { status: 'ignored' }
        try {
          const data = message.decode(event.data)
          message.onMessage(data, { channel, discriminator: null, phase: event.phase, direction: 'inbound' })
          this.rx.handled++
          this.recordMessageEvidence(channel,null,'received')
          const response = { channel, discriminator: null, status: 'handled', data }
          this.runtime.emit('nativeChannelMessage', response)
          this._matchResponse(response)
          return response
        } catch (error) {
          this.rx.rejected++
          this._failure(channel, null, String(error?.message || error).slice(0, 80))
          this.runtime.emit('nativeChannelDecodeError', { channel, reason: String(error?.message || error).slice(0, 80) })
          return { status: 'rejected', reason: 'raw_channel_decode_failed' }
        }
      }
      const result = this.dispatcher.observe(event)
      if (result.status === 'candidate-only' || result.status === 'structural-only') {
        if (result.status === 'structural-only') this.rx.structural++
        this.rx.candidate++
        this._observation(channel, result.discriminator, result.id)
      } else if (result.status === 'envelope-only') this.rx.envelope++
      else if (result.status === 'handled') {
        this.rx.handled++
        this.recordMessageEvidence(channel,result.discriminator,'received')
        if (this.adapterChannels.has(channel)) this._matchResponse(result)
      }
      else if (result.status === 'rejected') { this.rx.rejected++; this._failure(channel, result.discriminator, result.reason) }
      return result
    }
    try {
      const { discriminator, payload } = unpackSimpleChannel(event.data)
      const data = this.tier.receive(discriminator, payload)
      this.rx.handled++
      this.runtime.emit('nativeChannelMessage', { channel, discriminator, status: 'handled', data })
      return { status: 'handled', channel, discriminator, data }
    } catch (error) {
      this.rx.rejected++
      this._failure(channel, null, error.message)
      this.runtime.emit('nativeChannelDecodeError', { channel, reason: error.message })
      return { status: 'rejected', reason: error.message }
    }
  }

  registerHandler (handler) {
    // Local-only handlers remain unadvertised unless part of an explicit Mod adapter.
    return this.dispatcher.registerHandler(handler)
  }

  _failure (channel, discriminator, reason) {
    this.failures.push({ channel, discriminator, reason })
    if (this.failures.length > 32) this.failures.shift()
  }
  _observation (channel, discriminator, id) {
    this.observations.push({ channel, discriminator, id, status: 'candidate-only' })
    if (this.observations.length > 32) this.observations.shift()
  }

  destroy () {
    this._disposed = true
    this._cancelRequests('native_request_transport_ended')
    this._disposeMessageHandlers()
    if (this._registerImmediate) clearImmediate(this._registerImmediate)
    this._registerImmediate = null
    this._registerScheduled = false
    if (typeof this.runtime.removeListener === 'function') {
      for (const [event, handler] of this._subscriptions) this.runtime.removeListener(event, handler)
    }
    this._subscriptions.length = 0
  }

  _disposeMessageHandlers () {
    for (const disposers of this._handlerDisposers.values()) for (const dispose of disposers) dispose()
    this._handlerDisposers.clear()
    this.dispatcher.handlers.clear()
    this.dispatcher.codecHandlers.clear()
  }

  getReport () {
    const adapters = [...this.adapters.values()].map(adapter => ({
      id: adapter.id,
      version: adapter.version,
      advertised: adapter.advertise,
      channels: adapter.channels.map(channel => ({
        id: channel.id,
        version: channel.version,
        framing: channel.framing,
        messages: channel.messages.map(message => ({ discriminator: message.discriminator, direction: message.direction }))
      }))
    }))
    return {
      advertisedMods: this.getAdvertisedMods(),
      advertisedChannels: this.getAdvertisedChannels(),
      channelNegotiation: this.getChannelNegotiation(),
      wrapperChannelDeclarations: this.wrapperObservationChannels.map(channel=>({
        ...channel,admitted:this.getAdvertisedChannels().some(offered=>offered.id===channel.id&&offered.version===channel.version),
        scope:'channel negotiation and bounded incoming observation only; no Mod ID, serverbound encoder or behavior'
      })),
      adapters,
      forgeJarObservation: { enabled: this.forgeJarCodecObservation, channelAdvertisementEnabled: this.forgeJarChannelObservation,
        channels: [...this.observationChannels.values()], mode: 'constructor-scoped-data-observation', clientBehaviorImplemented: false, serverboundEnabled: false },
      playChannelRegistration: {
        sent: this._playRegistrationSent, channels: [...this._registeredPlayChannels],
        serverPlayPacketObserved: this._serverPlayPacketObserved,
        firstServerPlayPacket: this._firstServerPlayPacket,
        registrationCompleted: this._registrationCompleted,
        transportEnded: this._transportEnded,
        timing: 'after_clientbound_join_game_packet',
        registrationDeferred: this._registerScheduled
      },
      transmit: { ...this.tx },
      implementedChannels: [{ id: 'forge:tier_sorting', version: '1.0', direction: 'clientbound', completeness: 'wire-and-state', serverVerified: false }],
      candidateDecoders: [...this.candidates.values()].filter(v => v.source === 'static-candidate').map(({ id, channel, discriminator }) => ({ id, channel, discriminator, serverVerified: false })),
      structuralDecoders: [...this.candidates.values()].filter(v => v.source === 'bytecode-structure').map(({ id, channel, discriminator }) => ({ id, channel, discriminator, serverVerified: false })),
      modChannelsAdvertisable: adapters.some(adapter=>adapter.advertised===true),
      genericNetwork: this.dispatcher.report(),
      genericChannelCoverage: evaluateChannelCoverage(this._observedMessages, this.dispatcher),
      tierSorting: this.tier.getReport(),
      receive: { ...this.rx }, failures: this.failures.map(x => ({ ...x })), observations: this.observations.map(x => ({ ...x })),
      warnings: this.warnings.slice(-32),
      canJoinModded: false
    }
  }
}
module.exports = { NativeChannelRuntime, validateAdapter }
