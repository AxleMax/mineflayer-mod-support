# Mineflayer Mod Support

[English](README.md) | [简体中文](README.zh-CN.md)

Mineflayer Mod Support 是一个轻量级、纯 Node.js 的模组协议与交互兼容层。它通过动态数据发现、协议解析和按需行为适配，让 Mineflayer 尽可能直接操作 Forge、NeoForge、Fabric 服务器中的模组内容，而不依赖完整 Mod 客户端。

**当前已实现并验证：Forge FML3 / Minecraft Java 1.20.1。** NeoForge 和 Fabric 是扩展方向，**尚未实现对应加载器**。本项目仍是实验性的兼容层，不是通用 Mod 客户端，也不提供 Java 执行环境。

## 安装

需要 Node.js 22 或更高版本。可直接从 GitHub 安装，无需等待 npm 仓库发布：

```powershell
npm install mineflayer@4.39.0 minecraft-protocol@1.68.0 github:AxleMax/mineflayer-mod-support#main
```

开发环境：

```powershell
git clone https://github.com/AxleMax/mineflayer-mod-support.git
cd mineflayer-mod-support
npm ci
npm run check
npm test
npm run typecheck
```

## 运行普通 Mineflayer Bot

```js
const mineflayer = require('mineflayer')
const modSupport = require('mineflayer-mod-support')

const bot = modSupport.createBot(mineflayer, {
  host: '127.0.0.1', port: 25565,
  username: 'ModSupportBot', version: '1.20.1', auth: 'offline',
  modSupport: {
    // 可选：读取本地 JAR 的元数据与协议结构，不执行 Java。
    ...(process.env.MC_MODS_DIR ? { modsDir: process.env.MC_MODS_DIR } : {}),
    experimental: { forgeFml3Marker: true, fml3Runtime: true, nativeTierChannel: true }
  }
})

bot.once('spawn', () => {
  console.log(bot.modSupport.getCapabilities())
  console.log(bot.inventory.items()) // ItemStack 名称、数量、NBT
  // 使用原生 bot.equip、bot.toss、bot.activateBlock、bot.closeWindow 等 API。
})
bot.modSupport.on('packetDecodeFailure', failure => console.error(failure))
bot.on('error', error => console.error(error.message))
bot.on('end', () => bot.modSupport.destroy())
```

使用 `createBot`，确保兼容逻辑在 **Forge 握手开始前**生效。连接开始后再通过 `bot.loadPlugin` 注入，无法补回已经交换的报文。

`auth: 'offline'` 用于离线认证测试服务器；连接其他服务器时，请按正常 Mineflayer 方式配置认证。本插件不会绕过登录认证。

在仓库目录执行 `npm run example`，会运行 [basic-bot.js](examples/basic-bot.js)，保持在线，按 Ctrl+C 退出。请自行启动服务端；示例不会启动、停止或重启 Mohist。

## 自动覆盖能力与边界

| 能力 | 范围 |
| --- | --- |
| Forge 通道协商 | 以服务端声明补齐本地发现，这一步不要求本地 JAR |
| 注册表身份 | 获取服务端 item/entity/block/menu 名称和 ID；向每个 Bot 独立投影 item/entity 类型 |
| 可获得的内容数据 | 保留 ItemStack、NBT、数量及经过确认的显式数据，不伪造状态 ID 或碰撞形状 |
| 协议发现 | 对已覆盖的标准入口使用可复用静态规则，结构候选仍作为候选报告 |
| 原生交互 | 由 Mineflayer 执行操作；目标容器布局和自定义协议可能需要 adapter |
| 私有协议扩展 | 支持声明式消息、显式编解码器、作用域生命周期、服务端条件匹配和回放 |
| 任意 Mod payload/配方 | **不承诺通用支持**，未知私有 serializer 仍属于数据缺口 |
| Java Mod 行为和渲染 | **不执行、不模拟** |

通道存在不等于消息能够解析、Java Mod 已执行或行为已经实现。复杂私有配方格式可能导致整张配方同步包无法完整交付；插件会报告错误，不猜测条目边界或伪造成功。

不承诺自动重建所有全局 BlockState/碰撞数据、任意自定义实体语义或特殊容器点击规则。

## 低成本扩展私有协议

adapter 可以是普通本地模块，也可以作为独立 npm 包维护：

```js
module.exports = {
  id: 'my-protocol', apiVersion: 1,
  loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'],
  matches: { channels: { 'example:wire': '1' } },
  setup(ctx) {
    ctx.registerChannel({
      id: 'example:wire', version: '1',
      messages: [{
        name: 'setLabel', discriminator: 0, direction: 'serverbound',
        schema: { type: 'struct', fields: [
          { name: 'entityId', codec: { type: 'int' } },
          { name: 'label', codec: { type: 'utf' } }
        ] }
      }]
    })
  }
}
```

`example:wire` 仅为示例协议，不表示你的服务器已有该通道。通过 `modSupport: { adapters: [require('./my-adapter')] }` 安装。adapter 会等待匹配的服务端声明，不分配服务器 ID，也不声明已经运行 Java Mod。目标协议和 PLAY 通道就绪后才能发送：

```js
const receipt = bot.modSupport.sendModMessage('example:wire', 0, {
  entityId: target.id, label: 'New label'
})
// receipt.serverConfirmed 为 false；实际操作结果需要单独确认。
```

详细文档目前以英文提供：[adapter 开发](docs/ADAPTERS.md)、[schema 与回放](docs/SCHEMAS.md)、[API 与架构](docs/API.md)、[验证结果与限制](docs/VALIDATION.md)。

## adapter 工具

```powershell
npx mms-adapter draft --mods ./mods --out ./my-adapter.cjs
npx mms-adapter replay --adapter ./my-adapter.cjs --capture ./capture.json --out ./replay-result.json
```

生成的草稿默认不能启用，必须先审查；缺失的 schema 仍保持未解析状态。回放会检查完整样本解码及逐字节重新编码，不等于实际服务端行为测试。

工具不会覆盖已有输出文件。原始抓包可能包含私有数据，adapter 是可执行代码：只加载可信模块，服务端原始资料请保留在本地。

## 开发边界

核心负责公共协议机制、发现与数据投影；adapter 补充私有格式；原生 Mineflayer 和业务程序执行操作。不新增第二套装备、放置或容器操作 API，不执行 Java，不以支持所有私有配方作为完成条件。基础联机、数据完整性、显式适配与实际服务端效果分别验收。

欢迎在上述边界内贡献，参见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目采用 MIT 许可证。仓库不分发第三方 Mod JAR、世界、玩家数据或本地开发历史。
