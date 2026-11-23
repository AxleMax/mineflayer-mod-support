'use strict'
// Application-side helper. Install declarative-adapter.js first, and implement
// the matching protocol on your server. An accepted reply is not effect proof.
async function requestLabel(bot,label,{signal}={}){
  const requestId=require('node:crypto').randomInt(0,0x7fffffff)
  return bot.modSupport.requestModMessage('example:wire',0,{requestId,label},{responseDiscriminator:1,match:data=>data.requestId===requestId,timeoutMs:5000,signal})
}
module.exports={requestLabel}
