// Local, invented fixtures only. No production account, location, or tile service.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {staticFile} from '../src/server.js';
import {parseVectorPath} from '../src/tile-path.js';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
export const demoCenter=[-80.145,25.783];
const feature=(geometry,properties)=>({type:'Feature',geometry,properties});
const polygon=(ring,properties)=>feature({type:'Polygon',coordinates:[[...ring,ring[0]]]},properties);
const rect=(w,s,e,n,p)=>polygon([[w,s],[e,s],[e,n],[w,n]],p);
const line=(points,p)=>feature({type:'LineString',coordinates:points},{name:'',bridge:0,tunnel:0,layer:0,...p});
export function demoFeatures(){
  const data={landuse:[],water:[],parks:[],roads:[],rail:[],buildings:[],places:[]};
  data.landuse.push(rect(-80.19,25.75,-80.126,25.82,{class:'urban'}));
  data.water.push(rect(-80.1255,25.74,-80.08,25.83,{class:'area'}));
  data.parks.push(rect(-80.153,25.786,-80.147,25.791,{class:'park',name:'Palm Gardens'}),rect(-80.131,25.762,-80.127,25.811,{class:'park',name:'Coast Park'}));
  for(let i=0;i<=12;i++){
    const x=-80.17+i*.0033,y=25.761+i*.0037;
    data.roads.push(line([[x,25.756],[x,25.815]],{class:i===8?'primary':i===3?'secondary':'residential',name:i===8?'PALM AVENUE':i===3?'بلوار امام رضا':`${i+1} AVENUE`}));
    data.roads.push(line([[-80.176,y],[-80.128,y]],{class:i===6?'primary':i===9?'secondary':'residential',name:i===6?'BAY DRIVE':`${i+1} STREET`}));
  }
  data.roads.push(line([[-80.171,25.754],[-80.162,25.763],[-80.154,25.779],[-80.14,25.794],[-80.129,25.82]],{class:'motorway',name:'COAST EXPRESSWAY',bridge:1,layer:1}));
  data.roads.push(line([[-80.13,25.755],[-80.128,25.773],[-80.129,25.798],[-80.127,25.817]],{class:'footway',name:'COAST WALK'}));
  data.rail.push(line([[-80.167,25.755],[-80.158,25.778],[-80.156,25.815]],{class:'rail'}));
  for(let i=0;i<12;i++)for(let j=0;j<12;j++)for(let k=0;k<9;k++){
    const w=-80.16955+i*.0033+(k%3)*.00103,s=25.7614+j*.0037+Math.floor(k/3)*.00115;
    if(w>-.0-80.154&&w<-80.147&&s>25.785&&s<25.792)continue;
    const h=10+(i*7+j*13+k*19)%38+(i>5&&i<9&&j>4&&j<8?45:0);
    data.buildings.push(rect(w,s,w+.00070,s+.00077,{class:'apartments',height:h,name:''}));
  }
  for(const [name,x,y,c] of [['BAY DISTRICT',-80.143,25.792,'suburb'],['PALM QUARTER',-80.16,25.777,'suburb'],['مشهد',-80.134,25.785,'neighbourhood']])data.places.push(feature({type:'Point',coordinates:[x,y]},{name,class:c}));
  return data;
}
export function demoPeople(){
  const now=Math.floor(Date.now()/1000),path=(x,y,dx,dy)=>Array.from({length:8},(_,i)=>({latitude:y-(7-i)*dy,longitude:x-(7-i)*dx,at:now-(7-i)*25}));
  return [
    {id:'1',name:'Alex',latitude:25.783,longitude:-80.145,accuracy:25,heading:35,liveUntil:now+3000,at:now,trail:path(-80.145,25.783,.00035,.0003)},
    {id:'2',name:'Mina',latitude:25.786,longitude:-80.140,accuracy:18,heading:100,liveUntil:now+3000,at:now-10,trail:path(-80.14,25.786,.0006,0)},
    {id:'3',name:'Noah',latitude:25.778,longitude:-80.147,accuracy:35,heading:null,liveUntil:0,at:now-500,stopped:true,trail:path(-80.147,25.778,0,.0004)},
    {id:'4',name:'Sam',latitude:25.7815,longitude:-80.137,accuracy:25,heading:null,liveUntil:now+3000,at:now-20,sos:now+1800,trail:path(-80.137,25.7815,.0003,-.0002)},
    {id:'5',name:'Jamie · private',latitude:25.787,longitude:-80.151,accuracy:220,hidden:true,liveUntil:now+3000,at:now-25,trail:[...path(-80.154,25.783,.0003,.0004),{latitude:25.7838,longitude:-80.1536,at:now-5,gap:true}]},
  ];
}
export async function startDemo(){
  const data=demoFeatures(),indexes=Object.fromEntries(Object.entries(data).map(([key,features])=>[key,geojsonvt({type:'FeatureCollection',features},{maxZoom:19,indexMaxZoom:6,tolerance:1,extent:4096,buffer:192})]));
  let people=demoPeople();const streams=new Set(),requests=[],mutations=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
    const json=(d)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(d));};
    if(url.pathname==='/api/me')return json({id:'1',admin:true,circles:true,live:true,sos:true,checks:true,sosCall:'110 (police) or 115 (ambulance)'});
    if(url.pathname==='/api/positions')return json({people});
    if(url.pathname==='/api/stream'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write('event: hello\ndata: '+JSON.stringify({people})+'\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;
    }
    if(url.pathname.startsWith('/api/person/')){const p=people.find((p)=>p.id===url.pathname.split('/').pop());return json({id:p?.id,name:p?.name||'Demo',username:'',photo:false});}
    if(url.pathname==='/api/place')return json({place:'Bay Drive, Bay District'});
    if(url.pathname.startsWith('/api/history/'))return json({points:people.find((p)=>p.id===url.pathname.split('/').pop())?.trail||[]});
    if(url.pathname==='/api/fences'&&req.method==='GET')return json({fences:[{id:1,name:'Meeting point',ring:[[25.775,-80.143],[25.775,-80.139],[25.778,-80.139],[25.778,-80.143]]}]});
    if(url.pathname==='/api/zones'&&req.method==='GET')return json({zones:[{id:1,name:'Home',latitude:25.780,longitude:-80.154,radius:210}]});
    if(url.pathname.startsWith('/api/gpx/')){res.setHeader('content-type','application/gpx+xml');res.setHeader('content-disposition','attachment; filename="demo-day.gpx"');return res.end('<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="25.780" lon="-80.147"><time>2026-09-24T10:00:00Z</time></trkpt><trkpt lat="25.783" lon="-80.145"><time>2026-09-24T10:05:00Z</time></trkpt></trkseg></trk></gpx>');}
    if(url.pathname==='/api/circle')return json({canSeeMe:[],iCanSee:[]});
    if(url.pathname==='/api/devices')return json({devices:[]});
    if(url.pathname==='/api/live')return json({links:[]});
    if(url.pathname.startsWith('/api/')){mutations.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams)});return json(url.pathname==='/api/sos'?{until:Math.floor(Date.now()/1000)+3600,told:2,call:'110 (police) or 115 (ambulance)'}:{ok:true});}
    const tile=parseVectorPath(url.pathname);
    if(tile){const tiles={};for(const [key,index] of Object.entries(indexes)){if(key==='buildings'&&tile.z<15)continue;const t=index.getTile(tile.z,tile.x,tile.y);if(t)tiles[key]=t;}
      const raw=Buffer.from(vtpbf.fromGeojsonVt(tiles, {version:2}));res.writeHead(200,{'content-type':'application/vnd.mapbox-vector-tile','content-encoding':'gzip','x-carto-source':'postgis'});return res.end(gzipSync(raw));}
    if(url.pathname.startsWith('/carto/')){res.writeHead(200,{'content-type':'image/svg+xml','x-carto-source':'empty'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>');}
    if(url.pathname.startsWith('/tiles/')){res.writeHead(200,{'content-type':'image/png'});return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWPgk1H6DwABqwFkWrOO9QAAAABJRU5ErkJggg==','base64'));}
    if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
    const file=url.pathname==='/'?{file:new URL('../public/index.html',import.meta.url),type:'text/html'}:staticFile(url.pathname);
    const bytes=file?await readFile(file.file).catch(()=>null):null;
    if(!bytes){res.writeHead(404);return res.end('Not found');}res.setHeader('content-type',file.type);res.end(bytes);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  process.env.TELEGRAM_API=origin+'/telegram-stub';process.env.TILE_UPSTREAM=origin+'/tiles/{z}/{x}/{y}.png';
  return {server,origin,requests,mutations,data,indexes,
    update(p){people=people.map((q)=>q.id===p.id?{...q,...p}:q);const updated=people.find((q)=>q.id===p.id);for(const s of streams)s.write('event: position\ndata: '+JSON.stringify(updated)+'\n\n');},
    event(name,data){for(const s of streams)s.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');},
    async close(){for(const s of streams)s.end();server.closeAllConnections();await new Promise((r)=>server.close(r));},
  };
}
