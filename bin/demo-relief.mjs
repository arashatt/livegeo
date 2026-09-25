// A separate review of real elevation near Mashhad, with no live people/data.
import {chromium} from 'playwright-core';
import {access,mkdir,stat,writeFile} from 'node:fs/promises';
import {startDemo} from '../test/game-demo.mjs';
import {makeTerrainTiles} from '../src/terrain-tiles.js';
const paths=[process.env.CHROMIUM_PATH,'/usr/bin/google-chrome','/usr/bin/chromium',new URL('../../qa/chromium',import.meta.url).pathname].filter(Boolean);
let executablePath;for(const p of paths)try{await access(p);executablePath=p;break;}catch{}
if(!executablePath)throw new Error('Set CHROMIUM_PATH');
const cacheDir=process.env.TERRAIN_DEMO_CACHE;if(!cacheDir)throw new Error('Set TERRAIN_DEMO_CACHE to a prepared DEM cache or a writable directory');
const elevation=makeTerrainTiles({cacheDir}),features=Object.fromEntries(['landuse','water','parks','roads','rail','buildings','places'].map(k=>[k,[]]));
const demo=await startDemo({features,positions:[],elevation,district:'Mashhad region'}),args=['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
if(executablePath.includes('/qa/'))args.push('--single-process','--in-process-gpu','--disable-features=IsolateOrigins,site-per-process');
const browser=await chromium.launch({executablePath,headless:true,args}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const out=new URL('../docs/reference-map/',import.meta.url).pathname;await mkdir(out,{recursive:true});
try{
 await page.goto(demo.origin);await page.waitForFunction(()=>document.body.dataset.renderer==='game');
 await page.evaluate(()=>{const m=window.livegeoMap;m.light='day';m.lighting(true);m.setCamera('map');m.gl.jumpTo({center:[59.47,36.34],zoom:10.8});});
 await page.waitForFunction(()=>window.livegeoMap.gl.areTilesLoaded(),{},{timeout:60000});await page.waitForTimeout(1200);
 if(!(await page.evaluate(()=>window.livegeoMap.reliefAvailable)))throw new Error('Real elevation unavailable');
 const path=out+'mashhad-relief.jpg';for(const quality of [78,64,50,38]){await page.screenshot({path,type:'jpeg',quality});if((await stat(path)).size<250000)break;}
 const report={source:'Mapzen Terrain Tiles / USGS elevation near Mashhad',center:[59.47,36.34],zoom:10.8,contains:'Elevation only; no OSM street snapshot or production locations',terrainTiles:demo.requests.filter(p=>p.startsWith('/relief/')).length,bytes:(await stat(path)).size,errors};
 await writeFile(out+'relief-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(errors.length)throw new Error('Terrain capture errors');
}finally{console.log(JSON.stringify({requested:demo.requests.filter(p=>p.startsWith('/relief/'))}));await browser.close();await demo.close();}
