'use strict'
const { createHash } = require('node:crypto')
const { Fml3Session } = require('../protocol/forge/fml3-session')
const { Fml3EmptyCapabilityProbe } = require('../protocol/forge/fml3-probe')
const { Fml3ControlledProbe } = require('../protocol/forge/fml3-controller')
const { NativeChannelRuntime } = require('../runtime/native-channels')
const { ConfigSyncMirror } = require('../runtime/config-sync-mirror')
const { ForgeContainerBridge } = require('../protocol/forge/open-container')
const { ForgeSplitRuntime } = require('../protocol/forge/split-packets')
const { ForgeEntityBridge } = require('../protocol/forge/entity-spawn')
const { installForgeArgumentCodecs } = require('../protocol/forge/play-codecs')
const { extractLoginRequest } = require('../diagnostics/forge-evidence')
const { addFml3ToHandshake } = require('../bootstrap/fml3-marker')
const { PlayProtocolCodecs } = require('../protocol/forge/play-protocol-codecs')
const { negotiateChannels } = require('../protocol/forge/channel-negotiation')

// This module owns Forge wire mechanisms. The shared runtime owns registry
// data and Mineflayer projection; no gameplay action is implemented here.
class ForgeProtocol {
  constructor (runtime) {
    this.runtime = runtime
    this.id = 'forge'
    this.apiVersion = 1
    const r = runtime
    r.protocolCodecs = new PlayProtocolCodecs(r)
    r.fml3 = new Fml3Session()
    r._seenFml3 = new Map()
    if ((r.options.experimental?.fml3ProbeControlled || r.options.experimental?.fml3Runtime) && r.options.experimental?.fml3ProbeEmptyReply) throw new Error('Choose either the legacy empty FML3 probe or the controlled FML3 probe')
    r.fml3Probe = new Fml3EmptyCapabilityProbe(r.options.experimental?.fml3ProbeEmptyReply === true)
    r.forgeContainers = new ForgeContainerBridge(r)
    r.forgeSplit = new ForgeSplitRuntime(r)
    r.forgeEntities = new ForgeEntityBridge(r)
    r.fml3Controller = new Fml3ControlledProbe({
      enabled: r.options.experimental?.fml3ProbeControlled === true || r.options.experimental?.fml3Runtime === true,
      experimentalRegistryFlow: r.options.experimental?.fml3RegistryProgression === true || r.options.experimental?.fml3Runtime === true,
      experimentalTrialChannels: r.options.experimental?.trialChannels || [],
      serverPrimaryChannels: r.options.experimental?.fml3Runtime === true
    })
    r.fml3Controller.applyRegistry = (details, messageId) => {
      const result = r.registryMappings.install({ ...details, source: 'forge-registry-snapshot' }, messageId)
      try { r.nativeRegistry.syncRegistry(details.registryName) } catch (error) {
        // The FML3 Registry ACK depends on the valid, installed Forge mapping,
        // NOT on the optional native Mineflayer registry projection.
        r.emitWarning(new Error('Native registry projection failed: ' + error.message))
      }
      r.emit('forgeRegistryMappingInstalled', result)
      r.emit('registryInstalled', result)
      return result
    }
    r.fml3Controller.applyConfig = (details, messageId) => {
      const result = r.serverConfigs.install(details, messageId)
      r.emit('forgeConfigStored', result)
      return result
    }

    if (r.options.experimental?.fml3Runtime === true) {
      installForgeArgumentCodecs(r.protocolCodecs)
      r.protocolCodecs.recipeCandidates = r.compatibility.recipeSerializers
      r.protocolCodecs.recipeBookTypes = r.compatibility.recipeBookTypes
    }
    r.nativeChannels = new NativeChannelRuntime(r, r.options, r.compatibility)
    if(r.options.experimental?.fml3Runtime === true) r.nativeChannels.resolveChannelNegotiation = local => negotiateChannels(local,r.fml3.modList?.channels)
    r.configMirror = new ConfigSyncMirror({ runtime:r, modsDir:r.options.modsDir, manifest:r.compatibility._manifest })
    r.fml3Controller.getNativeAdvertisedChannels = () => r.nativeChannels.getAdvertisedChannels()
    r.fml3Controller.getNativeAdvertisedMods = () => r.nativeChannels.getAdvertisedMods()
    r.fml3Controller.getNativeAdvertisedRegistries = () => r.nativeChannels.getAdvertisedRegistries()
  }
  attachClient (client) { this.runtime.forgeContainers.attachClient(client) }
  decodePacket (...args) { return this.runtime.protocolCodecs.decode(...args) }
  registerProtocolCodec (...args) { return this.runtime.protocolCodecs.register(...args) }
  registerExplicitCodec (...args) { return this.runtime.protocolCodecs.registerExplicit(...args) }
  registerChannel (...args) { return this.runtime.nativeChannels.registerChannel(...args) }
  getMenuContext (windowId) { const current = this.runtime.forgeContainers.getCurrent(); return current?.windowId === windowId ? current : null }
  onState (state) { if (state === 'play') this.runtime.fml3.markPlayReached() }
  observeInbound (packet) {
    const r=this.runtime, data=packet.data, login=extractLoginRequest(packet)
    if (login?.channel !== 'fml:loginwrapper' || !Number.isInteger(login.messageId)) return
    const body=[data?.data,data?.payload,data?.contents].find(Buffer.isBuffer)
    r.fml3Probe.prepare({messageId:login.messageId,channel:login.channel,payload:body})
    if(r.fml3Controller.enabled&&!r.fml3Controller.pending.has(login.messageId))r.fml3Controller.prepare({messageId:login.messageId,channel:login.channel,payload:body})
    this._observeFml3Request(login.messageId,login.channel,body)
  }
  observeOutbound (packet) {
    const login=extractLoginRequest(packet),data=packet.data
    if(login?.direction==='outbound'&&Number.isInteger(login.messageId)&&packet.name==='login_plugin_response'){
      const payload=[data?.data,data?.payload,data?.contents].find(Buffer.isBuffer)
      this.runtime.fml3.inspectResponse({messageId:login.messageId,payload,successful:typeof data?.successful==='boolean'?data.successful:undefined})
    }
  }
  transformOutgoing (name,data) {
    const r=this.runtime
    if(name==='set_protocol'&&r.options.experimental?.forgeFml3Marker===true){
      const result=addFml3ToHandshake(name,data,r.client?.version)
      r.emit('forgeFml3Marker',{applied:result.applied,...(result.applied?{}:{reason:result.reason||'not_applied'})})
      return result.applied?{action:'replace',data:result.data}:{action:'passthrough'}
    }
    return name==='login_plugin_response'?this.interceptExperimentalLoginResponse(name,data):{action:'passthrough'}
  }
  observePayload (event) {
    const r=this.runtime
    if(r.options.experimental?.fml3Runtime===true)for(const bridge of [r.forgeSplit,r.forgeContainers,r.forgeEntities]){
      const result=bridge.observe(event);if(result.status!=='ignored')return result
    }
    const config=r.configMirror.observe(event)
    return config.status==='ignored'||config.status==='envelope-only'?r.nativeChannels.observe(event):config
  }
  registerModAdapter (adapter) { return this.runtime.nativeChannels.registerModAdapter(adapter) }
  registerModCodecHandler ({onMessage,...profile}={}) {
    const r=this.runtime
    if(r.state==='closed'||typeof onMessage!=='function'||r.nativeChannels.rawChannels.has(profile.channel)||profile.channel==='forge:tier_sorting')throw new Error('invalid_codec_handler')
    return r.nativeChannels.dispatcher.registerCodecHandler({...profile,onMessage:(data,context)=>onMessage(data,{...context,getConfig:id=>r.configMirror.get(id)})})
  }
  sendModMessage (...args) { return this.runtime.nativeChannels.send(...args) }
  requestModMessage (...args) { return this.runtime.nativeChannels.request(...args) }
  _observeFml3Request (messageId, channel, payload) {
    const r = this.runtime
    if (channel !== 'fml:loginwrapper' || !Number.isInteger(messageId) || !Buffer.isBuffer(payload)) return null
    const digest = createHash('sha256').update(payload).digest('hex')
    if (r._seenFml3.get(messageId) === digest) return null
    r._seenFml3.set(messageId, digest)
    if (r._seenFml3.size > 64) r._seenFml3.delete(r._seenFml3.keys().next().value)
    const parsed = r.fml3.inspectRequest({ messageId, channel, payload })
    const forgeVersion = r.fml3.getReport().forgeVersion
    if (forgeVersion) r.loader = { name: 'forge', version: forgeVersion, confidence: 'confirmed_from_fml_mod_data' }
    if (parsed.parsed && parsed.type === 'S2CModList') {
      const report = r.fml3.getReport()
      const evaluated = r.compatibility.observeServer({ ...report.server, modIds: r.fml3.modList.modIds })
      r._syncCompatibilityEvidence()
      r.emit('compatibilityEvaluated', evaluated)
    }
    if (parsed.parsed && parsed.type === 'S2CRegistry') r.emit('forgeRegistryObserved', r.fml3.registryObserver.getReport())
    if (parsed.parsed && parsed.type === 'S2CChannelMismatchData') r.emit('fml3ChannelMismatch', parsed.details)
    r.emit('fml3Message', { messageId, type: parsed.type, parsed: parsed.parsed, error: parsed.error })
    return parsed
  }

  captureNamedLoginPluginRequest (data) {
    const r = this.runtime
    // Prepend listener executes before the upstream auto-reply. Observe the
    // real transaction in this order; a later generic `packet` event is de-duped.
    const channel = [data?.channel, data?.identifier, data?.tag].find(v => typeof v === 'string')
    const id = [data?.messageId, data?.message_id, data?.transactionId, data?.transaction_id].find(Number.isInteger)
    const payload = [data?.data, data?.payload, data?.contents].find(Buffer.isBuffer)
    try { this._observeFml3Request(id, channel, payload) } catch (err) { r.emitWarning(err) }
    r.fml3Probe.inspectNamedRequest(data)
    r.fml3Controller.inspectNamedRequest(data)
  }

  interceptExperimentalLoginResponse (name, data) {
    const r = this.runtime
    const controller = r.fml3Controller.interceptAutoReply(name, data, r.client?.state, r.client?.version)
    if (controller.action === 'suppress') {
      const last = r.fml3Controller.handled.at(-1)
      r.fml3.inspectSuppression(last.messageId, last.kind)
      r.emit('fml3AutoReplySuppressed', last)
      return { action: 'suppress' }
    }
    if (controller.action === 'replace') {
      r.emit('fml3ControlledReply', { messageId: controller.data.messageId, bytes: controller.data.data.length })
      return controller
    }
    const updated = r.fml3Probe.replaceAutoReply(name, data, r.client?.state, r.client?.version)
    if (updated) r.emit('fml3ProbeReplyReplaced', { messageId: updated.messageId, bytes: updated.data.length })
    return updated ? { action: 'replace', data: updated } : { action: 'passthrough' }
  }


  syncEvidence () {
    const r = this.runtime
    if (!r.compatibility || !r.nativeChannels || !r.fml3Controller) return null
    const channelReport = r.nativeChannels.getReport()
    const serverboundChannels = []
    for (const adapter of channelReport.adapters || []) {
      for (const channel of adapter.channels || []) {
        if ((channel.messages || []).some(message => message.direction === 'serverbound' || message.direction === 'bidirectional')) {
          serverboundChannels.push(channel.id)
        }
      }
    }
    return r.compatibility.setRuntimeEvidence({
      fml3RuntimeEnabled: r.fml3Controller.enabled === true && r.fml3Controller.experimentalRegistryFlow === true,
      fml3HandshakeComplete: r.fml3.getReport().handshakeComplete === true,
      advertisedMods: r.nativeChannels.getAdvertisedMods(),
      advertisedChannels: r.nativeChannels.getAdvertisedChannels(),
      serverboundChannels,
      playRegisteredChannels: channelReport.playChannelRegistration?.channels || [],
      registryMappingsInstalled: r.registryMappings.getReport().mappingInstalledCount,
      nativeItemOverlayActive: r.nativeRegistry.getReport().nativeItemOverlayActive
    })
  }


  snapshot () {
    const r=this.runtime
    return {fml3:r.fml3.getReport(),fml3Probe:r.fml3Probe.getReport(),fml3Controller:r.fml3Controller.getReport(),nativeChannels:r.nativeChannels.getReport(),forgeEntities:r.forgeEntities.getReport(),forgeSplit:r.forgeSplit.getReport(),forgeContainers:r.forgeContainers.getReport(),modConfigs:r.configMirror.getReport()}
  }
  destroy () { const r=this.runtime;r.forgeContainers.destroy();r.forgeSplit.destroy();r.nativeChannels.destroy() }
}
module.exports={id:'forge',apiVersion:1,create:runtime=>new ForgeProtocol(runtime)}
