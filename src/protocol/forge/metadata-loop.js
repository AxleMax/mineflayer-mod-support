'use strict'
const { PartialReadError } = require('protodef').utils
// Same vanilla terminator framing as NMP, retaining the enclosing entity
// context for diagnostics and checking the moving cursor on truncation.
function count (value) {
  if (!Array.isArray(value) || value.length > 255) throw new Error('entity_metadata_entry_limit')
}
module.exports = { entityMetadataLoop: [function (buffer, offset, args, parent) {
  let cursor = offset
  const value = []
  while (true) {
    if (cursor >= buffer.length) throw new PartialReadError('truncated_entity_metadata')
    if (buffer[cursor] === args.endVal) return { value, size: cursor + 1 - offset }
    if (value.length >= 255) throw new Error('entity_metadata_entry_limit')
    const result = this.read(buffer, cursor, args.type, parent)
    if (!Number.isSafeInteger(result.size) || result.size < 1 || cursor + result.size > buffer.length) throw new Error('invalid_entity_metadata_entry_size')
    value.push(result.value); cursor += result.size
  }
}, function (value, buffer, offset, args, parent) {
  count(value)
  for (const entry of value) {
    if (entry.key === args.endVal) throw new Error('reserved_entity_metadata_key')
    offset = this.write(entry, buffer, offset, args.type, parent)
  }
  buffer.writeUInt8(args.endVal, offset); return offset + 1
}, function (value, args, parent) {
  count(value)
  return 1 + value.reduce((size, entry) => size + this.sizeOf(entry, args.type, parent), 0)
}] }
