'use strict'
const { instructions } = require('./classfile')

// Read-only JVM classfile evidence; never executes code, reflection, or Java.
function literalInteger (ins) {
  if (ins.op === 0x02) return -1
  if (ins.op >= 0x03 && ins.op <= 0x08) return ins.op - 0x03
  if (typeof ins.number === 'number') return ins.number
  return null
}

function extractEnumOrdinals (classes, owner) {
  const cls = classes.get(owner)
  if (!cls || !(cls.access & 0x4000)) return { status: 'unresolved', reason: 'enum_class_missing_or_not_enum', owner }
  const clinit = cls.methods.find(m => m.name === '<clinit>' && m.code)
  if (!clinit) return { status: 'unresolved', reason: 'enum_clinit_missing', owner }
  const code = instructions(cls, clinit)
  if (code.some(i => (i.op >= 0x99 && i.op <= 0xa8) || [0xaa, 0xab, 0xc6, 0xc7, 0xc8, 0xc9].includes(i.op))) {
    return { status: 'unresolved', reason: 'enum_clinit_control_flow', owner }
  }
  const declarations = cls.fields.filter(f => (f.flags & 0x4000) && f.descriptor === `L${owner};`).map(f => f.name)
  if (!declarations.length || declarations.length > 256) return { status: 'unresolved', reason: 'enum_fields_invalid', owner }
  const sequence = []
  for (let i = 0; i < code.length; i++) {
    const inst = code[i]
    if (inst.op !== 0xb3 || inst.member?.owner !== owner || inst.member?.descriptor !== `L${owner};`) continue
    const ctorIndex = code.slice(0,i).findLastIndex(x => x.op === 0xb7 && x.member?.owner === owner && x.member?.name === '<init>' && x.member?.descriptor?.startsWith('(Ljava/lang/String;I'))
    const newIndex = code.slice(0,ctorIndex).findLastIndex(x => x.op === 0xbb && x.className === owner)
    if (ctorIndex < 0 || newIndex < 0 || code[newIndex+1]?.op !== 0x59) return { status: 'unresolved', reason: 'enum_ctor_not_proven', owner }
    // JVM enum constructor arguments start with (name, ordinal), regardless
    // of additional user fields. They follow the new/dup allocation pair.
    const label = code[newIndex+2]?.literal
    const ordinalInstruction = code[newIndex+3]
    const ordinal = ordinalInstruction ? literalInteger(ordinalInstruction) : null
    if (!label || ordinal !== sequence.length || label !== inst.member.name || !/^[A-Za-z_$][\w$]*$/.test(label)) {
      return { status: 'unresolved', reason: 'enum_ordinal_mismatch', owner }
    }
    sequence.push(label)
  }
  if (sequence.length !== declarations.length || sequence.some((x, i) => x !== declarations[i])) {
    return { status: 'unresolved', reason: 'enum_field_order_mismatch', owner }
  }
  return { status: 'static-evidence', owner, values: sequence, ordinalType: 'varint', runtimeVerified: false }
}

function detectCountedLoop (cls, method, direction) {
  if (!cls || !method?.code) return { status: 'unresolved', reason: 'missing_method' }
  const seq = instructions(cls, method)
  const allBranches = seq.filter(x => (x.op >= 0x99 && x.op <= 0xa8) || [0xaa, 0xab, 0xc6, 0xc7, 0xc8, 0xc9].includes(x.op))
  // Only prove this narrow two-branch pattern. Other conditionals, switches,
  // extra loop exits or nested loops must stay unresolved.
  if (allBranches.length !== 2 || allBranches.some(x => typeof x.target !== 'number')) {
    return { status: 'unresolved', reason: 'complex_control_flow' }
  }
  const backEdges = allBranches.filter(x => x.target <= x.offset)
  const candidates = []
  for (const back of backEdges) {
    const body = seq.filter(x => x.offset >= back.target && x.offset <= back.offset)
    const condition = body.find(x => x.target > back.offset && x.op >= 0x99 && x.op <= 0xa6)
    if (!condition) continue
    const calls = body.filter(x => x.op === 0xb8 && x.member && /FriendlyByteBuf;/.test(x.member.descriptor || ''))
    if (calls.length !== 1) continue
    const countCalls = seq.filter(x => x.offset < back.target && x.member && (direction === 'encode' ? x.member.name === 'writeShort' : x.member.name === 'readShort') && /FriendlyByteBuf$/.test(x.member.owner || ''))
    if (countCalls.length !== 1) continue
    if (direction === 'encode') {
      const hasSize = seq.some(x => x.offset < countCalls[0].offset && x.member?.name === 'size')
      const hasIterator = body.some(x => x.member?.name === 'hasNext') && body.some(x => x.member?.name === 'next')
      if (!hasSize || !hasIterator || condition.op !== 0x99) continue
    } else {
      const counterIncrement = body.some(x => x.op === 0x84 && x.increment === 1)
      const countCondition = condition.op >= 0x9f && condition.op <= 0xa4
      if (!counterIncrement || !countCondition) continue
    }
    candidates.push({ header: back.target, backEdge: back.offset, exit: condition.target,
      elementOwner: calls[0].member.owner, elementMethod: calls[0].member.name,
      lengthType: 'short', matchedCallCount: calls.length })
  }
  return candidates.length === 1
    ? { status: 'counted-loop-pattern', direction, ...candidates[0], runtimeVerified: false,
        proofScope: 'bytecode structural pattern only; no symbolic execution or wire validation' }
    : { status: 'unresolved', reason: candidates.length ? 'ambiguous_loop_patterns' : 'unsupported_loop_pattern' }
}

module.exports = { literalInteger, extractEnumOrdinals, detectCountedLoop }
