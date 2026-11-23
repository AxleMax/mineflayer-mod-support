'use strict'
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { ZipArchive } = require('./zip')
const { readClass, instructions } = require('./classfile')
const { proveBalmCounter, applyPredictions, isBranched } = require('./discriminator')
const { traceCodec, traceRegisteredCodec } = require('./callgraph')
const { inferCallGraphPlan } = require('./codec-inference')
const { discoverRecipeSerializers } = require('./recipe-serializers')
const { discoverRecipeBookTypes } = require('./recipe-book-types')
const { discoverForgeChannels } = require('./forge-channels')
const { parseToml, parseManifestMain, resolveMods } = require('./mod-metadata')

function sha (bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }

const KNOWN = {
  'm_130077_': 'writeUUID', 'm_130259_': 'readUUID',
  'm_130070_': 'writeUtf', 'm_130136_': 'readUtf', 'm_130277_': 'readUtf',
  'm_130130_': 'writeVarInt', 'm_130242_': 'readVarInt',
  'm_130064_': 'writeBlockPos', 'm_130135_': 'readBlockPos',
  'm_130085_': 'writeResourceLocation', 'm_130281_': 'readResourceLocation',
  writeBoolean: 'writeBoolean', readBoolean: 'readBoolean',
  writeVarInt: 'writeVarInt', readVarInt: 'readVarInt',
  writeInt: 'writeInt', readInt: 'readInt',
  writeLong: 'writeLong', readLong: 'readLong',
  writeByte: 'writeByte', readByte: 'readByte',
  writeShort: 'writeShort', readShort: 'readShort',
  writeFloat: 'writeFloat', readFloat: 'readFloat',
  writeDouble: 'writeDouble', readDouble: 'readDouble'
}
const TYPES = {
  writeUUID: 'uuid', readUUID: 'uuid', writeUtf: 'utf', readUtf: 'utf',
  writeBlockPos: 'blockpos', readBlockPos: 'blockpos',
  writeResourceLocation: 'resource_location', readResourceLocation: 'resource_location',
  writeBoolean: 'boolean', readBoolean: 'boolean', writeVarInt: 'varint', readVarInt: 'varint',
  writeInt: 'int', readInt: 'int', writeLong: 'long', readLong: 'long',
  writeByte: 'byte', readByte: 'byte', writeShort: 'short', readShort: 'short', writeFloat: 'float', readFloat: 'float', writeDouble: 'double', readDouble: 'double'
}
const SUPPORTED_RUNTIME = new Set(['uuid', 'utf', 'boolean', 'varint', 'int', 'byte', 'short', 'long', 'blockpos', 'resource_location'])
function refs (code) {
  return code.filter(x => x.member).map(x => ({ offset: x.offset, ...x.member }))
}
function discoverRegistrations (cls, code, modId) {
  const result = []
  // Each registration consumes its own arguments; do not reuse the previous
  // packet's class literal as a candidate for the next call.
  let lastRegistrationIndex = -1
  for (let i = 0; i < code.length; i++) {
    const x = code[i]
    const isSyncConfig = x.member?.owner?.endsWith('/SyncConfigMessage') && x.member.name === 'register'
    if (!x.member || !(/^register(?:Serverbound|Clientbound)Packet$/.test(x.member.name) || isSyncConfig)) continue
    const recent = code.slice(lastRegistrationIndex + 1, i)
    lastRegistrationIndex = i
    const strings = recent.filter(a => typeof a.literal === 'string').map(a => a.literal)
    const classes = recent.filter(a => a.literal?.className).map(a => a.literal.className)
    const name = strings.at(-1)
    const className = isSyncConfig ? classes.at(-2) : classes.at(-1)
    const configClass = isSyncConfig ? classes.at(-1) : undefined
    if (!name || !className || !/^[\w.:-]+$/.test(name)) continue
    const reg = { id: name.includes(':') ? name : `${modId}:${name}`, name, direction: (x.member.name === 'registerClientboundPacket' || isSyncConfig) ? 'clientbound' : 'serverbound', kind: isSyncConfig ? 'sync-config' : 'packet', className, registrationClass: cls.thisClass, registrationMethod: '<method>', evidence: 'literal and class reference before registration call', confidence: 'structural', offset: x.offset }
    if (isSyncConfig && configClass) reg.configClass = configClass
    result.push(reg)
  }
  return result
}
function codecFromClass (cls) {
  const get = name => cls.methods.find(m => m.name === name && m.code)
  const encode = get('encode'); const decode = get('decode')
  if (!encode || !decode) return { status: 'unresolved', reason: 'No static encode/decode pair' }
  const readMethod = (m, prefix) => {
    const code = instructions(cls, m)
    const ops = []
    const opaque = []
    for (let i = 0; i < code.length; i++) {
      const x = code[i]
      const member = x.member
      if (!member) continue
      if (/(?:FriendlyByteBuf|ByteBuf)$/.test(member.owner || '')) {
        const operation = KNOWN[member.name]
        if (!operation || !operation.startsWith(prefix)) {
          opaque.push({ offset: x.offset, method: member.name, owner: member.owner }); continue
        }
        const prevField = prefix === 'write' ? code.slice(Math.max(0, i - 3), i).reverse().find(a => a.op === 0xb4 && a.member) : null
        ops.push({ operation, type: TYPES[operation], field: prevField?.member?.name ?? null, offset: x.offset })
      }
    }
    // Branching requires control-flow-aware extraction; never certify a schema from a linear scan.
    const branch = code.some(x => (x.op >= 0x99 && x.op <= 0xa8) || [0xaa,0xab,0xc6,0xc7,0xc8,0xc9].includes(x.op))
    return { ops, opaque, branch }
  }
  // A packet that really encodes zero bytes must be explicitly recognized.
  // Do not infer an empty codec just because no buffer methods were seen:
  // unresolved bytecode can also produce an empty static scan.
  const encIns = instructions(cls, encode)
  const decIns = instructions(cls, decode)
  const emptyEncoder = encIns.length === 1 && encIns[0].op === 0xb1 // return
  const emptyDecoder = decIns.map(x => x.op).join(',') === '187,89,183,176' &&
    decIns[2].member?.owner === cls.thisClass &&
    decIns[2].member?.name === '<init>' &&
    decIns[2].member?.descriptor === '()V'
  if (emptyEncoder && emptyDecoder) return { status: 'candidate-codec', reason: null, encode: [], decode: [], hasBranch: false, opaqueCalls: [], schema: [], verifiedAgainstServer: false, emptyPayload: true }

  const writes = readMethod(encode, 'write')
  const reads = readMethod(decode, 'read')
  const matched = writes.ops.length > 0 && writes.ops.length === reads.ops.length && writes.ops.every((op, i) => op.type && op.type === reads.ops[i].type)
  const complete = matched && !writes.opaque.length && !reads.opaque.length && !writes.branch && !reads.branch
  const executable = complete && writes.ops.every(op => SUPPORTED_RUNTIME.has(op.type) && op.field)
  return { status: executable ? 'candidate-codec' : (complete ? 'schema-only' : 'unresolved'), reason: !matched ? 'Encode/decode primitives cannot be matched' : !complete ? 'Contains branching or unknown buffer calls' : !executable ? 'Unsupported primitive or field mapping' : null, encode: writes.ops, decode: reads.ops, hasBranch: writes.branch || reads.branch, opaqueCalls: writes.opaque.concat(reads.opaque), schema: executable ? writes.ops.map(op => ({ field: op.field, type: op.type })) : null, verifiedAgainstServer: false }
}

function analyzeArchive (bytes, sourceName, depth = 0, limits = {}) {
  const z = new ZipArchive(bytes, limits)
  const names = z.names()
  let meta = { mods: [], deps: [] }
  if (z.has('META-INF/mods.toml')) meta = parseToml(z.read('META-INF/mods.toml').toString('utf8'))
  const fabric = z.has('fabric.mod.json') ? JSON.parse(z.read('fabric.mod.json').toString('utf8')) : null
  const modId = meta.mods[0]?.modId || fabric?.id || path.basename(sourceName).split('-')[0]
  const resolved = resolveMods(meta.mods, parseManifestMain(z.has('META-INF/MANIFEST.MF') ? z.read('META-INF/MANIFEST.MF') : ''))
  const mods = resolved.mods
  if (!mods.length && fabric) mods.push({ id: fabric.id, version: fabric.version, displayName: fabric.name })
  const dependencies = meta.deps.map(d => ({ modId: d.modId, mandatory: d.mandatory === true, versionRange: d.versionRange || null, side: d.side || null }))
  const warnings = [...resolved.warnings]
  const jars = []
  if (z.has('META-INF/jarjar/metadata.json')) {
    let nested
    try { nested = JSON.parse(z.read('META-INF/jarjar/metadata.json').toString('utf8')) }
    catch (e) { warnings.push('Invalid jarjar metadata: ' + e.message) }
    for (const entry of (nested?.jars || [])) {
      if (!entry.path || !z.has(entry.path)) { warnings.push('Missing nested JAR: ' + entry.path); continue }
      const nestedBytes = z.read(entry.path)
      const item = { path: entry.path, sizeBytes: nestedBytes.length, sha256: sha(nestedBytes), coordinate: entry.identifier ?? null, version: entry.version ?? null }
      if (depth < (limits.maxDepth ?? 2)) {
        try { item.archive = analyzeArchive(nestedBytes, entry.path, depth + 1, limits) } catch (e) { item.error = e.message; warnings.push('Nested JAR failed: ' + entry.path) }
      } else { item.error = 'Depth limit reached' }
      jars.push(item)
    }
  }
  const classes = new Map()
  let classCount = 0
  for (const name of names) {
    if (!name.endsWith('.class')) continue
    classCount++
    try { const cls = readClass(z.read(name)); classes.set(cls.thisClass, cls) }
    catch (e) { warnings.push('Cannot parse ' + name + ': ' + e.message) }
  }
  const registrations = []
  for (const cls of classes.values()) {
    for (const m of cls.methods) {
      if (!m.code) continue
      const seq = instructions(cls, m)
      for (const r of discoverRegistrations(cls, seq, modId)) {
        r.registrationMethod = m.name
        r.registrationMethodUnbranched = !seq.some(x => isBranched([x]))
        registrations.push(r)
      }
    }
  }
  for (const [i, reg] of registrations.entries()) {
    reg.orderInExtractedList = i
    reg.numericDiscriminator = null // Cannot assume index: Balm/Forge runtime must be verified.
    const cls = classes.get(reg.className)
    reg.codec = reg.kind === 'sync-config' ? { status: 'unresolved', reason: 'SyncConfigMessage uses Balm-generated config serialization, not a direct message encode/decode pair' } : cls ? codecFromClass(cls) : { status: 'unresolved', reason: 'Message class not found in this archive' }
    const graph = traceCodec(classes, reg)
    if (graph) {
      reg.codec.callGraph = graph
      reg.codec.inference = inferCallGraphPlan(graph)
    }
  }
  const serviceProviders = Object.create(null)
  for (const name of names.filter(n => n.startsWith('META-INF/services/') && !n.endsWith('/'))) {
    const service = name.slice('META-INF/services/'.length).replace(/\./g,'/')
    const providers = z.read(name).toString('utf8').split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean).map(name => name.replace(/\./g,'/'))
    serviceProviders[service] = [...new Set(providers)]
  }
  const recipeSerializers = discoverRecipeSerializers(classes, { serviceProviders })
  const forge = discoverForgeChannels(classes, { mods, serviceProviders })
  for (const registration of forge.registrations) {
    const graph = traceRegisteredCodec(classes, registration)
    const inference = inferCallGraphPlan(graph)
    registration.codec = { graph, inference }
    registration.codecStatus = inference.status
  }
  return {
    source: path.basename(sourceName), sha256: sha(bytes), entries: names.length, classCount,
    modLoader: meta.mods.length ? 'forge/javafml' : fabric ? 'fabric' : 'unknown', mods, dependencies,
    assetCounts: { itemModels: names.filter(n => /^assets\/[^/]+\/models\/item\/.*\.json$/.test(n)).length, blockstates: names.filter(n => /^assets\/[^/]+\/blockstates\/.*\.json$/.test(n)).length },
    nestedJars: jars, serviceProviders, recipeBookTypes: discoverRecipeBookTypes(classes), recipeSerializers, recipeDiscoveryDiagnostics: recipeSerializers.discoveryDiagnostics || [],
    network: { registrations, forge, counterProof: proveBalmCounter(classes) }, warnings
  }
}
function analyzeJars (filePaths, opts = {}) {
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('At least one JAR path or directory is required')
  const expanded = filePaths.flatMap(f => fs.statSync(f).isDirectory() ? fs.readdirSync(f).filter(n => n.toLowerCase().endsWith('.jar')).sort().map(n => path.join(f,n)) : [f])
  if (!expanded.length) throw new Error('No .jar files found')
  if (expanded.length > 100) throw new Error('Too many JARs in one analysis')
  const artifacts = expanded.map(f => analyzeArchive(fs.readFileSync(f), f, 0, opts))
  const flatten = xs => xs.flatMap(x => [x, ...flatten(x.nestedJars.filter(y => y.archive).map(y => y.archive))])
  const discriminatorProof = applyPredictions(artifacts)
  const all = flatten(artifacts)
  // ServiceLoader discovery is classpath scoped, not archive scoped. A second
  // provider in any supplied/nested JAR invalidates a unique receiver binding.
  const providers = new Map()
  for (const artifact of all) for (const [service, entries] of Object.entries(artifact.serviceProviders || {})) {
    const values = providers.get(service) || new Set()
    for (const entry of entries) values.add(entry)
    providers.set(service, values)
  }
  for (const artifact of all) for (const recipe of artifact.recipeSerializers) {
    if ((recipe.bindingEvidence || []).some(e => e.kind === 'ServiceLoader' &&
        (providers.get(e.interface)?.size !== 1 || !providers.get(e.interface).has(e.provider)))) {
      recipe.status = 'unresolved'; recipe.schema = null; delete recipe.definitions
      recipe.reason = 'ambiguous_service_provider'; recipe.inferenceFailure = 'ambiguous_service_provider'
    }
  }
  for(const artifact of all) if((artifact.network.forge.serviceBindings||[]).some(binding=>providers.get(binding.interface)?.size!==1 || !providers.get(binding.interface)?.has(binding.provider))) {
    for(const registration of artifact.network.forge.registrations) {
      delete registration.channelIdentity
      registration.constructorScopedDiscriminator=null
      registration.unresolved.push('ambiguous_service_provider')
    }
    artifact.network.forge.diagnostics.push({reason:'ambiguous_service_provider'})
  }
  const allMods = all.flatMap(a => a.mods.map(m => ({ ...m, source: a.source })))
  const reported = all.flatMap(a => a.network.registrations.map(r => ({ ...r, source: a.source })))
  const wrapperChannels = []
  // Only an analyzed, unique wrapper implementation supplies a channel version.
  // Imported compatibility manifests cannot grant this observation capability.
  const wrapperProofs=all.filter(a=>a.network.counterProof?.proven && a.network.counterProof.channelVersionDeclaration)
  if(wrapperProofs.length===1) {
    const proof=wrapperProofs[0].network.counterProof
    const groups=new Map()
    for(const message of reported)if(message.predictedChannel && message.predictedDiscriminator!=null) {
      if(!groups.has(message.predictedChannel))groups.set(message.predictedChannel,[])
      groups.get(message.predictedChannel).push(message)
    }
    for(const [id,messages] of groups)if(messages.some(m=>m.direction==='clientbound'))wrapperChannels.push({id,...proof.channelVersionDeclaration,source:wrapperProofs[0].source,messageSources:[...new Set(messages.map(m=>m.source))]})
  }
  return {
    schema: 'mineflayer-mod-support/jar-analysis/v1',
    engine: { language: 'JavaScript', javaExecuted: false, jsDependencies: 'node built-ins + smol-toml (pure JavaScript)', codecMethodMappings: 'Minecraft Java 1.20.1 (SRG)' },
    artifacts, discoveredMods: allMods, discriminatorProof, wrapperChannels,
    recipeDiscoveryDiagnostics: all.flatMap(a => a.recipeDiscoveryDiagnostics.map(d => ({ ...d, source: a.source }))),
    recipeBookTypes: { extensions: all.flatMap(a => a.recipeBookTypes.extensions.map(e => ({ ...e, source: a.source }))),
      unresolved: all.flatMap(a => a.recipeBookTypes.unresolved.map(e => ({ ...e, source: a.source }))) },
    forgeChannels: all.map(artifact => ({ source: artifact.source, ...artifact.network.forge })),
    recipeSerializers: all.flatMap(artifact => artifact.recipeSerializers.map(recipe => ({ ...recipe, source: artifact.source }))),
    summary: { topLevelJars: artifacts.length, nestedJars: all.length - artifacts.length, discoveredMods: allMods.length, networkRegistrations: reported.length, standardForgeRegistrations: all.reduce((n,a) => n+a.network.forge.registrations.length,0), candidateCodecs: reported.filter(r => r.codec.status === 'candidate-codec').length, predictedDiscriminators: reported.filter(r => r.predictedDiscriminator != null).length, crossClassCodecs: reported.filter(r => r.codec.callGraph).length, schemaOnly: reported.filter(r => r.codec.status === 'schema-only').length, unresolvedCodecs: reported.filter(r => r.codec.status === 'unresolved').length },
    limitations: ['No Java/JVM execution', 'No verification of packet discriminator indices or login acceptance', 'Linear bytecode extraction does not evaluate Java control flow', 'Candidate codecs must pass oracle tests against known mod/client behavior before production use', 'Registration lists may be conditional or computed dynamically', 'Predicted discriminators are statically inferred, NOT runtime verified or authorized for sending', 'Codec method mappings target Minecraft 1.20.1; cannot be assumed valid for other versions']
  }
}
module.exports = { analyzeJars, analyzeArchive, parseToml, codecFromClass }
