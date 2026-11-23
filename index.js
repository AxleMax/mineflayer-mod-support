'use strict'

const { ModSupportRuntime } = require('./src/core/runtime')
const { createBot } = require('./src/bootstrap/create-bot')
const { Fml3Session, analyzeP04Report } = require('./src/protocol/forge/fml3-session')
const { CompatibilityRuntime, evaluateCompatibility, validateManifest } = require('./src/runtime/compatibility')

/**
 * Standard Mineflayer plugin entry point.
 *
 * For guaranteed pre-connect instrumentation, prefer modSupport.createBot().
 * This plugin entry is useful when the host application controls plugin loading
 * and has already configured the Client constructor appropriately.
 */
function modSupportPlugin (bot, botOptions = {}) {
  if (bot.modSupport instanceof ModSupportRuntime) return bot.modSupport

  const config = botOptions.modSupport || {}
  const runtime = new ModSupportRuntime(config)
  runtime.attachBot(bot)

  if (bot._client) {
    const protocolState = String(bot._client.state || '').toLowerCase()
    if (['login', 'configuration', 'play'].includes(protocolState)) {
      runtime.emitWarning(new Error('Plugin injection occurred after the protocol handshake started; earlier packets cannot be observed. Use modSupport.createBot() for guaranteed early instrumentation.'))
    }
    runtime.attachClient(bot._client)
  } else {
    runtime.emitWarning(new Error('Mineflayer client is not available when mod-support plugin was injected'))
  }

  return runtime
}

modSupportPlugin.plugin = modSupportPlugin
modSupportPlugin.createBot = createBot
modSupportPlugin.ModSupportRuntime = ModSupportRuntime
modSupportPlugin.Fml3Session = Fml3Session
modSupportPlugin.analyzeP04Report = analyzeP04Report

modSupportPlugin.analyzeJars = require('./src/analyzer/mod-jar').analyzeJars
modSupportPlugin.createCompatibilityManifest = require('./src/analyzer/compatibility-manifest').createCompatibilityManifest
modSupportPlugin.CompatibilityRuntime = CompatibilityRuntime
modSupportPlugin.evaluateCompatibility = evaluateCompatibility
modSupportPlugin.validateManifest = validateManifest
modSupportPlugin.makeCodec = require('./src/analyzer/codec-runtime').makeCodec
modSupportPlugin.compileCodecPlan = require('./src/analyzer/codec-ir').compileCodecPlan
modSupportPlugin.compileMessageSchema = require('./src/protocol/message-schema').compileMessageSchema
modSupportPlugin.flatSchemaToPlan = require('./src/analyzer/codec-ir').flatSchemaToPlan
modSupportPlugin.inferCallGraphPlan = require('./src/analyzer/codec-inference').inferCallGraphPlan
modSupportPlugin.GenericPacketDispatcher = require('./src/runtime/packet-dispatcher').GenericPacketDispatcher
modSupportPlugin.replayCapturedPlayWire = require('./examples/forge-p23-replay').replay
modSupportPlugin.PlayWireRecorder = require('./src/runtime/play-wire-recorder').PlayWireRecorder
modSupportPlugin.ModStateStore = require('./src/runtime/mod-state').ModStateStore
modSupportPlugin.GenericModDataRuntime = require('./src/runtime/mod-data').GenericModDataRuntime
modSupportPlugin.NativeRegistryBridge = require('./src/runtime/native-registry-bridge').NativeRegistryBridge
modSupportPlugin.NativeInventoryObserver = require('./src/runtime/native-inventory-observer').NativeInventoryObserver
modSupportPlugin.ServerRegistryMappings = require('./src/runtime/registry-mappings').ServerRegistryMappings
modSupportPlugin.encodeC2SModListReply = require('./src/protocol/forge/fml3-client-wire').encodeC2SModListReply
modSupportPlugin.decodeC2SModListReply = require('./src/protocol/forge/fml3-client-wire').decodeC2SModListReply
modSupportPlugin.wrapFml3Reply = require('./src/protocol/forge/fml3-client-wire').wrapFml3Reply
modSupportPlugin.inspectFml3LoginWrapper = require('./src/protocol/forge/login-wrapper').inspectFml3LoginWrapper
modSupportPlugin.Fml3ControlledProbe = require('./src/protocol/forge/fml3-controller').Fml3ControlledProbe
modSupportPlugin.NativeChannelRuntime = require('./src/runtime/native-channels').NativeChannelRuntime
modSupportPlugin.decodeTierSync = require('./src/protocol/forge/simple-channel').decodeTierSync
modSupportPlugin.encodeTierSync = require('./src/protocol/forge/simple-channel').encodeTierSync
modSupportPlugin.decodeSimpleChannel = require('./src/protocol/forge/simple-channel').unpackSimpleChannel
modSupportPlugin.decodeForgeRegistrySnapshot = require('./src/protocol/forge/registry-snapshot').decodeForgeRegistrySnapshot

module.exports = modSupportPlugin
