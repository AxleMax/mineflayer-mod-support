'use strict'

const { WireReader } = require('./wire')
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const { createHash } = require('node:crypto')
const { explicitCodec } = require('./explicit-codec')

// Per-client protocol definitions. Never pass these to NMP's shared protocol cache.
class PlayProtocolCodecs {
  constructor (runtime) {
    this.runtime = runtime
    this.recipes = new Map()
    this.ingredients = new Map()
    this.recipeCandidates = []
    this.recipeBookTypes = null
    this.verifiedRecipes = new Set()
    this.arguments = new Map()
    this.metadata = new Map()
    this.synchronization = { recipes: { status: 'not-observed', recipes: 0 }, entityMetadata: { status: 'not-observed' } }
    this.revision = 0
    this.cache = null
    this.counts = { decoded: 0, rejected: 0 }
  }

  register (kind, id, schema, version = '1.20.1') {
    const entries = { recipe: this.recipes, argument: this.arguments, ingredient: this.ingredients, metadata: this.metadata }[kind]
    if (!(entries instanceof Map) || !ID.test(id || '') || version !== '1.20.1' || entries.has(id) || entries.size >= 64) throw new Error('invalid_protocol_codec_registration')
    const copy = structuredClone(schema)
    if (JSON.stringify(copy).length > 16384) throw new Error('protocol_codec_schema_limit')
    const entry = { schema: copy, version }
    entries.set(id, entry)
    this.revision++
    return () => {
      if (entries.get(id) === entry && entries.delete(id)) this.revision++
    }
  }

  registerExplicit (kind, id, codec, version = '1.20.1') {
    explicitCodec(codec, this.runtime.registryMappings) // validate before committing
    const dispose = this.register(kind, id, 'void', version)
    const entries = { recipe: this.recipes, argument: this.arguments, ingredient: this.ingredients, metadata: this.metadata }[kind]
    const entry = entries.get(id)
    entry.schema = 'mmr_explicit_' + createHash('sha256').update(kind + ':' + id).digest('hex').slice(0,24)
    entry.codec = { read: codec.read, write: codec.write, sizeOf: codec.sizeOf }
    return dispose
  }

  _protocol (version) {
    const mappings = this.runtime.registryMappings
    const stamp = version + ':' + mappings.getReport().version + ':' + this.revision
    if (this.cache?.stamp === stamp) return this.cache
    const { ProtoDef } = require('protodef')
    const nbt = require('prismarine-nbt')
    const data = structuredClone(require('minecraft-data')(version).protocol)
    const metadataTypes = data.types.entityMetadata[1].type[1].find(f => f.name === 'type').type[1].mappings
    const metadataFields = data.types.entityMetadataItem[1]
    for (const entry of mappings.getEntries('forge:entity_data_serializers') || []) {
      // Forge 1.20.1 reserves 0..255 for vanilla, custom registry IDs are
      // already the wire IDs. Never add an inferred numeric offset.
      if (entry.id < 256 || Object.hasOwn(metadataTypes, String(entry.id))) throw new Error('invalid_forge_metadata_serializer_id')
      metadataTypes[String(entry.id)] = entry.name
      metadataFields.fields[entry.name] = this.metadata.get(entry.name)?.schema || 'unsupported_mod_protocol_type'
    }
    metadataFields.default = 'unsupported_mod_protocol_type'
    const book = this.recipeBookTypes
    const bookExtensions = book?.extensions || []
    const bookNames = bookExtensions.map(e => e.name)
    const bookReady = !book?.unresolved?.length && new Set(bookNames).size === bookNames.length && bookNames.length <= 64
    if (bookReady && bookExtensions.length) {
      const fields = data.play.toClient.types.packet_unlock_recipes[1]
      const beforeRecipes = fields.findIndex(f => f.name === 'recipes1')
      fields.splice(beforeRecipes, 0, { name: 'additionalRecipeBookSettings', type: ['array', { count: bookExtensions.length,
        type: ['container', [{ name: 'open', type: 'bool' }, { name: 'filtering', type: 'bool' }]] }] })
    }
    const argument = data.types.command_node[1].find(f => f.name === 'extraNodeData').type[1].fields['2'][1]
    const parser = argument.find(f => f.name === 'parser').type[1].mappings
    const properties = argument.find(f => f.name === 'properties').type[1]
    const vanillaByName = Object.fromEntries(Object.values(parser).map(name => [name, name]))
    vanillaByName['minecraft:nbt_compound_tag'] = 'minecraft:nbt'
    for (const entry of mappings.getEntries('minecraft:command_argument_type') || []) {
      const canonical = vanillaByName[entry.name] || entry.name
      parser[String(entry.id)] = canonical
    }
    for (const [id, entry] of this.arguments) properties.fields[id] = entry.schema
    properties.default = 'unsupported_mod_protocol_type'
    const recipes = data.play.toClient.types.packet_declare_recipes[1][0].type[1].type[1][2].type[1]
    const registered = new Set((mappings.getEntries('minecraft:recipe_serializer') || []).map(entry => entry.name))
    const candidateCounts = new Map()
    for (const candidate of this.recipeCandidates) {
      const key = candidate.kind + ':' + candidate.id
      candidateCounts.set(key, (candidateCounts.get(key) || 0) + 1)
    }
    const inferred = new Set()
    const definitions = {}
    const ingredientSchemas = new Map([...this.ingredients].map(([id, entry]) => [id, entry.schema]))
    for (const candidate of this.recipeCandidates) {
      if (candidate.status !== 'candidate' || candidateCounts.get(candidate.kind + ':' + candidate.id) !== 1) continue
      if (candidate.kind === 'ingredient') {
        if (!ingredientSchemas.has(candidate.id)) ingredientSchemas.set(candidate.id, candidate.schema)
        continue
      }
      if (!registered.has(candidate.id) || this.recipes.has(candidate.id) || Object.hasOwn(recipes.fields, candidate.id)) continue
      const extra = candidate.definitions || {}
      if (Object.keys(extra).length > 128 || JSON.stringify(extra).length > 262144) continue
      if (Object.entries(extra).some(([key, value]) => !/^mmr_read_[a-f0-9]{24}$/.test(key) ||
          (definitions[key] && JSON.stringify(definitions[key]) !== JSON.stringify(value)))) continue
      Object.assign(definitions, extra)
      if (Array.isArray(candidate.schema) && candidate.schema[0] === 'standard_recipe_reference') {
        const target = candidate.schema[1]?.id
        if (!target?.startsWith('minecraft:') || !Object.hasOwn(recipes.fields,target)) continue
        recipes.fields[candidate.id] = structuredClone(recipes.fields[target])
      } else recipes.fields[candidate.id] = candidate.schema
      inferred.add(candidate.id)
    }
    for (const [id, entry] of this.recipes) recipes.fields[id] = entry.schema
    recipes.default = 'unsupported_mod_protocol_type'
    const proto = new ProtoDef(false)
    const observedIngredients = new Set()
    proto.addTypes(require('minecraft-protocol/src/datatypes/minecraft'))
    proto.addTypes(require('./metadata-loop'))
    proto.addTypes(require('./varlong'))
    nbt.addTypesToInterpreter('big', proto)
    const array = proto.types.array
    const { getCount } = require('protodef/src/utils')
    proto.addType('array', [function (buffer, offset, args, context) {
      const { count } = getCount.call(this, buffer, offset, args, context)
      if (!Number.isSafeInteger(count) || count < 0 || count > 16384) throw new Error('protocol_array_limit')
      return array[0].call(this, buffer, offset, args, context)
    }, array[1], array[2]])
    const unsupported = (buffer, offset, args, context) => {
      let resource, recipeId, entityId
      for (let current=context, depth=0; current && depth<64; current=current['..'], depth++) {
        resource ??= current.type ?? current.parser
        recipeId ??= current.recipeId
        entityId ??= current.entityId
        if (resource !== undefined && recipeId !== undefined) break
      }
      const error = new Error('unsupported_mod_protocol_type' +
        (typeof resource === 'string' ? ' ' + resource : '') +
        (typeof recipeId === 'string' ? ' recipe=' + recipeId : '') + ' offset=' + offset)
      error.resource = resource
      error.recipeId = recipeId
      error.offset = offset
      error.entityId = entityId
      throw error
    }
    proto.addType('unsupported_mod_protocol_type', [unsupported, unsupported, unsupported])
    proto.addProtocol(data, ['play', 'toClient'])
    for (const entries of [this.recipes,this.ingredients,this.arguments,this.metadata]) for (const entry of entries.values()) {
      if (entry.codec) proto.addType(entry.schema, explicitCodec(entry.codec, mappings))
    }
    proto.addTypes(definitions)
    // Recursive ingredient alternatives are length counted, but their nesting
    // must also be bounded before entering ProtoDef's recursive interpreter.
    let nesting = 0
    for (const key of Object.keys(definitions)) {
      const original = proto.types[key]
      proto.addType(key, original.map(fn => function (...args) {
        if (++nesting > 64) { nesting--; throw new Error('protocol_schema_nesting_limit') }
        try { return fn.apply(this, args) } finally { nesting-- }
      }))
    }
    const vanillaIngredient = proto.types.ingredient
    const ingredientHeader = ['container', [{ name: 'marker', type: 'varint' }, { name: 'serializer', type: 'string' }]]
    const marker = -1
    proto.addType('ingredient', [
      function (buffer, offset, args, context) {
        if (this.read(buffer, offset, 'varint', context).value !== marker) return vanillaIngredient[0].call(this, buffer, offset, args, context)
        const header = this.read(buffer, offset, ingredientHeader, context)
        const { serializer } = header.value
        const schema = ingredientSchemas.get(serializer)
        if (!schema) {
          // The enclosing recipe supplies context through the ProtoDef container.
          let recipe = context
          while (recipe && !recipe.recipeId) recipe = recipe['..']
          return unsupported(buffer, offset, args, { type: serializer, recipeId: recipe?.recipeId })
        }
        const payload = this.read(buffer, offset + header.size, schema, context)
        observedIngredients.add(serializer)
        return { value: { serializer, data: payload.value }, size: header.size + payload.size }
      },
      function (value, buffer, offset, args, context) {
        if (Array.isArray(value)) return vanillaIngredient[1].call(this, value, buffer, offset, args, context)
        const header = this.write({ marker, serializer: value.serializer }, buffer, offset, ingredientHeader, context)
        return this.write(value.data, buffer, header, ingredientSchemas.get(value.serializer), context)
      },
      function (value, args, context) {
        if (Array.isArray(value)) return vanillaIngredient[2].call(this, value, args, context)
        return this.sizeOf({ marker, serializer: value.serializer }, ingredientHeader, context) +
          this.sizeOf(value.data, ingredientSchemas.get(value.serializer), context)
      }
    ])
    this.cache = { stamp, proto, inferred, observedIngredients, bookReady }
    return this.cache
  }

  decode (buffer, version, phase) {
    if (phase !== 'play' || version !== '1.20.1' || (!this.arguments.size && !this.recipes.size && !this.ingredients.size && !this.metadata.size)) return null
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null
    const id = new WireReader(buffer.subarray(0, 5)).varInt()
    if (!this.packetNames) {
      this.packetNames = require('minecraft-data')(version).protocol.play.toClient.types.packet[1][0].type[1].mappings
    }
    const name = this.packetNames['0x' + id.toString(16).padStart(2, '0')]
    if (!['declare_recipes', 'declare_commands', 'unlock_recipes', 'entity_metadata'].includes(name)) return null
    const { proto, inferred, observedIngredients, bookReady } = this._protocol(version)
    observedIngredients.clear()
    let packet
    try {
      if (buffer.length > 16 * 1048576) throw new Error('protocol_packet_size_limit')
      if (name === 'unlock_recipes' && !bookReady) throw new Error('recipe_book_extension_count_unresolved')
      packet = proto.parsePacketBuffer('packet', buffer)
      if (packet.metadata.size !== buffer.length) throw new Error('protocol_packet_trailing_bytes')
      if (name === 'unlock_recipes') {
        if (![0,1,2].includes(packet.data.params.action)) throw new Error('invalid_recipe_book_action')
        if (!proto.createPacketBuffer('packet', packet.data).equals(buffer)) throw new Error('recipe_book_roundtrip_mismatch')
      }
      if (name === 'declare_recipes') {
        const inferredTypes = packet.data.params.recipes.filter(recipe => inferred.has(recipe.type)).map(recipe => recipe.type)
        if (inferredTypes.length || observedIngredients.size || [...this.recipes.values(),...this.ingredients.values()].some(e=>e.codec)) {
          if (!proto.createPacketBuffer('packet', packet.data).equals(buffer)) throw new Error('inferred_recipe_roundtrip_mismatch')
          for (const type of inferredTypes) this.verifiedRecipes.add(type)
          for (const type of observedIngredients) if (!this.ingredients.has(type)) this.verifiedRecipes.add(type)
        }
        this.synchronization.recipes = { status: 'complete', recipes: packet.data.params.recipes.length }
      }
      if (name === 'entity_metadata') {
        if (!proto.createPacketBuffer('packet', packet.data).equals(buffer)) throw new Error('entity_metadata_roundtrip_mismatch')
        this.synchronization.entityMetadata = { status: 'last-packet-decoded', entityId: packet.data.params.entityId }
      }
    } catch (error) {
      this.counts.rejected++
      error.code = 'MMR_PLAY_CODEC_REJECTED'
      error.packetName = name
      const key = name === 'declare_recipes' ? 'recipes' : name === 'entity_metadata' ? 'entityMetadata' : null
      if (key) {
        this.synchronization[key] = { status: 'failed', resource: error.resource || null, reason: error.message, ...(error.entityId === undefined ? {} : {entityId:error.entityId}) }
        this.runtime.emit('protocolSyncFailed', { component: key, ...this.synchronization[key] })
      }
      throw error
    }
    this.counts.decoded++
    this.runtime.emit('protocolPacketDecoded', { name, bytes: buffer.length })
    return packet
  }

  getReport () {
    return { recipeSerializers: [...this.recipes.keys()], commandArguments: [...this.arguments.keys()],
      synchronization: structuredClone(this.synchronization),
      entityMetadataSerializers: (this.runtime.registryMappings.getEntries('forge:entity_data_serializers') || []).map(e=>({...e,codecRegistered:this.metadata.has(e.name)})),
      recipeBook: { extensionTypes: this.recipeBookTypes?.extensions || [], unresolved: this.recipeBookTypes?.unresolved || [],
        extensionOrderKnown: (this.recipeBookTypes?.extensions.length || 0) <= 1, settingsPerType: 2 },
      ingredientSerializers: [...this.ingredients.keys()],
      inferredRecipes: this.recipeCandidates.map(({ schema, definitions, ...candidate }) => ({ ...candidate,
        definitionCount: Object.keys(definitions || {}).length, wireVerified: this.verifiedRecipes.has(candidate.id) })),
      ...this.counts }
  }
}

module.exports = { PlayProtocolCodecs }
