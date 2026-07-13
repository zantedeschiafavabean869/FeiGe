'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const {
  t,
  getLocale,
  setLocale,
  apply: applyTranslations,
  localizeRuntimeMessage,
  localizeError
} = window.FeigeI18n;

const ALL_SCENES = '__all__';

let state = {
  lists: { projects: [], research: [] },
  current: null,
  currentKind: 'project',
  settings: null,
  newKind: 'project',
  providerId: 'openai',
  analysisActive: false,
  uiBusy: false,
  activeScene: ALL_SCENES,
  activeTab: 'shots',
  editing: null,
  lastProgress: null,
  localeChanging: false,
  renderToken: 0,
  frameCache: new Map()
};

function icon(name, className = '') {
  return `<svg class="icon${className ? ` ${className}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function formatTime(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  return [Math.floor(sec / 3600), Math.floor(sec % 3600 / 60), Math.floor(sec % 60)]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
}

function projectCount(count) {
  const key = getLocale() === 'en-US' && Number(count) === 1 ? 'project.shotCountOne' : 'project.shotCount';
  return t(key, { count: Number(count) || 0 });
}

function toast(message, duration = 3600) {
  const element = $('#toast');
  element.textContent = String(message || '');
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), duration);
}

function updateActionStates() {
  const hasCurrent = Boolean(state.current);
  const shots = state.current?.shots || [];
  const hasShots = shots.length > 0;
  const hasFailed = shots.some(shot => shot.analysisStatus === 'failed');
  const busy = state.uiBusy || state.analysisActive;

  $('#detectBtn').disabled = !hasCurrent || busy;
  $('#manualCut').disabled = !hasCurrent || busy;
  $('#analyzeAll').disabled = !hasShots || busy;
  $('#retryFailed').disabled = !hasFailed || busy;
  $('#generateScript').disabled = !hasShots || busy;
  $('#saveScript').disabled = !hasCurrent || busy;
  $('#regenerateScript').disabled = !hasShots || busy;
  $('#scriptVersion').disabled = !hasCurrent || busy || !(state.current?.scriptVersions?.length);
  $('#deleteScriptVersion').disabled = !hasCurrent || busy || !(state.current?.scriptVersions?.length);
  $('#openFolder').disabled = !hasCurrent || busy;
  $('#exportScript').disabled = !hasCurrent || busy;
  $('#exportBoard').disabled = !hasCurrent || busy;
  $('#exportHtml').disabled = !hasCurrent || busy;
  $('#exportAll').disabled = !hasCurrent || busy;
  $$('[data-analyze]').forEach(button => { button.disabled = busy; });
  $$('[data-shot-edit],[data-shot-delete]').forEach(button => {
    const shotId=button.dataset.shotEdit||button.dataset.shotDelete;
    const locked=shots.find(shot=>shot.id===shotId)?.analysisStatus==='running';
    button.disabled=busy||locked;
  });
  $$('[data-script-edit],[data-script-insert],[data-script-delete]').forEach(button => { button.disabled=busy; });
  $$('.nav-item, [data-kind]').forEach(button => { button.disabled = busy; });
}

function splitScriptScenesClient(script) {
  const text = String(script || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/), preamble = [], scenes = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) scenes.push(current.join('\n').trim());
      current = [line];
    } else if (current) current.push(line);
    else preamble.push(line);
  }
  if (current) scenes.push(current.join('\n').trim());
  if (!scenes.length) return [text];
  if (preamble.some(line => line.trim())) scenes[0] = `${preamble.join('\n').trim()}\n\n${scenes[0]}`;
  return scenes.filter(Boolean);
}

function closeEditDialogs() {
  for (const selector of ['#shotEditDialog','#sceneEditDialog']) {
    const dialog = $(selector);
    if (dialog?.open) dialog.close();
  }
  state.editing = null;
}

function versionLabel(version) {
  const provider = [version.providerLabel, version.model].filter(Boolean).join(' · ') || t('script.unknownProvider');
  return `${provider} · ${new Date(version.createdAt).toLocaleString(getLocale())}`;
}

function renderScriptPanel() {
  const item = state.current;
  const versions = item?.scriptVersions || [];
  $('#scriptVersion').innerHTML = versions.length
    ? versions.map(version => `<option value="${esc(version.id)}" ${String(version.id) === String(item.activeScriptVersionId) ? 'selected' : ''}>${esc(versionLabel(version))}</option>`).join('')
    : `<option value="">${esc(t('script.noVersions'))}</option>`;
  const scenes = item?.scriptScenes?.length ? item.scriptScenes : splitScriptScenesClient(item?.script);
  if (item) item.scriptScenes = scenes;
  $('#scriptScenes').innerHTML = scenes.length ? scenes.map((scene, index) => {
    const title = scene.match(/^##\s+(.+)$/m)?.[1] || t('script.sceneNumber', { number:index + 1 });
    return `<article class="script-scene" data-script-index="${index}">
      <header><span><small>${esc(t('script.sceneLabel', { number:index + 1 }))}</small><b>${esc(title)}</b></span><div class="scene-actions">
        <button type="button" data-script-edit="${index}" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">${icon('script')}<span>${esc(t('common.edit'))}</span></button>
        <button type="button" data-script-insert="${index}" aria-label="${esc(t('common.insertAfter'))}" title="${esc(t('common.insertAfter'))}">${icon('plus')}<span>${esc(t('common.insertAfter'))}</span></button>
        <button type="button" data-script-delete="${index}" class="danger-quiet" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}">${icon('close')}<span>${esc(t('common.delete'))}</span></button>
      </div></header><pre>${esc(scene)}</pre></article>`;
  }).join('') : `<div class="empty-script"><b>${esc(t('script.emptyTitle'))}</b><p>${esc(t('script.emptyBody'))}</p></div>`;
  $('#scriptEditor').value = item?.script || '';
  updateActionStates();
}

function drawDifferenceCurve() {
  const canvas = $('#differenceCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.setTransform(ratio,0,0,ratio,0,0);
  context.clearRect(0,0,rect.width,rect.height);
  context.fillStyle = '#090b0e'; context.fillRect(0,0,rect.width,rect.height);
  const scores = state.current?.sceneScores || [];
  const duration = Number(state.current?.duration) || 0;
  if (scores.length && duration) {
    const max = Math.max(0.01,...scores.map(point => Number(point.score) || 0));
    context.beginPath();
    scores.forEach((point,index) => {
      const x = (point.time / duration) * rect.width;
      const y = rect.height - 5 - ((point.score || 0) / max) * (rect.height - 12);
      if (!index) context.moveTo(x,y); else context.lineTo(x,y);
    });
    context.strokeStyle = '#5db6f2'; context.lineWidth = 1; context.stroke();
    context.lineTo(rect.width,rect.height);context.lineTo(0,rect.height);context.closePath();
    const gradient=context.createLinearGradient(0,0,0,rect.height);gradient.addColorStop(0,'rgba(93,182,242,.24)');gradient.addColorStop(1,'rgba(93,182,242,0)');context.fillStyle=gradient;context.fill();
    context.strokeStyle='rgba(225,173,96,.8)';context.lineWidth=1;
    for(const shot of (state.current?.shots||[]).slice(1)){const x=(shot.start/duration)*rect.width;context.beginPath();context.moveTo(x,0);context.lineTo(x,rect.height);context.stroke();}
  }
}

function openShotEditor(shotId) {
  const shot = state.current?.shots?.find(entry => entry.id === shotId);
  if (!shot || shot.analysisStatus === 'running') return toast(t('error.shotLocked'));
  state.editing = { kind:'shot', id:shot.id };
  $('#shotEditTitle').textContent = t('shot.editTitle', { number:String(shot.index).padStart(3,'0'), start:shot.startTc, end:shot.endTc });
  const fields = {editScene:'scene',editTimeOfDay:'timeOfDay',editInteriorExterior:'interiorExterior',editShotSize:'shotSize',editAngle:'angle',editMovement:'movement',editDescription:'description',editDialogue:'dialogue',editSound:'sound'};
  for (const [element,field] of Object.entries(fields)) $(`#${element}`).value = shot[field] || '';
  $('#shotEditDialog').showModal();
}

function openSceneEditor(index, mode = 'edit') {
  const scenes = state.current?.scriptScenes || [];
  state.editing = { kind:'script-scene', index:Number(index), mode, versionId:state.current?.activeScriptVersionId };
  $('#sceneEditTitle').textContent = t(mode === 'insert' ? 'script.insertSceneTitle' : 'script.editSceneTitle', { number:Number(index) + 1 });
  $('#editSceneSource').value = mode === 'insert' ? `## ${t('script.newScene')}\n\n` : scenes[index] || '';
  $('#sceneEditDialog').showModal();
}

function showContextMenu(items, x, y) {
  const menu = $('#contextMenu');
  menu.innerHTML = items.map(item => `<button type="button" role="menuitem" data-menu-action="${esc(item.action)}" data-menu-value="${esc(item.value ?? '')}" ${item.disabled ? 'disabled' : ''}>${icon(item.icon || 'marker')}<span>${esc(item.label)}</span></button>`).join('');
  menu.classList.remove('hidden');
  const box=menu.getBoundingClientRect();
  menu.style.left=`${Math.min(x,window.innerWidth-box.width-12)}px`;menu.style.top=`${Math.min(y,window.innerHeight-box.height-12)}px`;
}

function hideContextMenu() { $('#contextMenu')?.classList.add('hidden'); }

function busy(on, message = t('progress.processing'), cancelable = false) {
  state.uiBusy = Boolean(on);
  const overlay = $('#progressOverlay');
  overlay.classList.toggle('hidden', !on);
  overlay.setAttribute('aria-busy', String(Boolean(on)));
  $('#progressText').textContent = message;
  $('#cancelTask').classList.toggle('hidden', !on || !cancelable);
  if (on && cancelable) $('#cancelTask').disabled = false;
  if (!on) $('#progressBar').removeAttribute('value');
  updateActionStates();
}

function showBanner(message, type = 'error') {
  const element = $('#analysisBanner');
  element.textContent = String(message || '');
  element.className = `analysis-banner ${type}`;
}

function clearBanner() {
  $('#analysisBanner').className = 'analysis-banner hidden';
}

function readableError(error) {
  return localizeError(error) || t('error.unexpected', { detail: '' });
}

function providerDisplayName(id, provider) {
  const builtIn = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'qwen']);
  return builtIn.has(id) ? t(`provider.${id}`) : provider.label;
}

async function refreshLists() {
  state.lists = await window.feige.invoke('list-all');
  renderList('projectList', state.lists.projects, 'project');
  renderList('researchList', state.lists.research, 'research');
}

function renderList(id, items, kind) {
  const root = $(`#${id}`);
  const navIcon = kind === 'research' ? 'stack' : 'film';
  root.innerHTML = items.length
    ? items.map(project => `
      <button class="nav-item ${state.current?.id === project.id ? 'active' : ''}" data-id="${esc(project.id)}" data-kind="${kind}" type="button">
        <span class="thumb">${icon(navIcon)}</span>
        <span><span>${esc(project.name)}</span><small>${esc(projectCount(project.shots?.length || 0))}</small></span>
      </button>`).join('')
    : `<div class="nav-empty">${esc(t('nav.empty'))}</div>`;
}

function updateProjectIdentity() {
  if (!state.current) return;
  $('#projectName').textContent = state.current.name;
  $('#videoName').textContent = state.current.videoPath.split(/[\\/]/).pop();
  $('#kindBadge').textContent = t(state.currentKind === 'research' ? 'project.kind.research' : 'project.kind.project');
  $('#durationLabel').textContent = formatTime(state.current.duration);
}

async function openProject(id, kind) {
  closeEditDialogs();
  const item = await window.feige.invoke('load-project', { id, kind });
  state.current = item;
  state.currentKind = kind;
  state.activeScene = ALL_SCENES;
  state.frameCache.clear();
  $('#emptyView').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  updateProjectIdentity();
  $('#video').src = `file:///${item.videoPath.replace(/\\/g, '/')}`;
  $('#scriptEditor').value = item.script || '';
  await renderCurrent({ preserveScroll: false });
  await refreshLists();
}

function analysisLabel(shot) {
  if (shot.analysisStatus === 'running') return `<span class="shot-status running">${esc(t('shot.status.running'))}</span>`;
  if (shot.analysisStatus === 'success' || shot.description) return `<span class="shot-status success">${esc(t('shot.status.success'))}</span>`;
  if (shot.analysisStatus === 'failed') return `<span class="shot-status failed">${esc(t('shot.status.failed'))}</span>`;
  return `<span class="shot-status pending">${esc(t('shot.status.pending'))}</span>`;
}

function setShotCount(count) {
  $('#shotCount').textContent = projectCount(count);
}

function applySceneFilter() {
  $$('.shot-card').forEach(card => {
    const visible = state.activeScene === ALL_SCENES || card.dataset.scene === state.activeScene;
    card.classList.toggle('hidden', !visible);
  });
  $$('#sceneChips [data-scene]').forEach(chip => {
    const selected = chip.dataset.scene === state.activeScene;
    chip.classList.toggle('active', selected);
    chip.setAttribute('aria-pressed', String(selected));
  });
}

async function frameForShot(item, shot) {
  const key = `${item.id}:${shot.id}:${item.updatedAt || ''}`;
  if (state.frameCache.has(key)) return state.frameCache.get(key);
  const source = await window.feige.invoke('local-frame', { item, frame: shot.frame });
  state.frameCache.set(key, source);
  return source;
}

async function renderCurrent({ preserveScroll = true } = {}) {
  const item = state.current;
  const root = $('#shots');
  const previousScroll = preserveScroll ? root.scrollTop : 0;
  const renderToken = ++state.renderToken;
  const shotCount = item?.shots?.length || 0;
  setShotCount(shotCount);

  if (!shotCount) {
    root.innerHTML = `<div class="empty-shots"><span class="empty-shot-icon">${icon('scissors')}</span><h3>${esc(t('shots.emptyTitle'))}</h3><p>${esc(t('shots.emptyBody'))}</p></div>`;
    $('#sceneChips').innerHTML = '';
    clearBanner();
    renderScriptPanel();
    drawDifferenceCurve();
    updateActionStates();
    return;
  }

  const summary = item.analysisSummary;
  if (summary?.completed) {
    const type = summary.failed ? 'warning' : 'success';
    showBanner(t('shots.summary', {
      completed: summary.completed,
      total: summary.total,
      success: summary.success,
      failed: summary.failed,
      cancelled: summary.cancelled ? t('shots.summaryCancelled') : ''
    }), type);
  } else {
    clearBanner();
  }

  const scenes = [...new Set(item.shots
    .map(shot => [shot.scene, shot.timeOfDay, shot.interiorExterior].filter(Boolean).join(' '))
    .filter(Boolean))];
  if (state.activeScene !== ALL_SCENES && !scenes.includes(state.activeScene)) state.activeScene = ALL_SCENES;
  $('#sceneChips').innerHTML = [ALL_SCENES, ...scenes].map(scene => {
    const label = scene === ALL_SCENES ? t('filter.all') : scene;
    const selected = scene === state.activeScene;
    return `<button class="chip ${selected ? 'active' : ''}" data-scene="${esc(scene)}" type="button" aria-pressed="${selected}">${esc(label)}</button>`;
  }).join('');

  const frames = await Promise.all(item.shots.map(shot => frameForShot(item, shot)));
  if (renderToken !== state.renderToken) return;

  root.innerHTML = item.shots.map((shot, index) => {
    const scene = [shot.scene, shot.timeOfDay, shot.interiorExterior].filter(Boolean).join(' ');
    const dialogue = shot.dialogue ? `<div class="shot-dialogue">${esc(t('shot.dialogue', { value: shot.dialogue }))}</div>` : '';
    const sound = shot.sound ? `<div class="shot-sound">${esc(t('shot.sound', { value: shot.sound }))}</div>` : '';
    const failure = shot.analysisError ? `<div class="shot-error">${esc(t('shot.failureReason', { value: localizeError(shot.analysisError) || shot.analysisError }))}</div>` : '';
    const locked = shot.analysisStatus === 'running';
    return `<article class="shot-card" data-scene="${esc(scene)}" data-shot-id="${esc(shot.id)}">
      <div class="shot-frame"><img src="${esc(frames[index])}?v=${esc(item.updatedAt || '')}" alt="${esc(t('a11y.shotFrame', { index: shot.index }))}"></div>
      <div class="shot-body">
        <div class="shot-head">
          <b>#${String(shot.index).padStart(3, '0')}</b>
          <small>${esc(shot.startTc)} – ${esc(shot.endTc)}</small>
          ${analysisLabel(shot)}
          <button data-shot-edit="${esc(shot.id)}" type="button" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}" ${locked?'disabled':''}>${icon('script')}<span>${esc(t('common.edit'))}</span></button>
          <button data-analyze="${esc(shot.id)}" type="button" aria-label="${esc(t('action.reanalyze'))}" title="${esc(t('action.reanalyze'))}" ${locked?'disabled':''}>${icon('refresh')}<span>${esc(t('action.reanalyze'))}</span></button>
          <button data-shot-delete="${esc(shot.id)}" class="danger-quiet" type="button" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}" ${locked?'disabled':''}>${icon('close')}<span>${esc(t('common.delete'))}</span></button>
        </div>
        <div class="shot-fields">${[shot.scene, shot.timeOfDay, shot.interiorExterior, shot.shotSize, shot.angle, shot.movement]
          .filter(Boolean).map(value => `<span class="pill">${esc(value)}</span>`).join('')}</div>
        <p class="shot-desc">${esc(shot.description || t('shot.unrecognized'))}</p>
        ${dialogue}${sound}${failure}
      </div>
    </article>`;
  }).join('');
  applySceneFilter();
  root.scrollTop = previousScroll;
  renderScriptPanel();
  drawDifferenceCurve();
  updateActionStates();
}

function openNew(kind) {
  state.newKind = kind;
  $('#newTitle').textContent = t(kind === 'research' ? 'dialog.newResearch' : 'dialog.newProject');
  $('#newName').value = '';
  $('#videoPath').value = '';
  $('#newDialog').showModal();
}

async function loadSettings() {
  state.settings = await window.feige.invoke('get-settings');
  const mode = state.settings.detectionMode === 'classic' ? 'classic' : 'hybrid';
  const modeInput = $(`input[name="detectionMode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  $('#setHardCutFloor').value = state.settings.hardCutFloor;
  $('#setRelativeMultiplier').value = state.settings.relativeMultiplier;
  $('#setClassicThreshold').value = state.settings.classicThreshold;
  $('#setMinGap').value = state.settings.minGap;
  $('#setMaxShots').value = state.settings.maxShots;
  $('#setConcurrency').value = state.settings.concurrency;
  $('#setAutoAnalyze').checked = state.settings.autoAnalyzeAfterDetection !== false;
  $('#shotPrompt').value = state.settings.shotPrompt;
  $('#scriptPrompt').value = state.settings.scriptPrompt;
  state.providerId = state.settings.activeProvider;
  renderProviders();
  updateDetectionSettingVisibility();
}

function updateDetectionSettingVisibility() {
  const mode = $('input[name="detectionMode"]:checked')?.value || 'hybrid';
  $$('[data-hybrid-setting]').forEach(element => element.classList.toggle('setting-muted', mode !== 'hybrid'));
  $$('[data-classic-setting]').forEach(element => element.classList.toggle('setting-muted', mode !== 'classic'));
}

function renderProviders() {
  if (!state.settings?.providers) return;
  const providers = state.settings.providers;
  $('#providerNav').innerHTML = Object.entries(providers).map(([id, provider]) => `
    <button type="button" class="provider-tab ${id === state.providerId ? 'active' : ''}" data-provider="${esc(id)}">${esc(providerDisplayName(id, provider))}</button>`).join('') +
    `<button type="button" id="addProvider">${icon('plus')}<span>${esc(t('action.addProvider').replace(/^＋\s*/, ''))}</span></button>`;

  const provider = providers[state.providerId];
  if (!provider) return;
  const keyHint = provider.apiKeyError
    ? t('placeholder.apiKeyDecryptError')
    : provider.hasApiKey ? t('placeholder.apiKeySaved') : t('placeholder.apiKey');

  $('#providerForm').innerHTML = `<div class="provider-fields">
    <label><span>${esc(t('field.displayName'))}</span><input id="pLabel" value="${esc(provider.label)}"></label>
    <label><span>${esc(t('field.apiType'))}</span><select id="pType"><option value="openai" ${provider.type === 'openai' ? 'selected' : ''}>${esc(t('settings.openaiCompatible'))}</option><option value="anthropic" ${provider.type === 'anthropic' ? 'selected' : ''}>Anthropic</option><option value="gemini" ${provider.type === 'gemini' ? 'selected' : ''}>Gemini</option></select></label>
    <label><span>${esc(t('field.baseUrl'))}</span><input id="pUrl" value="${esc(provider.baseUrl)}"></label>
    <label><span>${esc(t('field.modelName'))}</span><input id="pModel" value="${esc(provider.model)}"></label>
    <label class="field-wide"><span>${esc(t('field.apiKey'))}</span><input id="pKey" type="password" value="${esc(provider.apiKey || '')}" placeholder="${esc(keyHint)}"></label>
    <div class="provider-test"><button id="testProvider" type="button">${icon('scan')}<span>${esc(t('action.testProvider'))}</span></button><span>${provider.hasApiKey ? esc(t('settings.apiKeySaved')) : ''}</span></div>
  </div>`;
}

function captureProvider() {
  if (!state.settings?.providers) return;
  const provider = state.settings.providers[state.providerId];
  if (!provider || !$('#pLabel')) return;
  provider.label = $('#pLabel').value;
  provider.type = $('#pType').value;
  provider.baseUrl = $('#pUrl').value.trim();
  provider.model = $('#pModel').value.trim();
  provider.apiKey = $('#pKey').value.trim();
}

async function runBatch(mode = 'all') {
  if (state.analysisActive || !state.current?.shots?.length) return;
  closeEditDialogs();
  state.analysisActive = true;
  try {
    clearBanner();
    busy(true, t(mode === 'failed' ? 'progress.retryingFailed' : 'progress.analyzingAll'), true);
    const result = await window.feige.invoke('analyze-all-shots', { item: state.current, mode });
    state.current = result.item;
    state.frameCache.clear();
    await renderCurrent();
    const summary = result.summary;
    toast(summary.failed
      ? t('toast.batchComplete', { success: summary.success, failed: summary.failed })
      : t('toast.allShotsComplete', { count: summary.success }), summary.failed ? 7000 : 4000);
  } catch (error) {
    const message = t('error.batchFailed', { detail: readableError(error) });
    showBanner(message, 'error');
    toast(message, 8000);
  } finally {
    state.analysisActive = false;
    busy(false);
  }
}

async function exportResult(type) {
  if (!state.current) return;
  try {
    busy(true, t('progress.generatingExport'));
    const result = await window.feige.invoke(type === 'all' ? 'export-all' : 'export-file', type === 'all' ? state.current : { type, item: state.current });
    if (result) toast(t(type === 'all' ? 'toast.exportAllComplete' : 'toast.exportComplete'));
  } catch (error) {
    toast(t('error.exportFailed', { detail: readableError(error) }), 8000);
  } finally {
    busy(false);
    $('#exportMenu').removeAttribute('open');
  }
}

function activateTab(tabName, focus = false) {
  state.activeTab = tabName;
  $$('.tab').forEach(tab => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  $('#shotsPane').classList.toggle('hidden', tabName !== 'shots');
  $('#scriptPane').classList.toggle('hidden', tabName !== 'script');
}

function updateLanguageButtons() {
  const locale = getLocale();
  $$('[data-locale]').forEach(button => {
    const active = button.dataset.locale === locale;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', t(button.dataset.locale === 'zh-CN' ? 'a11y.switchToChinese' : 'a11y.switchToEnglish'));
  });
}

async function changeLocale(locale) {
  if (locale === getLocale() || state.localeChanging) return;
  state.localeChanging = true;
  $$('[data-locale]').forEach(button => { button.disabled = true; });
  try {
    if ($('#settingsDialog').open) captureProvider();
    const shotScroll = $('#shots').scrollTop;
    const scriptScroll = $('#scriptEditor').scrollTop;
    setLocale(locale);
    updateLanguageButtons();
    await window.feige.setUiLanguage?.(locale);
    renderList('projectList', state.lists.projects, 'project');
    renderList('researchList', state.lists.research, 'research');
    updateProjectIdentity();
    if (state.current) {
      await renderCurrent();
      $('#shots').scrollTop = shotScroll;
    }
    if (state.settings) renderProviders();
    $('#scriptEditor').scrollTop = scriptScroll;
    $('#newTitle').textContent = t(state.newKind === 'research' ? 'dialog.newResearch' : 'dialog.newProject');
    if (state.lastProgress?.message) {
      const message = localizeRuntimeMessage(state.lastProgress.message);
      $('#taskStatus').textContent = message;
      if (state.uiBusy) $('#progressText').textContent = message;
    } else {
      $('#taskStatus').textContent = t('nav.localReady');
    }
  } finally {
    state.localeChanging = false;
    $$('[data-locale]').forEach(button => { button.disabled = false; });
    updateLanguageButtons();
  }
}

$$('[data-kind]').forEach(button => button.addEventListener('click', () => openNew(button.dataset.kind)));

document.addEventListener('click', async event => {
  const menuAction = event.target.closest('[data-menu-action]');
  if (menuAction) {
    const { menuAction:action, menuValue:value } = menuAction.dataset;
    hideContextMenu();
    if (action === 'edit-shot') openShotEditor(value);
    if (action === 'reanalyze-shot') document.querySelector(`[data-analyze="${CSS.escape(value)}"]`)?.click();
    if (action === 'delete-shot') document.querySelector(`[data-shot-delete="${CSS.escape(value)}"]`)?.click();
    if (action === 'edit-script-scene') openSceneEditor(Number(value),'edit');
    if (action === 'insert-script-scene') openSceneEditor(Number(value),'insert');
    if (action === 'delete-script-scene') document.querySelector(`[data-script-delete="${CSS.escape(value)}"]`)?.click();
    if (action === 'regenerate-script') regenerateScript();
    return;
  }
  hideContextMenu();

  const nav = event.target.closest('.nav-item');
  if (nav) {
    await openProject(nav.dataset.id, nav.dataset.kind);
    return;
  }

  const shotEdit = event.target.closest('[data-shot-edit]');
  if (shotEdit) { openShotEditor(shotEdit.dataset.shotEdit); return; }

  const shotDelete = event.target.closest('[data-shot-delete]');
  if (shotDelete) {
    const shot = state.current?.shots?.find(entry => entry.id === shotDelete.dataset.shotDelete);
    if (!shot || !window.confirm(t('confirm.deleteShot', { number:shot.index }))) return;
    try {
      state.current = await window.feige.invoke('delete-shot',{item:state.current,shotId:shot.id});
      state.frameCache.clear();
      await renderCurrent();
      toast(t('toast.shotDeleted'));
    } catch (error) { toast(readableError(error),8000); }
    return;
  }

  const sceneEdit = event.target.closest('[data-script-edit]');
  if (sceneEdit) { openSceneEditor(Number(sceneEdit.dataset.scriptEdit),'edit'); return; }
  const sceneInsert = event.target.closest('[data-script-insert]');
  if (sceneInsert) { openSceneEditor(Number(sceneInsert.dataset.scriptInsert),'insert'); return; }
  const sceneDelete = event.target.closest('[data-script-delete]');
  if (sceneDelete) {
    const index=Number(sceneDelete.dataset.scriptDelete);
    if (!window.confirm(t('confirm.deleteScene',{number:index+1}))) return;
    const scenes=[...(state.current?.scriptScenes||[])];scenes.splice(index,1);
    try{state.current=await window.feige.invoke('save-script-scenes',{item:state.current,scenes});renderScriptPanel();toast(t('toast.sceneDeleted'));}
    catch(error){toast(readableError(error),8000);}
    return;
  }

  const analyze = event.target.closest('[data-analyze]');
  if (analyze) {
    try {
      clearBanner();
      busy(true, t('progress.analyzingOne'));
      state.current = await window.feige.invoke('analyze-shot', { item: state.current, shotId: analyze.dataset.analyze });
      state.frameCache.clear();
      await renderCurrent();
      toast(t('toast.shotComplete'));
    } catch (error) {
      const message = t('error.shotFailed', { detail: readableError(error) });
      showBanner(message, 'error');
      toast(message, 8000);
    } finally {
      busy(false);
    }
    return;
  }

  const chip = event.target.closest('#sceneChips [data-scene]');
  if (chip) {
    state.activeScene = chip.dataset.scene;
    applySceneFilter();
    return;
  }

  const providerTab = event.target.closest('[data-provider]');
  if (providerTab) {
    captureProvider();
    state.providerId = providerTab.dataset.provider;
    renderProviders();
    return;
  }

  if (event.target.closest('#addProvider')) {
    captureProvider();
    const id = `custom_${Date.now()}`;
    state.settings.providers[id] = { label: t('provider.custom'), type: 'openai', baseUrl: '', model: '', apiKey: '', hasApiKey: false };
    state.providerId = id;
    renderProviders();
    return;
  }

  if (event.target.closest('#testProvider')) {
    try {
      captureProvider();
      busy(true, t('progress.testingProvider'));
      const result = await window.feige.invoke('test-provider', { providerId: state.providerId, provider: state.settings.providers[state.providerId], item: state.current });
      toast(t('toast.connectionSuccess', { message: result.message }), 6000);
    } catch (error) {
      toast(t('error.connectionFailed', { detail: readableError(error) }), 9000);
    } finally {
      busy(false);
    }
    return;
  }

  if (!event.target.closest('#exportMenu')) $('#exportMenu').removeAttribute('open');
});

document.addEventListener('contextmenu', event => {
  const shotCard=event.target.closest('.shot-card[data-shot-id]');
  if(shotCard){
    event.preventDefault();
    const shot=state.current?.shots?.find(entry=>entry.id===shotCard.dataset.shotId),locked=shot?.analysisStatus==='running'||state.uiBusy||state.analysisActive;
    showContextMenu([
      {action:'edit-shot',value:shotCard.dataset.shotId,icon:'script',label:t('common.edit'),disabled:locked},
      {action:'reanalyze-shot',value:shotCard.dataset.shotId,icon:'refresh',label:t('action.reanalyze'),disabled:locked},
      {action:'delete-shot',value:shotCard.dataset.shotId,icon:'close',label:t('common.delete'),disabled:locked}
    ],event.clientX,event.clientY);return;
  }
  const scriptScene=event.target.closest('.script-scene[data-script-index]');
  if(scriptScene){
    event.preventDefault();const index=scriptScene.dataset.scriptIndex;
    showContextMenu([
      {action:'edit-script-scene',value:index,icon:'script',label:t('common.edit')},
      {action:'insert-script-scene',value:index,icon:'plus',label:t('common.insertAfter')},
      {action:'delete-script-scene',value:index,icon:'close',label:t('common.delete')},
      {action:'regenerate-script',value:'',icon:'refresh',label:t('script.regenerate'),disabled:state.uiBusy||state.analysisActive}
    ],event.clientX,event.clientY);
  }
});

$('#differenceCanvas').onclick = event => {
  const duration=Number(state.current?.duration)||0;if(!duration)return;
  const rect=event.currentTarget.getBoundingClientRect();$('#video').currentTime=Math.max(0,Math.min(duration,((event.clientX-rect.left)/rect.width)*duration));
};

$('#differenceCanvas').oncontextmenu = async event => {
  event.preventDefault();
  const duration=Number(state.current?.duration)||0;if(!duration||state.uiBusy||state.analysisActive)return;
  const rect=event.currentTarget.getBoundingClientRect(),time=Math.max(0,Math.min(duration,((event.clientX-rect.left)/rect.width)*duration));
  try{state.current=await window.feige.invoke('add-manual-cut',{item:state.current,time});state.frameCache.clear();await renderCurrent();toast(t('toast.cutAdded'));}
  catch(error){toast(readableError(error),8000);}
};

window.addEventListener('resize',drawDifferenceCurve);
window.addEventListener('keydown',event=>{if(event.key==='Escape')hideContextMenu();});

$('#chooseVideo').onclick = async () => {
  const selected = await window.feige.invoke('choose-video');
  if (selected) $('#videoPath').value = selected;
};

$('#createBtn').onclick = async () => {
  if (!$('#videoPath').value) return toast(t('toast.videoRequired'));
  const project = await window.feige.invoke('create-project', {
    kind: state.newKind,
    videoPath: $('#videoPath').value,
    name: $('#newName').value.trim()
  });
  $('#newDialog').close();
  await refreshLists();
  await openProject(project.id, state.newKind);
};

$('#detectBtn').onclick = async () => {
  try {
    closeEditDialogs();
    clearBanner();
    busy(true, t('progress.analyzingScene'));
    state.current = await window.feige.invoke('detect-scenes', { item: state.current, options: {} });
    state.frameCache.clear();
    state.activeScene = ALL_SCENES;
    await renderCurrent({ preserveScroll: false });
    updateProjectIdentity();
    toast(t('toast.shotsCreated', { count: state.current.shots.length }));
  } catch (error) {
    const message = t('error.detectFailed', { detail: readableError(error) });
    showBanner(message, 'error');
    toast(message, 8000);
    return;
  } finally {
    busy(false);
  }
  if (state.settings.autoAnalyzeAfterDetection !== false) await runBatch('all');
};

$('#manualCut').onclick = async () => {
  try {
    state.current = await window.feige.invoke('add-manual-cut', { item: state.current, time: $('#video').currentTime });
    state.frameCache.clear();
    await renderCurrent();
    toast(t('toast.cutAdded'));
  } catch (error) { toast(readableError(error),8000); }
};

$('#analyzeAll').onclick = () => runBatch('all');
$('#retryFailed').onclick = () => runBatch('failed');
$('#cancelTask').onclick = async () => {
  $('#cancelTask').disabled = true;
  $('#progressText').textContent = t('progress.safeCancel');
  await window.feige.invoke('cancel-analysis');
};

async function regenerateScript() {
  try {
    closeEditDialogs();
    busy(true, t('progress.generatingScriptFromShots'));
    state.current = await window.feige.invoke('generate-script', state.current);
    renderScriptPanel();
    activateTab('script');
    toast(t('toast.scriptGenerated'));
  } catch (error) {
    toast(t('error.scriptFailed', { detail: readableError(error) }), 9000);
  } finally {
    busy(false);
  }
}

$('#generateScript').onclick = regenerateScript;
$('#regenerateScript').onclick = regenerateScript;

$('#saveScript').onclick = async () => {
  const scenes = splitScriptScenesClient($('#scriptEditor').value);
  state.current = await window.feige.invoke('save-script-scenes', { item:state.current, scenes });
  renderScriptPanel();
  toast(t('toast.scriptSaved'));
};

$('#scriptVersion').onchange = async event => {
  if (!event.target.value) return;
  try {
    closeEditDialogs();
    state.current = await window.feige.invoke('activate-script-version',{item:state.current,versionId:event.target.value});
    renderScriptPanel();
    toast(t('toast.versionActivated'));
  } catch (error) { toast(readableError(error),8000); }
};

$('#deleteScriptVersion').onclick = async () => {
  const versionId=$('#scriptVersion').value;
  if(!versionId||!window.confirm(t('confirm.deleteVersion')))return;
  try{
    closeEditDialogs();
    state.current=await window.feige.invoke('delete-script-version',{item:state.current,versionId});
    renderScriptPanel();
    toast(t('toast.versionDeleted'));
  }catch(error){toast(readableError(error),8000);}
};

$('#saveShotEdit').onclick = async () => {
  if(state.editing?.kind!=='shot')return;
  const changes={scene:$('#editScene').value,timeOfDay:$('#editTimeOfDay').value,interiorExterior:$('#editInteriorExterior').value,shotSize:$('#editShotSize').value,angle:$('#editAngle').value,movement:$('#editMovement').value,description:$('#editDescription').value,dialogue:$('#editDialogue').value,sound:$('#editSound').value};
  try{state.current=await window.feige.invoke('update-shot',{item:state.current,shotId:state.editing.id,changes});$('#shotEditDialog').close();state.editing=null;await renderCurrent();toast(t('toast.shotSaved'));}
  catch(error){toast(readableError(error),8000);}
};

$('#saveSceneEdit').onclick = async () => {
  if(state.editing?.kind!=='script-scene')return;
  if(String(state.editing.versionId)!==String(state.current?.activeScriptVersionId)){closeEditDialogs();return toast(t('error.versionChanged'),7000);}
  const scenes=[...(state.current?.scriptScenes||[])],value=$('#editSceneSource').value.trim(),index=state.editing.index;
  if(state.editing.mode==='insert')scenes.splice(index+1,0,value);else scenes[index]=value;
  try{state.current=await window.feige.invoke('save-script-scenes',{item:state.current,scenes});$('#sceneEditDialog').close();state.editing=null;renderScriptPanel();toast(t('toast.sceneSaved'));}
  catch(error){toast(readableError(error),8000);}
};

$$('.tab').forEach(tab => {
  tab.onclick = () => activateTab(tab.dataset.tab);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    activateTab(tab.dataset.tab === 'shots' ? 'script' : 'shots', true);
  };
});

$('#exportScript').onclick = () => exportResult('script');
$('#exportBoard').onclick = () => exportResult('storyboard');
$('#exportHtml').onclick = () => exportResult('html');
$('#exportAll').onclick = () => exportResult('all');
$('#openFolder').onclick = () => window.feige.invoke('open-project-folder', state.current);

$('#settingsBtn').onclick = async () => {
  await loadSettings();
  $('#settingsDialog').showModal();
};

$('#saveSettings').onclick = async () => {
  captureProvider();
  state.settings.activeProvider = state.providerId;
  state.settings.detectionMode = $('input[name="detectionMode"]:checked')?.value || 'hybrid';
  state.settings.hardCutFloor = Number($('#setHardCutFloor').value);
  state.settings.relativeMultiplier = Number($('#setRelativeMultiplier').value);
  state.settings.classicThreshold = Number($('#setClassicThreshold').value);
  state.settings.minGap = Number($('#setMinGap').value);
  state.settings.maxShots = Number($('#setMaxShots').value);
  state.settings.concurrency = Number($('#setConcurrency').value);
  state.settings.autoAnalyzeAfterDetection = $('#setAutoAnalyze').checked;
  state.settings.shotPrompt = $('#shotPrompt').value;
  state.settings.scriptPrompt = $('#scriptPrompt').value;
  await window.feige.invoke('save-settings', state.settings);
  $('#settingsDialog').close();
  toast(t('toast.settingsSaved'));
};

$$('input[name="detectionMode"]').forEach(input => input.onchange = updateDetectionSettingVisibility);

$$('[data-locale]').forEach(button => {
  button.onclick = () => changeLocale(button.dataset.locale);
});

window.feige.onProgress(payload => {
  state.lastProgress = payload;
  const message = localizeRuntimeMessage(payload.message);
  $('#taskStatus').textContent = message;
  if (state.uiBusy) $('#progressText').textContent = message;
  if (payload.progress == null) $('#progressBar').removeAttribute('value');
  else $('#progressBar').value = payload.progress;
});

(async () => {
  applyTranslations(document);
  updateLanguageButtons();
  activateTab('shots');
  await window.feige.setUiLanguage?.(getLocale());
  await loadSettings();
  await refreshLists();
  updateActionStates();
})().catch(error => toast(readableError(error), 8000));
