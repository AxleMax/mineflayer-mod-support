'use strict'
const { WireReader }=require('./wire')
const { menuLayout }=require('../../runtime/menu-rules')
function decodeOpenContainer(payload){
  const r=new WireReader(payload),menuId=r.varInt(),windowId=r.varInt(),title=r.string(262144)
  JSON.parse(title)
  const size=r.varInt();if(size>32600)throw new Error('forge_container_extra_data_limit')
  const additionalData=Buffer.from(r.bytes(size));r.end();return {menuId,windowId,title,additionalData}
}
class ForgeContainerBridge {
  constructor(runtime){this.runtime=runtime;this.current=null;this.opened=0;this.projected=0;this.rejected=0;this.listeners=[]}
  attachClient(client){
    this.detach()
    // Mods may use vanilla OpenScreen instead of NetworkHooks.openScreen.
    // Resolve its synced menu ID before Mineflayer's named-event listener runs.
    const originalEmit=client.emit,bridge=this
    const emit=function(name,...args){
      if(name==='open_window'&&Number.isInteger(args[0]?.inventoryType)){
        const packet=bridge.standardOpen(args[0])
        if(!packet)return true // Preserved as an explicit read-only container observation.
        args[0]=packet
      }
      return originalEmit.call(this,name,...args)
    }
    client.emit=emit
    this.restoreEmit=()=>{if(client.emit===emit)client.emit=originalEmit}
    const listen=(event,fn)=>{client.on(event,fn);this.listeners.push([client,event,fn])}
    listen('window_items',packet=>{
      if(!this.current||this.current.windowId!==packet.windowId)return
      const Item=require('prismarine-item')(this.runtime.bot.registry)
      this.current.items=packet.items.map(raw=>{const item=Item.fromNotch(raw);return item?{type:item.type,name:item.name||null,count:item.count,metadata:item.metadata,nbt:structuredClone(item.nbt)}:null})
      this.current.stateId=packet.stateId;this.runtime.emit('forgeContainerContents',this.getCurrent())
    })
    listen('set_slot',packet=>{
      if(!this.current||this.current.windowId!==packet.windowId||packet.slot<0)return
      const Item=require('prismarine-item')(this.runtime.bot.registry),item=Item.fromNotch(packet.item)
      this.current.items ||= [];this.current.items[packet.slot]=item?{type:item.type,name:item.name||null,count:item.count,metadata:item.metadata,nbt:structuredClone(item.nbt)}:null
      this.current.stateId=packet.stateId
    })
    for(const event of ['login','respawn','end'])listen(event,()=>{this.current=null})
    listen('close_window',p=>{if(p.windowId===this.current?.windowId)this.current=null})
    const onOutgoing=packet=>{if(packet.name==='close_window'&&packet.data?.windowId===this.current?.windowId)this.current=null}
    this.runtime.on('outgoingPacket',onOutgoing);this.listeners.push([this.runtime,'outgoingPacket',onOutgoing])
  }
  standardOpen(packet){
    const menuId=packet.inventoryType,menu=this.runtime.registryMappings.getName('minecraft:menu',menuId)
    if(!menu&&!this.runtime.registryMappings.getEntries('minecraft:menu'))return packet
    if(!menu){this.rejected++;this.runtime.emit('forgeContainerError',{reason:'container_menu_not_registered:'+menuId,transport:'minecraft:open_window'})}
    const windows=require('prismarine-windows')(this.runtime.bot.registry)
    const nativeLayout=Boolean(menu?.startsWith('minecraft:')&&Object.hasOwn(windows.windows,menu))
    const definition=this.runtime.contentDefinitions?.get('menu',menu),projectable=Boolean(nativeLayout||definition)
    this.current={menuId,menu,windowId:packet.windowId,title:packet.windowTitle,additionalData:Buffer.alloc(0),slotLayoutKnown:projectable,readOnly:!projectable,layoutSource:nativeLayout?'prismarine-windows':definition?.source||null,items:[],transport:'minecraft:open_window'}
    this.opened++
    if(projectable)this.projected++
    else if(this.runtime.bot.currentWindow){const previous=this.runtime.bot.currentWindow;this.runtime.bot.currentWindow=null;this.runtime.bot.emit('windowClose',previous)}
    this.runtime.emit('forgeContainerOpened',this.getCurrent())
    if(!projectable)return null
    return {...packet,inventoryType:menu,...(nativeLayout?{}:{slotCount:Math.max(0,menuLayout(definition.data).slots-36)})}
  }
  observe(event){
    if(event?.channel!=='fml:play'||event.phase!=='play'||event.direction!=='inbound'||event.data?.[0]!==1)return {status:'ignored'}
    try{
      if(this.runtime.client?.version!=='1.20.1')throw new Error('unsupported_container_protocol_version')
      const {menuId,windowId,title,additionalData}=decodeOpenContainer(event.data.subarray(1))
      const menu=this.runtime.registryMappings.getName('minecraft:menu',menuId)
      if(!menu)throw new Error('forge_container_menu_not_registered:'+menuId)
      const windows=require('prismarine-windows')(this.runtime.bot.registry)
      const nativeLayout=menu.startsWith('minecraft:')&&Object.hasOwn(windows.windows,menu)
      const definition=this.runtime.contentDefinitions?.get('menu',menu)
      const projectable=Boolean(nativeLayout||definition)
      this.current={menuId,menu,windowId,title,additionalData,slotLayoutKnown:projectable,readOnly:!projectable,layoutSource:nativeLayout?'prismarine-windows':definition?.source||null,items:[]}
      this.opened++
      if(projectable){this.runtime.client.emit('open_window',{windowId,inventoryType:menu,windowTitle:title,...(nativeLayout?{}:{slotCount:Math.max(0,menuLayout(definition.data).slots-36)})});this.projected++}
      else if(this.runtime.bot.currentWindow){const previous=this.runtime.bot.currentWindow;this.runtime.bot.currentWindow=null;this.runtime.bot.emit('windowClose',previous)}
      this.runtime.emit('forgeContainerOpened',this.getCurrent())
      return {status:projectable?'handled':'envelope-only',menu,windowId,slotLayoutKnown:projectable}
    }catch(error){this.rejected++;this.runtime.emit('forgeContainerError',{reason:error.message});return {status:'rejected',reason:error.message}}
  }
  getCurrent(){return this.current?structuredClone(this.current):null}
  getReport(){const current=this.getCurrent();if(current){current.additionalBytes=current.additionalData.length;delete current.additionalData;current.itemSlots=current.items.length;delete current.items}return {opened:this.opened,projected:this.projected,rejected:this.rejected,current}}
  detach(){this.restoreEmit?.();this.restoreEmit=null;for(const [client,event,fn]of this.listeners)client.removeListener(event,fn);this.listeners=[];this.current=null}
  destroy(){this.detach()}
}
module.exports={decodeOpenContainer,ForgeContainerBridge}
