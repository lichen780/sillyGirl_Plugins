// [title: 邮件转发]
// [name: 邮件转发]
// [desc: 通过 IMAP 拉取当天邮件，按自定义消息模板转发「标题 / 接收时间 / 发件人 / 正文摘要 / 附件」，模板用 [@邮件标题] 这类占位符；按接收时间判断今天；关键词可匹配标题、正文、发件人（别名和邮箱）；只有精确「读取邮箱测试」走测试模式；手动和 Pro 定时任务触发口令通用]
// [version: v1.3]
// [author: 黎尘]
// [class: 工具]
// [rule: raw ^(读取邮箱|读取邮箱测试)$]
// [status: true]
// [depe: ["imapflow", "mailparser"]]

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const { sender: s, Bucket, plugin, Adapter } = require("sillygirl");

// 去重 / 初始化状态：一个插件一个桶
const store = Bucket("邮件转发");

// 配置表单必须在顶层构造，后台「插件设置」才会出现表单（见手册 7.4）
const config = new plugin.Form({
  imapHost: plugin.Form.string()
    .title("IMAP 服务器")
    .description("例如 imap.qq.com、imap.163.com、imap.gmail.com")
    .default(""),
  imapPort: plugin.Form.integer()
    .title("IMAP 端口")
    .description("SSL 一般为 993，STARTTLS 一般为 143")
    .default(993),
  imapSecure: plugin.Form.boolean().title("使用 SSL").default(true),
  imapUser: plugin.Form.string().title("邮箱账号").default(""),
  imapPass: plugin.Form.string()
    .title("邮箱密码 / 授权码")
    .description("QQ / 163 等邮箱必须填「授权码」，不是登录密码")
    .format("password")
    .default(""),
  mailbox: plugin.Form.string()
    .title("邮件文件夹")
    .description("一般是 INBOX")
    .default("INBOX"),
  markSeen: plugin.Form.boolean()
    .title("转发后标记为已读")
    .default(true),
  subjectKeyword: plugin.Form.string()
    .title("关键词过滤")
    .description(
      "留空表示不过滤；多个关键词用逗号分隔。标题、正文、发件人（显示名和邮箱）任意一处包含任意一个关键词才转发",
    )
    .default(""),
  fromAllow: plugin.Form.string()
    .title("发件人白名单")
    .description("留空表示不限制；可填完整邮箱或域名（如 qq.com），逗号分隔。关键词过滤和本白名单是「同时满足」关系")
    .default(""),
  maxBodyChars: plugin.Form.integer()
    .title("正文最大字符数")
    .description("邮件内容只显示前 N 个字，默认 50，超出用 … 结尾")
    .min(10)
    .max(20000)
    .default(50),
  messageTemplate: plugin.Form.string()
    .title("消息模板")
    .description(
      "自定义转发消息的文字、字段顺序和保留哪些字段。占位符会被替换成邮件数据：\n" +
        "[@邮件标题] 邮件标题\n" +
        "[@接收时间] 邮件接收时间\n" +
        "[@发件人] 发件人（显示名 + 邮箱）\n" +
        "[@邮件内容] 正文摘要\n" +
        "不写的字段就不显示；前面的「标题：」「人：」等文字可以随便改。附件单独发送，由下面「发送附件」开关控制",
    )
    .format("textarea")
    .default("邮件标题：[@邮件标题]\n发件人：[@发件人]\n邮件内容：[@邮件内容]"),
  showAttachments: plugin.Form.boolean()
    .title("发送附件")
    .description("关闭后不保存、也不发送附件，只发模板里的文字")
    .default(true),
  chunkSize: plugin.Form.integer()
    .title("单条消息最大字符数")
    .description("超长正文会拆成多条发送；建议 1000~1500")
    .min(200)
    .max(4000)
    .default(1200),
  maxAttachMB: plugin.Form.integer()
    .title("单个附件最大 MB")
    .description("超过限制的附件直接跳过，只在服务日志里记一行，不打断消息")
    .min(1)
    .max(100)
    .default(10),
  skipInline: plugin.Form.boolean()
    .title("跳过正文内嵌图片")
    .description("默认开启：正文里的签名图、统计像素、图文邮件配图不算附件；如果发现真附件被漏掉就关掉")
    .default(true),
  attachDir: plugin.Form.string()
    .title("附件保存目录")
    .description("相对路径基于 <数据目录>/plugins；也可写绝对路径")
    .default("email-forward-files"),
  keepAttachments: plugin.Form.boolean()
    .title("发送后保留附件文件")
    .description("默认关闭：消息发出去就删本地附件；只有平台需要延迟抓取 url= 时才打开")
    .default(false),
  cleanupDelaySec: plugin.Form.integer()
    .title("附件删除延迟（秒）")
    .description(
      "发送完成后等待多少秒再清空附件目录；默认 30 秒。0 = 立即删除（可能被 helper 的异步上传抢先，导致附件变成 [文件] 文件名），建议 30~60",
    )
    .min(0)
    .max(86400)
    .default(30),
  publicBaseUrl: plugin.Form.string()
    .title("附件公网地址前缀")
    .description("填写后附件改用 url= 形式（QQ 官方等需要公网可访问）；留空则用本地 file= 形式")
    .default(""),
  pushTargets: plugin.Form.string()
    .title("定时推送目标")
    .description(
      "一行一个，多个用逗号或换行隔开，每条都必须带 #平台（不写平台的条目会被跳过并写服务日志）：\n" +
        "· 私聊：123456789#telegram；同一平台多个用 & 连：464646&4546546#qq\n" +
        "· 群：群:889900&998877#qq（必须同时在群白名单里；白名单里登记过的群号也可以省掉「群:」）\n" +
        "· 留空则推给各平台管理员",
    )
    .format("textarea")
    .default(""),
  allowGroups: plugin.Form.string()
    .title("群白名单")
    .description(
      "哪些群能用这个插件，一行一个，格式「群号#平台」，例如 889900#qq、-1001234567#telegram；多个群用 & 连：889900&998877#qq。\n" +
        "只写群号=任何平台都放行。私聊不受限制；留空=所有群都拒绝。关键词触发、定时推送群、定时任务接收群都按它把关",
    )
    .format("textarea")
    .default(""),
  adminOnly: plugin.Form.boolean()
    .title("指令仅管理员可用")
    .description(
      "打开后，只有管理员（后台「管理员」页面里登记的人）发「读取邮件」才有反应；其他人私聊、群聊一律拒绝。\n" +
        "定时推送不受这个开关影响。建议对陌生人开放的机器人打开",
    )
    .default(true),
  retainDays: plugin.Form.integer()
    .title("去重记录保留天数")
    .description("只用来清理「已转发」的去重记录；同一封邮件不会重复转发，设小了顶多查得多一点")
    .min(1)
    .max(365)
    .default(30),
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errText(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function str(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

// 逗号 / 分号 / 空白 / 换行分隔的列表
function parseList(value) {
  return str(value)
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 带平台的 ID 列表，一行一个，格式「ID#平台」（也兼容老写法「平台:ID」）：
//   889900#qq             群号/用户号 + 平台
//   464646&4546546#qq     同一个平台的多个目标用 & 连起来
//   群:889900&998877#qq    明确这是群（QQ 上光看号码分不出用户和群，必须能标）
//   私:889900#qq           明确这是私聊
// 平台名只认字母数字下划线开头，所以 ID 里带冒号也不会被误判成平台。
// 没写平台时 platform 为空：推送目标会被跳过（不猜平台），群白名单则按“任何平台都放行”处理。
function parseEntries(value) {
  const list = [];
  for (const raw of str(value).split(/[\r\n,;，；]+/)) {
    let text = raw.trim();
    if (!text || text.startsWith("#")) continue;

    let role = "";
    const roleMatch = text.match(/^(群|私聊|私|用户|好友)\s*[:：]\s*/);
    if (roleMatch) {
      role = roleMatch[1] === "群" ? "chat" : "user";
      text = text.slice(roleMatch[0].length).trim();
    }

    let platform = "";
    const hash = text.lastIndexOf("#");
    if (hash > 0) {
      const tail = text.slice(hash + 1).trim().toLowerCase();
      if (/^[a-z][a-z0-9_-]*$/.test(tail)) {
        platform = tail;
        text = text.slice(0, hash).trim();
      }
    } else {
      // 老写法 平台:ID
      const at = text.indexOf(":");
      if (at > 0) {
        const head = text.slice(0, at).trim().toLowerCase();
        if (/^[a-z][a-z0-9_-]*$/.test(head)) {
          platform = head;
          text = text.slice(at + 1).trim();
        }
      }
    }

    // 同一平台的多个目标用 & 连起来
    for (const part of text.split(/[&＆]/)) {
      const id = part.trim();
      if (!id) continue;
      if (list.some((item) => item.platform === platform && item.id === id && item.role === role)) {
        continue;
      }
      list.push({ platform, id, role });
    }
  }
  return list;
}

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// 本地时间 YYYY-MM-DD HH:mm:ss
function stamp(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return (
    `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ` +
    `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`
  );
}

function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// 邮件里的方括号是别人给的，[CQ:xxx] 会被平台当真指令执行（比如 @全体），先拆掉
function neutralizeCQ(text) {
  return str(text).replace(/\[(?=cq:)/gi, "［");
}

function cleanSubject(value) {
  return neutralizeCQ(str(value).replace(/\s+/g, " ").slice(0, 200));
}

// 有显示名时输出「显示名 <邮箱>」，没有显示名时只输出邮箱。
// imapflow 的 envelope.from 是数组，mailparser 的 parsed.from 是 { value: [...] }，
// 两种都要认，否则发件人白名单会把所有邮件都当成“空的发件人”过滤掉。
function formatFrom(from) {
  let list = [];
  if (Array.isArray(from)) list = from;
  else if (from && Array.isArray(from.value)) list = from.value;
  const first = list.find((item) => item && str(item.address));
  if (first) {
    const address = str(first.address).trim();
    const name = str(first.name).trim();
    if (name && name !== address) return `${name} <${address}>`;
    return address;
  }
  const text = str(from && from.text).trim();
  if (!text) return "";
  // 没有结构化数据时，from.text 通常已经是「显示名 <邮箱>」，原样保留
  return text;
}

// HTML 邮件退化成纯文本
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bodyText(parsed) {
  const text = str(parsed && parsed.text);
  if (text) return text;
  return htmlToText(parsed && parsed.html);
}

// 邮件内容只保留一行，超出字数用 … 结尾
function limitText(text, max) {
  const value = str(text).replace(/\s+/g, " ");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

// 按行拆分成多条消息，避免单条超长被平台截断
function splitText(text, size) {
  const limit = Math.max(200, Number(size) || 1200);
  const chunks = [];
  let current = "";
  for (const line of String(text === undefined || text === null ? "" : text).split("\n")) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((item) => item.trim() !== "");
}

// CQ 码参数里逗号 / 方括号 / 换行都会截断参数，按 CQHTTP 约定转成实体，
// 这样文件名原样保留（适配器侧会把这些实体还原）
function escapeCQ(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

function safeFileName(name, index) {
  const fallback = `attachment-${index + 1}.bin`;
  const raw = str(name) || fallback;
  // 文件名还要落到磁盘，只去掉 Windows 不允许的字符与控制符
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  const text = cleaned || fallback;
  if (text.length <= 80) return text;
  // 太长时保住扩展名
  const dot = text.lastIndexOf(".");
  const ext = dot > 0 && text.length - dot <= 12 ? text.slice(dot) : "";
  return text.slice(0, 80 - ext.length) + ext;
}

// ---------------------------------------------------------------------------
// 配置读取（把后台表单值归一化成运行时对象）
// ---------------------------------------------------------------------------

async function loadConfig() {
  const values = (await config.get()) || {};
  const number = (value, fallback) => {
    if (value === undefined || value === null || str(value).trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const boolean = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on"].includes(str(value).toLowerCase());
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  return {
    host: str(values.imapHost),
    port: number(values.imapPort, 993),
    secure: boolean(values.imapSecure, true),
    user: str(values.imapUser),
    pass: str(values.imapPass),
    mailbox: str(values.mailbox) || "INBOX",
    markSeen: boolean(values.markSeen, true),
    subjectKeywords: parseList(values.subjectKeyword).map((item) => item.toLowerCase()),
    fromAllow: parseList(values.fromAllow).map((item) => item.toLowerCase()),
    maxBody: clamp(number(values.maxBodyChars, 50), 10, 20000),
    messageTemplate: str(values.messageTemplate) ||
      "邮件标题：[@邮件标题]\n发件人：[@发件人]\n邮件内容：[@邮件内容]",
    showAttachments: boolean(values.showAttachments, true),
    chunk: clamp(number(values.chunkSize, 1200), 200, 4000),
    maxAttachMB: clamp(number(values.maxAttachMB, 10), 1, 100),
    skipInline: boolean(values.skipInline, true),
    attachDir: str(values.attachDir) || "email-forward-files",
    keepAttachments: boolean(values.keepAttachments, false),
    cleanupDelaySec: clamp(number(values.cleanupDelaySec, 30), 0, 86400),
    publicBaseUrl: str(values.publicBaseUrl).replace(/\/+$/, ""),
    allowGroups: parseEntries(values.allowGroups),
    adminOnly: boolean(values.adminOnly, true),
    pushTargets: parseEntries(values.pushTargets),
    dedupeKey: `mail-forward-v2|${str(values.imapUser)}|${str(values.mailbox) || "INBOX"}`,
    retainDays: clamp(number(values.retainDays, 30), 1, 365),
  };
}

// ---------------------------------------------------------------------------
// 过滤与去重
// ---------------------------------------------------------------------------

// 桶里只存“已转发”的不可逆指纹和时间，不存标题、正文、发件人。
// 新记录用带盐 HMAC-SHA256，避免别人拿 Message-ID 直接算出同一个 key。
function opaqueKey(text, secret) {
  return crypto.createHmac("sha256", secret).update(String(text)).digest("hex");
}

// messageId 是最可靠的去重键；缺失时退化成 主题 + 时间 + UID
function mailKey(messageId, subject, date, uid, secret) {
  const id = str(messageId);
  if (id) return opaqueKey(id, secret);
  return opaqueKey([str(subject), date ? stamp(date) : "", str(uid)].join("|"), secret);
}

// 旧版 SHA1 key：升级后保留一次兼容查询，避免当天邮件被重新转发。
function legacyMailKey(messageId, subject, date, uid) {
  const id = str(messageId);
  if (id) return sha1(id);
  return sha1([str(subject), date ? stamp(date) : "", str(uid)].join("|"));
}

function keyFromEnvelope(envelope, uid, secret) {
  const env = envelope || {};
  return mailKey(env.messageId, env.subject, env.date, uid, secret);
}

function keyFromParsed(parsed, uid, secret) {
  return mailKey(parsed && parsed.messageId, parsed && parsed.subject, parsed && parsed.date, uid, secret);
}

function legacyKeyFromEnvelope(envelope, uid) {
  const env = envelope || {};
  return legacyMailKey(env.messageId, env.subject, env.date, uid);
}

function legacyKeyFromParsed(parsed, uid) {
  return legacyMailKey(parsed && parsed.messageId, parsed && parsed.subject, parsed && parsed.date, uid);
}

// 新 key 没命中时，再看一次旧 SHA1 key；旧记录保留到自然过期，不主动迁移。
async function seenBefore(key, legacyKey) {
  if (await store.get(`seen.${key}`, "")) return true;
  if (legacyKey && legacyKey !== key && (await store.get(`seen.${legacyKey}`, ""))) return true;
  return false;
}

// 关键词命中任意一个字段（标题 / 正文 / 发件人）即可。
// 发件人用 formatFrom 的结果，同时包含显示名和邮箱。
function matchKeywords(cfg, subject, text, from) {
  if (!cfg.subjectKeywords.length) return true;
  const fields = [subject, text, from].map((value) => str(value).toLowerCase());
  return cfg.subjectKeywords.some((keyword) => fields.some((field) => field.includes(keyword)));
}

function matchFrom(cfg, from) {
  if (!cfg.fromAllow.length) return true;
  const value = str(from).toLowerCase();
  if (!value) return false; // 取不到发件人时按“不在白名单”处理
  return cfg.fromAllow.some((rule) => value.includes(rule));
}

// 新记录的值是 { 邮件时间, 邮件标题, 转发时间 }；旧记录可能是 { t, s } 或纯时间戳。
function seenTimestamp(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const stamp = Number(value["转发时间"] ?? value.t ?? value.time ?? 0);
    return Number.isFinite(stamp) ? stamp : 0;
  }
  const text = String(value ?? "").trim().replace(/^d:/, "");
  const stamp = Number(text.split("|")[0]);
  return Number.isFinite(stamp) ? stamp : 0;
}

// 清掉超期的去重记录（seen.* / base.* 存的是转发时间，6 小时内只清一次）
async function pruneStore(cfg) {
  const last = Number(await store.get("state.lastPrune", 0));
  if (Number.isFinite(last) && last > 0 && Date.now() - last < 6 * 60 * 60 * 1000) return 0;
  const all = (await store.getAll()) || {};
  const cutoff = Date.now() - cfg.retainDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const key of Object.keys(all)) {
    if (!key.startsWith("seen.") && !key.startsWith("base.")) continue;
    const ts = seenTimestamp(all[key]);
    if (Number.isFinite(ts) && ts > 0 && ts < cutoff) {
      await store.delete(key);
      removed += 1;
    }
  }
  await store.set("state.lastPrune", Date.now());
  return removed;
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

function resolveAttachDir(cfg) {
  const dir = path.isAbsolute(cfg.attachDir)
    ? cfg.attachDir
    : path.join(process.cwd(), cfg.attachDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 同一次转发里出现同名附件时，用 -2、-3 区分，不覆盖前一个文件。
function uniqueFilePath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 100; i += 1) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

// 附件落地到本地，返回可生成 CQ 码的描述对象
function saveAttachments(cfg, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const result = { saved: [], skipped: 0, inline: 0 };
  if (!list.length) return result;
  const dir = resolveAttachDir(cfg);
  const maxBytes = cfg.maxAttachMB * 1024 * 1024;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    // 正文内嵌图片（签名、统计像素、图文邮件配图）不算附件
    if (cfg.skipInline && (item.related === true || str(item.cid))) {
      result.inline += 1;
      continue;
    }
    const content = item.content;
    if (!content || !content.length) {
      result.skipped += 1;
      continue;
    }
    if (content.length > maxBytes) {
      result.skipped += 1;
      console.warn(`附件 ${str(item.filename) || i + 1} 大小 ${formatBytes(content.length)} 超过 ${cfg.maxAttachMB}MB，已跳过`);
      continue;
    }
    const name = safeFileName(item.filename, i);
    const filePath = uniqueFilePath(dir, name);
    try {
      fs.writeFileSync(filePath, content);
      result.saved.push({
        name,
        path: filePath,
        size: content.length,
        contentType: str(item.contentType),
      });
    } catch (error) {
      console.error(`保存附件失败：${errText(error)}`);
      result.skipped += 1;
    }
  }
  return result;
}

// 本地路径 -> [CQ:file,file=...]；配置了公网前缀 -> url= 形式
function cqAttachment(cfg, item) {
  const name = escapeCQ(item.name);
  if (cfg.publicBaseUrl) {
    const url = `${cfg.publicBaseUrl}/${encodeURIComponent(path.basename(item.path))}`;
    if (/^image\//i.test(item.contentType)) return `[CQ:image,url=${escapeCQ(url)}]`;
    return `[CQ:file,url=${escapeCQ(url)},name=${name}]`;
  }
  const file = escapeCQ(String(item.path).replace(/\\/g, "/"));
  return `[CQ:file,file=${file},name=${name}]`;
}

function attachDirOf(cfg) {
  return path.isAbsolute(cfg.attachDir)
    ? cfg.attachDir
    : path.join(process.cwd(), cfg.attachDir);
}

// 直接清空附件保存目录里的全部文件（保留目录本身，不递归删子目录）。
function cleanupAttachDir(cfg) {
  const dir = attachDirOf(cfg);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = fs.lstatSync(full);
      if (info.isFile() || info.isSymbolicLink()) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (_) {
      /* 单个文件清理失败不影响主流程 */
    }
  }
  return removed;
}

// 发送成功/失败后清空本地附件目录，避免磁盘越攒越多。
// 注意：s.reply / adapter.push 只是把消息放进 Pro 的发送队列，helper 适配器会在
// 队列消费时才读取本地文件并 upload_file；如果这里立刻删文件，附件就会变成
// “[文件] 文件名”占位文本。因此发送完成后按插件设置“附件删除延迟（秒）”清理。
// 插件进程执行完会退出，普通 setTimeout + unref 会随进程一起消失；这里起一个
// 独立的小清理进程，延迟到点后清空目录，不依赖插件进程继续存活。
function scheduleCleanup(cfg) {
  const delaySec = Math.max(0, Number(cfg.cleanupDelaySec ?? 30) || 0);
  const delayMs = delaySec * 1000;
  const dir = attachDirOf(cfg);
  const payload = Buffer.from(dir, "utf8").toString("base64");
  const script = `
const fs = require("fs");
const path = require("path");
const dir = Buffer.from(process.argv[1], "base64").toString("utf8");
setTimeout(() => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = fs.lstatSync(full);
      if (info.isFile() || info.isSymbolicLink()) fs.unlinkSync(full);
    } catch (_) {}
  }
}, ${Number(delayMs) || 0});
`;
  try {
    const child = spawn(process.execPath, ["-e", script, payload], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  } catch (error) {
    console.error(`启动附件清理进程失败，改用进程内定时器：${errText(error)}`);
  }

  // spawn 不可用时至少保持进程内的定时器是 ref 状态，避免主流程立刻退出后不执行
  setTimeout(() => cleanupAttachDir(cfg), delayMs);
}

// 清理进程崩溃等情况遗留的旧附件（附件目录归本插件使用，超过 24 小时的文件直接删）
function pruneAttachDir(cfg) {
  const dir = path.isAbsolute(cfg.attachDir) ? cfg.attachDir : path.join(process.cwd(), cfg.attachDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = fs.statSync(full);
      if (info.isFile() && info.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (_) {
      /* 单个文件清理失败不影响主流程 */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 发送：聊天会话 / 无会话（定时、常驻）
// ---------------------------------------------------------------------------

async function sendChunked(text, size, sendOne) {
  for (const chunk of splitText(text, size)) {
    let ok = true;
    try {
      ok = await sendOne(chunk);
    } catch (error) {
      console.error(`发送失败：${errText(error)}`);
      return false;
    }
    // 发送函数可能用 false 表示失败（s.reply 成功时返回的是消息 ID，可能是空串）
    if (ok === false) return false;
  }
  return true;
}

// 群是否被放行：私聊（chatId 为空）一律放行；群必须命中白名单，
// 白名单行写了平台时还要平台也对上（qq:889900 只对 QQ 的 889900 生效）
function groupAllowed(cfg, platform, chatId) {
  const id = str(chatId);
  if (!id) return true;
  const list = cfg.allowGroups || [];
  if (!list.length) return false; // 留空 = 所有群都拒绝（失败关闭）
  const plt = str(platform).toLowerCase();
  return list.some(
    (item) => item.id === id && (!item.platform || !plt || item.platform === plt),
  );
}

function createChatDeliver(cfg) {
  return {
    async send(text) {
      return sendChunked(text, cfg.chunk, (chunk) => s.reply(chunk));
    },
    async sendBlock(text) {
      try {
        await s.reply(text);
        return true;
      } catch (error) {
        console.error(`发送附件消息失败：${errText(error)}`);
        return false;
      }
    },
  };
}

// 一次 pushAdmin，返回成功的目标数；options 为空表示推给各平台管理员
async function pushAdminBatch(text, options) {
  let results = [];
  try {
    results = (await s.pushAdmin(text, options)) || [];
  } catch (error) {
    console.error(`推送失败：${errText(error)}`);
    return 0;
  }
  let ok = 0;
  for (const item of results) {
    if (!item) continue;
    if (item.error) {
      console.error(`推送给 ${item.platform || "?"}/${item.user_id || "?"} 失败：${item.error}`);
      continue;
    }
    ok += 1;
  }
  if (!results.length) {
    console.error("没有可推送的目标：检查「定时推送用户」里写的平台是否是启用状态，或该平台是否配了机器人");
  }
  return ok;
}

// 推送到群：用 Adapter 带 chat_id 发（qq → send_group_msg，telegram 等同样认 chat_id）
async function pushToGroup(platform, chatId, text) {
  try {
    const adapter = new Adapter({ platform, bot_id: "" });
    await adapter.push({ user_id: "", chat_id: chatId, content: text });
    return true;
  } catch (error) {
    console.error(`推送到群 ${platform}:${chatId} 失败：${errText(error)}`);
    return false;
  }
}

// 定时推送：私聊目标按平台合并成一次 pushAdmin；群目标逐个推（先过群白名单）
async function pushContent(cfg, text) {
  const targets = cfg.pushTargets || [];

  // 什么都没填 → 推给各平台管理员（老行为）
  if (!targets.length) return (await pushAdminBatch(text, undefined)) > 0;

  let delivered = 0;
  const usersByPlatform = new Map();

  for (const item of targets) {
    const platform = item.platform;
    // 群/私聊判不出来时：白名单里登记过的按群处理，否则按私聊
    const isChat =
      item.role === "chat" ||
      (item.role !== "user" && Boolean(platform) && groupAllowed(cfg, platform, item.id));

    if (isChat) {
      if (!platform) {
        console.error(`推送目标「${item.id}」是群但没写平台，已跳过：请写成 群:${item.id}#qq`);
        continue;
      }
      if (!groupAllowed(cfg, platform, item.id)) {
        console.warn(`定时推送群 ${platform}:${item.id} 不在群白名单，本次跳过（白名单留空 = 全部拒绝）`);
        continue;
      }
      if (await pushToGroup(platform, item.id, text)) delivered += 1;
      continue;
    }

    if (!platform) {
      console.error(`推送目标「${item.id}」没写平台，已跳过：请写成 ${item.id}#qq（群写成 群:${item.id}#qq）`);
      continue;
    }
    if (!usersByPlatform.has(platform)) usersByPlatform.set(platform, []);
    usersByPlatform.get(platform).push(item.id);
  }

  for (const [platform, ids] of usersByPlatform) {
    if (await pushAdminBatch(text, { platform, userIds: ids })) delivered += 1;
  }

  if (!delivered) console.error("这一轮没有推送成功，检查「定时推送目标 / 群白名单」的填写");
  return delivered > 0;
}

// 定时任务如果配了接收人，sender 自带 chat_id / user_id，直接回给接收人；
// 否则走 pushAdmin / 指定平台用户
function createCronDeliver(cfg, target) {
  const hasTarget = Boolean(target && (target.chatId || target.userId));
  const push = async (text) => {
    if (hasTarget) {
      try {
        await s.reply(text);
        return true;
      } catch (error) {
        console.error(`推送给定时接收人失败：${errText(error)}`);
        return false;
      }
    }
    return pushContent(cfg, text);
  };
  return {
    async send(text) {
      return sendChunked(text, cfg.chunk, push);
    },
    async sendBlock(text) {
      return push(text);
    },
  };
}

// ---------------------------------------------------------------------------
// 组织一条邮件消息
// ---------------------------------------------------------------------------

// 邮件自带 Date: 头；缺失或解析失败时显示“未知”
function mailDateText(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "(未知)";
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function buildMail(parsed, cfg, attachments, receivedAt) {
  return {
    subject: cleanSubject(parsed && parsed.subject),
    received: mailDateText(receivedAt || (parsed && parsed.date)),
    from: formatFrom(parsed && parsed.from),
    text: neutralizeCQ(limitText(bodyText(parsed), cfg.maxBody)),
    attachments: cfg.showAttachments ? (attachments && attachments.saved) || [] : [],
  };
}

// 附件 CQ 码按条分批：一条消息最多 8 个码，长度也不超过「单条消息最大字符数」，
// 免得附件一多整条消息被平台截断
async function sendAttachments(cfg, mail, deliver) {
  const blocks = [];
  let current = [];
  let size = 0;
  for (const item of mail.attachments) {
    const code = cqAttachment(cfg, item);
    if (current.length && (current.length >= 8 || size + code.length > cfg.chunk)) {
      blocks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(code);
    size += code.length + 1;
  }
  if (current.length) blocks.push(current.join("\n"));

  let ok = true;
  for (const block of blocks) {
    const sent = await deliver.sendBlock(block);
    if (!sent) ok = false;
  }
  return ok;
}

// 把模板里的占位符换成邮件数据；没写的占位符自然就不会出现在消息里
function renderTemplate(template, mail) {
  const values = {
    "[@邮件标题]": mail.subject || "(无标题)",
    "[@接收时间]": mail.received || "(未知)",
    "[@发件人]": mail.from || "(未知)",
    "[@邮件内容]": mail.text || "(无内容)",
    // 顺手兼容几个短写法
    "[@标题]": mail.subject || "(无标题)",
    "[@时间]": mail.received || "(未知)",
    "[@正文]": mail.text || "(无内容)",
    "[@内容]": mail.text || "(无内容)",
  };
  let text = str(template);
  for (const [token, value] of Object.entries(values)) {
    text = text.split(token).join(value);
  }
  // 附件不支持塞进文字模板，统一由「发送附件」单独发；模板里写了就清掉占位符
  text = text.split("[@附件]").join("").trim();
  return text;
}

// 返回 { ok, attach }：ok=文字字段是否发出，attach=附件是否发出
async function deliverMail(cfg, mail, deliver) {
  const text = renderTemplate(cfg.messageTemplate, mail);

  // 模板为空时只发附件，不额外发一条空消息
  if (text) {
    const sent = await deliver.send(text);
    if (!sent) return { ok: false, attach: false };
  }
  // 正文已经发出，附件再失败也不能重发正文，只记日志
  if (!mail.attachments.length) return { ok: true, attach: true };

  const attach = await sendAttachments(cfg, mail, deliver);
  if (!attach) console.error(`邮件「${mail.subject || "(无标题)"}」附件发送失败，正文已发出，不重复发送`);
  return { ok: true, attach };
}

// ---------------------------------------------------------------------------
// 拉取并转发
// ---------------------------------------------------------------------------

// 只处理「今天收到的」邮件：SINCE 今天 00:00，含已读；更早的一律不看
async function runForward(cfg, deliver, options = {}) {
  const testMode = Boolean(options.test);
  const testLimit = 3;
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error("请先在后台「插件设置 → 邮件转发」里填写 IMAP 服务器、邮箱账号和授权码");
  }
  if (!cfg.messageTemplate.trim() && !cfg.showAttachments) {
    throw new Error("插件设置「消息模板」为空时必须打开「发送附件」，否则没有内容可转发");
  }

  const summary = {
    forwarded: 0,
    skipped: 0,
    filtered: 0,
    failed: 0,
    attachFailed: 0,
  };

  // 清掉上次异常退出可能残留的旧附件（只动自己生成的文件）
  const pruned = pruneAttachDir(cfg);
  if (pruned) console.log(`已清理 ${pruned} 个遗留附件`);

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    socketTimeout: 60000,
  });
  client.on("error", (error) => console.error(`IMAP 错误：${errText(error)}`));

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock(cfg.mailbox);

    // 先按 IMAP SINCE 今天取回，解析后再按邮件 Date: 过滤“昨天发出、今天才收到”的邮件
    const found = await client.search({ since: startOfToday() }, { uid: true });
    const all = (Array.isArray(found) ? found.slice() : []).sort((a, b) => a - b);

    // 符合查询条件的邮件全部转发（转发过的不再重复）。
    // 最多扫 200 封，避免大邮箱把这一轮拖死；扫到上限会在日志里说明。
    // 测试模式只取今天最早的 3 封「命中关键词」的邮件，且完全跳过「已转发」去重。
    // 关键词匹配标题 / 正文 / 发件人，所以这里要解析完整邮件后才能判断。
    const candidates = [];
    let scanned = 0;
    const scanCap = 200;
    const ordered = testMode ? all.slice() : all.slice().reverse();
    for (const uid of ordered) {
      if (scanned >= scanCap || (testMode && candidates.length >= testLimit)) break;
      scanned += 1;
      const peek = await client.fetchOne(uid, { envelope: true, internalDate: true }, { uid: true });
      if (!peek || !peek.envelope) continue;
      const envelopeKey = keyFromEnvelope(peek.envelope, uid, cfg.dedupeKey);
      const legacyEnvelopeKey = legacyKeyFromEnvelope(peek.envelope, uid);
      if (!testMode && (await seenBefore(envelopeKey, legacyEnvelopeKey))) {
        summary.skipped += 1;
        continue;
      }

      const fetched = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
      if (!fetched || !fetched.source) {
        summary.failed += 1;
        continue;
      }

      let parsed;
      try {
        parsed = await simpleParser(fetched.source);
      } catch (error) {
        console.error(`解析邮件失败（uid=${uid}）：${errText(error)}`);
        summary.failed += 1;
        continue;
      }

      const key = keyFromParsed(parsed, uid, cfg.dedupeKey);
      const legacyKey = legacyKeyFromParsed(parsed, uid);
      if (!testMode && key !== envelopeKey && (await seenBefore(key, legacyKey))) {
        summary.skipped += 1;
        continue;
      }

      // 和网页收件箱一致：按 IMAP 接收时间 internalDate 判断“今天”；
      // 服务器没给 internalDate 时才退回邮件头 Date:。
      const receivedAt = fetched.internalDate || peek.internalDate || parsed.date;
      if (!isTodayMail(receivedAt)) {
        summary.filtered += 1;
        continue;
      }

      const subject = cleanSubject(parsed.subject);
      const from = formatFrom(parsed.from) || formatFrom(peek.envelope.from);
      if (
        !matchKeywords(cfg, subject, bodyText(parsed), from) ||
        !matchFrom(cfg, from)
      ) {
        summary.filtered += 1;
        continue;
      }

      candidates.push({ uid, key, parsed, receivedAt });
    }
    if (!testMode) candidates.reverse(); // 从旧到新转发，读起来更自然

    if (!testMode && scanned >= scanCap && all.length > scanned) {
      console.warn(
        `本轮只扫了最近 ${scanned} 封（符合条件共 ${all.length} 封），更早的邮件这次没处理，下次触发还能接着拿`,
      );
    }

    for (const item of candidates) {
      const parsed = item.parsed;
      const key = item.key;

      const attachments = cfg.showAttachments
        ? saveAttachments(cfg, parsed.attachments)
        : { saved: [], skipped: 0, inline: 0 };
      if (attachments.inline) console.log(`邮件「${cleanSubject(parsed.subject)}」跳过 ${attachments.inline} 个内嵌图片`);
      if (attachments.skipped) console.warn(`邮件「${cleanSubject(parsed.subject)}」有 ${attachments.skipped} 个附件超限或为空，已跳过`);
      const mail = buildMail(parsed, cfg, attachments, item.receivedAt);

      // 正常模式先占位再发送，降低关键词触发与定时任务重复转发概率；
      // 测试模式只看今天前 3 封，不写去重、不改已读状态。
      // 值里带接收时间和标题，方便在数据桶页面直接看到转发过哪些邮件。
      if (!testMode) {
        await store.set(`seen.${key}`, {
          邮件时间: mailDateText(item.receivedAt),
          邮件标题: cleanSubject(parsed.subject) || "(无标题)",
          转发时间: Date.now(),
        });
      }

      const result = await deliverMail(cfg, mail, deliver);
      if (!result.ok) {
        // 正文都没发出去：撤销去重占位，下一轮重试
        if (!testMode) await store.delete(`seen.${key}`).catch(() => {});
        cleanupAttachDir(cfg);
        summary.failed += 1;
        continue;
      }

      if (result.attach) summary.forwarded += 1;
      else summary.attachFailed += 1;

      // 附件消息只是进了 Pro 的发送队列，等 helper 真正上传完再清理；
      // 立刻删会让 helper 读不到文件，退化成“[文件] 文件名”文本。
      if (attachments.saved.length && !cfg.keepAttachments) {
        scheduleCleanup(cfg);
      }

      if (!testMode && cfg.markSeen) {
        try {
          await client.messageFlagsAdd(item.uid, ["\\Seen"], { uid: true });
        } catch (error) {
          console.error(`标记已读失败：${errText(error)}`);
        }
      }
    }

    return summary;
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch (_) {
        /* 忽略释放异常 */
      }
    }
    try {
      await client.logout();
    } catch (_) {
      /* 忽略登出异常 */
    }
  }
}

// ---------------------------------------------------------------------------
// 场景判定：聊天会话 / 定时任务
// ---------------------------------------------------------------------------

// 定时任务的 sender 没有原始消息（message_id 为空、也没有昵称）；Web 控制台的消息
// 本来就没有 message_id，所以 web 平台按会话处理，否则网页里会变成“只推给管理员”。
async function detectRun() {
  const platform = str(await s.getPlatform());
  const msgId = str(await s.getMsgId());
  const userName = str(await s.getUserName());
  const chatId = str(await s.getChatId());
  const userId = str(await s.getUserId());
  const cronLike =
    platform === "task" || platform === "*" || (platform !== "web" && !msgId && !userName);
  return { platform, msgId, chatId, userId, cronLike };
}

// ---------------------------------------------------------------------------
// 权限：私聊放行，群聊查白名单；「指令仅管理员可用」再卡一道
// ---------------------------------------------------------------------------

async function checkGroupAllowed(cfg, platform) {
  const chatId = str(await s.getChatId());
  if (!chatId) return { ok: true, chatId: "" }; // 私聊 / 单聊会话
  return { ok: groupAllowed(cfg, platform, chatId), chatId };
}

// 管理员判断走核心的 s.isAdmin()：各平台「管理员」页面里登记的人
async function checkAdminOnly(cfg) {
  if (!cfg.adminOnly) return { ok: true, admin: false };
  let admin = false;
  try {
    admin = await s.isAdmin();
  } catch (error) {
    console.error(`判断管理员失败：${errText(error)}`);
  }
  return { ok: Boolean(admin), admin: Boolean(admin) };
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// 判断一封邮件是否属于“今天”：优先用 IMAP 接收时间 internalDate，
// 和网页收件箱的日期分组一致；取不到时由调用方回退到邮件头 Date:。
function isTodayMail(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return true; // 取不到接收时间时不误删
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

async function report(cron, summary, deliver) {
  const lines = [];
  if (!cron && !summary.forwarded) {
    // 有邮件转发时不额外发汇总，避免多出一条与邮件无关的消息
    if (summary.filtered) lines.push("没有符合条件的新邮件。");
    else lines.push("今天还没有收到新邮件。");
  }
  if (summary.attachFailed) lines.push(`⚠️ ${summary.attachFailed} 封邮件的附件发送失败，详见服务日志。`);
  if (summary.failed) lines.push(`⚠️ ${summary.failed} 封发送失败，下一轮会重试。`);
  if (!lines.length) return;
  await deliver.send(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

// 只有精确的“读取邮箱测试”走测试模式；其余口令一律按普通读取邮箱处理。
// 这样以后在 [rule] 或 Pro 定时任务里新增/修改口令，不需要再回来维护命令表。
const TEST_COMMAND = "读取邮箱测试";

async function currentCommand() {
  try {
    return String((await s.getMsg()) ?? "");
  } catch (_) {
    return "";
  }
}

async function main() {
  let cfg = null;
  let cron = true; // 出错且还没判明场景时，按“无会话”处理，避免 reply 卡住
  let target = { chatId: "", userId: "" };
  let testMode = false;

  try {
    cfg = await loadConfig();
    const run = await detectRun();
    cron = run.cronLike;
    target = { chatId: run.chatId, userId: run.userId };

    // 手动触发和定时任务触发都走这里；不再拦截未登记的口令
    const command = await currentCommand();
    testMode = command === TEST_COMMAND;
    console.log(
      `${cron ? "定时任务" : "手动"}口令：${JSON.stringify(command)}（test=${testMode}）`,
    );

    if (cron) {
      await pruneStore(cfg).catch((error) => console.error(`清理去重记录失败：${errText(error)}`));
      // 定时任务配了群接收人时，同样要过群白名单（留空 = 全部拒绝）
      if (target.chatId && !groupAllowed(cfg, run.platform, target.chatId)) {
        console.warn(
          `定时接收群 ${run.platform}:${target.chatId} 不在群白名单，本次推送已跳过（白名单留空 = 全部拒绝）`,
        );
        return;
      }
      // 由 Pro 的定时任务决定什么时候唤醒；唤醒后直接拉取当天邮件
    } else {
      const allowed = await checkGroupAllowed(cfg, run.platform);
      if (!allowed.ok) {
        await s
          .reply(
            `本群未加入邮件转发白名单，请联系管理员在「插件设置 → 邮件转发 → 群白名单」里加上「${run.platform}:${allowed.chatId}」。`,
          )
          .catch((error) => console.error(`回复白名单提示失败：${errText(error)}`));
        return;
      }
      // 「指令仅管理员可用」：非管理员一律不拉邮件（私聊、群聊都管）
      const guard = await checkAdminOnly(cfg);
      if (!guard.ok) {
        const label = testMode ? "读取邮箱测试" : "读取邮箱";
        console.log(`非管理员触发「${label}」，已拒绝`);
        await s
          .reply(`「${label}」仅限管理员使用。`)
          .catch((error) => console.error(`回复权限提示失败：${errText(error)}`));
        return;
      }
    }

    // 手动和定时都只处理「今天收到的」邮件，转发过的按去重跳过
    const deliver = cron ? createCronDeliver(cfg, target) : createChatDeliver(cfg);
    const summary = await runForward(cfg, deliver, { test: testMode });
    await report(cron, summary, deliver);
  } catch (error) {
    const message = `邮件转发失败：${errText(error)}`;
    console.error(message);
    const fallback = cfg || { chunk: 1200, pushTargets: [], allowGroups: [] };
    try {
      if (cron) await createCronDeliver(fallback, target).send(`⚠️ ${message}`);
      else await s.reply(message);
    } catch (notifyError) {
      console.error(`发送错误提示失败：${errText(notifyError)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
