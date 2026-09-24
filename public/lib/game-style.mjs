// Style and sun math are independent of the dashboard's privacy/business logic.
export const palettes = {
  day: {land:'#172d37',urban:'#263e47',sand:'#53615c',water:'#126679',park:'#123e37',building:'#8a9b99',roof:'#c9ded3',sky:'#176986',horizon:'#a3d7cd',fog:'#c3d6bc',road:'#ecb9ca',highway:'#ff68cb',rail:'#93b4bb'},
  golden: {land:'#22363a',urban:'#334749',sand:'#6d6751',water:'#155d6a',park:'#133d32',building:'#acb2a0',roof:'#ffe1a6',sky:'#484978',horizon:'#f2a579',fog:'#efc99d',road:'#edbbcd',highway:'#ff6ace',rail:'#a7c8c4'},
  night: {land:'#081720',urban:'#102631',sand:'#283b40',water:'#073a4a',park:'#082f29',building:'#24434e',roof:'#80b3bc',sky:'#050d21',horizon:'#213b5c',fog:'#345367',road:'#89b0ba',highway:'#ff64d1',rail:'#7198a4'},
};
export function sunAt(lat,lon,time=new Date()) {
  const rad=Math.PI/180, day=(+time-Date.UTC(time.getUTCFullYear(),0,0))/86400000;
  const gamma=2*Math.PI/365*(day-1+(time.getUTCHours()-12)/24);
  const eq=229.18*(.000075+.001868*Math.cos(gamma)-.032077*Math.sin(gamma)-.014615*Math.cos(2*gamma)-.040849*Math.sin(2*gamma));
  const dec=.006918-.399912*Math.cos(gamma)+.070257*Math.sin(gamma)-.006758*Math.cos(2*gamma)+.000907*Math.sin(2*gamma)-.002697*Math.cos(3*gamma)+.00148*Math.sin(3*gamma);
  const h=((time.getUTCHours()*60+time.getUTCMinutes()+time.getUTCSeconds()/60+eq+4*lon)/4-180)*rad;
  const elevation=Math.asin(Math.sin(lat*rad)*Math.sin(dec)+Math.cos(lat*rad)*Math.cos(dec)*Math.cos(h))/rad;
  const azimuth=(Math.atan2(Math.sin(h),Math.cos(h)*Math.sin(lat*rad)-Math.tan(dec)*Math.cos(lat*rad))/rad+180+360)%360;
  return {elevation,azimuth,phase:elevation < -6?'night':elevation<12?'golden':'day',label:elevation < -6?'Night':elevation<0?'Dawn / dusk':elevation<12?'Golden hour':'Day'};
}
const source='city', font=['LiveGeo'];
const field=['upcase',['coalesce',['get','name'],'']];
const isPath=['in',['get','class'],['literal',['pedestrian','path','footway','track','cycleway','steps']]];
const major=['in',['get','class'],['literal',['motorway','motorway_link','trunk','trunk_link','primary','primary_link']]];
const width=['match',['get','class'],['motorway','trunk'],7,['motorway_link','trunk_link','primary'],5,['secondary','primary_link'],3.7,['tertiary','secondary_link'],2.6,1.2];
function roadWidth(scale=1){return ['interpolate',['exponential',1.35],['zoom'],8,['*',width,.1*scale],14,['*',width,.65*scale],18,['*',width,2.4*scale]];}
export function gameStyle(phase='day',lite=false) {
  const p=palettes[phase];
  return {version:8,projection:{type:'globe'},glyphs:'/vendor/fonts/glyphs/{fontstack}/{range}.pbf',
    sky:lite?undefined:{'sky-color':p.sky,'horizon-color':p.horizon,'fog-color':p.fog,'sky-horizon-blend':.7,'horizon-fog-blend':.65,'fog-ground-blend':.4,'atmosphere-blend':['interpolate',['linear'],['zoom'],0,1,5,1,9,.1,12,0]},
    light:{anchor:'map',color:phase==='golden'?'#ffe2a9':'#d5edeb',intensity:phase==='night'?.35:.48,position:[1.5,210,40]},
    sources:{world:{type:'geojson',data:'/vendor/natural-earth/land.json',maxzoom:7,tolerance:.5,attribution:'Public domain · Natural Earth'},
      city:{type:'vector',tiles:[location.origin+'/carto/{z}/{x}/{y}.mvt'],minzoom:8,maxzoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}},
    layers:[
      {id:'ocean',type:'background',paint:{'background-color':p.water}},
      {id:'world-land',type:'fill',source:'world',paint:{'fill-color':p.land}},
      {id:'world-coast',type:'line',source:'world',maxzoom:9,paint:{'line-color':'#4eabb5','line-width':.7,'line-opacity':.6}},
      {id:'landuse',type:'fill',source,'source-layer':'landuse',paint:{'fill-color':['match',['get','class'],'terrain',p.sand,p.urban],'fill-opacity':.85}},
      {id:'parks',type:'fill',source,'source-layer':'parks',paint:{'fill-color':p.park}},
      {id:'park-rim',type:'line',source,'source-layer':'parks',minzoom:14,paint:{'line-color':'#358776','line-width':.65,'line-opacity':.5}},
      {id:'water',type:'fill',source,'source-layer':'water',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':p.water}},
      {id:'water-lines',type:'line',source,'source-layer':'water',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':p.water,'line-width':['interpolate',['linear'],['zoom'],11,1,17,8]}},
      {id:'rail',type:'line',source,'source-layer':'rail',paint:{'line-color':p.rail,'line-width':1.5,'line-dasharray':[3,3]}},
      {id:'roads-glow',type:'line',source,'source-layer':'roads',filter:['all',major,['==',['get','tunnel'],0]],layout:{visibility:lite?'none':'visible','line-cap':'round','line-join':'round'},paint:{'line-color':p.highway,'line-width':roadWidth(2.8),'line-blur':6,'line-opacity':phase==='night'?.58:.24}},
      {id:'roads-case',type:'line',source,'source-layer':'roads',filter:['!',isPath],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#071921','line-width':roadWidth(1.6),'line-opacity':.9}},
      {id:'roads',type:'line',source,'source-layer':'roads',filter:['!',isPath],layout:{'line-cap':'round','line-join':'round','line-sort-key':['get','layer']},paint:{'line-color':['case',major,p.highway,p.road],'line-width':roadWidth(),'line-opacity':['case',['==',['get','tunnel'],1],.4,.9]}},
      {id:'paths',type:'line',source,'source-layer':'roads',filter:isPath,paint:{'line-color':'#a0c1bc','line-width':1.1,'line-dasharray':[1,3],'line-opacity':.7}},
      {id:'buildings-flat',type:'fill',source,'source-layer':'buildings',paint:{'fill-color':p.building,'fill-opacity':.55,'fill-outline-color':p.roof}},
      {id:'buildings',type:'fill-extrusion',source,'source-layer':'buildings',minzoom:15,layout:{visibility:lite?'none':'visible'},paint:{'fill-extrusion-color':phase==='night'?p.building:['match',['%', ['to-number',['get','height']],3],0,'#91b3b4',1,'#aebaa1',p.building],'fill-extrusion-height':['get','height'],'fill-extrusion-base':0,'fill-extrusion-opacity':1,'fill-extrusion-vertical-gradient':true}},
      {id:'roof-light',type:'fill-extrusion',source,'source-layer':'buildings',minzoom:15,layout:{visibility:lite?'none':'visible'},paint:{'fill-extrusion-color':p.roof,'fill-extrusion-height':['+',['get','height'],.2],'fill-extrusion-base':['-',['get','height'],.6],'fill-extrusion-opacity':1}},
      {id:'road-label',type:'symbol',source,'source-layer':'roads',minzoom:15,filter:['all',['has','name'],['!',isPath]],layout:{'symbol-placement':'line','text-field':field,'text-font':font,'text-size':12,'text-letter-spacing':0,'symbol-spacing':260,'text-max-angle':30},paint:{'text-color':'#e8f0e9','text-halo-color':'#11242d','text-halo-width':2}},
      {id:'place-label',type:'symbol',source,'source-layer':'places',layout:{'text-field':field,'text-font':font,'text-size':['match',['get','class'],'city',23,'town',19,16],'text-letter-spacing':0,'text-padding':24,'text-max-width':10},paint:{'text-color':'#f6ead6','text-halo-color':'#12232c','text-halo-width':2.5}},
    ],transition:{duration:0,delay:0}};
}
export function windowsImage(){
  const width=32,height=64,data=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const lit=x%8>=2&&x%8<=4&&y%12>=3&&y%12<=6&&((Math.floor(x/8)*3+Math.floor(y/12))%4!==0);
    const color=lit?[212,218,156]:[25,49,60]; const i=(y*width+x)*4;
    data.set([...color,255],i);
  }
  return {width,height,data};
}
