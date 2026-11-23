'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeCodec } = require('../src/analyzer/codec-runtime')
const { analyzeJars } = require('../src/analyzer/mod-jar')

test('empty packet codec encodes and decodes zero bytes only', () => {
  const codec = makeCodec([])
  assert.equal(codec.encode({}).length, 0)
  assert.deepEqual(codec.decode(Buffer.alloc(0)), {})
  assert.throws(() => codec.decode(Buffer.from([0])), /trailing/)
})
test('two VarInts for SortWaystone support signed values', () => {
  const codec = makeCodec([{field:'index',type:'varint'}, {field:'otherIndex',type:'varint'}])
  const value = {index: 112, otherIndex: -12345}
  assert.deepEqual(codec.decode(codec.encode(value)),value)
})
test('BlockPos packs x,z,y into Java Edition 1.20.1 64-bit wire value', () => {
  const codec = makeCodec([{field:'pos', type:'blockpos'}])
  for (const pos of [{x:0,y:0,z:0},{x:-150,y:64,z:400}, {x:-33554432,y:-2048,z:33554431}, {x:33554431,y:2047,z:-33554432}]) {
    const encoded = codec.encode({pos})
    assert.equal(encoded.length,8)
    assert.deepEqual(codec.decode(encoded),{pos})
  }
  assert.throws(()=>codec.encode({pos:{x:33554432,y:1,z:0}}),/BlockPos/)
})
test('signed long encoding retains 64-bit precision', () => {
  const codec = makeCodec([{field:'timestamp',type:'long'}])
  for(const value of [0n, 9223372036854775807n, -9223372036854775808n]){
    assert.equal(codec.decode(codec.encode({timestamp:value})).timestamp,value)
  }
  assert.equal(codec.decode(codec.encode({timestamp:'-4503599627370497'})).timestamp, -4503599627370497n)
  assert.throws(()=>codec.encode({timestamp:123}),/signed 64-bit/)
})
test('ResourceLocation and short use their wire representations', () => {
  const codec = makeCodec([{field:'id',type:'resource_location'},{field:'count',type:'short'}])
  const value = {id:'waystones:waystone',count:-250}
  assert.deepEqual(codec.decode(codec.encode(value)),value)
  assert.throws(()=>codec.encode({id:'bad:name:twice',count:5}),/ResourceLocation/)
})
test('JAR fixtures: correct sync_config class and 8 candidates', { skip: !process.env.MMR_BALM_JAR || !process.env.MMR_WAYSTONES_JAR }, () => {
  const r = analyzeJars([process.env.MMR_BALM_JAR, process.env.MMR_WAYSTONES_JAR])
  assert.equal(r.summary.candidateCodecs,8)
  assert.equal(r.summary.unresolvedCodecs,4)
  const regs = r.artifacts[1].network.registrations
  const sync = regs.find(x=>x.id==='waystones:sync_config')
  assert.equal(sync.className,'net/blay09/mods/waystones/network/message/SyncWaystonesConfigMessage')
  assert.equal(sync.configClass,'net/blay09/mods/waystones/config/WaystonesConfigData')
  assert.deepEqual(regs.find(x=>x.id==='waystones:sort_waystone').codec.schema,[
    {field:'index',type:'varint'}, {field:'otherIndex',type:'varint'}
  ])
  assert.deepEqual(regs.find(x=>x.id==='waystones:inventory_button').codec.schema,[])
  assert.equal(regs.find(x=>x.id==='waystones:teleport_effect').codec.schema[0].type,'blockpos')
  assert.deepEqual(regs.filter(x=>x.numericDiscriminator !== null),[])
  assert.ok(regs.every(x => x.codec.verifiedAgainstServer !== true))
})
