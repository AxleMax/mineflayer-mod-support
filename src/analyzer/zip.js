'use strict'
const fs = require('node:fs')
const zlib = require('node:zlib')

const MAX_ARCHIVE = 80 * 1024 * 1024
const MAX_ENTRY = 12 * 1024 * 1024
const MAX_FILES = 20000

class ZipArchive {
  constructor (input, limits = {}) {
    this.bytes = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
    this.maxEntry = limits.maxEntry ?? MAX_ENTRY
    if (this.bytes.length > (limits.maxArchive ?? MAX_ARCHIVE)) throw new Error('Archive exceeds size limit')
    const b = this.bytes
    let eocd = -1
    const start = Math.max(0, b.length - 22 - 65535)
    for (let p = b.length - 22; p >= start; p--) {
      if (b.readUInt32LE(p) === 0x06054b50 && p + 22 + b.readUInt16LE(p + 20) === b.length) { eocd = p; break }
    }
    if (eocd === -1) throw new Error('ZIP central directory not found')
    if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) throw new Error('Multi-disk ZIP unsupported')
    const count = b.readUInt16LE(eocd + 10)
    if (count > MAX_FILES || count === 0xffff) throw new Error('Too many entries / ZIP64 unsupported')
    const directorySize = b.readUInt32LE(eocd + 12)
    const directoryOffset = b.readUInt32LE(eocd + 16)
    if (directoryOffset + directorySize > eocd) throw new Error('Invalid ZIP central directory extent')
    this.entries = new Map()
    let p = directoryOffset
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || b.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid central directory entry')
      const method = b.readUInt16LE(p + 10)
      const flags = b.readUInt16LE(p + 8)
      const compressedSize = b.readUInt32LE(p + 20)
      const size = b.readUInt32LE(p + 24)
      const nameLen = b.readUInt16LE(p + 28)
      const extraLen = b.readUInt16LE(p + 30)
      const commentLen = b.readUInt16LE(p + 32)
      const offset = b.readUInt32LE(p + 42)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > eocd) throw new Error('Invalid entry name extent')
      const name = b.toString('utf8', p + 46, p + 46 + nameLen)
      if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') || name.includes('\u0000')) throw new Error('Unsafe ZIP path')
      if (this.entries.has(name)) throw new Error('Duplicate ZIP entry: ' + name)
      this.entries.set(name, { method, flags, compressedSize, size, offset })
      p = end
    }
    if (p !== directoryOffset + directorySize) throw new Error('Central directory length mismatch')
  }
  names () { return [...this.entries.keys()] }
  has (name) { return this.entries.has(name) }
  read (name) {
    const e = this.entries.get(name)
    if (!e) return null
    if (e.size > this.maxEntry || e.compressedSize > this.maxEntry) throw new Error('Entry too large: ' + name)
    if (e.flags & 1) throw new Error('Encrypted ZIP entry unsupported: ' + name)
    const b = this.bytes
    const p = e.offset
    if (p + 30 > b.length || b.readUInt32LE(p) !== 0x04034b50) throw new Error('Bad local ZIP header')
    const nameLen = b.readUInt16LE(p + 26)
    const extraLen = b.readUInt16LE(p + 28)
    const start = p + 30 + nameLen + extraLen
    if (start + e.compressedSize > b.length) throw new Error('Invalid ZIP data range')
    const compressed = b.subarray(start, start + e.compressedSize)
    const out = e.method === 0 ? Buffer.from(compressed)
      : e.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: this.maxEntry })
        : (() => { throw new Error('Unsupported ZIP compression: ' + e.method) })()
    if (out.length !== e.size) throw new Error('ZIP size mismatch: ' + name)
    return out
  }
}
module.exports = { ZipArchive }
