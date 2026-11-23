'use strict'

// Read-only compatibility planning. A manifest is *evidence* obtained from
// static JAR inspection, never proof of Java mod initialization or a licence
// to advertise Forge capabilities to a remote server.
const fs = require('node:fs')
const { analyzeJars } = require('../analyzer/mod-jar')
const { createCompatibilityManifest } = require('../analyzer/compatibility-manifest')
const { compileCodecPlan } = require('../analyzer/codec-ir')

const MANIFEST_SCHEMA = 'mineflayer-mod-support/compatibility-manifest/v1'
const ID_RE = /^[a-z0-9_.-]+(?::[a-z0-9_./-]+)?$/
const HASH_RE = /^[a-f0-9]{64}$/
const MAX_JSON = 8 * 1024 * 1024
const SUPPORTED_CODEC_TYPES = new Set(['uuid', 'utf', 'boolean', 'varint', 'int', 'byte', 'short', 'long', 'blockpos', 'resource_location'])
const SYSTEM_IDS = new Set(['minecraft', 'forge', 'mohist'])

function validateManifest (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema !== MANIFEST_SCHEMA || input.execution !== 'node-only') {
    throw new Error('unsupported_compatibility_manifest')
  }
  if (!Array.isArray(input.generatedFrom) || !Array.isArray(input.dependencies) || !Array.isArray(input.messages)) {
    throw new Error('invalid_manifest_arrays')
  }
  if (input.generatedFrom.length > 100 || input.dependencies.length > 2048 || input.messages.length > 8192) {
    throw new Error('manifest_too_large')
  }
  const seen = new Set()
  for (const mod of input.dependencies) {
    if (!mod || typeof mod.id !== 'string' || !ID_RE.test(mod.id) || typeof mod.version !== 'string' || mod.version.length > 128) {
      throw new Error('invalid_manifest_dependency')
    }
    if (seen.has(mod.id)) throw new Error('duplicate_manifest_mod:' + mod.id)
    seen.add(mod.id)
  }
  for (const artifact of input.generatedFrom) {
    if (!artifact || typeof artifact.file !== 'string' || artifact.file.length > 256 || !HASH_RE.test(artifact.sha256)) {
      throw new Error('invalid_manifest_source')
    }
  }
  const messageIds = new Set()
  for (const message of input.messages) {
    if (!message || typeof message.id !== 'string' || !message.id.includes(':') || !ID_RE.test(message.id)) {
      throw new Error('invalid_manifest_message')
    }
    if (messageIds.has(message.id)) throw new Error('duplicate_manifest_message:' + message.id)
    messageIds.add(message.id)
    if (message.predictedChannel != null && (typeof message.predictedChannel !== 'string' || !message.predictedChannel.includes(':') || !ID_RE.test(message.predictedChannel))) {
      throw new Error('invalid_predicted_channel')
    }
    if (message.predictedDiscriminator != null && (!Number.isInteger(message.predictedDiscriminator) || message.predictedDiscriminator < 0 || message.predictedDiscriminator > 0x7fffffff)) {
      throw new Error('invalid_predicted_discriminator')
    }
    if (message.direction !== 'clientbound' && message.direction !== 'serverbound') throw new Error('invalid_message_direction')
    if (!message.codec || !['candidate-codec', 'schema-only', 'unresolved'].includes(message.codec.status)) throw new Error('invalid_codec_status')
    if (message.codec.structuralInference?.status === 'structural-candidate' && message.codec.structuralInference.plan != null) {
      // Offline evidence only. A validated structural plan may decode a real
      // packet, but never grants channel or Java client capabilities.
      compileCodecPlan(message.codec.structuralInference.plan)
    }
    if (message.codec.status === 'candidate-codec') {
      const fields = message.codec.candidateSchema
      if (!Array.isArray(fields) || fields.length > 64) throw new Error('invalid_candidate_schema')
      const uniqueFields = new Set()
      for (const field of fields) {
        if (!field || typeof field.field !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field.field) ||
            !SUPPORTED_CODEC_TYPES.has(field.type) || uniqueFields.has(field.field) || ['__proto__','prototype','constructor'].includes(field.field)) throw new Error('invalid_candidate_field')
        uniqueFields.add(field.field)
      }
      if (message.codec.plan != null) compileCodecPlan(message.codec.plan)
    }
  }
  // Construct our own trusted, minimal representation. Ignore claims such as
  // verifiedAgainstServer, runtimeReady and runtime.canAdvertiseMods in JSON.
  return {
    schema: MANIFEST_SCHEMA,
    execution: 'node-only',
    sources: input.generatedFrom.map(v => ({ file: v.file, sha256: v.sha256 })),
    mods: input.dependencies.map(v => ({ id: v.id, version: v.version, source: typeof v.source === 'string' ? v.source.slice(0, 256) : null })),
    messages: input.messages.map(v => ({
      id: v.id, direction: v.direction,
      predictedChannel: v.predictedChannel ?? null,
      predictedDiscriminator: v.predictedDiscriminator ?? null,
      codecStatus: v.codec.status === 'unresolved' && v.codec.structuralInference?.status === 'structural-candidate' && v.codec.structuralInference.plan != null ? 'structural-candidate' : v.codec.status,
      fieldCount: Array.isArray(v.codec.candidateSchema) ? v.codec.candidateSchema.length : null,
      codecSchema: v.codec.status === 'candidate-codec' ? v.codec.candidateSchema.map(f => ({ field: f.field, type: f.type })) : null,
      codecPlan: v.codec.status === 'candidate-codec' && v.codec.plan != null
        ? structuredClone(v.codec.plan)
        : v.codec.structuralInference?.status === 'structural-candidate' && v.codec.structuralInference.plan != null
          ? structuredClone(v.codec.structuralInference.plan) : null,
      structuralStatus: v.codec.structuralInference?.status || null
    }))
  }
}

function loadCompatibilityManifest (options = {}) {
  if (options.compatibilityManifest != null && options.modsDir != null) throw new Error('Choose compatibilityManifest or modsDir, not both')
  if (options.modsDir != null) {
    if (typeof options.modsDir !== 'string' || !options.modsDir) throw new TypeError('modsDir must be a directory path')
    const analysis = analyzeJars([options.modsDir])
    return { manifest: validateManifest(createCompatibilityManifest(analysis)), source: 'analyzed-jars', analysisSummary: analysis.summary,
      recipeSerializers: analysis.recipeSerializers, recipeBookTypes: analysis.recipeBookTypes, forgeChannels: analysis.forgeChannels, wrapperChannels: analysis.wrapperChannels,analysisHashes:analysis.artifacts.map(a=>a.sha256) }
  }
  if (options.compatibilityManifest == null) return { manifest: null, source: 'none', analysisSummary: null }
  let input = options.compatibilityManifest
  if (typeof input === 'string') {
    const stats = fs.statSync(input)
    if (!stats.isFile() || stats.size > MAX_JSON) throw new Error('manifest_file_too_large_or_not_file')
    input = JSON.parse(fs.readFileSync(input, 'utf8'))
  }
  return { manifest: validateManifest(input), source: 'manifest', analysisSummary: null }
}

function normalizeRuntimeEvidence (input = null) {
  const value = input && typeof input === 'object' ? input : {}
  const advertisedMods = [...new Set((Array.isArray(value.advertisedMods) ? value.advertisedMods : [])
    .filter(id => typeof id === 'string' && /^[a-z0-9_.-]{1,128}$/.test(id)).slice(0, 128))]
  const advertisedChannels = []
  const seenChannels = new Set()
  for (const item of (Array.isArray(value.advertisedChannels) ? value.advertisedChannels : []).slice(0, 256)) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(item.id) ||
        typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 64 || seenChannels.has(item.id)) continue
    seenChannels.add(item.id)
    advertisedChannels.push({ id: item.id, version: item.version })
  }
  const serverboundChannels = [...new Set((Array.isArray(value.serverboundChannels) ? value.serverboundChannels : [])
    .filter(id => typeof id === 'string' && seenChannels.has(id)).slice(0, 256))]
  const playRegisteredChannels = [...new Set((Array.isArray(value.playRegisteredChannels) ? value.playRegisteredChannels : [])
    .filter(id => typeof id === 'string' && seenChannels.has(id)).slice(0, 256))]
  return {
    fml3RuntimeEnabled: value.fml3RuntimeEnabled === true,
    fml3HandshakeComplete: value.fml3HandshakeComplete === true,
    advertisedMods,
    advertisedChannels,
    serverboundChannels,
    playRegisteredChannels,
    registryMappingsInstalled: Number.isSafeInteger(value.registryMappingsInstalled) && value.registryMappingsInstalled > 0 ? value.registryMappingsInstalled : 0,
    nativeItemOverlayActive: value.nativeItemOverlayActive === true
  }
}

function evaluateCompatibility (manifest, serverInput = null, runtimeInput = null) {
  const server = serverInput?.server || serverInput || null
  const runtime = normalizeRuntimeEvidence(runtimeInput)
  const hasList = Array.isArray(server?.modIds) && Array.isArray(server?.channels)
  const localMods = manifest?.mods || []
  const localMessages = manifest?.messages || []
  const localById = new Map(localMods.map(m => [m.id, m]))
  const serverModIds = hasList ? [...new Set(server.modIds.filter(id => typeof id === 'string'))] : []
  const serverModsById = new Map((Array.isArray(server?.mods) ? server.mods : []).filter(m => m && typeof m.id === 'string').map(m => [m.id, m]))
  const notInLocal = serverModIds.filter(id => !SYSTEM_IDS.has(id) && !localById.has(id))
  const matchingModIds = serverModIds.filter(id => localById.has(id))
  const reportedVersionDifferences = matchingModIds.filter(id => serverModsById.has(id) && String(localById.get(id).version) !== String(serverModsById.get(id).version))
  const localChannels = [...new Set(localMessages.map(m => m.predictedChannel).filter(Boolean))].sort()
  const serverChannels = hasList ? [...new Set(server.channels.map(c => c?.id).filter(id => typeof id === 'string'))].sort() : []
  const serverChannelMap = new Map((Array.isArray(server?.channels) ? server.channels : []).filter(c => c && typeof c.id === 'string').map(c => [c.id, c.version]))
  const matchingAdvertisedChannels = runtime.advertisedChannels.filter(channel => serverChannelMap.get(channel.id) === channel.version)
  const matchingServerboundChannels = runtime.serverboundChannels.filter(id => matchingAdvertisedChannels.some(channel => channel.id === id) && runtime.playRegisteredChannels.includes(id))
  const serverChannelSet = new Set(serverChannels)
  const channelMatches = localChannels.filter(ch => serverChannelSet.has(ch))
  const unsupportedChannels = serverChannels.filter(ch => !localChannels.includes(ch))
  const codecCandidates = localMessages.filter(m => m.codecStatus === 'candidate-codec').length
  const blockers = []
  if (!manifest) blockers.push('no_local_manifest')
  if (!hasList) blockers.push('server_mod_list_not_observed')
  if (notInLocal.length) blockers.push('server_mods_not_found_in_local_jars')
  if (reportedVersionDifferences.length) blockers.push('reported_mod_versions_differ')
  if (!runtime.fml3RuntimeEnabled) blockers.push('fml3_runtime_not_enabled')
  else if (!runtime.fml3HandshakeComplete) blockers.push('fml3_handshake_not_live_verified')
  if (!runtime.advertisedMods.length) blockers.push('no_explicit_node_mod_adapter_registered')
  if (!matchingServerboundChannels.length) blockers.push('no_serverbound_mod_channel_version_match')
  if (!runtime.registryMappingsInstalled) blockers.push('forge_registry_snapshots_not_received')
  else blockers.push('forge_registry_mappings_are_not_full_block_state_or_entity_runtime_sync')
  if (codecCandidates) blockers.push('jar_codec_candidates_not_server_verified')
  if (runtime.advertisedChannels.length) blockers.push('node_adapter_codecs_not_server_verified')
  blockers.push('java_mod_logic_not_executed', 'server_authoritative_mod_behavior_not_verified')
  return {
    schema: 'mineflayer-mod-support/runtime-compatibility/v1',
    status: hasList ? 'inspected-not-compatible' : 'awaiting-fml3-mod-list',
    source: 'static-analysis-plus-live-fml3-runtime-evidence',
    local: { mods: localMods.map(m => ({ ...m })), messageCount: localMessages.length, candidateCodecs: codecCandidates, inferredChannels: localChannels, sourceCount: manifest?.sources.length || 0,
      nodeAdapterMods: [...runtime.advertisedMods], nodeAdapterChannels: runtime.advertisedChannels.map(c => ({ ...c })) },
    server: { observed: hasList, modIds: serverModIds, declaredChannels: serverChannels, declaredRegistryNames: Array.isArray(server?.registries) ? [...server.registries] : [] },
    comparison: { matchingModIds, absentFromLocalJars: notInLocal, versionDifferences: reportedVersionDifferences, channelNameMatches: channelMatches, serverChannelsWithoutLocalCandidates: unsupportedChannels,
      nodeAdapterChannelVersionMatches: matchingAdvertisedChannels.map(c => ({ ...c })), serverboundChannelVersionMatches: [...matchingServerboundChannels] },
    runtime: { ...runtime, registryMappingsAvailable: runtime.registryMappingsInstalled > 0 },
    capabilities: {
      canAdvertiseMods: runtime.fml3RuntimeEnabled && runtime.advertisedMods.length > 0,
      canReplyFml3: runtime.fml3RuntimeEnabled,
      canSendModPayloads: runtime.fml3RuntimeEnabled && matchingServerboundChannels.length > 0,
      registrySyncApplied: false,
      registryMappingsAvailable: runtime.registryMappingsInstalled > 0,
      nativeItemOverlayActive: runtime.nativeItemOverlayActive,
      canJoinModded: false
    },
    blockers
  }
}

class CompatibilityRuntime {
  constructor (options = {}) {
    const loaded = loadCompatibilityManifest(options)
    this._manifest = loaded.manifest
    this.source = loaded.source
    this.analysisSummary = loaded.analysisSummary
    this.recipeBookTypes = loaded.recipeBookTypes || null
    this.recipeSerializers = loaded.recipeSerializers || []
    this.forgeChannels = loaded.forgeChannels || []
    this.wrapperChannels = loaded.wrapperChannels || []
    this.analysisHashes=loaded.analysisHashes||[]
    this._server = null
    this._runtimeEvidence = normalizeRuntimeEvidence()
    this._report = evaluateCompatibility(this._manifest, null, this._runtimeEvidence)
  }
  observeServer (server) {
    this._server = server
    this._report = evaluateCompatibility(this._manifest, server, this._runtimeEvidence)
    return this.getReport()
  }
  setRuntimeEvidence (evidence) {
    this._runtimeEvidence = normalizeRuntimeEvidence(evidence)
    this._report = evaluateCompatibility(this._manifest, this._server, this._runtimeEvidence)
    return this.getReport()
  }
  getReport () { return structuredClone({ ...this._report, forgeChannelDiscovery: this.forgeChannels }) }
  listLocalMods () { return this._manifest ? this._manifest.mods.map(v => ({ ...v })) : [] }
  getMessage (id) {
    const found = this._manifest?.messages.find(m => m.id === id)
    return found ? { ...found, safeToSend: false } : null
  }
  resetServer () { this._server = null; this._report = evaluateCompatibility(this._manifest, null, this._runtimeEvidence) }
}

module.exports = { validateManifest, loadCompatibilityManifest, normalizeRuntimeEvidence, evaluateCompatibility, CompatibilityRuntime }
