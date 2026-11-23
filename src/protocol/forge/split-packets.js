'use strict'
// Forge 1.20.1 VanillaPacketSplitter: FIRST=1 (packet ID + bytes),
// MIDDLE=0 (bytes), LAST=2 (bytes). Re-enter NMP's existing packet pipeline.
class ForgeSplitRuntime {
  constructor(runtime,{maxBytes=16*1024*1024,timeoutMs=30000}={}) {
    this.runtime=runtime;this.maxBytes=maxBytes;this.timeoutMs=timeoutMs;this.parts=[];this.bytes=0;this.timer=null
    this.counts={fragments:0,reassembled:0,rejected:0,expired:0};this.failures=[]
    this.ended=false;this.onEnd=()=>{this.ended=true;this.reset()};runtime.on('end',this.onEnd)
  }
  reset(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.parts=[];this.bytes=0}
  failure(reason){this.counts.rejected++;this.failures.push(reason);if(this.failures.length>16)this.failures.shift();this.runtime.emit('forgeSplitError',{reason});return {status:'rejected',reason}}
  observe(event){
    if(this.ended||event?.channel!=='forge:split'||event.direction!=='inbound'||event.phase!=='play')return {status:'ignored'}
    try{
      if(this.runtime.client?.version!=='1.20.1')throw new Error('unsupported_split_protocol_version')
      const data=event.data
      if(!Buffer.isBuffer(data)||data.length<2||data.length>1048576)throw new Error('invalid_split_fragment_size')
      const state=data[0];if(![0,1,2].includes(state))throw new Error('invalid_split_state')
      if(state===1){
        if(this.parts.length)this.failure('split_first_replaces_incomplete_packet')
        this.reset();this.timer=setTimeout(()=>{this.counts.expired++;this.failure('split_timeout');this.reset()},this.timeoutMs);this.timer.unref?.()
      }else if(!this.parts.length)throw new Error('split_fragment_without_first')
      if(this.bytes+data.length-1>this.maxBytes||this.parts.length>=1024)throw new Error('split_packet_limit')
      this.parts.push(Buffer.from(data.subarray(1)));this.bytes+=data.length-1;this.counts.fragments++
      if(state!==2)return {status:'buffered',bytes:this.bytes}
      const packet=Buffer.concat(this.parts,this.bytes);this.reset()
      const parser=this.runtime.client.deserializer
      if(!parser||typeof parser.write!=='function')throw new Error('split_packet_parser_unavailable')
      // No socket writes, no synthetic server responses. FullPacketParser
      // accepts decompressed packet-ID-prefixed bytes, without a frame length.
      parser.write(packet);this.counts.reassembled++
      this.runtime.emit('forgeSplitPacketReassembled',{bytes:packet.length})
      return {status:'reassembled',bytes:packet.length}
    }catch(error){this.reset();return this.failure(error.message)}
  }
  getReport(){return {...this.counts,pendingBytes:this.bytes,pendingFragments:this.parts.length,maxBytes:this.maxBytes,failures:[...this.failures]}}
  destroy(){this.ended=true;this.reset();this.runtime.removeListener('end',this.onEnd)}
}
module.exports={ForgeSplitRuntime}
