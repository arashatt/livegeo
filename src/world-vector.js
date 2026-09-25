// Adapt the already configured/cached OpenMapTiles source to the dashboard's
// small MVT vocabulary. No browser contacts a tile provider. Local PostGIS wins.
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import {gzipSync} from 'node:zlib';
import {classify} from './cartography-vector.js';
import {VECTOR_MAX_ZOOM} from './vector-tiles.js';
import {EMPTY_VECTOR,VECTOR_LAYERS} from './postgis-vector.js';

const SOURCES=['landuse','landcover','park','water','waterway','building','transportation','transportation_name','place','poi','aerodrome_label','mountain_peak','water_name'];
export const WORLD_BUDGET=Object.freeze({landuse:350,parks:500,'water-area':400,'water-line':500,buildings:1800,rail:400,roads:2400,places:150});
const priorities={motorway:0,trunk:0,primary:1,secondary:2,tertiary:3};
const named=(p)=>String(p.name||p['name:latin']||p['name:en']||'').slice(0,160);
const finite=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;
function landmark(source,p){
  if(source==='aerodrome_label')return 'airport';
  const names=[p.class,p.subclass];
  for(const [type,aliases] of Object.entries({airport:['airport','aerodrome'],university:['university','college'],park:['park','garden'],bus:['bus_station'],hospital:['hospital','clinic'],station:['railway','station'],worship:['place_of_worship'],landmark:['monument','attraction']}))if(names.some(n=>aliases.includes(n)))return type;
  return null;
}
function kindOf(source,p,type,z){
  if(type===3&&z>=10&&((source==='landcover'&&p.class==='farmland')||(source==='landuse'&&['farmland','farmyard','orchard','vineyard'].includes(p.class))))return {layer:'landuse',subtype:'field'};
  if(type===3&&z>=10&&source==='landuse'&&p.class==='aerodrome')return {layer:'landuse',subtype:'airport'};
  if(source==='mountain_peak'&&type===1&&z>=11&&named(p))return {layer:'places',subtype:'peak',landmark:true};
  if(source==='water_name'&&type===1&&z>=12&&named(p))return {layer:'places',subtype:'water',landmark:true};
  if(source==='place'){
    const minimum={country:8,state:8,city:8,town:9,village:11,suburb:11,quarter:12,neighbourhood:13,hamlet:14,locality:14}[p.class];
    return type===1&&minimum!==undefined&&z>=minimum&&named(p)?{layer:'places',subtype:p.class}:null;
  }
  if(source==='poi'||source==='aerodrome_label'){
    const kind=landmark(source,p);
    return type===1&&kind&&z>=(kind==='airport'?11:12)&&named(p)?{layer:'places',subtype:kind,landmark:true}:null;
  }
  if(source==='transportation_name')return z>=13&&named(p)?classify('transportation',p,type,z):null;
  return classify(source,p,type,z);
}
function properties(source,p,kind){
  const result={name:named(p),class:kind.subtype||p.class||'park'};
  if(kind.layer==='parks')result.class=source==='landcover'&&p.class==='wood'?'wood':p.class==='grass'?'grass':'park';
  if(kind.layer==='buildings')result.height=Math.min(350,Math.max(3,finite(p.render_height,finite(p.height,finite(p['building:levels'],2)*3))));
  if(kind.layer==='roads'||kind.layer==='rail'){
    result.bridge=p.brunnel==='bridge'||p.bridge===1?1:0;result.tunnel=p.brunnel==='tunnel'||p.tunnel===1?1:0;
    result.layer=Math.min(10,Math.max(-10,finite(p.layer)));result.label_only=source==='transportation_name'?1:0;
  }
  if(kind.layer==='places'){result.kind=kind.landmark?'landmark':'place';result.rank=finite(p.rank,kind.landmark?100:20);}
  return result;
}
const groupOf=(kind,type)=>kind.layer==='water'?(type===3?'water-area':'water-line'):kind.layer;

export function makeWorldVector({upstream,now=Date.now,log=console}={}){
  const parents=new Map(),loading=new Map(),cache=new Map(),pending=new Map();
  async function parent(tile){
    const key=`${tile.z}/${tile.x}/${tile.y}`,hit=parents.get(key);
    if(hit&&hit.until>now())return hit.records;
    if(loading.has(key))return loading.get(key);
    const task=(async()=>{
      const got=await upstream.tile(tile);if(!got)throw new Error('world vector unavailable');
      if(got.bytes.length>8*1024*1024)throw new Error('world vector exceeds 8 MiB');
      const decoded=new VectorTile(new Pbf(got.bytes)),records=[];
      for(const source of SOURCES){
        const layer=decoded.layers[source];if(!layer)continue;
        for(let i=0;i<Math.min(layer.length,12000);i++){
          const feature=layer.feature(i),kind=kindOf(source,feature.properties,feature.type,19);
          if(kind)records.push({source,feature,bounds:feature.bbox()});
        }
      }
      if(parents.size>=6)parents.delete(parents.keys().next().value);
      parents.set(key,{records,until:now()+300000});return records;
    })().catch(error=>{
      if(parents.size>=6)parents.delete(parents.keys().next().value);
      parents.set(key,{records:null,until:now()+30000});
      log.error('geo: cannot read world vector cartography —',error?.message||error);return null;
    }).finally(()=>loading.delete(key));loading.set(key,task);return task;
  }
  async function build(z,x,y){
    const pz=Math.min(z,VECTOR_MAX_ZOOM),scale=2**(z-pz),tile={z:pz,x:Math.floor(x/scale),y:Math.floor(y/scale)};
    const records=await parent(tile);if(!records)return null;
    const grouped={};
    for(const {source,feature:f,bounds:b} of records){
      const kind=kindOf(source,f.properties,f.type,z);if(!kind)continue;
      const width=f.extent/scale,left=(x-tile.x*scale)*width,top=(y-tile.y*scale)*width,margin=width*192/4096;
      if(b[2]<left-margin||b[0]>left+width+margin||b[3]<top-margin||b[1]>top+width+margin)continue;
      const group=groupOf(kind,f.type),props=properties(source,f.properties,kind);
      (grouped[group]??=[]).push({f,props,layer:kind.layer,priority:kind.layer==='roads'?(priorities[props.class]??4)+(props.label_only?10:0):kind.layer==='places'?(props.kind==='landmark'?1000:0)+props.rank:-(b[2]-b[0])*(b[3]-b[1])});
    }
    const features={};
    for(const [group,found] of Object.entries(grouped)){
      found.sort((a,b)=>a.priority-b.priority);
      for(const {f,props,layer} of found.slice(0,WORLD_BUDGET[group])){
        const geo=f.toGeoJSON(tile.x,tile.y,tile.z);geo.properties=props;
        (features[layer]??=[]).push(geo);
      }
    }
    const layers={};
    for(const [name,fs] of Object.entries(features)){
      // geojson-vt clips and reprojects overzoomed parent geometry. It retains
      // polygon holes and road fragments, without inventing extra detail.
      const index=geojsonvt({type:'FeatureCollection',features:fs},{maxZoom:19,indexMaxZoom:0,indexMaxPoints:0,extent:4096,buffer:192,tolerance:1});
      const part=index.getTile(z,x,y);if(part?.features.length)layers[name]=part;
    }
    return {layers,variants:new Map(),until:now()+300000};
  }
  return {async tile(z,x,y,wanted=VECTOR_LAYERS){
    if(!upstream||upstream.enabled===false||z<8||z>19||![z,x,y].every(Number.isInteger)||x<0||y<0||x>=2**z||y>=2**z||!Array.isArray(wanted)||!wanted.length||wanted.some(n=>!VECTOR_LAYERS.includes(n)))return EMPTY_VECTOR;
    const key=`${z}/${x}/${y}`;let hit=cache.get(key);
    try{
      if(!hit||hit.until<=now()){
        if(!pending.has(key)){
          if(pending.size>=32)return EMPTY_VECTOR;
          pending.set(key,build(z,x,y).then(result=>{if(result){if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,result);}return result;}).finally(()=>pending.delete(key)));
        }
        hit=await pending.get(key);
      }
      if(!hit)return EMPTY_VECTOR;
      const names=VECTOR_LAYERS.filter(n=>wanted.includes(n)),variant=names.join(',');
      if(hit.variants.has(variant))return hit.variants.get(variant);
      const selected=Object.fromEntries(names.filter(n=>hit.layers[n]).map(n=>[n,hit.layers[n]]));
      const raw=Object.keys(selected).length?Buffer.from(vtpbf.fromGeojsonVt(selected,{version:2})):Buffer.alloc(0);
      const result=raw.length?{raw,gzip:gzipSync(raw),empty:false,source:'upstream'}:EMPTY_VECTOR;
      if(hit.variants.size>=2)hit.variants.delete(hit.variants.keys().next().value);hit.variants.set(variant,result);return result;
    }catch(error){log.error('geo: cannot adapt world vector cartography —',error?.message||error);return EMPTY_VECTOR;}
  }};
}
