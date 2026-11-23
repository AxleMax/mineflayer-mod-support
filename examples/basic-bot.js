'use strict'
const mineflayer=require('mineflayer'),modSupport=require('..')
const bot=modSupport.createBot(mineflayer,{
  host:process.env.MC_HOST||'127.0.0.1',port:25565,
  username:process.env.MC_USERNAME||'ModSupportBot',version:'1.20.1',auth:'offline',
  modSupport:{
    ...(process.env.MC_MODS_DIR?{modsDir:process.env.MC_MODS_DIR}:{}),
    experimental:{forgeFml3Marker:true,fml3Runtime:true,nativeTierChannel:true}
  }
})
bot.once('spawn',()=>{
  console.log('Spawned. Native Mineflayer owns gameplay; Ctrl+C quits.')
  console.log(JSON.stringify(bot.modSupport.getCapabilities(),null,2))
  // Use bot.inventory.items(), bot.equip(), bot.activateBlock(), bot.closeWindow(), etc.
})
bot.modSupport.on('packetDecodeFailure',failure=>console.error('Incomplete synchronization:',failure))
bot.on('error',error=>console.error(error.message))
bot.on('kicked',reason=>console.error('Kicked:',reason))
bot.on('end',reason=>{console.log('Ended:',reason);bot.modSupport.destroy()})
process.once('SIGINT',()=>bot.quit('user quit'))
