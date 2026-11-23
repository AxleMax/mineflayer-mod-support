'use strict'
const { compileCodecPlan } = require('./codec-ir')

// Static bytecode evidence -> positional IR. This can produce a *structural*
// candidate even for a recognizable counted-list loop, but it is never proof
// of Java object field names, exact runtime register order, or wire parity.
function inferCallGraphPlan (graph) {
  if (!graph?.encode || !graph?.decode) return { status: 'no-call-graph', reasons: ['missing_encode_or_decode'] }
  const reasons = new Set()
  const hints = []
  const stats = { nestedCalls: 0, buffers: 0, branches: 0, resolvedEnums: 0, recognizedLists: 0 }
  const definitions = Object.create(null)
  let nextDefinition = 0

  function loopMatch (enc, dec, i) {
    const e = enc.controlFlow; const d = dec.controlFlow
    const a = enc.steps[i]; const b = dec.steps[i]
    const nextE = enc.steps[i + 1]; const nextD = dec.steps[i + 1]
    return e?.status === 'counted-loop-pattern' && d?.status === 'counted-loop-pattern' &&
      e.lengthType === d.lengthType &&
      a?.kind === 'buffer-operation' && b?.kind === 'buffer-operation' &&
      a.type === e.lengthType && b.type === d.lengthType &&
      nextE?.kind === 'static-call' && nextD?.kind === 'static-call' &&
      nextE.target.owner === e.elementOwner && nextE.target.method === e.elementMethod &&
      nextD.target.owner === d.elementOwner && nextD.target.method === d.elementMethod
  }
  function walk (enc, dec, depth = 0) {
    if (depth > 8 || !enc || !dec || enc.missing || dec.missing || enc.recursive || dec.recursive || enc.truncated || dec.truncated) {
      reasons.add('missing_recursive_or_truncated_method'); return null
    }
    if (!Array.isArray(enc.steps) || !Array.isArray(dec.steps) || enc.steps.length !== dec.steps.length) {
      reasons.add('asymmetric_method_steps'); return null
    }
    if (enc.hasBranch || dec.hasBranch) {
      stats.branches++
      if (enc.controlFlow?.status !== 'counted-loop-pattern' || dec.controlFlow?.status !== 'counted-loop-pattern') {
        reasons.add('control_flow_not_proven')
      }
    }
    const fields = []
    let pairedLengthCalls = 0
    for (let i = 0; i < enc.steps.length; i++) {
      const e = enc.steps[i]; const d = dec.steps[i]
      let codec = null
      const slotIndex = i
      if (loopMatch(enc, dec, i)) {
        stats.recognizedLists++
        hints.push({ kind: 'counted-list-structural-pattern', lengthType: e.type,
          writer: enc.steps[i + 1].target.owner + '.' + enc.steps[i + 1].target.method,
          reader: dec.steps[i + 1].target.owner + '.' + dec.steps[i + 1].target.method,
          verified: false })
        stats.nestedCalls++
        const child = walk(enc.steps[i + 1].target, dec.steps[i + 1].target, depth + 1)
        if (child) {
          const ref = 'Nested_' + nextDefinition++
          definitions[ref] = child
          codec = { type: 'list', lengthType: e.type, maxItems: 4096, element: { type: 'ref', name: ref } }
        }
        pairedLengthCalls++
        i++ // length + nested serializer form one logical list field
      } else if (e.kind === 'buffer-operation' && d.kind === 'buffer-operation') {
        stats.buffers++
        if (!e.type || !d.type || e.type !== d.type) reasons.add('unknown_or_mismatched_primitive')
        else if (e.type === 'enum') {
          const ev = e.enumEvidence; const dv = d.enumEvidence
          if (e.enumClass && e.enumClass === d.enumClass && ev?.status === 'static-evidence' && dv?.status === 'static-evidence' &&
            JSON.stringify(ev.values) === JSON.stringify(dv.values) && ev.ordinalType === dv.ordinalType) {
            stats.resolvedEnums++
            codec = { type: 'enum', ordinalType: ev.ordinalType, values: ev.values }
            hints.push({ kind: 'enum-static-ordinal-evidence', owner: e.enumClass, values: ev.values, verified: false })
          } else reasons.add('primitive_requires_additional_metadata:enum')
        } else codec = { type: e.type }
      } else if (e.kind === 'static-call' && d.kind === 'static-call') {
        stats.nestedCalls++
        const child = walk(e.target, d.target, depth + 1)
        if (child) {
          const ref = 'Nested_' + nextDefinition++
          definitions[ref] = child
          codec = { type: 'ref', name: ref }
        }
      } else reasons.add('encode_decode_shape_mismatch')
      if (codec) {
        if (e.sourceAccessor) hints.push({ kind: 'source-getter-candidate',
          source: e.sourceAccessor.owner + '.' + e.sourceAccessor.method,
          position: slotIndex, verified: false })
        fields.push({ name: 'slot_' + slotIndex, codec })
      }
    }
    if (fields.length + pairedLengthCalls !== enc.steps.length) return null
    return { type: 'struct', fields }
  }
  const root = walk(graph.encode, graph.decode)
  let plan = null
  if (root && reasons.size === 0) {
    const result = { schema: 'mineflayer-mod-support/codec-ir/v1', root, definitions }
    try { compileCodecPlan(result); plan = result } catch (e) { reasons.add('invalid_inferred_ir:' + e.message) }
  }
  if (!plan) return { status: 'blocked', reasons: [...reasons].sort(), ...stats, hints, executable: false, plan: null }
  return { status: 'structural-candidate', reasons: ['field_names_not_proven', 'wire_layout_not_verified'], ...stats, hints, executable: false, plan }
}
module.exports = { inferCallGraphPlan }
