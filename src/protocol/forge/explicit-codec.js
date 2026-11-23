'use strict'
// Explicit adapter codecs consume their actual format, not guessed lengths.
// A surrounding complete packet must still consume and round-trip all bytes.
function explicitCodec (codec, mappings) {
  if (!codec || ['read', 'write', 'sizeOf'].some(key => typeof codec[key] !== 'function')) throw new Error('invalid_explicit_protocol_codec')
  const limit = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 16 * 1048576) throw new Error('invalid_explicit_codec_size')
    return value
  }
  const context = (proto, buffer, parent) => Object.freeze({
    getRegistryId: (name, id) => mappings.getId(name, id), getRegistryName: (name, id) => mappings.getName(name, id),
    read: (type, offset) => proto.read(buffer, offset, type, parent),
    write: (type, value, offset) => proto.write(value, buffer, offset, type, parent),
    sizeOf: (type, value) => proto.sizeOf(value, type, parent)
  })
  return [function (buffer, offset, args, parent) {
    const result = codec.read(buffer, offset, context(this, buffer, parent))
    if (!result || offset + limit(result.size) > buffer.length) throw new Error('explicit_codec_read_outside_frame')
    return result
  }, function (value, buffer, offset, args, parent) {
    const ctx = context(this, buffer, parent), size = limit(codec.sizeOf(value, ctx))
    if (offset + size > buffer.length) throw new Error('explicit_codec_write_outside_frame')
    const end = codec.write(value, buffer, offset, ctx)
    if (end !== offset + size) throw new Error('explicit_codec_write_size_mismatch')
    return end
  }, function (value, args, parent) { return limit(codec.sizeOf(value, context(this, null, parent))) }]
}
module.exports = { explicitCodec }
