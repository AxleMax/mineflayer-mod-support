'use strict'

const { ReadCodecCompiler } = require('./read-codec-compiler')
const { discoverDeferredRecipes } = require('./deferred-recipes')
const { vanillaRecipeDelegate, wireEvidence } = require('./recipe-wire-evidence')
const { normalInstructions } = require('./normal-control-flow')
const { instructions } = require('./classfile')

const BUFFER = 'net/minecraft/network/FriendlyByteBuf'
const INGREDIENT = 'net/minecraft/world/item/crafting/Ingredient'
const SIMPLE = 'net/minecraft/world/item/crafting/SimpleCraftingRecipeSerializer'
const DEFERRED = 'net/minecraftforge/registries/DeferredRegister'
const RESOURCE = 'net/minecraft/resources/ResourceLocation'
const INGREDIENT_API = 'net/minecraftforge/common/crafting/IIngredientSerializer'
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

const primitives = {
  read: { m_130277_: 'string', m_130136_: 'string', m_130242_: 'varint', m_130267_: 'slot', readFloat: 'f32', readDouble: 'f64', readShort: 'i16', readInt: 'i32', readLong: 'i64', m_130258_: 'varlong', readBoolean: 'bool' },
  write: { m_130070_: 'string', m_130130_: 'varint', m_130055_: 'slot', writeFloat: 'f32', writeDouble: 'f64', writeShort: 'i16', writeInt: 'i32', writeLong: 'i64', m_130103_: 'varlong', writeBoolean: 'bool' }
}

function supplierClass (classes, target) {
  if (!target) return null
  if (target.name === '<init>') return target.owner
  const cls = classes.get(target.owner)
  const method = cls?.methods.find(m => m.name === target.name && m.descriptor === target.descriptor && m.code)
  if (!method || !method.descriptor.startsWith('()')) return null
  const body = instructions(cls, method)
  if (body[0]?.op !== 0xbb || body.at(-1)?.op !== 0xb0 ||
      body.some(i => ![0xbb, 0x59, 0xba, 0xb7, 0xb3, 0xb0, 0x12, 0x13].includes(i.op)) ||
      body.filter(i => i.op === 0xbb || i.op === 0xb7).length !== 2 ||
      !body.some(i => i.member?.owner === body[0].className && i.member.name === '<init>')) return null
  return body[0].className
}

function wireShape (classes, cls, method, direction, depth = 0) {
  if (depth > 3 || !method?.code || method.code.length > 2048) return null
  const code = normalInstructions(cls, method).code
  if (code.slice(0, -1).some(i => i.op >= 0xac && i.op <= 0xb1)) return null
  const fields = []
  const loops = []
  for (const [index, ins] of code.entries()) {
    const member = ins.member
    if ([0xaa, 0xab, 0xa8, 0xa9, 0xc8, 0xc9, 0xbf, 0xba].includes(ins.op)) return null
    if (ins.op === 0xa7 && ins.target < ins.offset) {
      const start = code.findIndex(i => i.offset === ins.target)
      const body = code.slice(start, index)
      const calls = body.filter(i => i.member && i.member.tag !== 9)
      const branches = body.filter(i => i.target !== undefined)
      const exit = code[index + 1]?.offset
      if (start < 0 || branches.length !== 1 || branches[0].target !== exit) return null
      const names = calls.map(i => i.member.name)
      if (direction === 'write') {
        const iterator = code[start - 2]?.member
        const size = code[start - 7]?.member
        if (names.length !== 3 || names[0] !== 'hasNext' || names[1] !== 'next' ||
            calls[0].member.owner !== 'java/util/Iterator' || calls[1].member.owner !== 'java/util/Iterator' ||
            branches[0].op !== 0x99 || iterator?.name !== 'iterator' || size?.name !== 'size' ||
            code[start - 6]?.member?.owner !== BUFFER || code[start - 6].member.name !== 'm_130130_' ||
            code[start - 3]?.member?.tag !== 9 || code[start - 3].member.owner !== code[start - 8]?.member?.owner ||
            code[start - 3].member.name !== code[start - 8]?.member?.name) return null
      } else {
        const bound = calls[0]?.member
        const allocation = code.slice(Math.max(0, start - 10), start).find(i =>
          i.member?.owner === 'net/minecraft/core/NonNullList' && ['m_122780_', 'm_182647_'].includes(i.member.name))
        if (!allocation || branches[0].op !== 0xa2 || code[index - 1]?.op !== 0x84 ||
            !(names.length === 2 && names[1] === 'add' && allocation.member.name === 'm_182647_' ||
              names.length === 3 && bound?.name === 'size' && names[2] === 'set' && allocation.member.name === 'm_122780_')) return null
      }
      loops.push({ start: ins.target, end: ins.offset, exit })
    }
    if (!member || member.tag === 9) continue
    let type
    if (member.owner === BUFFER) type = primitives[direction][member.name]
    else if (member.owner === INGREDIENT && member.name === (direction === 'read' ? 'm_43940_' : 'm_43923_')) type = 'ingredient'
    else if (member.descriptor.includes('L' + BUFFER + ';')) {
      const nested = classes.get(member.owner)
      const child = nested?.methods.find(m => m.name === member.name && m.descriptor === member.descriptor)
      if (!child || child.name === '<init>') return null
      type = wireShape(classes, nested, child, direction, depth + 1)
    } else continue
    if (!type) return null
    fields.push({ offset: ins.offset, type })
  }
  const types = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const loop = loops.find(l => field.offset >= l.start && field.offset < l.end)
    if (loop) {
      if (depth || types.at(-1) !== 'varint' || !fields[i - 1] || fields[i - 1].offset >= loop.start ||
          fields[i + 1]?.offset < loop.end) return null
      types.pop()
      types.push(['array', { countType: 'varint', type: field.type }])
    } else types.push(field.type)
  }
  for (const ins of code.filter(i => i.target !== undefined)) {
    if (loops.some(l => ins.offset >= l.start && ins.offset <= l.end)) continue
    // Permit a branch that changes a value before a shared wire write.
    if (depth || ins.target <= ins.offset || fields.some(f => f.offset >= ins.offset && f.offset < ins.target)) return null
  }
  if (!types.length) return null
  return ['container', types.map((type, i) => ({ name: 'field_' + i, type }))]
}

function findMethod(classes,owner,names) {
  const seen=new Set()
  while(owner&&!seen.has(owner)) {
    seen.add(owner);const cls=classes.get(owner)
    const method=cls?.methods.find(m=>names.includes(m.name)&&!(m.flags&64)&&m.code&&m.descriptor.includes('L'+BUFFER+';'))
    if(method)return {cls,method}
    owner=cls?.superClass
  }
  return null
}
function discoverRecipeSerializers (classes, options = {}) {
  const locations = new Map()
  const staticInstances = new Map()
  for (const cls of classes.values()) {
    const init = cls.methods.find(m => m.name === '<clinit>')
    if (!init) continue
    const code = instructions(cls, init)
    for (const [i, ins] of code.entries()) {
      if (ins.op === 0xb3 && code[i - 3]?.className === code[i - 1]?.member?.owner &&
          code[i - 2]?.op === 0x59 && code[i - 1]?.member?.name === '<init>' &&
          code[i - 1]?.member?.descriptor === '()V') {
        staticInstances.set(cls.thisClass + '.' + ins.member.name, code[i - 3].className)
      }
      if (ins.member?.owner !== RESOURCE || ins.member.name !== '<init>' ||
          ins.member.descriptor !== '(Ljava/lang/String;Ljava/lang/String;)V' || code[i + 1]?.op !== 0xb3) continue
      const id = code[i - 2]?.literal + ':' + code[i - 1]?.literal
      if (typeof code[i - 2]?.literal === 'string' && typeof code[i - 1]?.literal === 'string' && ID.test(id)) {
        locations.set(cls.thisClass + '.' + code[i + 1].member.name, id)
      }
    }
  }
  const recipes = []
  function append(id,factory,ingredientOwner) {
    const ingredient = ingredientOwner !== undefined
    const owner = ingredient ? ingredientOwner : supplierClass(classes, factory)
    const serializer = classes.get(owner)
    let schema = owner === SIMPLE ? 'minecraft_simple_recipe_format' : null
    let evidence = null; let vanillaDelegate = null; let readDerived = null; let inferenceFailure = null
    if (serializer) {
      const readNames = ingredient ? ['parse'] : ['fromNetwork', 'm_8005_']
      const writeNames = ingredient ? ['write'] : ['toNetwork', 'm_6178_']
      const read = findMethod(classes,owner,readNames)
      const write = findMethod(classes,owner,writeNames)
      evidence = { read: wireEvidence(classes,read,'read'), write: wireEvidence(classes,write,'write') }
      vanillaDelegate = vanillaRecipeDelegate(read,write)
      const incoming = wireShape(classes, read?.cls, read?.method, 'read')
      const outgoing = wireShape(classes, write?.cls, write?.method, 'write')
      if (incoming && JSON.stringify(incoming) === JSON.stringify(outgoing)) schema = incoming
      if (!schema && vanillaDelegate) schema = ['standard_recipe_reference', { id: vanillaDelegate }]
      if (!schema && read) {
        try { readDerived = new ReadCodecCompiler(classes,options.serviceProviders).compile(read,owner); schema = readDerived.schema }
        catch(error) { inferenceFailure = error.message }
      }
    }
    recipes.push({ id, kind: ingredient ? 'ingredient' : 'recipe', serializer: owner, schema, definitions: readDerived?.definitions, derivation: readDerived?.derivation || (schema ? 'paired-read-write' : null), bindingEvidence: readDerived?.evidence, pairedWriterProven: readDerived ? false : Boolean(schema), inferenceFailure, wireEvidence: evidence, vanillaDelegate, status: schema ? 'candidate' : 'unresolved',
      reason: schema ? null : owner ? 'unsupported_or_nonmatching_wire_structure' : 'unresolved_serializer_supplier' })
  }
  for (const cls of classes.values()) {
    for (const method of cls.methods.filter(m => m.code)) {
      const code = instructions(cls, method)
      const registries = new Map()
      for (const [i, ins] of code.entries()) {
        if (ins.member?.owner === DEFERRED && ins.member.name === 'create' &&
            code[i - 2]?.member?.owner === 'net/minecraftforge/registries/ForgeRegistries' &&
            code[i - 2].member.name === 'RECIPE_SERIALIZERS' && code[i + 1]?.op === 0xb3) {
          registries.set(code[i + 1].member.name, code[i - 1].literal)
        }
        let id, factory, ingredientOwner
        if (ins.member?.owner === DEFERRED && ins.member.name === 'register' && code[i - 3]?.op === 0xb2 &&
            typeof code[i - 2]?.literal === 'string') {
          const namespace = registries.get(code[i - 3].member.name)
          if (!namespace || code[i - 3].member.owner !== cls.thisClass) continue
          id = namespace + ':' + code[i - 2].literal
          factory = code[i - 1]?.lambda
        } else if (ins.member?.owner === 'net/blay09/mods/balm/api/recipe/BalmRecipes' &&
            ins.member.name === 'registerRecipeType' && code[i - 1]?.op === 0xb2) {
          const field = code[i - 1].member
          id = locations.get(field.owner + '.' + field.name)
          factory = code[i - 2]?.lambda
        } else if (ins.member?.owner === 'net/minecraftforge/common/crafting/CraftingHelper' &&
            ins.member.name === 'register' && ins.member.descriptor.includes('L' + INGREDIENT_API + ';') &&
            code[i - 1]?.op === 0xb2 && code[i - 2]?.member?.owner === RESOURCE &&
            typeof code[i - 4]?.literal === 'string' && typeof code[i - 3]?.literal === 'string') {
          const field = code[i - 1].member
          id = code[i - 4].literal + ':' + code[i - 3].literal
          ingredientOwner = staticInstances.get(field.owner + '.' + field.name) || null
        }
        if (!id || !ID.test(id) || recipes.length >= 256) continue
        append(id,factory,ingredientOwner)
      }
    }
  }
  const deferred=discoverDeferredRecipes(classes)
  for(const {id,factory} of deferred.registrations) if(ID.test(id)&&!recipes.some(r=>r.id===id)) append(id,factory,undefined)
  recipes.discoveryDiagnostics=deferred.diagnostics
  return recipes
}

module.exports = { discoverRecipeSerializers, wireShape }
