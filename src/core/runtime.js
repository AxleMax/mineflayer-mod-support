'use strict'

const { EventEmitter } = require('node:events')
const { instrumentClient } = require('./client-instrumentation')
const { ChannelInspector } = require('../network/channel-inspector')
const { CompatibilityRuntime } = require('../runtime/compatibility')
const { ServerRegistryMappings } = require('../runtime/registry-mappings')
const { ServerConfigStore } = require('../runtime/server-config-store')
const { PlayWireRecorder } = require('../runtime/play-wire-recorder')
const { ModStateStore } = require('../runtime/mod-state')
const { GenericModDataRuntime } = require('../runtime/mod-data')
const { NativeRegistryBridge } = require('../runtime/native-registry-bridge')
const { NativeInventoryObserver } = require('../runtime/native-inventory-observer')
const { createLoaderProtocol } = require('./loader-protocol')
const { AdapterHost } = require('./adapter-host')
const { ContentDefinitions } = require('./content-definitions')
const { NativeWindowBridge } = require('../runtime/native-window-bridge')
const { MenuRules } = require('../runtime/menu-rules')
const { BlockCollisions, NativeBlockReader } = require('../runtime/block-collisions')
const { CapabilityCatalog } = require('./capability-catalog')


const DEFAULT_OPTIONS = Object.freeze({
  trace: Object.freeze({ packets: false, raw: false, log: false }),
  maxPayloadBytes: 1024 * 1024
})

class ModSupportRuntime extends EventEmitter {
  constructor (options = {}) {
    super()
    if (Object.hasOwn(options, 'nativeItemOperations')) throw new Error('nativeItemOperations_removed: use native bot.equip(item, destination)')
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      trace: { ...DEFAULT_OPTIONS.trace, ...(options.trace || {}) }
    }
    this.state = 'created'
    this.client = null
    this.bot = null
    this.loader = {
      name: 'unknown',
      version: null,
      confidence: 'unknown'
    }
    this.protocol = {
      minecraftVersion: null,
      protocolVersion: null,
      state: null,
      packetsIn: 0,
      packetsOut: 0,
      rawPacketsIn: 0,
      rawPacketsOut: 0
    }
    this._instrumentation = null
    this._readySettled = false
    this._packetListeners = new Set()
    this.packetDecodeFailures = []
    this.packetDecodeFailureCount = 0
    this.network = new ChannelInspector(this)
    this.registryMappings = new ServerRegistryMappings()
    this.contentDefinitions = new ContentDefinitions()
    this.menuRules = new MenuRules()
    this.blockCollisions = new BlockCollisions()
    this.nativeBlockReader = new NativeBlockReader(this.blockCollisions, event => this.emit('blockCollisionError', event), event => this.emit('unresolvedBlockState', event))
    this.serverConfigs = new ServerConfigStore()
    this.nativeRegistry = new NativeRegistryBridge({ mappings: this.registryMappings, definitions: this.contentDefinitions, itemOverlay: this.options.nativeRegistry?.itemOverlay !== false, entityOverlay: this.options.nativeRegistry?.entityOverlay !== false, blockOverlay: this.options.nativeRegistry?.blockOverlay !== false })
    this.nativeWindows = new NativeWindowBridge(this.nativeRegistry, { definitions: this.contentDefinitions, rules: this.menuRules,
      context: window => this.loaderProtocol.getMenuContext?.(window.id) || { menu: window.type, windowId: window.id } })
    this.nativeInventory = new NativeInventoryObserver({ bridge: this.nativeRegistry, enabled: this.options.nativeInventory?.observe === true, expectedItem: this.options.nativeInventory?.expectedItem ?? null })
    this.nativeInventory.on('modItemObserved', item => this.emit('modItemObserved', item))
    this.nativeInventory.on('modItemNameMismatch', item => this.emit('modItemNameMismatch', item))
    this.modState = new ModStateStore()
    this.playWire = new PlayWireRecorder({
      enabled: this.options.experimental?.playWireCapture === true,
      channels: this.options.experimental?.playWireCaptureChannels ?? 'modded'
    })
    this.compatibility = new CompatibilityRuntime(this.options)
    this.capabilities = new CapabilityCatalog()
    this.modData = new GenericModDataRuntime({ manifest: this.compatibility._manifest, registryMappings: this.registryMappings })
    this.loaderProtocol = createLoaderProtocol(this, options.loaderProtocol)
    this.adapters = new AdapterHost(this)
    this.on('nativeModAdapterRegistered', () => this._syncCompatibilityEvidence())
    this.on('nativePlayChannelRegistered', () => this._syncCompatibilityEvidence())
    this.on('registryInstalled', () => this._syncCompatibilityEvidence())
    this.on('protocolState', () => this._syncCompatibilityEvidence())
    this._syncCompatibilityEvidence()
    // Candidate wire parity gives observational state, not business semantics.
    // Handled messages are marked applied only when an actual Node handler ran.
    for (const eventName of ['nativeChannelCandidate', 'nativeChannelEnvelope', 'genericModMessage']) {
      this.on(eventName, event => {
        const status = eventName === 'genericModMessage' ? 'handled' : event.status
        const stored = this.modState.record({ ...event, status })
        if (stored) {
          const projection = this.modData.observe(stored)
          if (projection) this.emit('modDataObserved', { channel: projection.channel, discriminator: projection.discriminator, kind: projection.kind, entityKey: projection.entityKey, revision: projection.revision, appliedToModRuntime: projection.appliedToModRuntime, changes: projection.changes })
          this.emit(status === 'handled' ? 'modStateApplied' : 'modStateObserved', stored)
        }
      })
    }
    this.on('payload', event => {
      const outcome = this.loaderProtocol.observePayload?.(event) || { status: 'ignored' }
      this.capabilities.record(event,outcome)
      if (this.playWire.observe(event, outcome)) {
        this.emit('playWireCaptured', { channel: event.channel, payloadBytes: event.data.length, outcome: outcome.status })
      }
    })
    this.diagnostics = {
      snapshot: () => this.snapshot()
    }

    // EventEmitter treats an unhandled 'error' event as a process-level throw.
    // A no-op default keeps diagnostics opt-in without destabilizing the bot.
    this.on('error', () => {})

    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    // Consumers may choose not to await `ready`; avoid an unhandled rejection.
    this.ready.catch(() => {})
    try {
      for (const adapter of options.adapters || []) this.use(adapter)
    } catch (error) { this.destroy(); throw error }
  }

  attachBot (bot) {
    if (!bot || typeof bot !== 'object') throw new TypeError('Expected a Mineflayer bot object')
    if (this.bot && this.bot !== bot) throw new Error('This runtime is already attached to another bot')
    this.bot = bot
    bot.modSupport = this
    this.nativeRegistry.attachBot(bot)
    this.nativeBlockReader.attachBot(bot)
    this.nativeWindows.attachBot(bot)
    this.nativeInventory.attachBot(bot)
    return this
  }

  attachClient (client) {
    if (this.client === client) return this
    if (this.client && this._instrumentation) this._instrumentation.dispose()
    this.adapters.validateVersion(client.version)
    this.client = client
    this.nativeRegistry.attachClient(client)
    this.loaderProtocol.attachClient?.(client)
    this._instrumentation = instrumentClient(client, this)
    this.protocol.minecraftVersion = client.version || this.protocol.minecraftVersion
    this.protocol.protocolVersion = client.protocolVersion ?? this.protocol.protocolVersion
    this._transition('prepared')
    return this
  }

  registerModAdapter (adapter) { return this._loaderMethod('registerModAdapter', adapter) }
  use (adapter) { return this.adapters.use(adapter) }
  getCapabilities () { return this.capabilities.report(this) }
  installRegistry ({ name, entries, source }) {
    const result = this.registryMappings.installEntries(name, entries, source || this.loaderProtocol.id)
    this.nativeRegistry.syncRegistry(name)
    this.emit('registryInstalled', result)
    return result
  }
  registerModCodecHandler (profile) { return this._loaderMethod('registerModCodecHandler', profile) }
  sendModMessage (...args) { return this._loaderMethod('sendModMessage', ...args) }
  requestModMessage (...args) { return this._loaderMethod('requestModMessage', ...args) }
  _loaderMethod (name, ...args) {
    const method=this.loaderProtocol[name]
    if(typeof method!=='function')throw new Error('loader_protocol_capability_unavailable:'+name)
    return method.apply(this.loaderProtocol,args)
  }

  captureConnect () {
    this._transition('connected')
    this.emit('connect')
  }

  captureConnectAllowed () {
    this.emit('connectAllowed', {
      version: this.client?.version,
      protocolVersion: this.client?.protocolVersion
    })
  }

  captureAutoVersion (response, client, options) {
    this.adapters.validateVersion(client?.version)
    this.protocol.minecraftVersion = client?.version || this.protocol.minecraftVersion
    this.protocol.protocolVersion = options?.protocolVersion ?? client?.protocolVersion ?? this.protocol.protocolVersion
    this.emit('autoVersion', { response, client, options })
  }

  captureProtocolState (next, previous) {
    const state = normalizeState(next)
    this.protocol.state = state
    this.protocol.minecraftVersion = this.client?.version || this.protocol.minecraftVersion
    this.protocol.protocolVersion = this.client?.protocolVersion ?? this.protocol.protocolVersion
    this.emit('protocolState', { state, previous: normalizeState(previous), rawState: next })
    this.loaderProtocol.onState?.(state)

    if (state === 'login') this._transition('login')
    if (state === 'configuration') this._transition('configuration')
    if (state === 'play') {
      this._syncCompatibilityEvidence()
      this._transition('ready')
      if (!this._readySettled) {
        this._readySettled = true
        this._resolveReady(this)
        this.emit('ready', this)
      }
    }
  }

  capturePlayerJoin () {
    if (this.protocol.state !== 'play') this.captureProtocolState('play', this.protocol.state)
    this.emit('playerJoin')
  }

  captureInboundPacket (data, metadata = {}, buffer, fullBuffer) {
    this.protocol.packetsIn += 1
    const packet = {
      direction: 'inbound',
      name: metadata?.name || data?.name || 'unknown',
      phase: normalizeState(metadata?.state || this.client?.state),
      metadata,
      data,
      buffer,
      fullBuffer,
      timestamp: Date.now()
    }
    try { this.loaderProtocol.observeInbound?.(packet) } catch (err) { this.emitWarning(err) }
    this.nativeInventory.observePacket(packet)
    this.emit('packet', packet)
    this.network.inspectPacket(packet)
    if (this.options.trace.log && this.options.trace.packets) this._logPacket(packet)
  }

  captureNamedLoginPluginRequest (data) { this.loaderProtocol.captureNamedLoginPluginRequest?.(data) }
  interceptExperimentalLoginResponse (name, data) { return this.loaderProtocol.interceptExperimentalLoginResponse?.(name,data) || {action:'passthrough'} }
  transformOutgoing (name, data) { return this.loaderProtocol.transformOutgoing?.(name,data) || {action:'passthrough'} }
  decodePacket (buffer, version, phase) { return this.loaderProtocol.decodePacket?.(buffer,version,phase) || null }

  // Backward-compatible interface for integrations calling the P1.5 helper.
  replaceExperimentalLoginResponse (name, data) {
    const outcome = this.interceptExperimentalLoginResponse(name, data)
    return outcome.action === 'replace' ? outcome.data : null
  }

  captureInboundRaw (buffer, metadata = {}) {
    this.protocol.rawPacketsIn += 1
    const packet = {
      direction: 'inbound',
      name: metadata?.name || 'unknown',
      phase: normalizeState(metadata?.state || this.client?.state),
      metadata,
      buffer,
      timestamp: Date.now()
    }
    this.emit('rawPacket', packet)
    if (this.options.trace.log && this.options.trace.raw) this._logRaw(packet)
  }

  captureOutbound (methodName, args) {
    if (methodName === 'write') {
      this.protocol.packetsOut += 1
      const [name, data] = args
      const packet = {
        direction: 'outbound',
        name: typeof name === 'string' ? name : 'unknown',
        phase: normalizeState(this.client?.state),
        data,
        timestamp: Date.now()
      }
      try { this.loaderProtocol.observeOutbound?.(packet) } catch (err) { this.emitWarning(err) }
      this.emit('outgoingPacket', packet)
      this.network.inspectPacket(packet)
      if (this.options.trace.log && this.options.trace.packets) this._logPacket(packet)
    } else if (methodName === 'writeRaw') {
      this.protocol.rawPacketsOut += 1
      const [buffer] = args
      const packet = {
        direction: 'outbound',
        name: 'raw',
        phase: normalizeState(this.client?.state),
        buffer,
        timestamp: Date.now()
      }
      this.emit('outgoingRawPacket', packet)
      if (this.options.trace.log && this.options.trace.raw) this._logRaw(packet)
    }
  }

  captureEnd (reason) {
    this._transition('closed')
    this.nativeWindows.destroy()
    this.nativeBlockReader.destroy()
    this.adapters.destroy()
    if (!this._readySettled) {
      this._readySettled = true
      this._rejectReady(new Error(`Connection ended before PLAY state: ${String(reason || 'unknown')}`))
    }
    this.emit('end', reason)
    this._disposeLoader()
  }

  captureError (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    this.emit('protocolError', err)
    this.emit('error', err)
    if (!this._readySettled && this.state !== 'ready') {
      this._transition('failed')
    }
  }

  emitWarning (warning) {
    const err = warning instanceof Error ? warning : new Error(String(warning))
    this.emit('warning', err)
  }

  onPacket (listener) {
    this.on('packet', listener)
    this._packetListeners.add(listener)
    return () => {
      this.removeListener('packet', listener)
      this._packetListeners.delete(listener)
    }
  }

  snapshot () {
    this._syncCompatibilityEvidence()
    return {
      state: this.state,
      loaderProtocol: { id: this.loaderProtocol.id, apiVersion: this.loaderProtocol.apiVersion },
      adapters: this.adapters.getReport(),
        capabilities: this.getCapabilities(),
      contentDefinitions: this.contentDefinitions.getReport(),
      menuRules: this.menuRules.getReport(),
      blockCollisions: this.nativeBlockReader.getReport(),
      ...(this.loaderProtocol.snapshot?.() || {}),
      loader: { ...this.loader },
      protocol: { ...this.protocol },
      packetDecoding: { failureCount: this.packetDecodeFailureCount, failures: this.packetDecodeFailures.map(entry => ({ ...entry })) },
      protocolCodecs: this.protocolCodecs?.getReport() || null,
      channels: this.network.channels(),
      registryMappings: this.registryMappings.getReport(),
      nativeRegistry: this.nativeRegistry.getReport(),
      nativeWindows: this.nativeWindows.getReport(),
      nativeInventory: this.nativeInventory.getReport(),
      serverConfigs: this.serverConfigs.getReport(),
      modState: this.modState.getReport(),
      modData: this.modData.getReport(),
      playWire: this.playWire.getReport(),
      compatibility: this.compatibility.getReport()
    }
  }

  _syncCompatibilityEvidence () { return this.loaderProtocol?.syncEvidence?.() || null }

  destroy () {
    if (this._destroyed) return
    this._destroyed = true
    this.adapters.destroy()
    this.nativeWindows.destroy()
    this.nativeBlockReader.destroy()
    this._disposeLoader()
    this.nativeInventory.destroy()
    this.nativeRegistry.destroy()
    if (this._instrumentation) this._instrumentation.dispose()
    this._instrumentation = null
    if (!this._readySettled) {
      this._readySettled = true
      this._rejectReady(new Error('ModSupport runtime was destroyed before the protocol reached PLAY'))
    }
    this._transition('closed')
    this.emit('destroy')
  }

  _disposeLoader () {
    if (this._loaderDisposed) return
    this._loaderDisposed = true
    this.loaderProtocol.destroy()
  }

  _transition (next) {
    if (this.state === next) return
    const previous = this.state
    this.state = next
    this.emit('state', { state: next, previous })
  }

  _logPacket (packet) {
    const prefix = `[mineflayer-mod-support] ${packet.direction} ${packet.phase}.${packet.name}`
    console.log(prefix, packet.data === undefined ? '' : packet.data)
  }

  _logRaw (packet) {
    const length = packet.buffer?.length ?? 0
    console.log(`[mineflayer-mod-support] ${packet.direction} raw ${packet.phase}.${packet.name} (${length} bytes)`)
  }
}

function normalizeState (state) {
  if (state == null) return null
  const value = String(state).toLowerCase()
  if (['handshaking', 'status', 'login', 'configuration', 'play'].includes(value)) return value
  return value
}

module.exports = { ModSupportRuntime, normalizeState }
