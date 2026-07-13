'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ExcelJS = require('exceljs');
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} = require('docx');

const BRAND = 'FeiGe';
const HTML_COLORS = {
  background: '#0e0d0b',
  surface: '#1b1813',
  accent: '#e0a53f'
};

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pad2(value) {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0');
}

function formatTimecode(seconds) {
  const value = Math.max(0, finiteNumber(seconds));
  return `${pad2(value / 3600)}:${pad2((value % 3600) / 60)}:${pad2(value % 60)}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, finiteNumber(seconds));
  return formatTimecode(value);
}

function formatBytes(bytes) {
  const value = finiteNumber(bytes, NaN);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** exponent);
  return `${scaled >= 100 || exponent === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[exponent]}`;
}

function formatBitrate(bitrate) {
  const value = finiteNumber(bitrate, NaN);
  if (!Number.isFinite(value) || value <= 0) return stringValue(bitrate);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)} Kbps`;
  return `${value.toFixed(0)} bps`;
}

function formatFps(fps) {
  const value = finiteNumber(fps, NaN);
  if (!Number.isFinite(value) || value <= 0) return stringValue(fps);
  return `${Number(value.toFixed(3))} fps`;
}

function normalizeShot(shot = {}, index = 0) {
  const startSec = Math.max(0, finiteNumber(shot.startSec ?? shot.start, 0));
  const inferredEnd = finiteNumber(shot.endSec ?? shot.end, startSec);
  const durationSec = Math.max(0, finiteNumber(shot.durationSec ?? shot.duration, inferredEnd - startSec));
  const endSec = Math.max(startSec, Number.isFinite(inferredEnd) ? inferredEnd : startSec + durationSec);
  const tcStart = stringValue(shot.tcStart ?? shot.startTc) || formatTimecode(startSec);
  const tcEnd = stringValue(shot.tcEnd ?? shot.endTc) || formatTimecode(endSec);

  return {
    number: finiteNumber(shot.number ?? shot.index, index + 1),
    shotType: stringValue(shot.shotType ?? shot.shotSize),
    angle: stringValue(shot.angle),
    cameraMove: stringValue(shot.cameraMove ?? shot.movement),
    description: stringValue(shot.description),
    dialogue: stringValue(shot.dialogue),
    sound: stringValue(shot.sound),
    startSec,
    endSec,
    durationSec: Math.max(durationSec, endSec - startSec),
    timeRange: stringValue(shot.timeRange) || `${tcStart} – ${tcEnd}`,
    tcStart,
    tcEnd,
    frame: shot.frame ?? shot.framePath ?? shot.keyFrame ?? '',
    scene: stringValue(shot.scene),
    timeOfDay: stringValue(shot.timeOfDay),
    interiorExterior: stringValue(shot.interiorExterior),
    raw: shot
  };
}

function normalizeShots(item = {}) {
  return (Array.isArray(item.shots) ? item.shots : []).map(normalizeShot);
}

function countScenes(item, shots) {
  const explicit = finiteNumber(item.sceneCount, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const scenes = new Set(
    shots
      .map(shot => [shot.scene, shot.timeOfDay, shot.interiorExterior].filter(Boolean).join('|'))
      .filter(Boolean)
  );
  return scenes.size;
}

function buildMeta(item = {}, shots, generatedAt) {
  const source = item.videoMeta || item.meta || {};
  const durationSec = Math.max(0, finiteNumber(source.durationSec ?? source.duration ?? item.durationSec ?? item.duration, 0));
  const width = finiteNumber(source.width ?? item.width, 0);
  const height = finiteNumber(source.height ?? item.height, 0);
  const resolution = stringValue(source.resolution ?? item.resolution) || (width && height ? `${width} × ${height}` : '');
  const videoPath = stringValue(item.videoPath ?? source.videoPath);
  const rawSize = source.size ?? source.fileSize ?? item.size ?? item.fileSize;
  const rawBitrate = source.bitrate ?? item.bitrate;

  return {
    projectName: stringValue(item.projectName ?? item.name) || '未命名项目',
    videoName: stringValue(item.videoName ?? source.videoName) || (videoPath ? path.basename(videoPath) : ''),
    durationSec,
    duration: stringValue(source.durationText ?? item.durationText) || formatDuration(durationSec),
    resolution,
    fps: formatFps(source.fps ?? item.fps),
    bitrate: typeof rawBitrate === 'string' ? rawBitrate : formatBitrate(rawBitrate),
    size: typeof rawSize === 'string' ? rawSize : formatBytes(rawSize),
    codec: stringValue(source.codec ?? item.codec),
    generatedAt: generatedAt || new Date().toISOString(),
    sceneCount: countScenes(item, shots),
    shotCount: shots.length
  };
}

function extensionFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  return '';
}

function mimeFromBuffer(buffer, fileName = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(stringValue(value));
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  return {
    buffer,
    mime: match[1].toLowerCase(),
    dataUrl: `data:${match[1].toLowerCase()};base64,${buffer.toString('base64')}`
  };
}

function placeholderDataUrl(number) {
  const label = String(number).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="${HTML_COLORS.surface}"/><path d="M0 430L255 236l176 136 132-107 397 275H0z" fill="#2b261d"/><circle cx="740" cy="145" r="58" fill="${HTML_COLORS.accent}" opacity=".7"/><text x="48" y="75" fill="#d8cfbf" font-family="Arial,sans-serif" font-size="28">${BRAND} · 镜 ${label}</text><text x="480" y="290" fill="#8e826e" font-family="Arial,sans-serif" font-size="24" text-anchor="middle">关键帧不可用</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function candidateFramePaths(item, shot, options) {
  const frame = shot.frame;
  if (typeof frame !== 'string' || !frame || frame.startsWith('data:')) return [];
  if (path.isAbsolute(frame)) return [frame];

  const roots = [
    options.frameDir,
    options.framesDir,
    options.projectDir && path.join(options.projectDir, 'frames'),
    item.frameDir,
    item.framesDir,
    item.projectDir && path.join(item.projectDir, 'frames')
  ].filter(Boolean);

  return [...new Set(roots.map(root => {
    const resolvedRoot = path.resolve(String(root));
    const resolvedFile = path.resolve(resolvedRoot, frame);
    const relative = path.relative(resolvedRoot, resolvedFile);
    return relative.startsWith('..') || path.isAbsolute(relative) ? null : resolvedFile;
  }).filter(Boolean))];
}

async function readFrameAsset(item, shot, options = {}) {
  let source = options.frameMap?.[shot.frame] ?? item.frameMap?.[shot.frame] ?? shot.frame;
  if (typeof options.resolveFrame === 'function') {
    const resolved = await options.resolveFrame(shot.raw, item, shot);
    if (resolved != null) source = resolved;
  }

  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const buffer = Buffer.from(source);
    const mime = mimeFromBuffer(buffer);
    return { buffer, mime, extension: extensionFromMime(mime), dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  }

  const inline = parseDataUrl(source);
  if (inline) return { ...inline, extension: extensionFromMime(inline.mime) };

  for (const file of candidateFramePaths(item, { ...shot, frame: source }, options)) {
    try {
      const buffer = await fsp.readFile(file);
      const mime = mimeFromBuffer(buffer, file);
      return { buffer, mime, extension: extensionFromMime(mime), dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, file };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  if (options.strictFrames) throw new Error(`镜 ${shot.number} 的关键帧不可读取：${stringValue(source) || '未提供路径'}`);
  return { buffer: null, mime: 'image/svg+xml', extension: '', dataUrl: placeholderDataUrl(shot.number), missing: true };
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value) {
  return stringValue(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function htmlDocument(payload) {
  const title = `${payload.meta.projectName} · ${BRAND}`;
  const data = jsonForHtml(payload);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:dark;--bg:${HTML_COLORS.background};--surface:${HTML_COLORS.surface};--surface2:#242018;--text:#f4eee3;--muted:#a99e8b;--line:#3b3428;--accent:${HTML_COLORS.accent};--accent2:#f0c46c;--shadow:0 24px 70px rgba(0,0,0,.36)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 50% -10%,#302717 0,transparent 34rem),var(--bg);color:var(--text);font:15px/1.65 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;transition:background .2s,color .2s}button,input{font:inherit}button{color:inherit}
    body[data-theme="paper"]{color-scheme:light;--bg:#f4efe5;--surface:#fffdf8;--surface2:#eee6d7;--text:#231f19;--muted:#776c5b;--line:#d5c9b8;--shadow:0 18px 50px rgba(66,51,30,.12);background:var(--bg)}
    .shell{width:min(1520px,calc(100% - 40px));margin:auto;padding:34px 0 80px}.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:26px;background:linear-gradient(145deg,rgba(224,165,63,.12),transparent 42%),var(--surface);box-shadow:var(--shadow);padding:34px}.hero:after{content:"";position:absolute;right:-80px;top:-160px;width:360px;height:360px;border:1px solid rgba(224,165,63,.2);border-radius:50%;box-shadow:0 0 0 36px rgba(224,165,63,.04),0 0 0 76px rgba(224,165,63,.025)}
    .brand{position:relative;z-index:1;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.25em;text-transform:uppercase}.hero h1{position:relative;z-index:1;margin:.3rem 0 0;font:700 clamp(30px,4vw,58px)/1.12 Georgia,"Songti SC",serif;max-width:980px}.subline{position:relative;z-index:1;display:flex;flex-wrap:wrap;gap:12px 26px;margin-top:16px;color:var(--muted)}
    .meta-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-top:30px}.meta{min-height:76px;padding:13px 15px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--surface2) 86%,transparent)}.meta span{display:block;color:var(--muted);font-size:11px;letter-spacing:.08em}.meta b{display:block;margin-top:3px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .toolbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;margin:18px 0;padding:12px;border:1px solid var(--line);border-radius:16px;background:color-mix(in srgb,var(--surface) 90%,transparent);backdrop-filter:blur(18px);box-shadow:0 12px 30px rgba(0,0,0,.12)}.search{position:relative;flex:1}.search input{width:100%;border:1px solid var(--line);border-radius:11px;background:var(--surface2);color:var(--text);padding:10px 42px 10px 14px;outline:none}.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(224,165,63,.14)}.count{position:absolute;right:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:12px}.tool-button{border:1px solid var(--line);border-radius:10px;background:var(--surface2);padding:9px 13px;cursor:pointer}.tool-button:hover,.tool-button.active{border-color:var(--accent);color:var(--accent2)}.switch{display:flex;gap:4px;padding:3px;border:1px solid var(--line);border-radius:12px}.switch .tool-button{border:0;background:transparent}.switch .active{background:var(--surface2)}
    .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.card{display:grid;grid-template-columns:minmax(260px,42%) 1fr;min-height:250px;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--surface);box-shadow:0 14px 40px rgba(0,0,0,.12)}.frame-button{position:relative;min-height:250px;padding:0;border:0;background:#050504;cursor:zoom-in;overflow:hidden}.frame-button img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s}.frame-button:hover img{transform:scale(1.025)}.frame-index{position:absolute;left:14px;top:14px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:rgba(14,13,11,.78);color:white;padding:5px 11px;font-weight:800;backdrop-filter:blur(8px)}.card-body{padding:20px 22px}.shot-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.shot-top h2{margin:0;font:700 23px/1.2 Georgia,serif}.time{color:var(--accent);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}.tags{display:flex;flex-wrap:wrap;gap:7px;margin:13px 0}.tag{border:1px solid var(--line);border-radius:999px;color:var(--muted);padding:3px 9px;font-size:12px}.description{margin:11px 0;color:var(--text)}.detail{display:grid;grid-template-columns:52px 1fr;gap:10px;padding-top:8px;margin-top:8px;border-top:1px dashed var(--line);font-size:13px}.detail b{color:var(--accent);font-weight:600}.detail span{white-space:pre-wrap}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:17px;background:var(--surface)}table{width:100%;min-width:1380px;border-collapse:collapse}th{position:sticky;top:0;z-index:2;background:#19150f;color:var(--accent);font-size:12px;letter-spacing:.06em}body[data-theme="paper"] th{background:#e9dfcf;color:#6b4a10}th,td{padding:11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td{white-space:pre-wrap}td:nth-child(1){font-weight:800;color:var(--accent)}.table-frame{width:170px;height:96px;padding:0;border:0;background:#050504;cursor:zoom-in}.table-frame img{width:100%;height:100%;object-fit:cover;display:block}.hidden{display:none!important}.empty{padding:70px 20px;text-align:center;color:var(--muted)}
    dialog{width:min(1200px,94vw);max-width:none;padding:0;border:1px solid #4b4030;border-radius:18px;background:#090806;color:#fff;box-shadow:0 30px 100px #000}dialog::backdrop{background:rgba(0,0,0,.88);backdrop-filter:blur(5px)}.lightbox-head{display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid #2d281f}.lightbox-head button{border:0;background:transparent;color:#fff;font-size:25px;cursor:pointer}.lightbox img{display:block;width:100%;max-height:82vh;object-fit:contain;background:#000}.lightbox-caption{color:#c8bda8;font-size:13px}
    @media(max-width:1180px){.meta-grid{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:1fr}}@media(max-width:720px){.shell{width:min(100% - 20px,1520px);padding-top:10px}.hero{padding:24px 19px}.meta-grid{grid-template-columns:repeat(2,1fr)}.toolbar{flex-wrap:wrap}.search{flex-basis:100%}.card{grid-template-columns:1fr}.frame-button{min-height:210px}}
    @media print{@page{size:A4 landscape;margin:10mm}body{--bg:#fff;--surface:#fff;--surface2:#fff;--text:#111;--muted:#555;--line:#bbb;background:#fff!important}.shell{width:100%;padding:0}.hero{box-shadow:none;border-radius:0;padding:0 0 14px}.hero:after,.toolbar{display:none!important}.hero h1{font-size:28px}.meta-grid{grid-template-columns:repeat(6,1fr);gap:4px}.meta{min-height:0;padding:6px;border-radius:0}.meta span{font-size:8px}.meta b{font-size:9px}.cards{display:none!important}.table-wrap{display:block!important;border:0;border-radius:0;overflow:visible}table{min-width:0;font-size:8px;table-layout:fixed}th{position:static;background:#eee!important;color:#111!important}th,td{padding:4px;border:1px solid #aaa}.table-frame{width:105px;height:60px}.empty,dialog{display:none!important}}
  </style>
</head>
<body data-theme="dark">
  <main class="shell">
    <section class="hero">
      <div class="brand">${BRAND} · STORYBOARD</div>
      <h1 id="projectTitle"></h1>
      <div class="subline"><span id="videoName"></span><span id="durationLine"></span><span id="generatedAt"></span></div>
      <div id="metaGrid" class="meta-grid"></div>
    </section>
    <nav class="toolbar" aria-label="分镜工具栏">
      <label class="search"><input id="search" type="search" placeholder="搜索景别、描述、台词或音效…" autocomplete="off"><span id="resultCount" class="count"></span></label>
      <div class="switch" aria-label="显示方式"><button class="tool-button active" data-view="cards">卡片</button><button class="tool-button" data-view="table">9 列表格</button></div>
      <button id="themeButton" class="tool-button">纸张主题</button>
      <button id="printButton" class="tool-button">打印</button>
    </nav>
    <section id="cards" class="cards"></section>
    <section id="tableView" class="table-wrap hidden"><table><thead><tr><th>镜号</th><th>关键帧</th><th>景别</th><th>角度</th><th>运镜</th><th>时码</th><th>描述</th><th>台词</th><th>音效</th></tr></thead><tbody id="tableBody"></tbody></table></section>
    <div id="emptyResult" class="empty hidden">没有匹配的镜头</div>
  </main>
  <dialog id="lightbox"><div class="lightbox"><div class="lightbox-head"><span id="lightboxCaption" class="lightbox-caption"></span><button id="lightboxClose" aria-label="关闭">×</button></div><img id="lightboxImage" alt="关键帧大图"></div></dialog>
  <script id="feige-data" type="application/json">${data}</script>
  <script>
  (function(){
    'use strict';
    var payload=JSON.parse(document.getElementById('feige-data').textContent);
    var meta=payload.meta,shots=payload.shots;
    var cards=document.getElementById('cards'),tbody=document.getElementById('tableBody');
    function node(tag,className,text){var element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element}
    function detail(label,value){if(!value)return null;var row=node('div','detail'),name=node('b','',label),content=node('span','',value);row.append(name,content);return row}
    function searchable(shot){return [shot.number,shot.shotType,shot.angle,shot.cameraMove,shot.description,shot.dialogue,shot.sound,shot.timeRange].join(' ').toLowerCase()}
    function openFrame(shot){document.getElementById('lightboxImage').src=shot.frame;document.getElementById('lightboxCaption').textContent='镜 '+shot.number+' · '+shot.timeRange;document.getElementById('lightbox').showModal()}
    function frameButton(shot,table){var button=node('button',table?'table-frame':'frame-button');button.type='button';button.setAttribute('aria-label','放大镜 '+shot.number+' 关键帧');var image=node('img');image.src=shot.frame;image.alt='镜 '+shot.number+' 关键帧';image.loading='lazy';button.appendChild(image);if(!table)button.appendChild(node('span','frame-index','#'+String(shot.number).padStart(3,'0')));button.addEventListener('click',function(){openFrame(shot)});return button}
    function renderCard(shot){var card=node('article','card');card.dataset.search=searchable(shot);card.appendChild(frameButton(shot,false));var body=node('div','card-body'),top=node('div','shot-top'),title=node('h2','',shot.shotType||('镜 '+shot.number)),time=node('div','time',shot.timeRange);top.append(title,time);body.appendChild(top);var tags=node('div','tags');[shot.shotType,shot.angle,shot.cameraMove].filter(Boolean).forEach(function(value){tags.appendChild(node('span','tag',value))});if(tags.children.length)body.appendChild(tags);body.appendChild(node('p','description',shot.description||'暂无描述'));var dialogue=detail('台词',shot.dialogue),sound=detail('音效',shot.sound);if(dialogue)body.appendChild(dialogue);if(sound)body.appendChild(sound);card.appendChild(body);cards.appendChild(card)}
    function renderRow(shot){var row=node('tr');row.dataset.search=searchable(shot);row.appendChild(node('td','',String(shot.number)));var frameCell=node('td');frameCell.appendChild(frameButton(shot,true));row.appendChild(frameCell);[shot.shotType,shot.angle,shot.cameraMove,shot.timeRange,shot.description,shot.dialogue,shot.sound].forEach(function(value){row.appendChild(node('td','',value))});tbody.appendChild(row)}
    function populateMeta(){document.getElementById('projectTitle').textContent=meta.projectName;document.getElementById('videoName').textContent=meta.videoName||'未记录源视频';document.getElementById('durationLine').textContent='总时长 '+meta.duration;document.getElementById('generatedAt').textContent='生成于 '+new Date(meta.generatedAt).toLocaleString();var values=[['镜头',meta.shotCount],['场景',meta.sceneCount],['分辨率',meta.resolution||'—'],['帧率',meta.fps||'—'],['码率',meta.bitrate||'—'],['文件大小',meta.size||'—'],['编码',meta.codec||'—'],['总秒数',Number(meta.durationSec||0).toFixed(2)+' s']];var grid=document.getElementById('metaGrid');values.forEach(function(entry){var box=node('div','meta');box.append(node('span','',entry[0]),node('b','',String(entry[1])));grid.appendChild(box)})}
    function applySearch(){var query=document.getElementById('search').value.trim().toLowerCase(),visible=0;Array.prototype.forEach.call(cards.children,function(card){var show=!query||card.dataset.search.indexOf(query)!==-1;card.classList.toggle('hidden',!show);if(show)visible++});Array.prototype.forEach.call(tbody.children,function(row){row.classList.toggle('hidden',!!query&&row.dataset.search.indexOf(query)===-1)});document.getElementById('resultCount').textContent=visible+'/'+shots.length;document.getElementById('emptyResult').classList.toggle('hidden',visible!==0)}
    populateMeta();shots.forEach(function(shot){renderCard(shot);renderRow(shot)});applySearch();
    document.getElementById('search').addEventListener('input',applySearch);
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'),function(button){button.addEventListener('click',function(){var table=button.dataset.view==='table';cards.classList.toggle('hidden',table);document.getElementById('tableView').classList.toggle('hidden',!table);Array.prototype.forEach.call(document.querySelectorAll('[data-view]'),function(other){other.classList.toggle('active',other===button)})})});
    document.getElementById('themeButton').addEventListener('click',function(){var paper=document.body.dataset.theme!=='paper';document.body.dataset.theme=paper?'paper':'dark';this.textContent=paper?'暗色主题':'纸张主题'});
    document.getElementById('printButton').addEventListener('click',function(){window.print()});document.getElementById('lightboxClose').addEventListener('click',function(){document.getElementById('lightbox').close()});document.getElementById('lightbox').addEventListener('click',function(event){if(event.target===this)this.close()});
  })();
  </script>
</body>
</html>`;
}

async function exportHtml(item, outputPath, options = {}) {
  const shots = normalizeShots(item);
  const assets = await Promise.all(shots.map(shot => readFrameAsset(item, shot, options)));
  const payload = {
    meta: buildMeta(item, shots, options.generatedAt),
    scenes: Array.isArray(item.scenes) ? item.scenes : [],
    shots: shots.map((shot, index) => ({
      number: shot.number,
      shotType: shot.shotType,
      angle: shot.angle,
      cameraMove: shot.cameraMove,
      description: shot.description,
      dialogue: shot.dialogue,
      sound: shot.sound,
      startSec: shot.startSec,
      timeRange: shot.timeRange,
      tcStart: shot.tcStart,
      tcEnd: shot.tcEnd,
      frame: assets[index].dataUrl
    }))
  };
  const html = htmlDocument(payload);
  if (!outputPath) return html;
  await ensureParent(outputPath);
  await fsp.writeFile(outputPath, html, 'utf8');
  return outputPath;
}

function applyThinBorder(cell) {
  const side = { style: 'thin', color: { argb: 'FFD9E1F2' } };
  cell.border = { top: side, left: side, bottom: side, right: side };
}

async function exportStoryboardXlsx(item, outputPath, options = {}) {
  const shots = normalizeShots(item);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = BRAND;
  workbook.lastModifiedBy = BRAND;
  workbook.company = BRAND;
  workbook.subject = '分镜表';
  workbook.title = `${stringValue(item.name ?? item.projectName) || '项目'} 分镜表`;
  workbook.created = new Date(options.generatedAt || Date.now());
  workbook.modified = workbook.created;

  const sheet = workbook.addWorksheet('分镜表', {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }],
    pageSetup: { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });
  sheet.properties.defaultRowHeight = 20;
  sheet.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
  sheet.pageSetup.printTitlesRow = '1:1';
  sheet.columns = [
    { header: '镜号', key: 'number', width: 8 },
    { header: '景别', key: 'shotType', width: 12 },
    { header: '角度', key: 'angle', width: 12 },
    { header: '运镜', key: 'cameraMove', width: 14 },
    { header: '关键帧', key: 'frame', width: 40 },
    { header: '时长', key: 'duration', width: 14 },
    { header: '描述', key: 'description', width: 50 },
    { header: '台词', key: 'dialogue', width: 40 },
    { header: '音效', key: 'sound', width: 30 }
  ];

  const header = sheet.getRow(1);
  header.height = 30;
  header.eachCell(cell => {
    cell.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002060' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    applyThinBorder(cell);
  });

  for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
    const shot = shots[shotIndex];
    const row = sheet.getRow(shotIndex + 2);
    row.values = [shot.number, shot.shotType, shot.angle, shot.cameraMove, '', shot.timeRange, shot.description, shot.dialogue, shot.sound];
    row.height = 140;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: '微软雅黑', size: 10, color: { argb: 'FF222222' } };
      cell.alignment = { vertical: 'top', horizontal: cell.col <= 6 ? 'center' : 'left', wrapText: true };
      applyThinBorder(cell);
    });
    const asset = await readFrameAsset(item, shot, options);
    if (asset.buffer && ['jpeg', 'png', 'gif'].includes(asset.extension)) {
      const imageId = workbook.addImage({ buffer: asset.buffer, extension: asset.extension });
      sheet.addImage(imageId, {
        tl: { col: 4, row: row.number - 1 },
        br: { col: 5, row: row.number },
        editAs: 'oneCell'
      });
    } else {
      row.getCell(5).value = '关键帧不可用';
      row.getCell(5).font = { name: '微软雅黑', size: 9, italic: true, color: { argb: 'FF808080' } };
    }
  }

  if (outputPath) {
    await ensureParent(outputPath);
    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function inlineRuns(value, base = {}) {
  const source = String(value || '');
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  const runs = [];
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) runs.push(new TextRun({ ...base, text: source.slice(cursor, match.index) }));
    const token = match[0];
    if (token.startsWith('**')) runs.push(new TextRun({ ...base, text: token.slice(2, -2), bold: true }));
    else if (token.startsWith('`')) runs.push(new TextRun({ ...base, text: token.slice(1, -1), font: 'Consolas', shading: { fill: 'EFECE6' } }));
    else runs.push(new TextRun({ ...base, text: token.slice(1, -1), italics: true }));
    cursor = match.index + token.length;
  }
  if (cursor < source.length) runs.push(new TextRun({ ...base, text: source.slice(cursor) }));
  return runs.length ? runs : [new TextRun({ ...base, text: source })];
}

function scriptParagraphs(markdown) {
  const source = String(markdown || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const paragraphs = [];
  let hasTitle = false;

  for (const original of lines) {
    const line = original.trimEnd();
    if (!line.trim()) {
      paragraphs.push(new Paragraph({ spacing: { after: 40 } }));
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\*\*/g, '').trim();
      if (level === 1) {
        hasTitle = true;
        paragraphs.push(new Paragraph({
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 360 },
          children: [new TextRun({ text, bold: true, size: 56, font: '微软雅黑', color: '1F1F1F' })]
        }));
      } else if (level === 2) {
        paragraphs.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          keepNext: true,
          spacing: { before: 280, after: 120 },
          children: [new TextRun({ text, bold: true, size: 26, font: '微软雅黑', color: '2E74B5' })]
        }));
      } else {
        paragraphs.push(new Paragraph({
          heading: level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
          keepNext: true,
          spacing: { before: 180, after: 80 },
          children: [new TextRun({ text, bold: true, size: 22, font: '微软雅黑', color: '3D5E7C' })]
        }));
      }
      continue;
    }

    if (/^人物[：:]/.test(line.trim())) {
      paragraphs.push(new Paragraph({
        spacing: { after: 80 },
        children: inlineRuns(line.trim(), { size: 18, font: '微软雅黑', color: '808080' })
      }));
      continue;
    }

    if (/^△/.test(line.trim())) {
      paragraphs.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 100 },
        children: inlineRuns(line.trim(), { size: 20, font: '微软雅黑', color: '666666', italics: true })
      }));
      continue;
    }

    if (/^【字幕[：:]/.test(line.trim())) {
      paragraphs.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 100 },
        children: inlineRuns(line.trim(), { size: 20, font: '微软雅黑', color: 'CC8833' })
      }));
      continue;
    }

    const dialogue = /^([^：:\n]{1,24})[：:]\s*(.+)$/.exec(line.trim());
    if (dialogue && !/^(源视频|时长|场景数|日期|备注)$/.test(dialogue[1])) {
      paragraphs.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 100 },
        children: [
          new TextRun({ text: `${dialogue[1]}：`, bold: true, size: 20, font: '微软雅黑', color: 'D4A373' }),
          ...inlineRuns(dialogue[2], { size: 20, font: '微软雅黑', color: '333333' })
        ]
      }));
      continue;
    }

    const metadata = /^(源视频|时长|场景数|日期|备注)[：:]\s*(.*)$/.exec(line.trim());
    if (metadata) {
      paragraphs.push(new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${metadata[1]}：`, bold: true, size: 19, font: '微软雅黑', color: '666666' }),
          new TextRun({ text: metadata[2], size: 19, font: '微软雅黑', color: '666666' })
        ]
      }));
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(line.trim());
    if (bullet) {
      paragraphs.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80 },
        children: inlineRuns(bullet[1], { size: 20, font: '微软雅黑', color: '333333' })
      }));
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line.trim());
    if (quote) {
      paragraphs.push(new Paragraph({
        indent: { left: 480, right: 360 },
        spacing: { after: 90 },
        children: inlineRuns(quote[1], { size: 20, font: '微软雅黑', color: '666666', italics: true })
      }));
      continue;
    }

    paragraphs.push(new Paragraph({
      spacing: { after: 100, line: 320 },
      children: inlineRuns(line.trim(), { size: 20, font: '微软雅黑', color: '333333' })
    }));
  }

  if (!hasTitle) {
    paragraphs.unshift(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 360 },
      children: [new TextRun({ text: '剧本', bold: true, size: 56, font: '微软雅黑', color: '1F1F1F' })]
    }));
  }
  return paragraphs;
}

async function exportScriptDocx(item, outputPath, options = {}) {
  const script = options.markdown ?? options.script ?? item.script ?? '';
  const title = stringValue(item.name ?? item.projectName) || '剧本';
  const children = scriptParagraphs(script || '# 剧本\n\n暂无剧本内容。');
  const document = new Document({
    creator: BRAND,
    lastModifiedBy: BRAND,
    title: `${title} 剧本`,
    subject: '剧本',
    description: `${BRAND} 剧本导出`,
    styles: {
      default: {
        document: {
          run: { font: '微软雅黑', size: 20, color: '333333' },
          paragraph: { spacing: { line: 320, after: 100 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 }
        }
      },
      children
    }]
  });
  const buffer = Buffer.from(await Packer.toBuffer(document));
  if (!outputPath) return buffer;
  await ensureParent(outputPath);
  await fsp.writeFile(outputPath, buffer);
  return outputPath;
}

function safeFileName(value) {
  const cleaned = stringValue(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || 'FeiGe';
}

async function exportAll(item, outputDir, options = {}) {
  if (!outputDir) throw new Error('请选择导出文件夹');
  await fsp.mkdir(outputDir, { recursive: true });
  const baseName = safeFileName(options.baseName || item.name || item.projectName || BRAND);
  const paths = {
    html: path.join(outputDir, `${baseName}.html`),
    xlsx: path.join(outputDir, '分镜表.xlsx'),
    docx: path.join(outputDir, '剧本.docx')
  };
  await Promise.all([
    exportHtml(item, paths.html, options),
    exportStoryboardXlsx(item, paths.xlsx, options),
    exportScriptDocx(item, paths.docx, options)
  ]);
  return paths;
}

module.exports = {
  exportAll,
  exportHtml,
  exportScriptDocx,
  exportStoryboardXlsx
};
