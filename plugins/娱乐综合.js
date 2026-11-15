// [title: 娱乐接口合集]
// [name: 娱乐综合]
// [desc: 随机小姐姐视频、白丝/黑丝图片、唱一首（歌词+音频）、疯狂星期四文案、短视频/抖音解析]
// [author: lichen]
// [version: v1.2.10-helper]
// [rule: raw ^(?:/)?随机小姐姐$]
// [rule: raw ^(?:/)?随机白丝$]
// [rule: raw ^(?:/)?随机黑丝$]
// [rule: raw ^(?:/)?唱一首(?:\s+(.+))?$]
// [rule: raw ^(?:/)?疯狂星期四$]
// [rule: raw ^(?:/)?(?:抖音|视频)解析]
// [status: true]
// [admin: false]
// [public: false]
// [priority: 0]
// [class: 娱乐]
// [icon: https://api.iconify.design/lucide:bot.svg]
// [origin: 自定义]
// [depe: []]



const { sender: s, plugin, Bucket } = require("sillygirl");

const http = require("http");
const https = require("https");
const { URL } = require("url");

const Config = new plugin.Form({
  audioSendMode: plugin.Form.select([
    { value: "auto", label: "自动：QQ/QQ群/helper(微信) 发语音条，其他平台发文件或链接" },
    { value: "record", label: "强制语音条（QQ 走 CQ，helper 转微信语音，超过 60 秒截取）" },
    { value: "file", label: "一律发 mp3 文件" },
    { value: "link", label: "只发音频链接" },
  ])
    .title("唱一首 音频发送方式")
    .description("helper 的语音只支持 SILK/WAV 且单条最长 60 秒，超长会截取前 60 秒；转码失败自动退回文件")
    .default("auto"),
  maxVideoSizeMB: plugin.Form.number()
    .title("视频大小上限（MB）")
    .description("超过该大小、或地址探测超时的视频只发链接，默认 100")
    .default(100)
    .min(1)
    .max(4096),
  requestTimeout: plugin.Form.number().title("请求超时（毫秒）").default(15000).min(3000).max(60000),
});

const DWO_GIRL_VIDEO = "https://openapi.dwo.cc/api/ksvideo";
const DWO_WHITE = "https://openapi.dwo.cc/api/bs_jk?type=json";
const DWO_BLACK = "https://openapi.dwo.cc/api/hs_img";
const DWO_SVPARSE = "https://openapi.dwo.cc/api/svparse";
const PEAR_CLICK_MUSIC = "https://api.pearapi.ai/api/click_music";
const PEAR_KFC = "https://api.pearapi.ai/api/kfc?type=json";

// 解析结果本地缓存时长，避免重复请求打满 5 次/分钟的频率限制
const PARSE_CACHE_MS = 30 * 60 * 1000;
const Store = new Bucket("entertainment-kit");

// 支持 [CQ:image,...] 的平台；web 端只认 file= 参数。
// helper 是新增的微信通道：适配器会把 CQ 码拆成媒体条目交给 helper 插件下载发送。
const CQ_PLATFORMS = new Set([
  "qq",
  "qqguild",
  "telegram",
  "dingtalk",
  "flowbot",
  "pagermaid",
  "clawbot",
  "helper",
  "web",
]);

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|amr)(\?|$)/i;

const KFC_FALLBACK = [
  "今天是疯狂星期四，V我50，我去吃肯德基。",
  "疯狂星期四，KFC的鸡腿在等我，V我50，让我替你尝一口。",
  "别人都在等周五下班，我在等疯狂星期四的炸鸡，V我50，炸鸡分你一半。",
  "疯狂星期四到了，钱包它有自己的想法，V我50，我替你和炸鸡合个影。",
  "这一天，鸡翅在打折，我的胃口在膨胀，V我50，我们一起把快乐吃下去。",
];

async function main() {
  const config = await Config.get();
  const timeout = normalizeTimeout(config.requestTimeout);
  const content = String((await s.getMsg()) || "").trim();
  const command = content.replace(/^[\s/／]+/, "");

  if (/^随机小姐姐$/.test(command)) {
    await randomGirl(timeout, config);
    return;
  }
  if (/^随机白丝$/.test(command)) {
    await randomWhite(timeout);
    return;
  }
  if (/^随机黑丝$/.test(command)) {
    await randomBlack(timeout);
    return;
  }
  const singMatch = command.match(/^唱一首(?:\s+(.+))?$/);
  if (singMatch) {
    if ((singMatch[1] || "").trim()) {
      await s.reply("这个接口是随机点歌，不支持指定歌名，先随机给你来一首～");
    }
    await sing(timeout, config);
    return;
  }
  if (/^疯狂星期四$/.test(command)) {
    await crazyThursday(timeout);
    return;
  }
  const parseMatch = command.match(/^(?:抖音|视频)解析([\s\S]*)$/);
  if (parseMatch) {
    // 必须同时具备命令 + v.douyin.com 短链，缺一不解析
    const link = extractDouyinUrl(parseMatch[1]);
    if (!link) {
      await s.reply("抖音解析需要带上 v.douyin.com 分享链接，例如：\n抖音解析 https://v.douyin.com/xxxxxx/");
      return;
    }
    await parseVideo(timeout, config, link);
    return;
  }

  await s.reply(
    "未识别的指令，可用：随机小姐姐 / 随机白丝 / 随机黑丝 / 唱一首 / 疯狂星期四 / 抖音解析 <v.douyin.com 链接>",
  );
}

async function parseVideo(timeout, config, link) {
  if (!link) {
    throw new Error("用法：抖音解析 https://v.douyin.com/xxxx/");
  }

  let payload = await readParseCache(link);
  if (!payload) {
    const data = await requestJson(withQuery(DWO_SVPARSE, { url: link }), { accept: "application/json" }, timeout);
    const code = data && typeof data === "object" && data.code !== undefined ? Number(data.code) : 200;
    if (code !== 200) {
      throw new Error(parseApiError(code, data && data.msg));
    }
    payload = data && data.data && typeof data.data === "object" ? data.data : data;
    if (!payload || typeof payload !== "object") {
      throw new Error("解析接口没有返回数据：" + truncate(toPlainText(data), 200));
    }
    await writeParseCache(link, payload);
  }

  const title = normalizeWhitespace(firstString(payload, ["title", "desc", "description"]) || "解析成功");
  const cover = firstString(payload, ["cover", "cover_url", "coverUrl"]);
  const video = firstString(payload, ["url", "video", "video_url", "videoUrl"]);

  // 按约定顺序：标题 → 封面 → 视频地址
  await s.reply(`标题：${clipText(title, 300)}`);
  if (cover) {
    await sendImage(cover);
  }
  if (video) {
    await sendVideoWithSizeGuard(video, timeout, config);
    return;
  }
  const images = payload.images;
  if (Array.isArray(images) && images.length) {
    for (const image of images.slice(0, 9)) {
      if (typeof image === "string" && isHttpUrl(image)) await sendImage(image);
    }
    return;
  }
  await s.reply("解析成功，但接口没有返回视频或图片地址");
}

// 视频体积上限（MB）：超过上限或探测超时只发链接，避免协议端拉大文件失败
async function sendVideoWithSizeGuard(video, timeout, config) {
  const limitBytes = maxVideoBytes(config);
  const size = await probeMediaSize(video, timeout);

  if (size < 0) {
    await s.reply(`视频地址探测超时或无法访问，为避免发送失败，只发链接：\n${video}`);
    return;
  }
  if (size > 0 && size > limitBytes) {
    await s.reply(`视频约 ${formatSize(size)}，超过 ${formatSize(limitBytes)} 上限，只发链接：\n${video}`);
    return;
  }
  await sendVideo(video);
}

function maxVideoBytes(config) {
  const mb = Number(config && config.maxVideoSizeMB);
  const safe = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 4096) : 100;
  return Math.floor(safe * 1024 * 1024);
}

function formatSize(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  return `${mb.toFixed(1)}MB`;
}

// 返回字节数；-1 表示探测失败或超时（调用方按“只发链接”处理）
async function probeMediaSize(url, timeout) {
  const budget = Math.min(normalizeTimeout(timeout), 12000);
  try {
    const head = await httpProbe(url, budget, "HEAD");
    if (head.status >= 200 && head.status < 300) {
      const length = Number(head.headers["content-length"] || 0);
      if (length > 0) return length;
    } else if (head.status >= 300 && head.status < 400 && head.headers.location) {
      const moved = new URL(head.headers.location, url).toString();
      const retry = await httpProbe(moved, budget, "HEAD");
      const length = Number(retry.headers["content-length"] || 0);
      if (length > 0) return length;
    }

    // HEAD 拿不到大小时，用 Range 探测真实总长度
    const ranged = await httpProbe(url, budget, "GET", "bytes=0-1");
    const contentRange = String(ranged.headers["content-range"] || "");
    const match = contentRange.match(/\/(\d+)$/);
    if (match) return Number(match[1]);
    const rangedLength = Number(ranged.headers["content-length"] || 0);
    if (ranged.status === 200 && rangedLength > 0) return rangedLength;
    return isHttpOk(ranged.status) ? 0 : -1;
  } catch (_) {
    return -1;
  }
}

function isHttpOk(status) {
  return (status >= 200 && status < 300) || (status >= 300 && status < 400);
}

function httpProbe(targetUrl, timeout, method, range) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (_) {
      reject(new Error("视频地址不合法"));
      return;
    }
    const client = parsed.protocol === "http:" ? http : https;
    const headers = {
      accept: "*/*",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    };
    if (range) headers.range = range;

    const request = client.request(targetUrl, { method: method || "GET", headers }, (response) => {
      const payload = { status: Number(response.statusCode || 0), headers: response.headers || {} };
      response.resume();
      finish(payload);
      // 仅探测大小，拿到响应头就断开，不下载完整视频
      if (String(method || "GET").toUpperCase() !== "HEAD") {
        response.destroy();
      }
    });
    request.setTimeout(timeout, () => request.destroy(new Error("探测超时")));
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end();
  });
}

function parseApiError(code, message) {
  if (code === 219) return "解析接口限流了（5 次/分钟），等一分钟再试";
  if (code === 217 || code === 216 || code === 203) return `解析接口密钥问题：${message || code}`;
  return `解析失败（${code}）：${message || "未知错误"}`;
}

async function readParseCache(link) {
  try {
    const item = await Store.get(cacheKey(link), null);
    if (!item || typeof item !== "object" || !item.payload) return null;
    if (Date.now() - Number(item.at || 0) > PARSE_CACHE_MS) return null;
    return item.payload;
  } catch (_) {
    return null;
  }
}

async function writeParseCache(link, payload) {
  try {
    await Store.set(cacheKey(link), { at: Date.now(), payload });
  } catch (_) {
    // 缓存写失败不影响正常解析
  }
}

function cacheKey(link) {
  return "svparse:" + String(link).trim();
}

const URL_PATTERN = /https?:\/\/[^\s"'<>（）()【】[\]，。；：！？、]+/g;

function extractUrls(text) {
  const matches = String(text == null ? "" : text).match(URL_PATTERN);
  if (!matches) return [];
  return matches.map((url) => url.replace(/[.,;!?]+$/, ""));
}

// 分享文本里可能夹着别的链接，只认 v.douyin.com 短链
function extractDouyinUrl(text) {
  const urls = extractUrls(text);
  return urls.find((url) => isDouyinShareUrl(url)) || "";
}

// 只匹配 v.douyin.com 短链，普通 douyin.com 网页链接不自动触发
function isDouyinShareUrl(url) {
  return /^https?:\/\/v\.douyin\.com\//i.test(url);
}

function withQuery(endpoint, params) {
  const target = new URL(endpoint);
  for (const key of Object.keys(params || {})) {
    const value = params[key];
    if (value === undefined || value === null || String(value) === "") continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function normalizeWhitespace(text) {
  return String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
}

async function randomGirl(timeout, config) {
  const data = await requestJson(DWO_GIRL_VIDEO, {}, timeout);
  const url = pickMediaUrl(data, ["pic", "video", "video_url", "url", "mp4"], "video");
  if (!url) throw noMediaError("小姐姐视频", data);
  if (VIDEO_EXT.test(url)) {
    // 和抖音解析走同一套体积保护，避免抽到大文件把协议端拖死
    await sendVideoWithSizeGuard(url, timeout, config);
    return;
  }
  await sendImage(url);
}

async function randomWhite(timeout) {
  const data = await requestJson(DWO_WHITE, {}, timeout);
  const url = pickMediaUrl(data, ["image_url", "imageUrl", "pic", "url"], "image");
  if (!url) throw noMediaError("白丝图片", data);
  await sendImage(url);
}

async function randomBlack(timeout) {
  const data = await requestJson(DWO_BLACK, {}, timeout);
  const state = deepFind(data, ["状态", "status", "message", "msg"]);
  if (typeof state === "string" && /失败|错误|error|fail/i.test(state)) {
    throw new Error("黑丝接口返回失败：" + state);
  }
  const url = pickMediaUrl(data, ["pic", "image_url", "imageUrl", "url"], "image");
  if (!url) throw noMediaError("黑丝图片", data);
  await sendImage(url);
}

function noMediaError(label, data) {
  return new Error(`${label}接口没有返回可用地址，原始返回：${truncate(toPlainText(data), 160)}`);
}

async function sing(timeout, config) {
  const data = await requestJson(PEAR_CLICK_MUSIC, { accept: "application/json" }, timeout);

  // 文档约定：code=200 成功，业务数据在 data 内
  if (data && typeof data === "object" && data.code !== undefined) {
    const code = Number(data.code);
    if (code !== 200) {
      throw new Error(`随机点歌接口返回 ${data.code}：${data.msg || "未知错误"}`);
    }
  }
  const payload = data && typeof data === "object" && data.data && typeof data.data === "object" ? data.data : data;

  const lyrics = firstString(payload, ["lyrics", "lyric", "歌词"]);
  // audiosrc 带 auth_key 时有时效性，取到就立刻发，不做缓存
  const audio = firstString(payload, ["audiosrc", "audio_url", "audioUrl", "audio", "music", "url"]);

  if (!lyrics && !audio) {
    throw new Error("随机点歌接口没有返回歌词或音频：" + truncate(toPlainText(data), 200));
  }

  if (lyrics) {
    await s.reply(`歌词：\n${clipText(normalizeLyrics(lyrics), 2000)}`);
  }
  if (audio) {
    await sendRecord(audio, config);
  } else {
    await s.reply("接口没有返回音频地址，只拿到了歌词");
  }
}

function firstString(data, keys) {
  for (const key of keys) {
    if (!data || typeof data !== "object") break;
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function crazyThursday(timeout) {
  try {
    const data = await requestJson(PEAR_KFC, { accept: "application/json" }, timeout);

    if (data && typeof data === "object" && data.code !== undefined) {
      const code = Number(data.code);
      if (code !== 200) {
        throw new Error(`接口返回 ${data.code}：${data.msg || "未知错误"}`);
      }
    }
    const text = extractKfcText(data);
    if (!text) throw new Error("接口没有返回文案：" + truncate(toPlainText(data), 200));
    await s.reply(clipText(unescapeNewlines(text), 2000));
  } catch (error) {
    console.error("[entertainmentKit] 疯狂星期四接口失败：", error && error.message ? error.message : error);
    await s.reply(
      `疯狂星期四接口请求失败（${error && error.message ? error.message : error}），先给你一条本地文案：\n${randomKfcCopy()}`,
    );
  }
}

// 接口文案里的换行是转义的 \\n，解析后是字面量 "\n"，需要还原成真换行
function unescapeNewlines(text) {
  return String(text == null ? "" : text)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

async function sendImage(url) {
  const platform = await currentPlatform();
  if (platform === "web") {
    await s.reply(buildCQ("image", "file", url));
    return;
  }
  if (CQ_PLATFORMS.has(platform)) {
    // helper 通道同样发 CQ:image，适配器会拆出媒体条目交给 helper 插件下载后用
    // ctx.send_image 发出；不要在这里改成纯链接，否则微信侧收不到图。
    await s.reply(buildCQ("image", "url", url));
    return;
  }
  await s.reply("图片地址：" + url);
}

async function sendVideo(url) {
  const platform = await currentPlatform();
  if (platform === "qq" || platform === "qqguild" || platform === "clawbot" || platform === "helper") {
    await s.reply(buildCQ("video", "file", url));
    return;
  }
  await s.reply("视频地址：" + url);
}

async function sendRecord(url, config) {
  const platform = await currentPlatform();
  const mode = String((config && config.audioSendMode) || "auto").toLowerCase();

  if (mode === "link") {
    await s.reply("音频地址：" + url);
    return;
  }

  if (mode === "file") {
    await s.reply(buildFileTag(url));
    return;
  }

  // record/voice：CQ 语音条。helper 适配器会把 record 拆成 voice 段，
  // 插件转成 SILK/WAV 后走 ctx.send_voice；转码失败会自动退回 mp3 文件。
  // （voice 只保留兼容旧配置，helper 上行为与 record 相同）
  if (mode === "record" || mode === "voice") {
    await s.reply(buildCQ("record", "file", url));
    return;
  }

  // auto：
  //   QQ / QQ频道 / helper（微信）直接发语音条；
  //   ClawBot 微信侧暂无语音发送能力，发 mp3 文件；
  //   其余平台降级发链接。
  if (platform === "qq" || platform === "qqguild" || platform === "helper") {
    await s.reply(buildCQ("record", "file", url));
    return;
  }
  if (platform === "clawbot") {
    await s.reply(buildFileTag(url));
    return;
  }
  await s.reply("音频地址：" + url);
}

function buildFileTag(url) {
  return buildCQ("file", "file", url, { name: audioName(url) });
}

function audioName(url) {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    if (/\.(mp3|wav|m4a|aac|ogg|amr|flac)$/i.test(base)) return base;
  } catch (_) {
    // 解析失败就退回默认名
  }
  return "random-song.mp3";
}

async function currentPlatform() {
  try {
    return String((await s.getPlatform()) || "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function buildCQ(type, key, value, extra) {
  let tag = `[CQ:${type},${key}=${escapeCQValue(value)}`;
  if (extra && typeof extra === "object") {
    for (const [name, item] of Object.entries(extra)) {
      tag += `,${name}=${escapeCQValue(item)}`;
    }
  }
  return tag + "]";
}

// CQ 码特殊字符转义，避免 URL 里的 & , [ ] 截断标签
function escapeCQValue(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;")
    .replace(/\r?\n/g, "");
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 15000;
  return Math.max(3000, Math.min(60000, Math.floor(n)));
}

function httpGet(targetUrl, headers, timeout) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const run = (url) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        reject(new Error("接口地址不合法：" + url));
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reject(new Error("只支持 http/https 接口：" + url));
        return;
      }
      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(
        url,
        {
          headers: Object.assign(
            {
              accept: "application/json, text/plain, */*",
              "user-agent": "Mozilla/5.0 (compatible; SillyGirlPlugin/1.0)",
            },
            headers || {},
          ),
        },
        (response) => {
          const status = Number(response.statusCode || 0);
          if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
            redirects += 1;
            response.resume();
            run(new URL(response.headers.location, url).toString());
            return;
          }
          let finished = false;
          const fail = (error) => {
            if (finished) return;
            finished = true;
            reject(error);
          };
          // 体积超限时 destroy 会让响应流发 'error'，这里必须挂监听，
          // 否则 Node 会抛未捕获异常把 worker 打挂。
          response.on("error", fail);
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (finished) return;
            body += chunk;
            if (body.length > 2 * 1024 * 1024) {
              fail(new Error("接口返回内容过大"));
              response.destroy();
            }
          });
          response.on("end", () => {
            if (finished) return;
            finished = true;
            resolve({ status, body });
          });
        },
      );
      request.setTimeout(timeout, () => {
        request.destroy(new Error(`请求超时（${timeout}ms）`));
      });
      request.on("error", (error) => reject(error));
    };

    run(targetUrl);
  });
}

async function requestJson(url, headers, timeout) {
  const response = await httpGet(url, headers, timeout);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}：${truncate(response.body, 160)}`);
  }
  const data = parseBody(response.body);
  if (typeof data === "string") {
    const text = data.trim();
    if (!text) throw new Error("接口返回内容为空");
    if (/^(error|fail)/i.test(text) || /失败|错误|权限|未授权|key/i.test(text)) {
      if (text.length <= 300) throw new Error(text);
    }
  }
  return data;
}

function parseBody(body) {
  const text = String(body == null ? "" : body).trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch (_) {
    // 兼容 JSONP：callback({...})
    const match = text.match(/([{[][\s\S]*[}\]])/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (_) {
        return text;
      }
    }
    return text;
  }
}

// 先按字段名取值，取不到再按媒体后缀兜底扫描
function pickMediaUrl(data, keys, kind) {
  const byKey = deepFind(data, keys);
  // 字段命中但后缀明显是别的媒体类型（例如 image 接口返回 mp4）时不要硬发
  if (isHttpUrl(byKey) && (matchKind(byKey, kind) || !matchesAnyMedia(byKey))) {
    return byKey;
  }

  const urls = scanUrls(data);
  const strict = urls.find((url) => matchKind(url, kind) && !looksLikeApiEndpoint(url));
  if (strict) return strict;
  const loose = urls.find((url) => !looksLikeApiEndpoint(url));
  return loose || "";
}

function matchesAnyMedia(url) {
  return IMAGE_EXT.test(url) || VIDEO_EXT.test(url) || AUDIO_EXT.test(url);
}

function matchKind(url, kind) {
  if (kind === "image") return IMAGE_EXT.test(url);
  if (kind === "video") return VIDEO_EXT.test(url);
  if (kind === "audio") return AUDIO_EXT.test(url);
  return true;
}

// 排除接口自身的地址（例如回显的请求 URL）
function looksLikeApiEndpoint(url) {
  return /\/api\//i.test(url) && !IMAGE_EXT.test(url) && !VIDEO_EXT.test(url) && !AUDIO_EXT.test(url);
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value.trim());
}

function deepFind(data, keys, depth) {
  const level = depth || 0;
  if (data === null || data === undefined || level > 8) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = deepFind(item, keys, level + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof data !== "object") return undefined;

  const wanted = keys.map((key) => key.toLowerCase());
  const objKeys = Object.keys(data);

  // 第一轮：精确命中字段名
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = asMediaValue(data[key]);
    if (value !== undefined) return value;
  }
  // 第二轮：忽略大小写
  for (const objKey of objKeys) {
    if (!wanted.includes(objKey.toLowerCase())) continue;
    const value = asMediaValue(data[objKey]);
    if (value !== undefined) return value;
  }
  // 第三轮：继续下钻
  for (const objKey of objKeys) {
    const found = deepFind(data[objKey], keys, level + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function asMediaValue(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .filter((item) => typeof item === "string" && item.trim())
      .join("\n")
      .trim();
    return text ? text : undefined;
  }
  return undefined;
}

function scanUrls(data, acc, depth) {
  const result = acc || [];
  const level = depth || 0;
  if (level > 8) return result;
  if (typeof data === "string") {
    const matches = data.match(/https?:\/\/[^\s"'<>\\]+/g);
    if (matches) {
      for (const url of matches) result.push(url);
    }
    return result;
  }
  if (Array.isArray(data)) {
    for (const item of data) scanUrls(item, result, level + 1);
    return result;
  }
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) scanUrls(data[key], result, level + 1);
  }
  return result;
}

function normalizeLyrics(text) {
  const content = String(text == null ? "" : text).trim();
  // LRC 歌词带 [mm:ss.xxx] 时间轴，去掉后再发送，避免刷屏
  if (!/\[\d{1,2}:\d{1,2}/.test(content)) return content;
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!line) continue;
    if (lines.length && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  return lines.join("\n");
}

function extractKfcText(data) {
  const direct = deepFind(data, ["text", "content", "copy", "文案", "message", "msg", "result", "answer", "data"]);
  if (typeof direct === "string" && !isHttpUrl(direct)) return direct;
  if (typeof data === "string") return data.trim();
  return "";
}

function randomKfcCopy() {
  const index = Math.floor(Math.random() * KFC_FALLBACK.length);
  return KFC_FALLBACK[index];
}

function toPlainText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function clipText(text, limit) {
  const content = String(text == null ? "" : text).trim();
  if (content.length <= limit) return content;
  return content.slice(0, limit) + "\n……（内容过长已截断）";
}

function truncate(text, limit) {
  const content = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (content.length <= limit) return content;
  return content.slice(0, limit) + "…";
}

main().catch(async (error) => {
  console.error("[entertainmentKit]", error && error.message ? error.message : error);
  try {
    await s.reply(`执行失败：${error && error.message ? error.message : error}`);
  } catch (_) {
    // 回复失败时不再抛出，避免插件异常堆栈污染日志
  }
});
