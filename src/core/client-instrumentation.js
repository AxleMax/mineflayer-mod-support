'use strict'

const WRAPPED = Symbol('mineflayer-mod-support-wrapped')

function instrumentClient (client, runtime) {
  if (!client || typeof client.on !== 'function') {
    throw new TypeError('Expected a minecraft-protocol Client EventEmitter')
  }

  if (client[WRAPPED]) return client[WRAPPED]

  const listeners = []
  const parsers = new Map()
  const observeParser = () => {
    const parser = client.deserializer
    if (!parser || typeof parser.parsePacketBuffer !== 'function' || parsers.has(parser)) return
    const original = parser.parsePacketBuffer
    const transform = parser._transform
    const phase = String(client.state)
    const wrapped = function (buffer, ...args) {
      try {
        const extended = runtime.decodePacket(buffer, client.version, phase)
        if (extended) return extended
        return original.call(this, buffer, ...args)
      } catch (error) {
        const failure = { phase, bytes: buffer?.length ?? 0,
          reason: String(error?.message || error).slice(0, 240), partialRead: error?.partialReadError === true }
        if (error.code === 'MMR_PLAY_CODEC_REJECTED') {
          Object.assign(failure, { packetName: error.packetName, resource: error.resource, recipeId: error.recipeId, entityId: error.entityId, offset: error.offset,
            disposition: typeof transform === 'function' ? 'dropped-frame' : 'rejected' })
        }
        runtime.packetDecodeFailureCount++
        runtime.packetDecodeFailures.push(failure)
        if (runtime.packetDecodeFailures.length > 32) runtime.packetDecodeFailures.shift()
        runtime.emit('packetDecodeFailure', { ...failure })
        throw error
      }
    }
    // NMP hands FullPacketParser one complete framed payload at a time.
    // Report the unsupported frame without failing the whole transform stream.
    const wrappedTransform = typeof transform === 'function' && function (buffer, encoding, callback) {
      return transform.call(this, buffer, encoding, error => {
        if (error?.code === 'MMR_PLAY_CODEC_REJECTED') return callback()
        return callback(error)
      })
    }
    if (wrappedTransform) parser._transform = wrappedTransform
    parser.parsePacketBuffer = wrapped
    parsers.set(parser, { original, wrapped, transform, wrappedTransform })
  }
  const listen = (event, handler) => {
    client.on(event, handler)
    listeners.push([event, handler])
  }

  const onPacket = (data, metadata, buffer, fullBuffer) => {
    runtime.captureInboundPacket(data, metadata, buffer, fullBuffer)
  }
  const onRaw = (buffer, metadata) => {
    runtime.captureInboundRaw(buffer, metadata)
  }
  const onState = (next, previous) => {
    observeParser()
    runtime.captureProtocolState(next, previous)
  }
  const onConnect = () => runtime.captureConnect()
  const onConnectAllowed = () => runtime.captureConnectAllowed()
  const onPlayerJoin = () => runtime.capturePlayerJoin()
  const onEnd = reason => runtime.captureEnd(reason)
  const onError = error => runtime.captureError(error)

  // Some NMP versions emit the named event before the generic 'packet' event.
  // Prepend ensures the optional probe is ready before NMP's auto reply runs.
  const onLoginPluginRequest = data => runtime.captureNamedLoginPluginRequest(data)
  client.prependListener('login_plugin_request', onLoginPluginRequest)
  listeners.push(['login_plugin_request', onLoginPluginRequest])
  listen('packet', onPacket)
  listen('raw', onRaw)
  listen('state', onState)
  listen('connect', onConnect)
  listen('connect_allowed', onConnectAllowed)
  listen('playerJoin', onPlayerJoin)
  listen('end', onEnd)
  listen('error', onError)

  const originalMethods = {}
  for (const methodName of ['write', 'writeRaw']) {
    if (typeof client[methodName] !== 'function') continue
    const original = client[methodName]
    originalMethods[methodName] = original
    const wrapped = function (...args) {
      // Loader modules transform protocol envelopes before serialization;
      // gameplay packets still originate from Mineflayer unchanged.
      if (methodName === 'write') {
        const outcome = runtime.transformOutgoing(args[0], args[1])
        if (outcome.action === 'suppress') return undefined
        if (outcome.action === 'replace') args = [args[0], outcome.data, ...args.slice(2)]
      }
      runtime.captureOutbound(methodName, args)
      return original.apply(this, args)
    }
    client[methodName] = wrapped
    originalMethods[`${methodName}Wrapped`] = wrapped
  }

  // node-minecraft-protocol calls these hooks after server status/version
  // detection and before connect_allowed allows the login handshake to proceed.
  if (!Array.isArray(client.autoVersionHooks)) client.autoVersionHooks = []
  const autoVersionHook = (response, hookClient, options) => {
    runtime.captureAutoVersion(response, hookClient || client, options)
  }
  client.autoVersionHooks.push(autoVersionHook)

  const instrumentation = {
    listeners,
    originalMethods,
    autoVersionHook,
    dispose () {
      for (const [parser, { original, wrapped, transform, wrappedTransform }] of parsers) {
        if (parser.parsePacketBuffer === wrapped) parser.parsePacketBuffer = original
        if (wrappedTransform && parser._transform === wrappedTransform) parser._transform = transform
      }
      parsers.clear()
      for (const [event, handler] of listeners) client.removeListener(event, handler)
      const hookIndex = client.autoVersionHooks?.indexOf(autoVersionHook) ?? -1
      if (hookIndex >= 0) client.autoVersionHooks.splice(hookIndex, 1)
      for (const methodName of ['write', 'writeRaw']) {
        const wrapped = originalMethods[`${methodName}Wrapped`]
        if (wrapped && client[methodName] === wrapped) {
          client[methodName] = originalMethods[methodName]
        }
      }
      delete client[WRAPPED]
    }
  }

  Object.defineProperty(client, WRAPPED, {
    value: instrumentation,
    configurable: true
  })

  // The constructor's initial state event is emitted inside `super()`, before
  // this instrumentation can subscribe. Read the current state explicitly.
  if (client.state != null) runtime.captureProtocolState(client.state, null)
  if (client.version != null) runtime.protocol.minecraftVersion = client.version
  observeParser()
  if (client.protocolVersion != null) runtime.protocol.protocolVersion = client.protocolVersion

  return instrumentation
}

module.exports = { instrumentClient }
