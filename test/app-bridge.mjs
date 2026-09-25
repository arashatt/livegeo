// The map page inside the Android app (android/), and outside it: with a
// stand-in for what the app's web view provides (window.LivegeoApp), the page
// shows Go live and follows the app's sharing state, starts in the game
// camera, and hands downloads and the share sheet to the app. Without it,
// none of that exists. See public/lib/app-bridge.js.
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {startDemo} from './game-demo.mjs';

const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',chromium.executablePath()].filter(Boolean);
let executablePath;
for(const path of candidates){try{await access(path);executablePath=path;break;}catch{}}
if(!executablePath){if(process.env.CI)throw new Error('Chromium is required for the app bridge test');console.log('App bridge: set CHROMIUM_PATH to run locally');process.exit(0);}
const args=['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];

// What MainActivity puts on the page, as far as the page can tell.
const standIn=()=>{
  window.__calls=[];
  window.LivegeoApp={
    version:()=>'test',
    sharing:()=>JSON.stringify({on:false,until:null,paired:false}),
    toggleSharing:()=>{window.__calls.push(['toggle']);},
    buzz:(kind)=>{window.__calls.push(['buzz',kind]);},
    saveFile:(name,mime,base64)=>{window.__calls.push(['save',name,mime,base64]);},
    share:(json)=>{window.__calls.push(['share',json]);},
  };
};

const demo=await startDemo();
let browser;
const errors=[];
async function open(app){
  const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  if(app)await page.addInitScript(standIn);
  await page.goto(demo.origin);
  await page.waitForFunction(()=>document.body.dataset.renderer==='game'&&document.querySelectorAll('.game-blip').length===4,{},{timeout:30000});
  return page;
}
const calls=(page,kind)=>page.evaluate((kind)=>window.__calls.filter(c=>c[0]===kind),kind);
const decode=(b64)=>Buffer.from(b64,'base64').toString('utf8');
// What the label says; the HUD shows it uppercase.
const label=(page)=>page.evaluate(()=>document.querySelector('#golivebtn .tool-label').textContent.trim());

try{
  browser=await chromium.launch({executablePath,headless:true,args});

  // A browser: nothing of the app.
  let page=await open(false);
  assert.equal(await page.locator('#golivebtn').isHidden(),true,'no Go live in a browser');
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('in-app')),false);
  assert.equal(await page.evaluate(()=>typeof window.livegeoApp),'undefined');
  assert.equal(await page.locator('#cameraMode').inputValue(),'map','a browser keeps the flat reference map by default');
  await page.close();

  // The app.
  page=await open(true);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('in-app')),true);
  assert.equal(await page.locator('#cameraMode').inputValue(),'auto','the app starts in the game camera');
  const button=page.locator('#golivebtn');
  assert.equal(await button.isVisible(),true);
  assert.equal(await label(page),'Go live');
  assert.equal(await button.getAttribute('aria-pressed'),'false');
  await button.click();
  assert.equal((await calls(page,'toggle')).length,1,'Go live asks the app, which pairs, asks permission and a duration');

  // The app says sharing started, for an hour; then until stopped; then stopped.
  await page.evaluate(()=>window.livegeoApp.onSharing({on:true,until:Math.floor(Date.now()/1000)+3600-30,paired:true}));
  assert.match(await label(page),/^Live · (59|60) min$/);
  assert.equal(await button.getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.getElementById('golivebtn').classList.contains('is-live')),true);
  await page.evaluate(()=>window.livegeoApp.onSharing({on:true,until:Math.floor(Date.now()/1000)+4*3600+90,paired:true}));
  assert.match(await label(page),/^Live · 4 h 1 min$/);
  await page.evaluate(()=>window.livegeoApp.onSharing({on:true,until:null,paired:true}));
  assert.equal(await label(page),'Live');
  await page.evaluate(()=>window.livegeoApp.onSharing({on:false,until:null,paired:true}));
  assert.equal(await label(page),'Go live');
  assert.equal(await page.evaluate(()=>document.getElementById('golivebtn').classList.contains('is-live')),false);

  // A day as GPX: Download goes to the app, which saves where the person picks;
  // Send, which a web view could not offer, goes to the app's share sheet.
  await page.locator('.game-blip.self').focus();await page.keyboard.press('Enter');
  await page.waitForSelector('#detailPanel:not([hidden])');
  await page.locator('#detailPanel .gpxbtn').click();await page.waitForSelector('#gpxDialog[open]');
  await page.waitForFunction(()=>!document.getElementById('gpxSave').disabled);
  await page.locator('#gpxSave').click();
  await page.waitForFunction(()=>window.__calls.some(c=>c[0]==='save'));
  const [[,name,mime,saved]]=await calls(page,'save');
  assert.match(name,/\.gpx$/);assert.match(mime,/gpx/);
  assert.match(decode(saved),/<gpx[\s\S]*<trkpt/,'the file itself, not a link to it');
  assert.equal(await page.locator('#gpxSend').isVisible(),true,'Send is offered in the app');
  await page.locator('#gpxSend').click();
  await page.waitForFunction(()=>window.__calls.some(c=>c[0]==='share'));
  const shared=JSON.parse((await calls(page,'share'))[0][1]);
  assert.equal(shared.files.length,1);assert.match(shared.files[0].name,/\.gpx$/);
  assert.equal(decode(shared.files[0].base64),decode(saved),'sent is exactly what is saved');
  assert.equal(demo.mutations.filter(r=>r.path.startsWith('/api/devices')).length,0,'the page never pairs by itself');

  assert.deepEqual(errors,[],'no console/application errors');
  console.log('App bridge: nothing in a browser; in the app Go live follows sharing, game camera first, GPX saved and sent through the app');
}finally{if(browser)await browser.close();await demo.close();}
