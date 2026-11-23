'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ModSupportRuntime } = require('../src/core/runtime')
const { WireWriter } = require('../src/protocol/forge/wire')
const { once } = require('node:events')

const recipePacket = type => new WireWriter().varInt(0x6d).varInt(1).identifier(type).identifier('sample:recipe').varInt(9).finish()

test('protocol extensions are isolated per bot and reject unsupported recipes and trailing data', () => {
  const r = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const other = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  try {
    const original = JSON.stringify(require('minecraft-data')('1.20.1').protocol)
    const off = r.protocolCodecs.register('recipe', 'sample:custom', ['container', [{ name: 'value', type: 'varint' }]])
    const packet = recipePacket('sample:custom')
    assert.equal(r.protocolCodecs.decode(packet, '1.20.1', 'play').data.params.recipes[0].data.value, 9)
    assert.throws(() => other.protocolCodecs.decode(packet, '1.20.1', 'play'), /unsupported_mod_protocol_type/)
    assert.throws(() => r.protocolCodecs.decode(Buffer.concat([packet, Buffer.from([0])]), '1.20.1', 'play'), /trailing_bytes/)
    off()
    assert.throws(() => r.protocolCodecs.decode(packet, '1.20.1', 'play'), /unsupported_mod_protocol_type/)
    r.protocolCodecs.register('recipe', 'sample:custom', ['container', [{ name: 'value', type: 'varint' }]])
    off()
    assert.equal(r.protocolCodecs.decode(packet, '1.20.1', 'play').data.params.recipes[0].data.value, 9)
    assert.equal(JSON.stringify(require('minecraft-data')('1.20.1').protocol), original)
  } finally { r.destroy(); other.destroy() }
})

test('command parser IDs resolve through the server registry including Forge enum properties', () => {
  const r = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  try {
    r.registryMappings.getEntries = name => name === 'minecraft:command_argument_type' ? [{ id: 70, name: 'forge:enum' }] : []
    const packet = new WireWriter().varInt(16).varInt(2)
      .byte(0).varInt(1).varInt(1)
      .byte(2).varInt(0).string('kind').varInt(70).string('sample.TestEnum')
      .varInt(0).finish()
    const out = r.protocolCodecs.decode(packet, '1.20.1', 'play')
    assert.equal(out.data.params.nodes[1].extraNodeData.parser, 'forge:enum')
    assert.equal(out.data.params.nodes[1].extraNodeData.properties.enumClass, 'sample.TestEnum')
    assert.equal(out.metadata.size, packet.length)
  } finally { r.destroy() }
})

test('an unsupported recipe frame is reported and the next framed packet still reaches the parser output', async () => {
  const { Client } = require('minecraft-protocol')
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new Client(false, '1.20.1')
  runtime.attachClient(client)
  try {
    client.state = 'play'
    const parser = client.deserializer
    const decoded = once(client, 'declare_recipes', { signal: AbortSignal.timeout(1000) })
    const codec = runtime.protocolCodecs._protocol('1.20.1').proto
    const next = codec.createPacketBuffer('packet', { name: 'declare_recipes', params: { recipes: [] } })
    parser.write(recipePacket('sample:unknown_serializer'))
    parser.write(next)
    const [packet] = await decoded
    assert.deepEqual(packet.recipes, [])
    const [failure] = runtime.snapshot().packetDecoding.failures
    assert.equal(failure.resource, 'sample:unknown_serializer')
    assert.equal(failure.recipeId, 'sample:recipe')
    assert.equal(failure.disposition, 'dropped-frame')
    assert.ok(failure.offset > 0)
  } finally { runtime.destroy() }
})

test('a Forge ingredient retains its serializer and can round-trip alongside ordinary ingredients', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  try {
    runtime.protocolCodecs.register('recipe', 'sample:mixed', ['container', [
      { name: 'vanilla', type: 'ingredient' }, { name: 'custom', type: 'ingredient' }
    ]])
    runtime.protocolCodecs.register('ingredient', 'sample:test', 'string')
    const codec = runtime.protocolCodecs._protocol('1.20.1').proto
    const params = { recipes: [{ type: 'sample:mixed', recipeId: 'sample:one', data: {
      vanilla: [], custom: { serializer: 'sample:test', data: 'test-value' }
    } }] }
    const bytes = codec.createPacketBuffer('packet', { name: 'declare_recipes', params })
    const packet = runtime.protocolCodecs.decode(bytes, '1.20.1', 'play')
    assert.deepEqual(packet.data.params, params)
  } finally { runtime.destroy() }
})

const capture = process.env.MMR_PROTOCOL_CAPTURE
const jar = process.env.MMR_WAYSTONES_JAR
const autoCapture = process.env.MMR_RECIPE_AUTO_CAPTURE
const autoMods = process.env.MMR_RECIPE_AUTO_MODS

test('real mixed-mod recipe frame uses only JAR-derived recipe and ingredient schemas', { skip: !autoCapture || !autoMods }, () => {
  const r = new ModSupportRuntime({ modsDir: autoMods, experimental: { fml3Runtime: true } })
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(autoCapture, 'report.json')))
    r.registryMappings.getEntries = name => name === 'minecraft:recipe_serializer' ? evidence.recipeSerializerRegistry : null
    const bytes = fs.readFileSync(path.join(autoCapture, 'declare-recipes.bin'))
    const packet = r.protocolCodecs.decode(bytes, '1.20.1', 'play')
    assert.equal(packet.data.params.recipes.length, evidence.recipes.total)
    assert.deepEqual(r.protocolCodecs.cache.proto.createPacketBuffer('packet', packet.data), bytes)
    const report = r.protocolCodecs.getReport()
    assert.deepEqual(report.recipeSerializers, [])
    assert.deepEqual(report.ingredientSerializers, [])
    for (const id of [
      'farmersdelight:cooking', 'farmersdelight:cutting', 'farmersdelight:food_serving',
      'farmersdelight:dough', 'farmersdelight:tool_action', 'waystones:warp_plate'
    ]) assert.equal(report.inferredRecipes.find(recipe => recipe.id === id)?.wireVerified, true, id)
  } finally { r.destroy() }
})

test('real recipe and command captures decode completely and round-trip with optional adapter', { skip: !capture || !jar }, () => {
  const { installAdapter } = require('../examples/waystones-node-adapter')
  const r = new ModSupportRuntime({ modsDir: path.dirname(jar), experimental: { fml3Runtime: true } })
  try {
    installAdapter(r)
    const report = JSON.parse(fs.readFileSync(path.join(capture, 'report.json')))
    r.registryMappings.getEntries = name => name === 'minecraft:command_argument_type' ? report.commandArgumentTypes : []
    for (const file of ['decode-failure-0.bin', 'decode-failure-1.bin']) {
      const packet = fs.readFileSync(path.join(capture, file))
      const out = r.protocolCodecs.decode(packet, '1.20.1', 'play')
      assert.equal(out.metadata.size, packet.length)
      const encoded = r.protocolCodecs.cache.proto.createPacketBuffer('packet', out.data)
      assert.deepEqual(encoded, packet)
    }
    assert.equal(r.protocolCodecs.getReport().decoded, 2)
  } finally { r.destroy() }
})
