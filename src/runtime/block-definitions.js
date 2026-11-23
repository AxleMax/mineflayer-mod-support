'use strict'
function validateCollisionShape (shape) {
  if (!Array.isArray(shape) || shape.length > 256) throw new Error('invalid_collision_shape')
  for (const box of shape) if (!Array.isArray(box) || box.length !== 6 || box.some(v => !Number.isFinite(v)) || box.slice(0, 3).some((v, i) => v > box[i + 3])) throw new Error('invalid_collision_box')
}

// Ordered values describe the actual StateDefinition enumeration supplied by
// an adapter. Neither global state IDs nor collision geometry are inferred.
function validateBlockDefinition (data) {
  const allowed = ['minStateId', 'defaultStateId', 'properties', 'collisionShapes', 'displayName', 'hardness', 'diggable', 'transparent', 'boundingBox']
  if (!data || Object.keys(data).some(k => !allowed.includes(k)) || !Number.isInteger(data.minStateId) || data.minStateId < 0 || data.minStateId > 1048575) throw new Error('invalid_block_definition')
  if (!Array.isArray(data.properties) || data.properties.length > 16) throw new Error('invalid_block_properties')
  const names = new Set(); let count = 1
  for (const property of data.properties) {
    if (!property || !/^[a-z0-9_]+$/.test(property.name || '') || names.has(property.name) || !Array.isArray(property.values) || !property.values.length ||
        property.values.some(v => !['string', 'boolean', 'number'].includes(typeof v) || typeof v === 'number' && !Number.isSafeInteger(v)) || new Set(property.values.map(String)).size !== property.values.length) throw new Error('invalid_block_property')
    names.add(property.name); count *= property.values.length
    if (property.values.some(v => typeof v === 'boolean') && !(property.values.length === 2 && property.values[0] === true && property.values[1] === false)) throw new Error('block_boolean_domain_requires_true_false')
    if (count > 8192) throw new Error('block_state_count_limit')
  }
  if (data.minStateId + count > 1048576 || !Number.isInteger(data.defaultStateId) || data.defaultStateId < data.minStateId || data.defaultStateId >= data.minStateId + count) throw new Error('invalid_default_block_state')
  if (!Array.isArray(data.collisionShapes) || data.collisionShapes.length !== count) throw new Error('block_collision_shape_count_mismatch')
  for (const shape of data.collisionShapes) {
    validateCollisionShape(shape)
  }
  if (data.displayName !== undefined && typeof data.displayName !== 'string' || data.hardness !== undefined && !Number.isFinite(data.hardness) || data.diggable !== undefined && typeof data.diggable !== 'boolean' || data.transparent !== undefined && typeof data.transparent !== 'boolean' || data.boundingBox !== undefined && !['block', 'empty'].includes(data.boundingBox)) throw new Error('invalid_block_metadata')
  return count
}
module.exports = { validateBlockDefinition, validateCollisionShape }
