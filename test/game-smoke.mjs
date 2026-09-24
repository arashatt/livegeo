import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {startDemo,demoCenter} from './game-demo.mjs';
const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',new URL('../../qa/chromium',import.meta.url).pathname,chromium.executablePath()].filter(Boolean);
let executablePath;
for(const path of candidates){try{await access(path);executablePath=path;break;}catch{}}
if(!executablePath){if(process.env.CI)throw new Error('Chromium is required for browser smoke tests');console.log('Browser smoke: set CHROMIUM_PATH to run locally');process.exit(0);}
const args=['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
if(executablePath.includes('/qa/'))args.push('--single-process','--in-process-gpu','--disable-features=IsolateOrigins,site-per-process');
const demo=await startDemo();
let browser;
const errors=[],external=[];
async function open(extra=[]){
  browser=await chromium.launch({executablePath,headless:true,args:[...args,...extra]});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(demo.origin+'/'))external.push(r.url());});
  return page;
}
try{
  let page=await open();await page.goto(demo.origin);
  await page.waitForFunction(()=>document.body.dataset.renderer==='game'&&document.querySelectorAll('.game-blip').length===4,{},{timeout:30000});
  await page.evaluate((center)=>window.livegeoMap.gl.jumpTo({center,zoom:16,bearing:15,pitch:70}),demoCenter);
  await page.waitForFunction(()=>window.livegeoMap.gl.areTilesLoaded());
  assert.equal(demo.requests.filter(r=>r.startsWith('/tiles/')).length,0,'WebGL never asks for raster by default');
  assert.ok(await page.locator('.veil-ground').count()>=2);
  assert.equal(await page.locator('.game-blip[data-person="5"]').count(),0,'private person has no point');
  assert.equal(await page.locator('.game-blip.sos').count(),1);
  assert.equal(await page.locator('.game-blip.self.arrow').count(),1);
  assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getLayer('buildings').type),'fill-extrusion');
  assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getCanvas().getContext('webgl2')!==null),true);
  // Real shaping and the committed presentation-form glyphs are exercised, not just plugin download.
  const shaped=await page.evaluate(async()=>{await import('/vendor/rtl/mapbox-gl-rtl-text.js');const plugin=await window['mapbox-gl-rtl-text'];const text=plugin.applyArabicShaping('مشهد تهران');return plugin.processBidirectionalText(text,[])[0];});
  assert.match(shaped,/[\ufb50-\ufeff]/);assert.notEqual(shaped,'مشهد تهران');
  await page.locator('.game-blip.self').focus();await page.keyboard.press('Enter');
  await page.waitForSelector('#detailPanel:not([hidden])');assert.match(await page.locator('#detailPanel').innerText(),/Alex/);
  await page.locator('#detailclose').click();await page.mouse.move(500,100);
  await page.locator('#cameraMode').selectOption('map');assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getPitch()),0);assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getBearing()),0);
  await page.locator('#cameraMode').selectOption('chase');assert.ok(await page.evaluate(()=>window.livegeoMap.gl.getPitch())>50);
  // Unknown heading falls back to north-up; a hidden self exits Chase entirely.
  demo.update({id:'1',heading:null,trail:[{latitude:25.783,longitude:-80.145,at:Math.floor(Date.now()/1000)+1,gap:true}]});await page.waitForFunction(()=>window.livegeoMap.gl.getBearing()===0);
  demo.update({id:'1',hidden:true,accuracy:250});await page.waitForFunction(()=>!document.querySelector('.game-blip.self'));
  assert.equal(await page.locator('#cameraMode').inputValue(),'auto');assert.equal(await page.locator('#radar').isVisible(),false);
  demo.update({id:'1',hidden:false,accuracy:25,heading:40,name:'<img src=x onerror="window.INJECTED=1">'});
  await page.waitForSelector('.game-blip.self');await page.locator('.game-blip.self').click();assert.equal(await page.locator('#detailPanel img[src=x]').count(),0);assert.equal(await page.evaluate(()=>window.INJECTED),undefined);await page.locator('#detailclose').click();
  await page.locator('#layersbtn').click();await page.locator('#lightMode').selectOption('night');
  assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getPaintProperty('buildings','fill-extrusion-pattern')),'windows');
  await page.locator('#liteMode').check();assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getLayoutProperty('buildings','visibility')),'none');await page.locator('#liteMode').uncheck();
  await page.locator('[data-feature=roads]').uncheck();assert.equal(await page.evaluate(()=>window.livegeoMap.gl.getLayoutProperty('roads','visibility')),'none');await page.locator('[data-feature=roads]').check();
  await page.locator('[data-layer=trails]').uncheck();await page.locator('[data-layer=trails]').check();
  await page.locator('#layersbtn').click();
  await page.locator('#newfence').click();assert.equal(await page.locator('body.fencing').count(),1);await page.keyboard.press('Escape');assert.equal(await page.locator('body.fencing').count(),0);
  // Settle camera/data before counting the renderer's idle frames.
  await page.mouse.move(500,70);await page.evaluate(()=>window.livegeoMap.gl.stop());await page.waitForTimeout(1200);
  const idle=await page.evaluate(()=>new Promise(resolve=>{let count=0;const map=window.livegeoMap.gl,listen=()=>count++;map.on('render',listen);setTimeout(()=>{map.off('render',listen);resolve(count);},1100);}));
  assert.equal(idle,0,'the map does not continuously repaint while idle');
  await page.setViewportSize({width:390,height:844});await page.locator('#mapLegend summary').click();
  await page.waitForFunction(()=>document.body.classList.contains('legend-open'));
  const layout=await page.evaluate(()=>({map:document.getElementById('map').getBoundingClientRect().bottom,legend:document.getElementById('mapLegend').getBoundingClientRect().top,width:document.documentElement.scrollWidth}));
  assert.ok(layout.map<=layout.legend+1,'phone legend has its own space below the map');assert.equal(layout.width,390);
  await page.locator('#mapLegend summary').click();
  // Classic selection is remembered, and the same data/veil/card handlers work.
  await page.locator('#layersbtn').click();await page.locator('#rendererMode').selectOption('classic');
  await page.waitForFunction(()=>document.body.dataset.renderer==='classic'&&document.querySelectorAll('#list .person').length===5);
  assert.equal(await page.locator('.leaflet-container').count(),1);assert.equal(await page.evaluate(()=>localStorage.getItem('livegeo.renderer')),'classic');
  await page.locator('#peoplebtn').click();await page.locator('#list .person[data-id="5"]').click();await page.waitForSelector('#detailPanel:not([hidden])');
  assert.equal(await page.locator('.leaflet-marker-icon.veil-chip').count(),1);
  await browser.close();browser=null;
  page=await open(['--disable-3d-apis']);await page.goto(demo.origin);await page.waitForFunction(()=>document.body.dataset.renderer==='classic'&&document.querySelectorAll('#list .person').length===5);
  assert.equal(await page.locator('.leaflet-container').count(),1);assert.match(await page.locator('#rendererNote').innerText(),/unavailable/);
  assert.deepEqual(errors,[],'no console/application errors');assert.deepEqual(external,[],'no external requests');
  console.log('Browser smoke: WebGL2, RTL, privacy, SOS, keyboard/card, camera, Lite, layers, escaping, idle=0, phone legend, selected and disabled-GPU Classic; zero errors/external requests');
}finally{if(browser)await browser.close();await demo.close();}
