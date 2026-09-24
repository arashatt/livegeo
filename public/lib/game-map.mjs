import {Map as GLMap, ScaleControl, setWorkerCount, setRTLTextPlugin} from '/vendor/maplibre/maplibre-gl.mjs';
import {gameStyle, sunAt, windowsImage} from './game-style.mjs';
const BaseL=window.L, reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const NS='http://www.w3.org/2000/svg';
const svg=(tag)=>document.createElementNS(NS,tag);
const ll=(value)=>BaseL.latLng(value);
const coords=(value)=>{const p=ll(value);return [p.lng,p.lat];};
const esc=(value)=>String(value).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function remember(key,value){try{localStorage.setItem('livegeo.'+key,value);}catch{}}
function saved(key,fallback){try{return localStorage.getItem('livegeo.'+key)||fallback;}catch{return fallback;}}

// A small drawing adapter keeps the existing dashboard's permissions, cards,
// path-time maths and API flows shared by both renderers. Only drawing changes.
class Events {
  constructor(){this.events={};}
  on(names,fn){for(const n of names.split(' '))(this.events[n]??=[]).push(fn);return this;}
  fire(name,event={}){for(const fn of this.events[name]||[])fn({...event,target:this});return this;}
}
class Layer extends Events {
  constructor(options={}){super();this.options={...options};}
  addTo(map){map.addLayer(this);return this;}
  setStyle(style){Object.assign(this.options,style);this.render?.();return this;}
  setOpacity(value){return this.setStyle({opacity:value});}
  bringToFront(){if(this.el)this.el.parentNode?.appendChild(this.el);return this;}
  bringToBack(){if(this.el)this.el.parentNode?.prepend(this.el);return this;}
  getElement(){return this.el;}
  bindTooltip(content,options={}){
    this.tipContent=content;this.tipOptions=options;
    if(options.permanent){this.tip=new Tip(options).setContent(content).setLatLng(this.tipPosition());if(this.map)this.tip.addTo(this.map);}
    return this;
  }
  setTooltipContent(content){this.tipContent=content;if(this.tip)this.tip.setContent(content);return this;}
  tipPosition(){return this.point||this.getBounds().getNorthEast();}
  wire(el){
    if(this.options.interactive===false)return;
    el.style.pointerEvents='auto';
    const send=(name,e)=>{
      const box=this.map.gl.getContainer().getBoundingClientRect();
      const cp=BaseL.point(e.clientX-box.left,e.clientY-box.top);
      const at=this.map.gl.unproject([cp.x,cp.y]);
      const event={originalEvent:e,containerPoint:cp,latlng:ll([at.lat,at.lng])};
      this.fire(name,event);
      if(name==='click'&&!e.cancelBubble&&!e._stopped)this.map.fire('click',event);
      if(name==='click')e.stopPropagation();
    };
    el.addEventListener('click',(e)=>send('click',e));
    const enter=(e)=>{this.fire('mouseover',{originalEvent:e});if(this.tipContent&&!this.tipOptions?.permanent){this.tip=new Tip(this.tipOptions).setLatLng(this.tipPosition()).setContent(this.tipContent).addTo(this.map);}};
    const leave=(e)=>{this.fire('mouseout',{originalEvent:e});if(this.tip&&!this.tipOptions?.permanent){this.map.removeLayer(this.tip);this.tip=null;}};
    el.addEventListener('mouseenter',enter);el.addEventListener('mouseleave',leave);el.addEventListener('focus',enter);el.addEventListener('blur',leave);
  }
  detach(){if(this.tip)this.map.removeLayer(this.tip);this.el?.remove();this.map=null;}
}
class PointMark extends Layer {
  constructor(point,options={},blip=false){super(options);this.point=ll(point);this.blip=blip;}
  attach(map){
    this.map=map;
    this.el=document.createElement(this.options.interactive===false?'div':'button');
    if(this.el.tagName==='BUTTON'){this.el.type='button';this.el.setAttribute('aria-label',this.blip?'Person':'Private area');}
    this.el.className=this.blip?'game-blip arriving':'game-marker '+(this.options.icon?.className||'');
    if(this.blip)this.el.innerHTML='<span class="blip-core"></span><span class="blip-state"></span>';
    else this.el.innerHTML=this.options.icon?.html||''; // callers use esc() for every external string
    map.html.appendChild(this.el);this.wire(this.el);this.render();
  }
  setLatLng(point){this.point=ll(point);this.render();if(this.tip&&!this.tipOptions?.permanent)this.tip.setLatLng(this.point);return this;}
  getLatLng(){return this.point;}
  setRadius(radius){this.options.radius=radius;this.render();return this;}
  setIcon(icon){this.options.icon=icon;if(this.el){this.el.className='game-marker '+(icon.className||'');this.el.innerHTML=icon.html||'';}return this;}
  setPerson(p,mine,live,heading){
    this.person=p;this.heading=heading;this.self=mine;
    if(!this.el)return;
    this.el.classList.toggle('self',mine);this.el.classList.toggle('sos',!!p.sos);this.el.classList.toggle('stale',!live);
    this.el.classList.toggle('arrow',mine&&!p.sos&&heading!=null&&live);
    this.el.dataset.person=p.id;
    this.el.setAttribute('aria-label',`${p.name||p.id}${mine?' · you':''} · ${p.sos?'SOS, asked for help':live?'live':'not live'}`);
    this.el.querySelector('.blip-state').textContent=p.sos?'SOS':!live?'Ⅱ':'';
    this.render();
  }
  render(){
    if(!this.map||!this.el)return;
    const point=this.map.project(this.point);this.el.style.transform=`translate(${point.x}px,${point.y}px) translate(-50%,-50%)`;
    this.el.style.visibility=this.map.visible(this.point)?'':'hidden';
    this.el.style.opacity=this.options.opacity??1;
    if(this.blip){this.el.style.setProperty('--blip',this.options.fillColor||'#ffffff');this.el.style.setProperty('--size',`${(this.options.radius||7)*2}px`);this.el.style.setProperty('--heading',`${(this.heading||0)-this.map.gl.getBearing()}deg`);this.el.style.zIndex=this.person?.sos?50:this.self?40:30;}
  }
}
class Tip extends PointMark {
  constructor(options={}){super([0,0],{...options,interactive:false,icon:{className:'game-tip '+(options.className||'')}});}
  setContent(content){this.options.icon.html=content;if(this.el)this.el.innerHTML=content;return this;}
  render(){super.render();if(this.el)this.el.style.marginTop='-24px';}
}
function runsOf(points){if(!points.length)return [];return typeof points[0]?.[0]==='number'||points[0]?.lat!==undefined?[points.map(ll)]:points.map((r)=>r.map(ll));}
class Shape extends Layer {
  constructor(points,options={},polygon=false){super(options);this.runs=runsOf(points);this.polygon=polygon;}
  attach(map){this.map=map;this.el=svg('path');this.el.classList.add('game-shape');map.ground.appendChild(this.el);this.wire(this.el);this.render();if(this.tip)this.tip.addTo(map);}
  setLatLngs(points){this.runs=runsOf(points);this.render();return this;}
  getLatLngs(){return this.runs;}
  getBounds(){return BaseL.latLngBounds(this.runs.flat());}
  render(){
    if(!this.map||!this.el)return;
    const d=this.runs.map((run)=>run.map((p,i)=>{const q=this.map.project(p);return `${i?'L':'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;}).join(' ')+(this.polygon?'Z':'')).join(' ');
    this.el.setAttribute('d',d);const o=this.options;
    for(const [key,value] of Object.entries({'fill':this.polygon?(o.fillColor||o.color||'#ffffff'):'none','fill-opacity':o.fillOpacity??.1,'stroke':o.color||'#ffffff','stroke-opacity':o.opacity??1,'stroke-width':o.weight??2,'stroke-dasharray':o.dashArray||'none','stroke-linecap':'round','stroke-linejoin':'round'}))this.el.setAttribute(key,value);
    if(o.weight>=10)this.el.style.filter='blur(4px)';
  }
}
class Circle extends Shape {
  constructor(point,options={}){super([],options,true);this.point=ll(point);}
  setLatLng(point){this.point=ll(point);this.render();return this;}
  setRadius(radius){this.options.radius=radius;this.render();return this;}
  render(){const r=this.options.radius||1,lat=this.point.lat,lng=this.point.lng;
    this.runs=[Array.from({length:64},(_,i)=>{const a=i*Math.PI/32;return ll([lat+Math.cos(a)*r/111320,lng+Math.sin(a)*r/(111320*Math.cos(lat*Math.PI/180))]);})];super.render();}
}
class Heading extends Shape {
  constructor(point,heading,color){super([],{color,fillColor:color,fillOpacity:.2,opacity:0,interactive:false},true);this.point=ll(point);this.heading=heading;}
  setLatLng(point){this.point=ll(point);this.render();return this;}
  render(){
    if(!this.map)return;
    const p=this.point,r=156543.03*Math.cos(p.lat*Math.PI/180)/2**this.map.getZoom()*36;
    this.runs=[[p,...Array.from({length:15},(_,i)=>{const a=(this.heading-35+i*5)*Math.PI/180;return ll([p.lat+Math.cos(a)*r/111320,p.lng+Math.sin(a)*r/(111320*Math.cos(p.lat*Math.PI/180))]);}),p]];
    super.render();
  }
}
class Veil extends Shape {
  constructor(bounds,className){super([],{interactive:false,weight:0,fillOpacity:.22},true);this.bounds=bounds;this.className=className;}
  attach(map){super.attach(map);this.el.classList.add('veil-ground');for(const c of this.className.split(' '))if(c)this.el.classList.add(c);this.render();}
  setBounds(bounds){this.bounds=bounds;this.render();return this;}
  getBounds(){return this.bounds;}
  render(){
    if(!this.bounds)return;
    const b=this.bounds,c=b.getCenter(),dy=(b.getNorth()-b.getSouth())/2,dx=(b.getEast()-b.getWest())/2;
    this.runs=[Array.from({length:72},(_,i)=>ll([c.lat+Math.cos(i*Math.PI/36)*dy,c.lng+Math.sin(i*Math.PI/36)*dx]))];
    super.render();if(!this.el)return;
    this.el.style.filter='url(#veil-soft)';
    if(this.className.includes('mine')){this.el.setAttribute('stroke','#b2a1ff');this.el.setAttribute('stroke-width','2');this.el.setAttribute('stroke-dasharray','6 7');this.el.style.filter='none';}
  }
}
class Group extends Layer {
  constructor(){super();this.layers=new Set();}
  addLayer(layer){this.layers.add(layer);if(this.map)this.map.addLayer(layer);return this;}
  removeLayer(layer){this.layers.delete(layer);if(this.map)this.map.removeLayer(layer);return this;}
  attach(map){this.map=map;this.layers.forEach((l)=>map.addLayer(l));}
  detach(){this.layers.forEach((l)=>this.map.removeLayer(l));this.map=null;}
  clearLayers(){this.layers.forEach((l)=>this.map?.removeLayer(l));this.layers.clear();return this;}
  eachLayer(fn){this.layers.forEach(fn);return this;}
}
class Raster extends Layer {
  attach(map){this.map=map;if(!map.gl.getSource('raster'))map.gl.addSource('raster',{type:'raster',tiles:[location.origin+'/tiles/{z}/{x}/{y}.png'],tileSize:256,maxzoom:19});if(!map.gl.getLayer('raster'))map.gl.addLayer({id:'raster',type:'raster',source:'raster',paint:{'raster-opacity':.55}},'landuse');else map.gl.setLayoutProperty('raster','visibility','visible');}
  detach(){this.map.gl.setLayoutProperty('raster','visibility','none');this.map=null;}
}

class DashboardMap extends Events {
  constructor(gl){
    super();this.gl=gl;this.layers=new Set();this.camera='auto';this.data=[];this.spotlight=null;
    this.html=document.createElement('div');this.html.className='game-overlays';
    this.ground=svg('svg');this.ground.classList.add('game-ground');this.ground.innerHTML='<defs><filter id="veil-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter></defs>';
    gl.getContainer().append(this.ground,this.html);
    for(const name of ['click','mousemove','mouseout','zoomend','moveend','resize'])gl.on(name,(event)=>{const p=event.point;this.fire(name,{originalEvent:event.originalEvent,containerPoint:p?BaseL.point(p.x,p.y):undefined,latlng:event.lngLat?ll([event.lngLat.lat,event.lngLat.lng]):undefined});});
    gl.on('move',()=>{this.redraw();this.updateHud();});gl.on('resize',()=>this.redraw());
    gl.on('zoomend',()=>this.autoCamera());gl.on('idle',()=>{this.report();this.radar();});
    this.bindControls();this.redraw();this.updateHud();
  }
  project(point){const q=this.gl.project(coords(point));return BaseL.point(q.x,q.y);}
  visible(point){
    if(this.gl.getZoom()>5)return true;
    const c=this.gl.getCenter(),r=Math.PI/180,p=ll(point);
    return Math.sin(c.lat*r)*Math.sin(p.lat*r)+Math.cos(c.lat*r)*Math.cos(p.lat*r)*Math.cos((p.lng-c.lng)*r)>-.05;
  }
  latLngToContainerPoint(point){return this.project(point);}
  getZoom(){return this.gl.getZoom();}
  getCenter(){const c=this.gl.getCenter();return ll([c.lat,c.lng]);}
  getSize(){const c=this.gl.getContainer();return BaseL.point(c.clientWidth,c.clientHeight);}
  getContainer(){return this.gl.getContainer();}
  invalidateSize(){this.gl.resize();return this;}
  setView(point,zoom){this.gl.jumpTo({center:coords(point),zoom});this.autoCamera();return this;}
  fitBounds(bounds){this.gl.fitBounds([[bounds.getWest(),bounds.getSouth()],[bounds.getEast(),bounds.getNorth()]],{padding:{top:100,bottom:120,left:50,right:50},maxZoom:16,duration:reduced?0:650});return this;}
  addLayer(layer){if(!this.layers.has(layer)){this.layers.add(layer);layer.attach(this);}return this;}
  removeLayer(layer){if(this.layers.delete(layer))layer.detach();return this;}
  hasLayer(layer){return this.layers.has(layer);}
  eachLayer(fn){this.layers.forEach(fn);}
  redraw(){if(document.hidden)return;this.ground.setAttribute('viewBox',`0 0 ${this.getSize().x} ${this.getSize().y}`);this.layers.forEach((l)=>l.render?.());}
  autoCamera(){
    if(this.camera!=='auto'||document.hidden)return;
    const z=this.gl.getZoom(),pitch=this.lite?0:z<10?0:z<14?(z-10)*10:Math.min(74,48+(z-14)*12);
    if(Math.abs(this.gl.getPitch()-pitch)>.5)this.gl.easeTo({pitch,duration:reduced?0:450});
  }
  setCamera(mode){
    const mine=this.data.find((p)=>p.mine&&p.live&&!p.hidden);
    if(mode==='chase'&&!mine)return;
    this.camera=mode;this.gl.setProjection({type:mode==='map'?'mercator':'globe'});this.features?.sync();document.getElementById('cameraMode').value=mode;
    if(mode==='map')this.gl.easeTo({pitch:0,bearing:0,duration:reduced?0:500});
    else if(mode==='chase')this.follow(mine);else this.autoCamera();
    this.updateHud();
  }
  follow(p){if(!p||document.hidden)return;this.gl.easeTo({center:[p.longitude,p.latitude],bearing:p.heading??0,pitch:this.lite?0:74,zoom:Math.max(16,this.gl.getZoom()),padding:{top:100,bottom:0,left:0,right:0},duration:reduced?0:650});}
  syncPeople(data,spotlight){
    this.data=data;this.spotlight=spotlight;
    const mine=data.find((p)=>p.mine&&p.live&&!p.hidden);
    document.querySelector('#cameraMode option[value="chase"]').disabled=!mine;
    document.querySelector('#cameraMode option[value="chase"]').hidden=!mine;
    if(this.camera==='chase'){
      if(!mine)this.setCamera('auto');else {
        const fix=`${mine.latitude},${mine.longitude},${mine.heading}`;
        if(fix!==this.lastChase){this.lastChase=fix;this.follow(mine);}
      }
    }
    this.radar();
  }
  radar(){
    const box=document.getElementById('radar'),canvas=document.getElementById('radarCanvas');
    const center=this.data.find((p)=>p.id===this.spotlight&&!p.hidden)||this.data.find((p)=>p.mine&&!p.hidden);
    box.hidden=!this.radarOn||!center;if(box.hidden||document.hidden)return;
    const ctx=canvas.getContext('2d'),size=216,mid=size/2,heading=(center.heading||0)*Math.PI/180,cos=Math.cos(heading),sin=Math.sin(heading),range=800;
    const project=(lon,lat)=>{const x=(lon-center.longitude)*111320*Math.cos(center.latitude*Math.PI/180)/range*mid,y=-(lat-center.latitude)*111320/range*mid;return [mid+x*cos+y*sin,mid-x*sin+y*cos];};
    ctx.clearRect(0,0,size,size);ctx.fillStyle='#0b222c';ctx.fillRect(0,0,size,size);
    ctx.strokeStyle='#334c56';ctx.lineWidth=1;
    for(let r=36;r<=108;r+=36){ctx.beginPath();ctx.arc(mid,mid,r,0,Math.PI*2);ctx.stroke();}
    // Reuse loaded geometry; no second WebGL context, tile stream or idle loop.
    for(const f of this.gl.querySourceFeatures('city',{sourceLayer:'roads'}).slice(0,2400)){
      const lines=f.geometry.type==='LineString'?[f.geometry.coordinates]:f.geometry.type==='MultiLineString'?f.geometry.coordinates:[];
      ctx.strokeStyle=/motorway|trunk|primary/.test(f.properties.class)?'#d683b2':'#728e99';ctx.lineWidth=1;
      for(const line of lines){ctx.beginPath();line.forEach(([lon,lat],i)=>{const [x,y]=project(lon,lat);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
    }
    for(const p of this.data){
      // Private people never become radar points or edge blips. Their ground veil remains on the main view.
      if(p.hidden)continue;
      let [x,y]=project(p.longitude,p.latitude),dx=x-mid,dy=y-mid;const d=Math.hypot(dx,dy),edge=d>94;
      if(edge){x=mid+dx/d*94;y=mid+dy/d*94;}
      ctx.fillStyle=p.colour;ctx.strokeStyle='#f1f9f5';ctx.lineWidth=2;ctx.beginPath();
      if(p.sos){ctx.rect(x-5,y-5,10,10);}else if(p.mine&&p.heading!=null){ctx.moveTo(x,y-7);ctx.lineTo(x+5,y+5);ctx.lineTo(x,y+2);ctx.lineTo(x-5,y+5);ctx.closePath();}else ctx.arc(x,y,edge?3:4,0,Math.PI*2);
      ctx.fill();ctx.stroke();if(p.sos){ctx.font='bold 10px sans-serif';ctx.fillStyle='#ffffff';ctx.fillText('SOS',x+8,y+3);}
    }
    const n=project(center.longitude,center.latitude+.006);const a=Math.atan2(n[1]-mid,n[0]-mid);ctx.fillStyle='#f4e8c8';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.fillText('N',mid+Math.cos(a)*97,mid+Math.sin(a)*97+4);
    document.getElementById('radarCaption').textContent=(center.mine?'You':center.name||'Spotlight')+' · 800 m';
  }
  bindControls(){
    this.lite=saved('lite','false')==='true';this.light=saved('light','auto');if(!['auto','day','golden','night'].includes(this.light))this.light='auto';
    this.radarOn=saved('radar',innerWidth<761?'false':'true')==='true';
    document.getElementById('cameraMode').onchange=(e)=>this.setCamera(e.target.value);
    document.getElementById('lightMode').value=this.light;
    document.getElementById('lightMode').onchange=(e)=>{this.light=e.target.value;remember('light',this.light);this.lighting(true);};
    document.getElementById('liteMode').checked=this.lite;
    document.getElementById('liteMode').onchange=(e)=>{this.lite=e.target.checked;remember('lite',String(this.lite));this.lighting(true);this.autoCamera();};
    document.getElementById('radarToggle').checked=this.radarOn;
    document.getElementById('radarToggle').onchange=(e)=>{this.radarOn=e.target.checked;remember('radar',String(this.radarOn));this.radar();};
    document.getElementById('compass').onclick=()=>this.gl.easeTo({bearing:0,duration:reduced?0:400});
    document.getElementById('tilt').onclick=()=>{this.setCamera('auto');this.gl.easeTo({pitch:this.gl.getPitch()>20?0:74,duration:reduced?0:400});};
    document.getElementById('zoomIn').onclick=()=>this.gl.zoomIn({duration:reduced?0:250});
    document.getElementById('zoomOut').onclick=()=>this.gl.zoomOut({duration:reduced?0:250});
    this.gl.on('moveend',()=>{if(Date.now()-(this.litAt||0)>180000)this.lighting();});
    this.lighting(true);this.lightTimer=setInterval(()=>this.lighting(),180000);
    document.addEventListener('visibilitychange',()=>{clearInterval(this.lightTimer);if(document.hidden){this.gl.stop();this.layers.forEach((l)=>{if(l.gliding)cancelAnimationFrame(l.gliding);});}else{this.redraw();this.lighting();this.lightTimer=setInterval(()=>this.lighting(),180000);}});
  }
  lighting(force=false){
    if(document.hidden)return;const c=this.gl.getCenter(),sun=sunAt(c.lat,c.lng);this.litAt=Date.now();
    const phase=this.light==='auto'?sun.phase:this.light;
    if(force||phase!==this.phase){
      this.phase=phase;const style=gameStyle(phase,this.lite);this.gl.setSky(style.sky);
      for(const layer of style.layers)if(this.gl.getLayer(layer.id)){
        for(const [k,v] of Object.entries(layer.paint||{}))this.gl.setPaintProperty(layer.id,k,v);
      }
      this.gl.setPaintProperty('buildings','fill-extrusion-pattern',phase==='night'?'windows':undefined);
      this.features?.sync();
    }
    const light=gameStyle(phase,this.lite).light;
    const elevation=this.light==='auto'?sun.elevation:phase==='day'?55:phase==='golden'?8:25;
    this.gl.setLight({...light,position:[1.5,sun.azimuth,Math.max(10,Math.min(100,90-elevation))]});
    document.getElementById('lightReadout').textContent=this.light==='auto'?'Sun · '+sun.label:this.light==='golden'?'Golden hour':phase;
    document.body.dataset.light=phase;this.updateHud();
  }
  updateHud(){
    document.getElementById('compassValue').textContent=String(Math.round((this.gl.getBearing()+360)%360)).padStart(3,'0')+'°';
    document.getElementById('tiltValue').textContent=Math.round(this.gl.getPitch())+'°';
    document.getElementById('zoomValue').textContent='Z'+this.gl.getZoom().toFixed(1);
  }
  report(){if(!this.status)return;const any=this.gl.querySourceFeatures('city',{sourceLayer:'roads'}).length||this.gl.querySourceFeatures('city',{sourceLayer:'water'}).length;
    this.status(!this.features.visible?'Local details are off.':this.gl.getZoom()<8?'World coastline · zoom in to explore':any?'Local OSM detail · heights are illustrative':'No local detail here · world coastline remains available');}
}
function featureSwitches(map,status){
  const state={visible:true,selected:new Set(['water','landuse','parks','buildings','roads','rail','places']),
    sync(){for(const l of map.gl.getStyle().layers){if(!l['source-layer'])continue;const feature=l['source-layer'];const effects=['buildings','roof-light','roads-glow'].includes(l.id);const show=this.visible&&this.selected.has(feature)&&!(map.lite&&effects)&&!(map.camera==='map'&&['buildings','roof-light'].includes(l.id));map.gl.setLayoutProperty(l.id,'visibility',show?'visible':'none');}map.report();},
    setVisible(on){this.visible=on;this.sync();},setFeature(name,on){if(!['water','landuse','parks','buildings','roads','rail','places'].includes(name))return;on?this.selected.add(name):this.selected.delete(name);this.sync();}};
  map.status=status;map.features=state;state.sync();return state;
}
function peopleDrawing(map){
  const halt=(entry)=>{if(entry.gliding)cancelAnimationFrame(entry.gliding);entry.gliding=0;};
  return {veil:(b,c='')=>new Veil(b,c),tint:(v,c)=>v.setStyle({fillColor:c,color:c}),size(){},halt,
    glide(entry,to,ms){halt(entry);const from=entry.marker.getLatLng();const put=(p)=>{entry.marker?.setLatLng(p);entry.halo?.setLatLng(p);entry.beam?.setLatLng(p);};
      if(!ms||reduced||document.hidden){put(to);return;}const start=performance.now();
      const step=(now)=>{if(document.hidden){halt(entry);put(to);return;}const k=Math.min(1,(now-start)/Math.min(1200,ms)),e=k<.5?2*k*k:1-(-2*k+2)**2/2;put(ll([from.lat+(to.lat-from.lat)*e,from.lng+(to.lng-from.lng)*e]));entry.gliding=k<1?requestAnimationFrame(step):0;};entry.gliding=requestAnimationFrame(step);
    },
    aim(entry,heading,color){
      if(heading==null||!entry.marker){if(entry.beam){map.removeLayer(entry.beam);entry.beam=null;}return;}
      if(!entry.beam)entry.beam=new Heading(entry.marker.getLatLng(),heading,color).addTo(map).bringToBack();
      entry.beam.heading=heading;entry.beam.setStyle({color,fillColor:color});
      entry.marker.heading=heading;entry.marker.render();
    },
    puff(){/* Still dissolve/condense avoids suggesting a point inside a newly private area. */},
    fadeOut(veil){if(reduced||document.hidden){map.removeLayer(veil);return;}veil.el?.classList.add('leaving');setTimeout(()=>map.removeLayer(veil),300);},
  };
}
export async function createGameMap(){
  setWorkerCount(2);
  await setRTLTextPlugin('/vendor/rtl/mapbox-gl-rtl-text.js',false);
  const gl=new GLMap({container:'map',style:gameStyle(),center:[0,20],zoom:2.2,minZoom:1.2,maxZoom:19,maxPitch:75,attributionControl:{compact:true},canvasContextAttributes:{antialias:true},fadeDuration:0,renderWorldCopies:false});
  try{await Promise.race([gl.once('load'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Map startup timed out')),20000))]);}catch(error){gl.remove();throw error;}
  gl.addImage('windows',windowsImage(),{pixelRatio:1});
  const map=new DashboardMap(gl);window.livegeoMap=map;
  const facade={...BaseL,map:()=>map,tileLayer:()=>new Raster(),circleMarker:(p,o)=>new PointMark(p,o,true),marker:(p,o)=>new PointMark(p,o),divIcon:(o)=>o,
    polyline:(p,o)=>new Shape(p,o),polygon:(p,o)=>new Shape(p,o,true),circle:(p,o)=>new Circle(p,o),tooltip:(o)=>new Tip(o),layerGroup:()=>new Group(),
    control:{scale:()=>({addTo(){gl.addControl(new ScaleControl({maxWidth:140,unit:'metric'}),'bottom-left');return this;}})}};
  return {L:facade,PeopleMap:{on:()=>peopleDrawing(map)},Cartography:{on:()=>featureSwitches(map,(s)=>document.getElementById('cartographyStatus').textContent=s)},map};
}
