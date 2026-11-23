'use strict'
const { validateBlockDefinition } = require('./block-definitions')

class NativeBlockProjection {
  constructor (bridge) { this.bridge = bridge; this.applied = []; this.unresolved = [] }
  prepare () {
    const { base, view } = this.bridge
    if (!base.blocks || !base.blocksByStateId) return
    // prismarine-block enriches registry records with shapes at factory load.
    // Clone records and shape tables before upstream plugins touch this view.
    const records = new Map(Object.values(base.blocks).filter(Boolean).map(b => [b.id, structuredClone(b)]))
    const blocks = []; const byName = Object.create(null); const byState = []
    for (const b of records.values()) { blocks[b.id] = b; byName[b.name] = b }
    for (const [state, block] of Object.entries(base.blocksByStateId)) if (block) byState[state] = records.get(block.id) || structuredClone(block)
    Object.assign(view, { blocks, blocksArray: [...records.values()], blocksByName: byName, blocksByStateId: byState,
      blockCollisionShapes: structuredClone(base.blockCollisionShapes || { blocks: {}, shapes: [] }) })
    this.baseView = { blocks, byName, byState, collision: view.blockCollisionShapes }
    this.sync()
  }
  sync () {
    if (!this.baseView || !this.bridge.view) return
    const { view, definitions, mappings } = this.bridge
    const collision = structuredClone(this.baseView.collision)
    const blocks = [], byName = Object.create(null)
    for (const original of this.baseView.blocks.filter(Boolean)) {
      const name = original.name.includes(':') ? original.name : 'minecraft:' + original.name
      const record = { ...original, id: mappings.getId('minecraft:block', name) ?? original.id }
      const knownShapes = collision.blocks[original.name]
      if (knownShapes !== undefined) {
        record.shapes = collision.shapes[Array.isArray(knownShapes) ? knownShapes[0] : knownShapes]
        if (Array.isArray(knownShapes)) record.stateShapes = knownShapes.map(id => collision.shapes[id])
      }
      blocks[record.id] = record; byName[record.name] = record; byName[name] = record
    }
    const byState = this.baseView.byState.map(record => record ? byName[record.name] || { ...record } : record)
    let nextShapeId = Object.keys(collision.shapes).reduce((max, key) => Math.max(max, Number(key)), -1) + 1
    this.applied = []; this.unresolved = []
    const definitionsList = [...(definitions?.entries.values() || [])].filter(d => d.kind === 'block')
    const ranges = []
    for (const { id: name, data, source } of definitionsList) {
      const count = validateBlockDefinition(data), max = data.minStateId + count - 1
      if (ranges.some(r => data.minStateId <= r.max && max >= r.min)) throw new Error('overlapping_adapter_block_states')
      ranges.push({ min: data.minStateId, max })
      const id = mappings.getId('minecraft:block', name)
      if (id === null) { this.unresolved.push({ name, reason: 'block_not_in_server_registry' }); continue }
      const record = { id, name, displayName: data.displayName || name, minStateId: data.minStateId, maxStateId: max,
        defaultState: data.defaultStateId, states: data.properties.map(p => p.values.length === 2 && p.values[0] === true && p.values[1] === false
          ? { name: p.name, type: 'bool', num_values: 2 }
          : p.values.every((value, i) => value === i) ? { name: p.name, type: 'int', num_values: p.values.length }
            : { name: p.name, type: 'enum', num_values: p.values.length, values: p.values.map(String) }),
        hardness: data.hardness, diggable: data.diggable, transparent: data.transparent, boundingBox: data.boundingBox,
        shapes: structuredClone(data.collisionShapes[0]), stateShapes: structuredClone(data.collisionShapes),
        _modSupport: { source, canonicalName: name, stateIdsKnown: true, collisionSource: 'explicit-static-definition', dynamicCollisionKnown: false } }
      blocks[id] = record; byName[name] = record
      if (name.startsWith('minecraft:')) byName[name.slice(10)] = record
      // Remove stale aliases of the same name/type when a server remaps IDs.
      for (let i = 0; i < byState.length; i++) if (byState[i] && (byState[i].name.includes(':') ? byState[i].name : 'minecraft:' + byState[i].name) === name) delete byState[i]
      for (let state = data.minStateId; state <= max; state++) byState[state] = record
      const shapeIds = data.collisionShapes.map(shape => { const index = nextShapeId++; collision.shapes[index] = structuredClone(shape); return index })
      collision.blocks[name] = shapeIds
      this.applied.push({ name, id, minStateId: data.minStateId, maxStateId: max, source, states: count })
    }
    Object.assign(view, { blocks, blocksByName: byName, blocksByStateId: byState, blocksArray: blocks.filter(Boolean), blockCollisionShapes: collision })
  }
  getReport () { return { applied: this.applied.map(x => ({ ...x })), unresolved: this.unresolved.map(x => ({ ...x })), dynamicCollisionKnown: false } }
}
module.exports = { NativeBlockProjection }
