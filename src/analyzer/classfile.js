'use strict'
class Reader {
  constructor (b) { this.b = b; this.p = 0 }
  u1 () { if (this.p + 1 > this.b.length) throw new Error('Truncated classfile'); return this.b[this.p++] }
  u2 () { if (this.p + 2 > this.b.length) throw new Error('Truncated classfile'); const v = this.b.readUInt16BE(this.p); this.p += 2; return v }
  u4 () { if (this.p + 4 > this.b.length) throw new Error('Truncated classfile'); const v = this.b.readUInt32BE(this.p); this.p += 4; return v }
  take (n) { if (n < 0 || this.p + n > this.b.length) throw new Error('Truncated classfile'); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v }
  skip (n) { this.take(n) }
}

function readClass (b) {
  if (b.length > 8 * 1024 * 1024) throw new Error('Class too large')
  const r = new Reader(b)
  if (r.u4() !== 0xcafebabe) throw new Error('Invalid class magic')
  r.u2(); const major = r.u2()
  const count = r.u2()
  const cp = Array(count).fill(null)
  for (let i = 1; i < count; i++) {
    const tag = r.u1()
    switch (tag) {
      case 1: { const n = r.u2(); cp[i] = { tag, str: r.take(n).toString('utf8') }; break }
      case 3: case 4: cp[i] = { tag, value: r.u4() }; break
      case 5: case 6: r.u4(); r.u4(); cp[i] = { tag }; i++; break
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, index: r.u2() }; break
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, index: r.u2(), second: r.u2() }; break
      case 15: cp[i] = { tag, kind: r.u1(), index: r.u2() }; break
      default: throw new Error('Unrecognized constant-pool tag: ' + tag)
    }
  }
  const utf = i => cp[i]?.tag === 1 ? cp[i].str : null
  const className = i => cp[i]?.tag === 7 ? utf(cp[i].index) : null
  const constant = i => cp[i]?.tag === 8 ? utf(cp[i].index) : cp[i]?.tag === 7 ? { className: className(i) } : cp[i]?.tag === 1 ? cp[i].str : null
  const member = i => {
    const v = cp[i]
    if (![9, 10, 11].includes(v?.tag)) return null
    const nt = cp[v.second]
    return { owner: className(v.index), name: utf(nt?.index), descriptor: utf(nt?.second), tag: v.tag }
  }
  const access = r.u2(); const thisClass = className(r.u2()); const superClass = className(r.u2())
  const interfaces = Array.from({ length: r.u2() }, () => className(r.u2()))
  const skipAttrs = () => { for (let a = r.u2(); a > 0; a--) { r.u2(); r.skip(r.u4()) } }
  const fields = []
  for (let n = r.u2(); n > 0; n--) {
    const flags = r.u2(); const name = utf(r.u2()); const descriptor = utf(r.u2()); skipAttrs()
    fields.push({ flags, name, descriptor })
  }
  const methods = []
  for (let n = r.u2(); n > 0; n--) {
    const flags = r.u2(); const name = utf(r.u2()); const descriptor = utf(r.u2()); let code = null; const exceptionHandlers = []; const annotationAttributes=[]
    for (let a = r.u2(); a > 0; a--) {
      const attr = utf(r.u2()); const len = r.u4(); const begin = r.p
      if (attr === 'Code') {
        r.u2(); r.u2(); code = r.take(r.u4())
        for (let count = r.u2(); count > 0; count--) {
          exceptionHandlers.push({ start: r.u2(), end: r.u2(), handler: r.u2(), catchType: className(r.u2()) })
        }
      }
      if(attr==='RuntimeVisibleAnnotations') annotationAttributes.push(r.b.subarray(begin,begin+len))
      r.p = begin + len
      if (r.p > r.b.length) throw new Error('Truncated Code attribute')
    }
    methods.push({ flags, name, descriptor, code, exceptionHandlers, annotationAttributes })
  }
  const bootstraps = []
  const annotations = []
  const annotationValue = (reader, depth = 0) => {
    if (depth > 16) throw new Error('Annotation nesting limit')
    const tag = String.fromCharCode(reader.u1())
    if ('BCDFIJSZs'.includes(tag)) { const index = reader.u2(); return tag === 's' ? utf(index) : cp[index]?.value }
    if (tag === 'e') return { enumType: utf(reader.u2()), name: utf(reader.u2()) }
    if (tag === 'c') return { className: utf(reader.u2()) }
    if (tag === '@') return annotation(reader, depth+1)
    if (tag === '[') return Array.from({ length: reader.u2() }, () => annotationValue(reader, depth+1))
    throw new Error('Unsupported annotation value')
  }
  const annotation = (reader, depth = 0) => {
    const type = utf(reader.u2()); const values = Object.create(null)
    for (let count = reader.u2(); count > 0; count--) values[utf(reader.u2())] = annotationValue(reader, depth+1)
    return { type, values }
  }
  for(const method of methods) {
    method.annotations=[]
    for(const bytes of method.annotationAttributes) {
      const reader=new Reader(bytes)
      for(let count=reader.u2();count>0;count--)method.annotations.push(annotation(reader))
    }
    delete method.annotationAttributes
  }
  for (let n = r.u2(); n > 0; n--) {
    const name = utf(r.u2())
    const attribute = new Reader(r.take(r.u4()))
    if (name === 'RuntimeVisibleAnnotations') {
      for (let count = attribute.u2(); count > 0; count--) annotations.push(annotation(attribute))
    }
    if (name !== 'BootstrapMethods') continue
    for (let count = attribute.u2(); count > 0; count--) {
      const handle = attribute.u2()
      const arguments_ = Array.from({ length: attribute.u2() }, () => attribute.u2())
      bootstraps.push({ handle, arguments_ })
    }
  }
  const lambdaTarget = index => {
    const entry = cp[index]
    const bootstrap = entry?.tag === 18 && bootstraps[entry.index]
    if (!bootstrap) return null
    const factory = member(cp[bootstrap.handle]?.index)
    if (factory?.owner !== 'java/lang/invoke/LambdaMetafactory' || factory.name !== 'metafactory') return null
    return member(cp[bootstrap.arguments_[1]]?.index)
  }
  const dynamicDescriptor = index => utf(cp[cp[index]?.second]?.second)
  const stringConcat = index => {
    const entry = cp[index]; const bootstrap = entry?.tag === 18 && bootstraps[entry.index]
    const factory = bootstrap && member(cp[bootstrap.handle]?.index)
    return factory?.owner === 'java/lang/invoke/StringConcatFactory' && factory.name === 'makeConcatWithConstants'
      ? { recipe: constant(bootstrap.arguments_[0]), constants: bootstrap.arguments_.slice(1).map(constant) } : null
  }
  return { thisClass, superClass, interfaces, annotations, major, access, fields, methods, constant, member, cp, lambdaTarget, dynamicDescriptor, stringConcat }
}

// Operand byte sizes, not including opcode. Unknown opcodes rejected rather than guessed.
const sizes = Array(256).fill(0)
for (const op of [0x10,0x12,0x15,0x16,0x17,0x18,0x19,0x36,0x37,0x38,0x39,0x3a,0xa9,0xbc]) sizes[op] = 1
for (const op of [0x11,0x13,0x14,0x84,0x99,0x9a,0x9b,0x9c,0x9d,0x9e,0x9f,0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xbb,0xbd,0xc0,0xc1,0xc6,0xc7]) sizes[op] = 2
for (const op of [0xc5]) sizes[op] = 3
for (const op of [0xb9,0xba,0xc8,0xc9]) sizes[op] = 4
function instructions (cls, method) {
  if (!method.code) return []
  const code = method.code; const out = []
  for (let p = 0; p < code.length;) {
    const offset = p; const op = code[p++]; let length = sizes[op]
    if (op === 0xaa || op === 0xab) { // switch tables are variable length
      p += (4 - (p % 4)) % 4
      if (p + (op === 0xaa ? 12 : 8) > code.length) throw new Error('Truncated switch')
      const defaultTarget = offset + code.readInt32BE(p); const cases = []
      if (op === 0xaa) { const low = code.readInt32BE(p + 4); const high = code.readInt32BE(p + 8); const n = high - low + 1; if (n < 0 || n > 100000 || p + 12 + n * 4 > code.length) throw new Error('Invalid tableswitch'); for (let i = 0; i < n; i++) cases.push({ value: low+i, target: offset+code.readInt32BE(p+12+i*4) }); p += 12 + n * 4 }
      else { const n = code.readInt32BE(p + 4); if (n < 0 || n > 100000 || p + 8 + n * 8 > code.length) throw new Error('Invalid lookupswitch'); for (let i = 0; i < n; i++) cases.push({ value: code.readInt32BE(p+8+i*8), target: offset+code.readInt32BE(p+12+i*8) }); p += 8 + n * 8 }
      if (p > code.length) throw new Error('Truncated switch entries')
      out.push({ offset, op, defaultTarget, cases }); continue
    }
    if (op === 0xc4) { // wide
      if (p >= code.length) throw new Error('Truncated wide')
      length = code[p] === 0x84 ? 5 : 3
    }
    if (p + length > code.length) throw new Error('Truncated bytecode operands')
    const index = [0x12].includes(op) ? code[p] : [0x13,0x14,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xbb,0xbd,0xc0,0xc1,0xc5].includes(op) ? code.readUInt16BE(p) : null
    const entry = { offset, op }
    if (op === 0xba) { entry.lambda = cls.lambdaTarget?.(index); entry.descriptor = cls.dynamicDescriptor?.(index); entry.stringConcat = cls.stringConcat?.(index) }
    if (index != null) {
      if ([0x12,0x13,0x14].includes(op)) entry.literal = cls.constant(index)
      else if ([0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9].includes(op)) entry.member = cls.member(index)
      else if (op === 0xbb || op === 0xc0) entry.className = cls.constant(index)?.className
    }
    if ((op >= 0x99 && op <= 0xa8) || op === 0xc6 || op === 0xc7) entry.target = offset + code.readInt16BE(p)
    if (op === 0xc8 || op === 0xc9) entry.target = offset + code.readInt32BE(p)
    if (op === 0x84) { entry.localIndex = code[p]; entry.increment = code.readInt8(p + 1) }
    if ((op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a)) entry.localIndex = code[p]
    if (op === 0x11) entry.number = code.readInt16BE(p)
    if (op === 0x10) entry.number = code.readInt8(p)
    p += length
    out.push(entry)
  }
  return out
}
module.exports = { readClass, instructions }
