'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { ZipArchive } = require('../src/analyzer/zip')
const { readClass, instructions } = require('../src/analyzer/classfile')
const { extractEnumOrdinals, detectCountedLoop } = require('../src/analyzer/bytecode-structure')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')
const { analyzeJars } = require('../src/analyzer/mod-jar')
const { ModSupportRuntime } = require('../src/core/runtime')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')

const filesPresent = process.env.MMR_BALM_JAR && process.env.MMR_WAYSTONES_JAR
const JAR = process.env.MMR_WAYSTONES_JAR
const enumName = 'net/blay09/mods/waystones/api/WaystoneOrigin'
function classesFromJar () {
  const zip = new ZipArchive(fs.readFileSync(JAR))
  const classes = new Map()
  for (const entry of zip.names().filter(x => x.endsWith('.class'))) {
    const cls = readClass(zip.read(entry)); classes.set(cls.thisClass, cls)
  }
  return classes
}

test('new parser reports real JVM branch targets and local iinc metadata', { skip: !filesPresent }, () => {
  const classes = classesFromJar()
  const cls = classes.get('net/blay09/mods/waystones/network/message/KnownWaystonesMessage')
  const code = instructions(cls, cls.methods.find(m => m.name === 'decode'))
  assert.ok(code.some(x => x.op === 0xa7 && x.target < x.offset))
  assert.ok(code.some(x => x.op === 0x84 && x.increment === 1))
})

test('enum names and numeric ordinals follow declared fields and class initializer', { skip: !filesPresent }, () => {
  const classes = classesFromJar()
  const result = extractEnumOrdinals(classes, enumName)
  assert.equal(result.status, 'static-evidence')
  assert.deepEqual(result.values, ['UNKNOWN', 'WILDERNESS', 'DUNGEON', 'VILLAGE', 'PLAYER'])
  assert.equal(result.runtimeVerified, false)
  assert.equal(extractEnumOrdinals(classes, 'not/present').status, 'unresolved')
})

test('static structure recognizes matching producer/consumer counted loops', { skip: !filesPresent }, () => {
  const classes = classesFromJar()
  const cls = classes.get('net/blay09/mods/waystones/network/message/KnownWaystonesMessage')
  const enc = detectCountedLoop(cls, cls.methods.find(m => m.name === 'encode'), 'encode')
  const dec = detectCountedLoop(cls, cls.methods.find(m => m.name === 'decode'), 'decode')
  assert.equal(enc.status, 'counted-loop-pattern')
  assert.equal(dec.status, 'counted-loop-pattern')
  assert.equal(enc.lengthType, 'short')
  assert.equal(dec.lengthType, 'short')
  assert.equal(enc.elementOwner, dec.elementOwner)
  assert.equal(enc.runtimeVerified, false)
  assert.equal(dec.runtimeVerified, false)
})

test('new structural IR is generic and works for enum plus nested bounded list', { skip: !filesPresent }, () => {
  const report = analyzeJars([process.env.MMR_BALM_JAR, JAR])
  const regs = report.artifacts.flatMap(x => x.network.registrations)
  const update = regs.find(x => x.id === 'waystones:waystone_update').codec.inference
  const known = regs.find(x => x.id === 'waystones:known_waystones').codec.inference
  assert.equal(update.status, 'structural-candidate')
  assert.equal(known.status, 'structural-candidate')
  assert.equal(known.recognizedLists, 1)
  assert.equal(update.resolvedEnums, 1)
  assert.equal(known.executable, false)
  assert.ok(update.hints.some(x => x.kind === 'source-getter-candidate'))
  assert.ok(known.hints.some(x => x.kind === 'counted-list-structural-pattern'))
  const codec = compileCodecPlan(known.plan)
  const item = { slot_0:'12345678-1234-1234-1234-123456789abc', slot_1:'waystones:waystone', slot_2:'sample',slot_3:true,
    slot_4:'minecraft:overworld', slot_5:{x:11,y:70,z:-8}, slot_6:'PLAYER' }
  const value = {slot_0:'waystones:waystone', slot_1:[item]}
  const binary = codec.encode(value)
  assert.deepEqual(codec.encode(codec.decode(binary)), binary)
  assert.deepEqual(codec.decode(binary).slot_1[0].slot_6, 'PLAYER')
  assert.equal(report.summary.candidateCodecs, 8)
  const runtime = new ModSupportRuntime({ compatibilityManifest:createCompatibilityManifest(report) })
  assert.equal(runtime.nativeChannels.getAdvertisedChannels().some(x => x.id === 'waystones:network'),false)
  assert.equal(runtime.snapshot().compatibility.capabilities.canJoinModded, false)
  runtime.destroy()
})

test('no execution or capability advertisement when only structural evidence exists', { skip: !filesPresent }, () => {
  const report = analyzeJars([process.env.MMR_BALM_JAR, JAR])
  const comp = report.artifacts.flatMap(x=>x.network.registrations).filter(x=>x.codec.inference)
  assert.equal(comp.filter(x=>x.codec.inference.status==='structural-candidate').length,2)
  assert.ok(comp.every(x=>x.codec.inference.executable===false))
  assert.ok(comp.every(x=>x.codec.verifiedAgainstServer===false))
})

test('fail-closed: non-enum or ambiguous control-flow cannot be inferred as ordinal or list', () => {
  const fake = new Map([['example/Normal', { thisClass: 'example/Normal', access: 0, methods: [], fields: [] }]])
  assert.equal(extractEnumOrdinals(fake, 'example/Normal').status, 'unresolved')
  const cls = { thisClass: 'example/Bad', methods: [], fields: [], constant: () => null, member: () => null }
  const method = {code: Buffer.from([0x03, 0x99, 0x00, 0x06, 0x03, 0xb1, 0xb1])}
  assert.equal(detectCountedLoop(cls, method, 'decode').status, 'unresolved')
})
