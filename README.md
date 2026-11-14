# SillyGirl Plugins

SillyGirl 插件集合。普通插件和共享模块均使用英文 `.js` 文件名；中文展示名写在头部 `[title: xxx]`。共享逻辑使用带 `[module: true]` 的同发布者模块，不再依赖市场外的桥接脚本。

插件按 SillyGirl 插件源结构组织：

```text
plugins/englishName.js
plugins/sharedRuntime.js
```

每个插件不单独提供 `package.json`。插件依赖写在脚本头部注释里，使用 `[depe: ...]` 声明依赖数组，例如：

```js
// [title: ipChange]
// [name: ipChange]
// [depe: ["ip"]]
```

引用同目录模块时，使用当前文档规定的相对 `.js` 路径；模块自身必须声明 `[module: true]`：

```js
// 普通插件
// [depe: ["./sharedRuntime.js", "undici"]]
const runtime = require("./sharedRuntime.js");

// sharedRuntime.js
// [module: true]
// [depe: []]
module.exports = {};
```

Action 会在提交插件后扫描静态 `require` / `import` 并回写 `[depe: ...]`：

| 插件类型 | 扫描工具        | 结果                      |
| -------- | --------------- | ------------------------- |
| NodeJS   | 内置依赖扫描器  | 写入 npm 包和 `./模块.js` |
| Python   | 内置 AST 扫描器 | 写入 `[depe: ["包名"]]`   |

`publicFileIndex.json` 同步写入 `dependencies` 数组。安装普通插件时，SillyGirl 会递归安装同发布者的模块依赖，再安装各模块及目标插件需要的 npm 包；被引用模块会受到卸载保护。

固定周期可在头部写 `[cron: ...]`；需要自定义接收平台和接收人时，在 SillyGirl 的“定时任务”页面选择对应插件和命令。

## 运行时约定

- NodeJS/Python 插件优先使用 SillyGirl 内联函数：`sender`、`Bucket`、`plugin.Form`、`user.Form`、`user`、`container`、`utils`；新增代码不要再封装重复运行时。
- Sender 消息 API 统一使用 `getMsg()`、`setMsg(content)` 和 `getMsgId()`；仓库审计会拦截已经移除的旧方法。
- 公共逻辑模块必须是同目录平铺的 `.js` 文件并声明 `[module: true]`；调用方必须在 `[depe]` 中填写完整的 `./模块名.js`，不能使用 `.cjs`、`../`、嵌套目录或跨发布者路径。
- Python 插件统一按 Python 3.12 运行时维护；不要使用 Python 3.13/3.14 专属语法或标准库 API。
- 青龙/呆呆/smallcat 容器能力走 `container` 或运行时兼容封装读取后台容器配置，不再随插件安装额外文件。
- 新增或维护插件只写 `[title: xxx]`、`[name: 文件名]`、`[rule: xxx]`、`[depe: [...]]` 这类头部注释；不再写 at 符号元数据或 param 注释。
- `[version: ...]` 固定使用 `v1.x.y` 三段版本号（例如 `v1.0.0`）；主版本固定为 `1`，`x`、`y` 只能是 `0-9`，补丁位到 `10` 时十进制进位（如 `v1.1.10` 写成 `v1.2.0`）。
- 仓库内不放私钥、WxPusher AppToken、接口签名 Token；确实需要时放到插件配置表单。
- 插件需要持久化文本、JSON、CSV 等数据时，统一写入傻妞存储桶，不直接读写本地文件。
- 插件总开关只使用头部 `[status: true|false]`；不要再用 `plugin.Form` 的通用 `enable` 字段重复控制运行状态。
- `[cron: ...]` 任务的启用状态由 SillyGirl“定时任务”页面独立保存，不与插件卡片的 `status` 共用；业务功能开关应使用含义明确的独立字段名。

## 仓库维护

```bash
npm ci
npm run format       # 统一格式化插件、脚本、测试和索引
npm run lint         # 检查死代码、不可达代码及无效转义
npm run metadata:check
npm run test:runtime # 公共运行时与京东模块回归测试
npm run verify       # 提交前完整检查
```

- 可执行插件只放在 `plugins/`。
- 索引和依赖维护程序只放在 `scripts/`。
- 不依赖真实账号的运行时回归测试统一放在 `tests/`。
- 一次性迁移清单、扫描结果和审计报告不进入源码目录。

## 插件清单

`publicFileIndex.json` 由 `scripts/generate-public-file-index.mjs` 自动生成；安装页展示中文名来自 `[title: xxx]`，文件 basename 来自 `[name: 文件名]`。仓库插件优先使用英文文件名，自建插件若已固定中文名需同步维护索引。

当前库内共 15 个文件（业务插件 + 共享模块），按作者收敛到 `sillyGirl`（含联合署名）与 `smallfawn` 署名插件，外加 `emojiChouXiangHua.js` 和自建的娱乐接口插件。

| 插件           | 文件                           | 状态 | 说明                                                           |
| -------------- | ------------------------------ | ---- | -------------------------------------------------------------- |
| 官方命令       | `plugins/guanFangMingLing.js`  | 可用 | 支持 `时间`、`版本`、`我是谁`、`更新`、`升级`、`重启`          |
| IP 变动通知    | `plugins/ipChange.js`          | 可用 | 使用傻妞存储桶保存上次 IP，直接使用 NodeJS `fetch` 查询公网 IP |
| 消息与群管理   | `plugins/xiaoXiYuQunGuanLi.js` | 可用 | 人工通知、消息推送、QQ 关联与 Vorto 入群验证                   |
| 娱乐接口合集   | `plugins/娱乐综合.js`          | 可用 | 随机小姐姐/白丝/黑丝、唱一首、疯狂星期四、抖音视频解析         |
| 京东工具       | `plugins/jingDongGongJu.js`    | 可用 | CK 去重、失效汇总、跨容器传输与任务触发                        |
| 京东 Code 登录 | `plugins/jdCodeLogin.js`       | 可用 | 使用 Code 换取京东 Cookie 并写入青龙变量                       |
| 积分卡密       | `plugins/jiFenKaMi.js`         | 可用 | 卡密系统、积分充值、支付接管与收款助手                         |
| UPS 通知       | `plugins/upsListen.js`         | 可用 | 使用 NodeJS 内置 `net` 查询 NUT 服务（默认 `status: false`）   |
| 临时邮箱       | `plugins/linShiYouXiang.js`    | 可用 | 创建 Mail.tm 临时邮箱并等待首封来信                            |
| emoji 抽象化   | `plugins/emojiChouXiangHua.js` | 可用 | 文本整段转换为 emoji 表达                                      |
| 数据迁移工具   | `plugins/shuJuQianYi.js`       | 可用 | 导出、用户桶迁移与分发接收                                     |
| 线报猴         | `plugins/xianBaoHou.js`        | 可用 | 从线报酷开放接口读取最新线报                                   |
| 携趣代理       | `plugins/xieQuDaiLi.js`        | 可用 | 代理提取、余量与公网 IP 自动加白                               |

共享模块（`[module: true]`，不可单独删除）：`jdLegacyCore`、`vortoUtils`。

## 兼容差异

SillyGirl 使用 `sender.pushAdmin(content, options)` 推送管理员；定时任务也可以继续使用 `sender.reply()`，实际投递目标取决于任务 Sender 的平台和接收人配置。

插件配置统一使用 `new plugin.Form({...})`；Home 普通用户参数使用 `new user.Form({...})`。用户表单可通过 `required/match/err` 校验、通过 `multiple/keyBy` 处理多次提交，插件使用 `user.getUserList({ withRecords: true })` 或 `user.getUser(...)` 读取当前插件的数据。
