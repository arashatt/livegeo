// Capture only invented local data. Reproduce with CHROMIUM_PATH=... npm run demo:game.
import {chromium} from 'playwright-core';
import {access,mkdir,writeFile,stat,readdir} from 'node:fs/promises';
import {startDemo,demoCenter,demoPeople} from '../test/game-demo.mjs';
const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/google-chrome','/usr/bin/chromium',new URL('../../qa/chromium',import.meta.url).pathname].filter(Boolean);
let executablePath;for(const p of candidates)try{await access(p);executablePath=p;break;}catch{}
if(!executablePath)throw new Error('Set CHROMIUM_PATH');
const args=['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
if(executablePath.includes('/qa/'))args.push('--single-process','--in-process-gpu','--disable-features=IsolateOrigins,site-per-process');
const demo=await startDemo(),out=new URL('../docs/game-map/',import.meta.url).pathname;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath,headless:true,args}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(demo.origin+'/'))external.push(r.url());});
const metrics={renderer:await browser.version(),cpuThrottle:4,graphics:'SwiftShader software WebGL2 (not a physical phone)',screenshots:[],externalRequests:external};
async function settle(){await page.waitForFunction(()=>window.livegeoMap?.gl.areTilesLoaded(),{},{timeout:30000});await page.waitForTimeout(900);}
async function camera(center,zoom,pitch,bearing=0,mode='auto',light='day'){
  await page.evaluate(({center,zoom,pitch,bearing,mode,light})=>{const m=window.livegeoMap;m.light=light;m.lighting(true);m.setCamera(mode);m.gl.jumpTo({center,zoom,pitch,bearing});}, {center,zoom,pitch,bearing,mode,light});await settle();
}
async function shot(name){const path=out+name+'.jpg';let size;for(const quality of [75,62,48]){await page.screenshot({path,type:'jpeg',quality});size=(await stat(path)).size;if(size<=250000)break;}if(size>250000)throw new Error('Screenshot too large');metrics.screenshots.push({name:name+'.jpg',bytes:size});}
try{
 await page.goto(demo.origin);await page.waitForFunction(()=>document.body.dataset.renderer==='game'&&document.querySelectorAll('.game-blip').length===4,{},{timeout:30000});
 for(const phone of [false,true]){
  await page.setViewportSize(phone?{width:390,height:844}:{width:1440,height:900});const prefix=phone?'phone':'desktop';
  await camera([25,22],1.4,0);await shot(prefix+'-globe');
  await camera([-80.143,25.783],16.15,74,-24);await shot(prefix+'-day');
  await camera([-80.143,25.783],16.15,74,-24,'auto','night');await shot(prefix+'-night');
  await camera(demoCenter,17,74,35,'auto','golden');await shot(prefix+'-street');
  await camera([-80.145,25.783],phone?14.1:15.25,0,0,'map');await shot(prefix+'-map');
  await page.evaluate(()=>{const m=window.livegeoMap;m.radarOn=true;m.radar();m.setCamera('chase');});await settle();await shot(prefix+'-chase');
  await camera(demoCenter,phone?14.2:15.2,0,0,'map');
  await page.locator('#mapLegend summary').click();await page.waitForFunction(()=>document.body.classList.contains('legend-open'));await settle();await shot(prefix+'-legend');await page.locator('#mapLegend summary').click();
  await page.locator('#layersbtn').click();await shot(prefix+'-layers');await page.locator('#layersbtn').click();
 }
 await page.setViewportSize({width:1440,height:900});await camera(demoCenter,15.3,0,0,'map');
 // Hover/tap a point midway along the first visible trail to show its interpolated time.
 const trail=demoPeople()[0].trail,a=trail[3],b=trail[4];const screen=await page.evaluate(({lat,lon})=>{const m=window.livegeoMap,p=m.gl.project([lon,lat]),r=m.gl.getContainer().getBoundingClientRect();return {x:p.x+r.left,y:p.y+r.top};},{lat:(a.latitude+b.latitude)/2,lon:(a.longitude+b.longitude)/2});
 await page.mouse.click(screen.x,screen.y);await page.waitForSelector('.game-tip.time-tip');await shot('desktop-trail-time');
 await page.locator('.game-blip.self').click();await page.waitForSelector('#detailPanel:not([hidden])');await shot('desktop-card');await page.locator('#detailclose').click();await page.mouse.click(550,120);
 // Real render-event counts, including expensive frames, after tiles/glyphs warm.
 for(const config of [{phone:false,lite:false},{phone:true,lite:false},{phone:true,lite:true}]){
  const {phone,lite}=config;await page.evaluate(lite=>{const m=window.livegeoMap;m.lite=lite;m.lighting(true);},lite);
  await page.setViewportSize(phone?{width:390,height:844}:{width:1440,height:900});await camera(demoCenter,16,lite?0:70,-20);
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const measurement=await page.evaluate(lite=>new Promise(resolve=>{const m=window.livegeoMap.gl;let count=0;const start=performance.now(),frame=()=>count++;m.on('render',frame);m.once('moveend',()=>{m.off('render',frame);const ms=performance.now()-start;resolve({frames:count,ms:Math.round(ms),fps:Math.round(count/ms*10000)/10});});const c=m.getCenter();m.easeTo({center:[c.lng+.003,c.lat+.002],pitch:lite?0:74,bearing:45,duration:4000,essential:true});}),lite);
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});metrics[lite?'phoneLitePan':phone?'phonePanTilt':'desktopPanTilt']=measurement;await settle();
 }
 const idle=await page.evaluate(()=>new Promise(resolve=>{const m=window.livegeoMap.gl;let count=0;const fn=()=>count++;m.on('render',fn);setTimeout(()=>{m.off('render',fn);resolve(count);},2000);}));metrics.idleRepaintsIn2s=idle;metrics.consoleErrors=errors;
 const categories={js:0,fonts:0,glyphs:0,data:0};
 async function total(dir){for(const name of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+name.name;if(name.isDirectory())await total(p);else{const n=(await stat(p)).size;if(/\/glyphs\//.test(p))categories.glyphs+=n;else if(/\.(ttf|woff2)$/.test(p)&&!/oswald/.test(p))categories.fonts+=n;else if(/natural-earth\/land.json$/.test(p))categories.data+=n;else if(/\.(js|mjs)$/.test(p)&&!/leaflet/.test(p))categories.js+=n;}}}
 await total(new URL('../public/vendor',import.meta.url).pathname);
 for(const f of ['game-map.mjs','game-start.mjs','game-style.mjs','map-bootstrap.js'])categories.js+=(await stat(new URL('../public/lib/'+f,import.meta.url))).size;
 metrics.addedAssetBytes=categories;
 await writeFile(out+'measurements.json',JSON.stringify(metrics,null,2)+'\n');console.log(JSON.stringify(metrics,null,2));
 if(errors.length||external.length||idle)throw new Error('Demo failed quality gates');
}finally{await browser.close();await demo.close();}
