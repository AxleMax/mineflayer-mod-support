'use strict'
const { instructions } = require('./classfile')
const { extractEnumOrdinals, detectCountedLoop } = require('./bytecode-structure')

// Call-graph explorer that never executes methods. Used for evidence, not automatic
// certification: dynamic dispatch, loops, reflection, and class initializers remain opaque.
const OPS = {
  m_130077_: 'uuid', m_130259_: 'uuid', m_130070_: 'utf', m_130136_: 'utf', m_130277_: 'utf',
  m_130130_: 'varint', m_130242_: 'varint', m_130064_: 'blockpos', m_130135_: 'blockpos',
  m_130085_: 'resource_location', m_130281_: 'resource_location',
  m_130068_: 'enum', m_130066_: 'enum',
  writeBoolean: 'boolean', readBoolean: 'boolean', writeVarInt: 'varint', readVarInt: 'varint',
  writeLong: 'long', readLong: 'long', writeShort: 'short', readShort: 'short',
  writeInt: 'int', readInt: 'int', writeByte: 'byte', readByte: 'byte',
  writeFloat: 'float', readFloat: 'float', writeDouble: 'double', readDouble: 'double'
}
function isBranch (op) { return op >= 0x99 && op <= 0xa8 || [0xaa,0xab,0xc6,0xc7,0xc8,0xc9].includes(op) }
function explore (classes, owner, name, descriptor, depth, state, ancestors) {
  const target = owner + '.' + name + descriptor
  if (ancestors.has(target)) return { owner, method: name, descriptor, recursive: true, steps: [] }
  if (depth > 5 || state.nodes++ > 60) return { owner, method: name, descriptor, truncated: true, steps: [] }
  const cls = classes.get(owner)
  const method = cls?.methods.find(m => m.name === name && m.descriptor === descriptor && m.code)
  if (!method) return { owner, method: name, descriptor, missing: true, steps: [] }
  const code = instructions(cls, method)
  const node = { owner, method: name, descriptor, hasBranch: code.some(x => isBranch(x.op)), steps: [] }
  if (node.hasBranch) node.controlFlow = detectCountedLoop(cls, method, name === 'encode' ? 'encode' : 'decode')
  const nextAncestors = new Set([...ancestors, target])
  for (const x of code) {
    const m = x.member
    if (!m) continue
    if (m.owner === 'net/minecraft/network/FriendlyByteBuf' || m.owner === 'io/netty/buffer/ByteBuf') {
      const step = { kind: 'buffer-operation', offset: x.offset, operation: m.name, type: OPS[m.name] ?? null }
      // Getter evidence is useful for later field lineage recovery but does
      // not establish Java object layout or constructor/decoder binding.
      const precedingCalls = code.slice(Math.max(0, code.indexOf(x) - 5), code.indexOf(x))
      const getter = precedingCalls.findLast(y => y.member && /^get[A-Z]|^is[A-Z]/.test(y.member.name) &&
        !y.member.descriptor.startsWith('(Lnet/minecraft/network/FriendlyByteBuf;'))
      if (getter) step.sourceAccessor = { owner: getter.member.owner, method: getter.member.name }
      if (step.type === 'enum') {
        const index = code.indexOf(x)
        const previous = code.slice(Math.max(0, index - 6), index)
        const enumField = previous.findLast(y => y.op === 0xb4 && /^L[^;]+;$/.test(y.member?.descriptor || ''))
        const enumOwner = m.name === 'm_130066_' ? previous.findLast(y => y.literal?.className)?.literal.className
          : enumField?.member.descriptor.slice(1,-1) || previous.findLast(y => /\(\)L[^;]+;$/.test(y.member?.descriptor || ''))?.member?.descriptor?.slice(3, -1)
        if (enumOwner) { step.enumClass = enumOwner; step.enumEvidence = extractEnumOrdinals(classes, enumOwner) }
      }
      // ResourceLocation objects can be reconstructed from a UTF string in the read path.
      if (m.name === 'm_130136_') {
        const index = code.indexOf(x)
        if (code.slice(index + 1, index + 5).some(y => y.member?.owner === 'net/minecraft/resources/ResourceLocation' && y.member?.name === '<init>')) {
          step.type = 'resource_location'
          step.refinement = 'utf_wrapped_as_resource_location'
        }
      }
      node.steps.push(step)
    } else if (x.op === 0xb8 && classes.has(m.owner) && (m.descriptor.includes('FriendlyByteBuf;') || m.descriptor.includes('ByteBuf;')) && m.name !== '<init>') {
      node.steps.push({ kind: 'static-call', offset: x.offset, target: explore(classes, m.owner, m.name, m.descriptor, depth + 1, state, nextAncestors) })
    } else if (m.descriptor.includes('FriendlyByteBuf;') || m.descriptor.includes('ByteBuf;')) {
      node.steps.push({ kind: 'unresolved-buffer-delegation', offset: x.offset, owner: m.owner, method: m.name })
    }
  }
  return node
}
function traceCodec (classes, reg) {
  const cls = classes.get(reg.className)
  if (!cls || reg.kind === 'sync-config') return null
  const encoder = cls.methods.find(m => m.name === 'encode' && m.code)
  const decoder = cls.methods.find(m => m.name === 'decode' && m.code)
  if (!encoder || !decoder) return null
  const state = { nodes: 0 }
  const encode = explore(classes, cls.thisClass, encoder.name, encoder.descriptor, 0, state, new Set())
  const decode = explore(classes, cls.thisClass, decoder.name, decoder.descriptor, 0, state, new Set())
  function countNested (root) {
    return root.steps.reduce((sum, step) => sum + (step.kind === 'static-call' ? 1 + countNested(step.target) : 0), 0)
  }
  const nestedCallCount = countNested(encode) + countNested(decode)
  return nestedCallCount ? { status: 'structural-only', nestedCallCount, encode, decode, verifiedAgainstServer: false } : null
}
function traceRegisteredCodec (classes, registration) {
  const encoder = registration.encoder?.resolvedCallback || registration.encoder?.callback
  const decoder = registration.decoder?.resolvedCallback || registration.decoder?.callback
  if (!encoder || !decoder) return null
  const state = { nodes: 0 }
  return { status: 'structural-only', verifiedAgainstServer: false,
    encode: explore(classes, encoder.owner, encoder.name, encoder.descriptor, 0, state, new Set()),
    decode: explore(classes, decoder.owner, decoder.name, decoder.descriptor, 0, state, new Set()) }
}
module.exports = { traceCodec, traceRegisteredCodec }
