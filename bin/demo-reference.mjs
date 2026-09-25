// Reference-layout review with invented fixture geography and people only.
import {chromium} from 'playwright-core';
import {access,mkdir,writeFile,stat} from 'node:fs/promises';
import {startDemo,demoCenter} from '../test/game-demo.mjs';
const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/google-chrome','/usr/bin/chromium',new URL('../../qa/chromium',import.meta.url).pathname].filter(Boolean);
let executablePath;for(const p of candidates)try{await access(p);executablePath=p;break;}catch{}
if(!executablePath)throw new Error('Set CHROMIUM_PATH');
const args=['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
if(executablePath.includes('/qa/'))args.push('--single-process','--in-process-gpu','--disable-features=IsolateOrigins,site-per-process');
const demo=await startDemo(),out=new URL('../docs/reference-map/',import.meta.url).pathname;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath,headless:true,args}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[],external=[],shots=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(demo.origin+'/'))external.push(r.url());});
async function camera(center,zoom,mode='map'){await page.evaluate(({center,zoom,mode})=>{const m=window.livegeoMap;m.light='day';m.lighting(true);m.setCamera(mode);m.gl.jumpTo({center,zoom,bearing:0,pitch:mode==='map'?0:50});},{center,zoom,mode});await page.waitForFunction(()=>window.livegeoMap.gl.areTilesLoaded());await page.waitForTimeout(1700);}
async function shot(name){const path=out+name+'.jpg';for(const quality of [78,64,50]){await page.screenshot({path,type:'jpeg',quality});if((await stat(path)).size<250000)break;}shots.push({name:name+'.jpg',bytes:(await stat(path)).size});}
try{
 await page.goto(demo.origin);await page.waitForFunction(()=>document.body.dataset.renderer==='game'&&document.querySelectorAll('.game-blip').length===4);
 await camera([-80.17,25.785],12.05);await shot('desktop-atlas');
 await camera(demoCenter,15.3);await shot('desktop-streets');
 await page.locator('#layersbtn').click();await shot('desktop-layers');await page.locator('#layersbtn').click();
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.livegeoMap.radarOn=false;window.livegeoMap.radar();});await camera(demoCenter,11.25);await shot('phone-atlas');
 await camera(demoCenter,14.15);await shot('phone-streets');
 await page.locator('#mapLegend summary').click();await page.waitForTimeout(300);await shot('phone-legend');
 await writeFile(out+'checks.json',JSON.stringify({screenshots:shots,consoleErrors:errors,externalRequests:external},null,2)+'\n');
 console.log(JSON.stringify({screenshots:shots,consoleErrors:errors,externalRequests:external}));
 if(errors.length||external.length||shots.some(s=>s.bytes>250000))throw new Error('Reference capture failed');
}finally{await browser.close();await demo.close();}
