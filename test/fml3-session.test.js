'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Fml3Session, analyzeP04Report } = require('../src/protocol/forge/fml3-session')
const V = n => { const b = []; do { let c = n & 127; n >>>= 7; if (n) c |= 128; b.push(c) } while (n); return Buffer.from(b) }
const S = s => Buffer.concat([V(Buffer.byteLength(s)), Buffer.from(s)])
const wrap = body => Buffer.concat([S('fml:handshake'), V(body.length), body])
const modData = wrap(Buffer.concat([Buffer.from([5]), V(2), S('minecraft'), S('Minecraft'), S('1.20.1'), S('forge'), S('Forge'), S('47.4.13')]))
const modList = wrap(Buffer.concat([Buffer.from([1]), V(2), S('minecraft'), S('forge'), V(1), S('fml:handshake'), S('FML3'), V(1), S('minecraft:item'), V(0)]))

test('FML3 session captures real-type negotiation without fake replies', () => {
  const s = new Fml3Session()
  assert.equal(s.inspectRequest({ messageId: 0, channel: 'fml:loginwrapper', payload: modData }).type, 'S2CModData')
  assert.equal(s.state, 'mod_data_received')
  assert.equal(s.inspectRequest({ messageId: 1, channel: 'fml:loginwrapper', payload: modList }).type, 'S2CModList')
  assert.equal(s.state, 'mod_list_reply_required')
  s.inspectResponse({ messageId: 0, payload: null })
  s.inspectResponse({ messageId: 1, payload: null })
  const report = s.getReport()
  assert.equal(report.forgeVersion, '47.4.13')
  assert.equal(report.handshakeComplete, false)
  assert.deepEqual(report.diagnostics.emptyResponses, [0, 1])
  assert.deepEqual(report.diagnostics.missingFromModData, [])
  assert.equal(report.server.channels[0].id, 'fml:handshake')
})

test('FML3 fails closed for malformed payloads without raw data disclosure', () => {
  const s = new Fml3Session()
  const x = s.inspectRequest({ messageId: 0, channel: 'fml:loginwrapper', payload: Buffer.from([0xff]) })
  assert.equal(x.parsed, false)
  assert.equal(s.state, 'inspection_error')
  assert.equal(s.getReport().diagnostics.warnings.length, 1)
})

test('FML3 marks out-of-order handshake and duplicate request IDs', () => {
  const s = new Fml3Session()
  s.inspectRequest({ messageId: 1, channel: 'fml:loginwrapper', payload: modList })
  s.inspectRequest({ messageId: 1, channel: 'fml:loginwrapper', payload: modData })
  assert(s.getReport().diagnostics.warnings.includes('mod_list_before_mod_data'))
  assert(s.getReport().diagnostics.warnings.includes('duplicate_request_id:1'))
})

test('analyzes an existing P0.4 report without network access', () => {
  const report = { schema:'mineflayer-mod-support/forge-p0-fml3-inspect/v1', settings:{minecraftVersion:'1.20.1'}, evidence:{status:{versionName:'mohist 1.20.1'}, fmlHandshake:[
    {messageId:0,parsed:true,outerChannel:'fml:handshake',trailingBytes:0,type:'S2CModData',details:{mods:[{id:'forge',name:'Forge',version:'47.4.13'}]}},
    {messageId:1,parsed:true,outerChannel:'fml:handshake',trailingBytes:0,type:'S2CModList',details:{modIds:['forge'],channels:[{id:'fml:handshake',version:'FML3'}],registries:['minecraft:item'],dataPackRegistries:[]}}
  ],loginPluginMessages:[{direction:'outbound',packetName:'login_plugin_response',messageId:1,hasPayload:false}]},outcome:{reachedPlay:false} }
  const r = analyzeP04Report(report)
  assert.equal(r.schema, 'mineflayer-mod-support/fml3-negotiation-analysis/v1')
  assert.equal(r.negotiation.state,'mod_list_reply_required')
  assert.deepEqual(r.negotiation.diagnostics.emptyResponses,[1])
  assert.equal(r.negotiation.server.registries.length,1)
})

test('rejects unsupported file schema', () => {
  assert.throws(() => analyzeP04Report({ schema:'other' }), /unsupported_report_schema/)
})

test('runtime records FML3 requests and empty replies without sending fabricated ones', () => {
  const { ModSupportRuntime } = require('../src/core/runtime')
  const runtime = new ModSupportRuntime()
  runtime.captureInboundPacket({ messageId: 0, channel: 'fml:loginwrapper', data: modData }, { name: 'login_plugin_request', state: 'login' })
  runtime.captureInboundPacket({ messageId: 1, channel: 'fml:loginwrapper', data: modList }, { name: 'login_plugin_request', state: 'login' })
  runtime.client = { state: 'login' }
  runtime.captureOutbound('write', ['login_plugin_response', { messageId: 0, data: null }])
  runtime.captureOutbound('write', ['login_plugin_response', { messageId: 1, data: null }])
  const snap = runtime.snapshot()
  assert.equal(snap.loader.name, 'forge')
  assert.equal(snap.loader.version, '47.4.13')
  assert.equal(snap.fml3.state, 'mod_list_reply_required')
  assert.deepEqual(snap.fml3.diagnostics.emptyResponses, [0, 1])
  runtime.destroy()
})
