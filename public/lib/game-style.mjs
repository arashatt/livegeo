// One cartographic palette at every zoom; perspective is an optional camera.
export const palettes = {
  day:{land:'#075866',urban:'#7b81a3',sand:'#bfa075',field:'#397c69',airport:'#405e76',water:'#16a9c4',park:'#2b956a',wood:'#176952',building:'#9aafb9',roof:'#d3dfd8',sky:'#478b9b',horizon:'#b9e0d9',fog:'#c3d6bc',road:'#f3b3d5',highway:'#fc62c6',minor:'#d7d3df',rail:'#dae0db'},
  golden:{land:'#155862',urban:'#617b8c',sand:'#c3a274',field:'#4b8166',airport:'#50677c',water:'#1ba5b8',park:'#348768',wood:'#25694e',building:'#abb5ae',roof:'#ffe1a6',sky:'#62628c',horizon:'#e6b38f',fog:'#e5d3b3',road:'#f1bed4',highway:'#fa78c7',minor:'#d0d7ce',rail:'#dfe1d5'},
  night:{land:'#0b3b4d',urban:'#3d6077',sand:'#87785e',field:'#285e53',airport:'#304e65',water:'#087d9d',park:'#176d54',wood:'#105240',building:'#718d9b',roof:'#a4cfd2',sky:'#132441',horizon:'#376079',fog:'#466f7d',road:'#ddb3cc',highway:'#fd79cc',minor:'#98b5be',rail:'#b8d2d5'},
};
export function sunAt(lat,lon,time=new Date()){
  const rad=Math.PI/180,day=(+time-Date.UTC(time.getUTCFullYear(),0,0))/86400000;
  const gamma=2*Math.PI/365*(day-1+(time.getUTCHours()-12)/24);
  const eq=229.18*(.000075+.001868*Math.cos(gamma)-.032077*Math.sin(gamma)-.014615*Math.cos(2*gamma)-.040849*Math.sin(2*gamma));
  const dec=.006918-.399912*Math.cos(gamma)+.070257*Math.sin(gamma)-.006758*Math.cos(2*gamma)+.000907*Math.sin(2*gamma)-.002697*Math.cos(3*gamma)+.00148*Math.sin(3*gamma);
  const h=((time.getUTCHours()*60+time.getUTCMinutes()+time.getUTCSeconds()/60+eq+4*lon)/4-180)*rad;
  const elevation=Math.asin(Math.sin(lat*rad)*Math.sin(dec)+Math.cos(lat*rad)*Math.cos(dec)*Math.cos(h))/rad;
  const azimuth=(Math.atan2(Math.sin(h),Math.cos(h)*Math.sin(lat*rad)-Math.tan(dec)*Math.cos(lat*rad))/rad+180+360)%360;
  return {elevation,azimuth,phase:elevation < -6?'night':elevation<12?'golden':'day',label:elevation < -6?'Night':elevation<0?'Dawn / dusk':elevation<12?'Golden hour':'Day'};
}
const source='city',font=['LiveGeo'],field=['upcase',['coalesce',['get','name'],'']];
const isPath=['in',['get','class'],['literal',['pedestrian','path','footway','track','cycleway','steps']]];
const major=['in',['get','class'],['literal',['motorway','motorway_link','trunk','trunk_link','primary','primary_link']]];
const streets=['!=',['get','label_only'],1];
const landmark=['==',['get','kind'],'landmark'];
const width=['match',['get','class'],['motorway','trunk'],4.7,['motorway_link','trunk_link','primary'],3.4,['secondary','primary_link'],2.3,['tertiary','secondary_link'],1.35,.65];
function roadWidth(scale=1){return ['interpolate',['exponential',1.25],['zoom'],8,['*',width,.16*scale],12,['*',width,.85*scale],15,['*',width,scale],18,['*',width,2*scale]];}
export function gameStyle(phase='day',lite=false,relief=true){
 const p=palettes[phase];
 return {version:8,projection:{type:'globe'},glyphs:'/lib/map-assets/fonts/glyphs/{fontstack}/{range}.pbf',
  sky:lite?undefined:{'sky-color':p.sky,'horizon-color':p.horizon,'fog-color':p.fog,'sky-horizon-blend':.7,'horizon-fog-blend':.65,'fog-ground-blend':.4,'atmosphere-blend':['interpolate',['linear'],['zoom'],0,1,5,1,9,.1,12,0]},
  light:{anchor:'map',color:phase==='golden'?'#ffe2a9':'#e2f1ed',intensity:phase==='night'?.35:.42,position:[1.5,210,40]},
  sources:{...(relief?{relief:{type:'raster-dem',tiles:[location.origin+'/relief/{z}/{x}/{y}.png'],tileSize:256,minzoom:5,maxzoom:12,encoding:'terrarium',attribution:'<a href="/lib/terrain-credits.html">Terrain · Mapzen / source credits</a>'}}:{}),world:{type:'geojson',data:'/lib/map-assets/natural-earth/land.json',maxzoom:7,tolerance:.5,attribution:'Natural Earth'},city:{type:'vector',tiles:[location.origin+'/carto/{z}/{x}/{y}.mvt'],minzoom:8,maxzoom:16,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> / <a href="https://openfreemap.org/">OpenFreeMap</a>'}},
  layers:[
   {id:'ocean',type:'background',paint:{'background-color':p.water}},
   {id:'world-land',type:'fill',source:'world',paint:{'fill-color':p.land}},
   {id:'world-coast',type:'line',source:'world',maxzoom:9,paint:{'line-color':'#73d7df','line-width':.8,'line-opacity':.65}},
   // MapLibre's elevation color ramp requires interpolate; paired stops retain
   // the poster's elevation bands without the silently ignored step expression.
   ...(relief?[
    {id:'relief-color',type:'color-relief',source:'relief',minzoom:5,layout:{visibility:lite?'none':'visible'},paint:{'color-relief-opacity':phase==='night'?.65:1,'color-relief-color':['interpolate',['linear'],['elevation'],-100,p.water,-1,p.water,0,p.land,499,p.land,500,'#1d655a',899,'#1d655a',900,'#346d58',1199,'#346d58',1200,'#557763',1449,'#557763',1450,'#7d8567',1649,'#7d8567',1650,'#9e9271',1849,'#9e9271',1850,'#b6a07a',2149,'#b6a07a',2150,'#c2aa84',2599,'#c2aa84',2600,'#d1ba96',3399,'#d1ba96',3400,'#ded0b5',4499,'#ded0b5',4500,'#f0e9d9']}},
    {id:'relief-shade',type:'hillshade',source:'relief',minzoom:5,layout:{visibility:lite?'none':'visible'},paint:{'hillshade-method':'standard','hillshade-illumination-anchor':'map','hillshade-illumination-direction':315,'hillshade-exaggeration':.62,'hillshade-shadow-color':'#213f3e','hillshade-highlight-color':'#efdbad','hillshade-accent-color':'#31564a'}},
   ]:[]),
   {id:'landuse',type:'fill',source,'source-layer':'landuse',paint:{'fill-color':['match',['get','class'],'terrain',p.sand,'field',p.field,'airport',p.airport,p.urban],'fill-opacity':.82}},
   {id:'parks',type:'fill',source,'source-layer':'parks',paint:{'fill-color':['match',['get','class'],'wood',p.wood,'grass',p.field,p.park]}},
   {id:'park-rim',type:'line',source,'source-layer':'parks',minzoom:11,paint:{'line-color':'#62b59a','line-width':.6,'line-opacity':.5}},
   {id:'water',type:'fill',source,'source-layer':'water',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':p.water}},
   {id:'water-rim',type:'line',source,'source-layer':'water',filter:['==',['geometry-type'],'Polygon'],paint:{'line-color':'#72dfdf','line-width':.7,'line-opacity':.7}},
   {id:'water-lines',type:'line',source,'source-layer':'water',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':p.water,'line-width':['interpolate',['linear'],['zoom'],10,.8,16,4,19,10]}},
   {id:'buildings-flat',type:'fill',source,'source-layer':'buildings',minzoom:15,paint:{'fill-color':p.building,'fill-opacity':['interpolate',['linear'],['zoom'],15,.18,17,.38,19,.52],'fill-outline-color':p.building}},
   {id:'rail',type:'line',source,'source-layer':'rail',paint:{'line-color':p.rail,'line-width':1.2,'line-dasharray':[2,3],'line-opacity':.8}},
   {id:'roads-glow',type:'line',source,'source-layer':'roads',filter:['all',streets,major,['!=',['get','tunnel'],1]],layout:{visibility:lite?'none':'visible','line-cap':'round','line-join':'round'},paint:{'line-color':p.highway,'line-width':roadWidth(2.3),'line-blur':3,'line-opacity':phase==='night'?.24:.12}},
   {id:'roads-case',type:'line',source,'source-layer':'roads',filter:['all',streets,['!',isPath]],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#204c60','line-width':roadWidth(1.7),'line-opacity':.7}},
   {id:'roads',type:'line',source,'source-layer':'roads',filter:['all',streets,['!',isPath]],layout:{'line-cap':'round','line-join':'round','line-sort-key':['coalesce',['get','layer'],0]},paint:{'line-color':['case',major,p.highway,['in',['get','class'],['literal',['secondary','secondary_link','tertiary','tertiary_link']]],p.road,p.minor],'line-width':roadWidth(),'line-opacity':['case',['==',['get','tunnel'],1],.5,.95]}},
   {id:'paths',type:'line',source,'source-layer':'roads',filter:['all',streets,isPath],paint:{'line-color':'#c5ddd0','line-width':.9,'line-dasharray':[1,3],'line-opacity':.7}},
   {id:'buildings',type:'fill-extrusion',source,'source-layer':'buildings',minzoom:15,layout:{visibility:lite?'none':'visible'},paint:{'fill-extrusion-color':p.building,'fill-extrusion-height':['coalesce',['get','height'],6],'fill-extrusion-base':0,'fill-extrusion-opacity':1,'fill-extrusion-vertical-gradient':true}},
   {id:'roof-light',type:'fill-extrusion',source,'source-layer':'buildings',minzoom:15,layout:{visibility:lite?'none':'visible'},paint:{'fill-extrusion-color':p.roof,'fill-extrusion-height':['+',['coalesce',['get','height'],6],.2],'fill-extrusion-base':['-',['coalesce',['get','height'],6],.6],'fill-extrusion-opacity':1}},
   {id:'road-label',type:'symbol',source,'source-layer':'roads',minzoom:13,filter:['all',['!=',['coalesce',['get','name'],''],''],['!',isPath]],layout:{'symbol-placement':'line','text-field':field,'text-font':font,'text-size':11,'text-letter-spacing':0,'symbol-spacing':300,'text-max-angle':30},paint:{'text-color':'#f4e8ed','text-halo-color':'#214454','text-halo-width':1.6}},
   {id:'place-label',type:'symbol',source,'source-layer':'places',filter:['!',landmark],layout:{'text-field':field,'text-font':font,'text-size':['match',['get','class'],'city',26,'town',23,['suburb','quarter'],20,16],'text-letter-spacing':0,'text-padding':28,'text-max-width':10,'symbol-sort-key':['coalesce',['get','rank'],20]},paint:{'text-color':'#f4f2e9','text-halo-color':'#173747','text-halo-width':2}},
   {id:'landmark-label',type:'symbol',source,'source-layer':'places',filter:landmark,layout:{'icon-image':['concat','poi-',['get','class']],'icon-size':.8,'icon-padding':5,'text-field':['get','name'],'text-font':font,'text-size':14,'text-letter-spacing':0,'text-anchor':'top','text-offset':[0,1.4],'text-max-width':9,'text-padding':8,'symbol-sort-key':['coalesce',['get','rank'],100]},paint:{'text-color':'#f0f7ec','text-halo-color':'#123849','text-halo-width':2}},
  ],transition:{duration:0,delay:0}};
}
export function windowsImage(){
 const width=32,height=64,data=new Uint8Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const lit=x%8>=2&&x%8<=4&&y%12>=3&&y%12<=6&&((Math.floor(x/8)*3+Math.floor(y/12))%4!==0);
  data.set([...(lit?[212,218,156]:[25,49,60]),255],(y*width+x)*4);
 }return {width,height,data};
}
// Original, neutral map symbols. Medical facilities use white, never SOS red.
export function landmarkImage(kind){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=40;const c=canvas.getContext('2d');
 c.fillStyle='#0b3246';c.strokeStyle='#d5edf0';c.lineWidth=2;c.beginPath();c.roundRect(3,3,34,34,7);c.fill();c.stroke();c.fillStyle='#eef6ee';c.strokeStyle='#eef6ee';c.lineWidth=2.8;c.lineCap='round';c.lineJoin='round';
 if(kind==='hospital'){c.fillRect(17,10,6,20);c.fillRect(10,17,20,6);}
 else if(kind==='university'){c.beginPath();c.moveTo(7,16);c.lineTo(20,10);c.lineTo(33,16);c.lineTo(20,22);c.closePath();c.fill();c.beginPath();c.moveTo(12,23);c.lineTo(12,27);c.quadraticCurveTo(20,32,28,27);c.lineTo(28,23);c.stroke();}
 else if(kind==='airport'){c.beginPath();c.moveTo(20,9);c.lineTo(20,30);c.moveTo(10,22);c.lineTo(20,17);c.lineTo(30,22);c.moveTo(15,30);c.lineTo(20,26);c.lineTo(25,30);c.stroke();}
 else if(kind==='station'||kind==='bus'){c.strokeRect(12,10,16,17);c.fillRect(15,13,10,7);c.beginPath();c.moveTo(15,27);c.lineTo(12,31);c.moveTo(25,27);c.lineTo(28,31);c.stroke();}
 else if(kind==='worship'){c.beginPath();c.moveTo(12,30);c.lineTo(12,18);c.quadraticCurveTo(20,8,28,18);c.lineTo(28,30);c.closePath();c.stroke();c.fillRect(18,23,4,7);}
 else if(kind==='peak'){c.beginPath();c.moveTo(7,30);c.lineTo(19,9);c.lineTo(33,30);c.closePath();c.stroke();c.moveTo(14,18);c.lineTo(19,21);c.lineTo(24,18);c.stroke();}
 else if(kind==='park'){c.fillStyle='#79c69a';c.beginPath();c.moveTo(20,8);c.lineTo(9,26);c.lineTo(31,26);c.closePath();c.fill();c.fillRect(18,25,4,7);}
 else if(kind==='water'){c.strokeStyle='#6edce3';for(let i=0;i<3;i++){c.beginPath();c.moveTo(8,13+i*7);c.bezierCurveTo(15,6+i*7,24,20+i*7,32,13+i*7);c.stroke();}}
 else{c.beginPath();for(let i=0;i<10;i++){const a=i*Math.PI/5-Math.PI/2,r=i%2?5:12;const x=20+Math.cos(a)*r,y=20+Math.sin(a)*r;i?c.lineTo(x,y):c.moveTo(x,y);}c.closePath();c.fill();}
 return c.getImageData(0,0,40,40);
}
