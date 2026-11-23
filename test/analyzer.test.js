'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { ZipArchive } = require('../src/analyzer/zip')
const { parseToml, analyzeJars } = require('../src/analyzer/mod-jar')
const { makeCodec } = require('../src/analyzer/codec-runtime')

function demoZip () {
  const file = Buffer.from('a.txt'); const data = Buffer.from('hi')
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(file.length,26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50,0); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(file.length,28)
  const localEntry = Buffer.concat([local,file,data]); const centralEntry = Buffer.concat([central,file]); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(centralEntry.length,12); end.writeUInt32LE(localEntry.length,16)
  return Buffer.concat([localEntry,centralEntry,end])
}
test('zero-dependency ZIP parser reads deflate-free ZIP', () => {
  const archive = new ZipArchive(demoZip())
  assert.deepEqual(archive.names(), ['a.txt'])
  assert.equal(archive.read('a.txt').toString(), 'hi')
})
test('Forge TOML extracts mods and mandatory dependencies', () => {
  const parsed = parseToml('[[mods]]\nmodId="waystones"\nversion="14.1.21"\n[[dependencies.waystones]]\nmodId="balm"\nmandatory=true\nversionRange="[7.3.28,)"')
  assert.equal(parsed.mods[0].modId, 'waystones')
  assert.equal(parsed.deps[0].mandatory, true)
})
test('candidate codec UUID/UTF/boolean roundtrip', () => {
  const c = makeCodec([{field:'waystoneUid',type:'uuid'},{field:'name',type:'utf'},{field:'isGlobal',type:'boolean'}])
  const value = {waystoneUid:'123e4567-e89b-12d3-a456-426614174000',name:'Waystone 测试',isGlobal:true}
  assert.deepEqual(c.decode(c.encode(value)), value)
})
test('decoder rejects unexpected trailing bytes', () => {
  const c = makeCodec([{field:'isGlobal',type:'boolean'}])
  assert.throws(() => c.decode(Buffer.from([1,2])), /trailing/)
})
test('codec rejects malformed UUID and overlong string', () => {
  const c = makeCodec([{field:'waystoneUid',type:'uuid'},{field:'name',type:'utf'}])
  assert.throws(() => c.encode({waystoneUid:'bad',name:'x'}), /UUID/)
  assert.throws(() => c.encode({waystoneUid:'123e4567-e89b-12d3-a456-426614174000',name:'x'.repeat(32768)}), /long/)
})
test('forge JARs are parsed read-only when fixture paths provided', { skip: !process.env.MMR_BALM_JAR || !process.env.MMR_WAYSTONES_JAR }, () => {
  const r=analyzeJars([process.env.MMR_BALM_JAR,process.env.MMR_WAYSTONES_JAR])
  assert.deepEqual(r.summary.topLevelJars,2)
  assert.equal(r.summary.nestedJars,1)
  assert.equal(r.summary.discoveredMods,3)
  assert.equal(r.artifacts[1].network.registrations.length,11)
  const edit = r.artifacts[1].network.registrations.find(x=>x.id==='waystones:edit_waystone')
  assert.equal(edit.codec.status,'candidate-codec')
  assert.deepEqual(edit.codec.schema.map(x=>x.type), ['uuid','utf','boolean'])
  const sync=r.artifacts[1].network.registrations.find(x=>x.id==='waystones:sync_config')
  assert.equal(sync.kind,'sync-config')
})
