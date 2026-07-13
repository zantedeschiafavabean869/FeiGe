'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { detectTransitions, _test } = require('../src/detection');

const root = path.resolve(__dirname, '..');

function sample(time, score = 0.005, luma = 0.45, histDiff = score, pixelDiff = score) {
  return { time, score, luma, histDiff, pixelDiff };
}

function detectionTests() {
  const hard = Array.from({ length:30 }, (_,index) => sample(index / 5));
  Object.assign(hard[15], { score:0.14, histDiff:0.15, pixelDiff:0.11 });
  assert(_test.findHardCuts(hard,{hardCutFloor:5.5,relativeMultiplier:8}).some(entry => Math.abs(entry.time - 3) < 0.01), 'hard-cut detector');

  const flash = Array.from({ length:12 }, (_,index) => sample(index / 5,0.01,0.42));
  Object.assign(flash[6], { luma:0.94, score:0.3, histDiff:0.3, pixelDiff:0.3 });
  assert(_test.findWhiteFlashes(flash).length === 1, 'white-flash detector');

  const fade = Array.from({ length:12 }, (_,index) => sample(index / 5,0.025,Math.max(0.08,0.9-index*0.085),0.025,0.02));
  assert(_test.findFades(fade,5).some(entry => entry.type === 'fade-out'), 'fade detector');

  const dissolve = Array.from({ length:24 }, (_,index) => sample(index / 5,0.005,0.48,0.005,0.005));
  for(let index=8;index<14;index++)Object.assign(dissolve[index],{score:0.04,histDiff:0.035,pixelDiff:0.05});
  assert(_test.findDissolves(dissolve,5,5.5).some(entry => entry.type === 'dissolve'), 'dissolve detector');

  const hybrid = detectTransitions([...hard],{mode:'hybrid',hardCutFloor:5.5,relativeMultiplier:8,minGap:.5,maxShots:6000,fps:5});
  assert(hybrid.cuts.length >= 1 && hybrid.cuts[0].detectors.includes('hard-cut'), 'hybrid fusion');

  const capped = _test.mergeCandidates(Array.from({length:20},(_,index)=>({time:index,confidence:.7,score:.1,type:'hard-cut'})),.5,5);
  assert.strictEqual(capped.length,4,'maximum shot limit');
}

function interfaceTests() {
  const html = fs.readFileSync(path.join(root,'src','index.html'),'utf8');
  const renderer = fs.readFileSync(path.join(root,'src','renderer.js'),'utf8');
  const allIds = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.strictEqual(new Set(allIds).size,allIds.length,'unique DOM ids');
  for(const id of ['differenceCanvas','scriptVersion','regenerateScript','deleteScriptVersion','shotEditDialog','sceneEditDialog','contextMenu'])assert(html.includes(`id="${id}"`),`required UI element ${id}`);
  for(const channel of ['update-shot','delete-shot','save-script-scenes','activate-script-version','delete-script-version'])assert(renderer.includes(`'${channel}'`),`renderer channel ${channel}`);
}

function translationTests() {
  const source=fs.readFileSync(path.join(root,'src','i18n.js'),'utf8');
  const context={window:{localStorage:{getItem(){},setItem(){}},navigator:{language:'zh-CN'}},document:{documentElement:{lang:''},querySelectorAll(){return[]},dispatchEvent(){}},CustomEvent:function(){}};
  vm.createContext(context);vm.runInContext(source,context);
  const api=context.window.FeigeI18n,used=new Set();
  for(const file of ['src/index.html','src/renderer.js']){
    const value=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of value.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g))used.add(match[1]);
    for(const match of value.matchAll(/\bt\(['"]([^'"]+)['"]/g))used.add(match[1]);
  }
  for(const locale of ['zh-CN','en-US']){
    api.setLocale(locale);
    const missing=[...used].filter(key=>api.t(key)===key);
    assert.deepStrictEqual(missing,[],`${locale} translations: ${missing.join(', ')}`);
  }
}

detectionTests();
interfaceTests();
translationTests();
console.log('FeiGe self-test passed');
