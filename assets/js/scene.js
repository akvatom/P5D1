import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function format(value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0$/, "");
}

function derive(profile) {
  const outer = profile.t + 50;
  const safeShare = (profile.c + 50) / 100;
  const inner = outer * safeShare;
  return { outer, inner, risk: outer - inner, safeShare };
}

export class ProfileScene {
  constructor(container, axisMetaResolver) {
    this.axisMetaResolver = axisMetaResolver;
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46,1,.1,1200);
    this.camera.position.set(170,135,180);
    this.renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.setClearColor(0x000000,0);
    container.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position="absolute";
    this.labelRenderer.domElement.style.inset="0";
    this.labelRenderer.domElement.style.pointerEvents="none";
    container.appendChild(this.labelRenderer.domElement);
    this.controls = new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=true;
    this.controls.dampingFactor=.07;
    this.controls.minDistance=35;
    this.controls.maxDistance=650;
    this.staticGroup = new THREE.Group();
    this.dynamic = new THREE.Group();
    this.scene.add(this.staticGroup, this.dynamic);
    this.lastProfiles = [];
    this.lastConnect = false;
    this.scene.add(new THREE.HemisphereLight(0xcfe8ff,0x10151d,1.75));
    const light = new THREE.DirectionalLight(0xffffff,1.5); light.position.set(90,130,110); this.scene.add(light);
    const fill = new THREE.PointLight(0x6ca8ff,35,450); fill.position.set(-110,40,-100); this.scene.add(fill);
    this.buildStatic();
    new ResizeObserver(()=>this.resize()).observe(container);
    this.resize();
    this.animate();
  }

  createLabel(html, className) { const el=document.createElement("div"); el.className=className; el.innerHTML=html; return new CSS2DObject(el); }
  axis(dir,color,pos,neg) {
    const p=new THREE.ArrowHelper(dir,new THREE.Vector3(),55,color,3.5,2.1);
    const n=new THREE.ArrowHelper(dir.clone().multiplyScalar(-1),new THREE.Vector3(),55,color,3.5,2.1);
    this.staticGroup.add(p,n);
    const lp=this.createLabel(pos,"axis-label-3d"); lp.position.copy(dir.clone().multiplyScalar(62)); this.staticGroup.add(lp);
    const ln=this.createLabel(neg,"axis-label-3d"); ln.position.copy(dir.clone().multiplyScalar(-62)); this.staticGroup.add(ln);
  }
  buildStatic() {
    const x=this.axisMetaResolver("x"), y=this.axisMetaResolver("y"), z=this.axisMetaResolver("z");
    this.axis(new THREE.Vector3(1,0,0),0xff7077,`+X · ${escapeHtml(x.right)}`,`−X · ${escapeHtml(x.left)}`);
    this.axis(new THREE.Vector3(0,1,0),0x6ce19b,`+Y · ${escapeHtml(y.right)}`,`−Y · ${escapeHtml(y.left)}`);
    this.axis(new THREE.Vector3(0,0,1),0x72aaff,`+Z · ${escapeHtml(z.right)}`,`−Z · ${escapeHtml(z.left)}`);
    const gridXZ=new THREE.GridHelper(100,10,0x6c7b91,0x273344); gridXZ.material.transparent=true; gridXZ.material.opacity=.24; this.staticGroup.add(gridXZ);
    const gridXY=new THREE.GridHelper(100,10,0x6c7b91,0x273344); gridXY.rotation.x=Math.PI/2; gridXY.material.transparent=true; gridXY.material.opacity=.10; this.staticGroup.add(gridXY);
    const cube=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(100,100,100)),new THREE.LineBasicMaterial({color:0x8493a8,transparent:true,opacity:.35})); this.staticGroup.add(cube);
    const origin=new THREE.Mesh(new THREE.SphereGeometry(1.1,18,14),new THREE.MeshBasicMaterial({color:0xffffff})); this.staticGroup.add(origin);
  }
  clearGroup(group) {
    [...group.children].forEach(child=>{ group.remove(child); child.traverse(node=>{ node.geometry?.dispose?.(); if(node.material){(Array.isArray(node.material)?node.material:[node.material]).forEach(m=>m.dispose?.());} if(node.element?.remove)node.element.remove();}); });
  }
  refreshLanguage() {
    this.clearGroup(this.staticGroup);
    this.buildStatic();
    if (this.lastProfiles.length) this.setProfiles(this.lastProfiles, this.lastConnect);
  }
  clearDynamic() {
    [...this.dynamic.children].forEach(child=>{ this.dynamic.remove(child); child.traverse(node=>{ node.geometry?.dispose?.(); if(node.material){(Array.isArray(node.material)?node.material:[node.material]).forEach(m=>m.dispose?.());} if(node.element?.remove)node.element.remove();}); });
  }
  line(a,b,color,opacity=.8,dashed=false) {
    const geo=new THREE.BufferGeometry().setFromPoints([a,b]);
    const mat=dashed?new THREE.LineDashedMaterial({color,dashSize:3,gapSize:2,transparent:true,opacity}):new THREE.LineBasicMaterial({color,transparent:true,opacity});
    const line=new THREE.Line(geo,mat); if(dashed)line.computeLineDistances(); return line;
  }
  addProfile(profile,index) {
    const d=derive(profile); const center=new THREE.Vector3(profile.x,profile.y,profile.z); const color=new THREE.Color(profile.color);
    const outer=new THREE.Mesh(new THREE.SphereGeometry(Math.max(.01,d.outer),44,30),new THREE.MeshPhongMaterial({color,transparent:true,opacity:index===0?.075:.06,side:THREE.DoubleSide,depthWrite:false,shininess:25})); outer.position.copy(center); this.dynamic.add(outer);
    const innerColor=color.clone().lerp(new THREE.Color(0xffffff),.22);
    const inner=new THREE.Mesh(new THREE.SphereGeometry(Math.max(.01,d.inner),44,30),new THREE.MeshPhongMaterial({color:innerColor,transparent:true,opacity:index===0?.19:.15,side:THREE.DoubleSide,depthWrite:false,shininess:35})); inner.position.copy(center); this.dynamic.add(inner);
    const marker=new THREE.Mesh(new THREE.SphereGeometry(2.5,26,20),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.45,roughness:.3})); marker.position.copy(center); this.dynamic.add(marker);
    const label=this.createLabel(`${escapeHtml(profile.name)}<br><span style="color:#9ba8ba">${profile.x}, ${profile.y}, ${profile.z} · R₄ ${format(d.outer)} · R₅ ${format(d.inner)}</span>`,"point-label-3d"); label.position.copy(center); this.dynamic.add(label);
    const ox=new THREE.Vector3(profile.x,0,0), oxy=new THREE.Vector3(profile.x,profile.y,0);
    this.dynamic.add(this.line(new THREE.Vector3(),ox,0xff7077,.8));
    this.dynamic.add(this.line(ox,oxy,0x6ce19b,.8));
    this.dynamic.add(this.line(oxy,center,0x72aaff,.8));
  }
  setProfiles(profiles,connect=false) {
    this.lastProfiles = profiles.map(profile => ({...profile}));
    this.lastConnect = connect;
    this.clearDynamic(); profiles.forEach((p,i)=>this.addProfile(p,i));
    if(connect&&profiles.length>1){const a=new THREE.Vector3(profiles[0].x,profiles[0].y,profiles[0].z),b=new THREE.Vector3(profiles[1].x,profiles[1].y,profiles[1].z);this.dynamic.add(this.line(a,b,0xffefad,.95,true));}
    this.fit(profiles);
  }
  fit(profiles) {
    if(!profiles.length)return;
    const box=new THREE.Box3(); profiles.forEach(p=>{const d=derive(p); const c=new THREE.Vector3(p.x,p.y,p.z); box.expandByPoint(c.clone().addScalar(d.outer)); box.expandByPoint(c.clone().addScalar(-d.outer));});
    const center=box.getCenter(new THREE.Vector3()); const size=box.getSize(new THREE.Vector3()); const max=Math.max(size.x,size.y,size.z,100); const dist=max/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)))*1.25;
    this.camera.position.copy(center).add(new THREE.Vector3(1,.78,1).normalize().multiplyScalar(dist)); this.controls.target.copy(center); this.controls.update();
  }
  setView(mode) {
    const target=this.controls.target.clone(); const distance=this.camera.position.distanceTo(target);
    if(mode==="iso")this.camera.position.copy(target).add(new THREE.Vector3(1,.78,1).normalize().multiplyScalar(distance));
    if(mode==="xy")this.camera.position.copy(target).add(new THREE.Vector3(0,0,distance));
    if(mode==="xz")this.camera.position.copy(target).add(new THREE.Vector3(0,distance,0));
    if(mode==="yz")this.camera.position.copy(target).add(new THREE.Vector3(distance,0,0));
    this.controls.update();
  }
  resize() { const w=this.container.clientWidth,h=Math.max(1,this.container.clientHeight); this.camera.aspect=w/h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w,h,false); this.labelRenderer.setSize(w,h); }
  animate() { requestAnimationFrame(()=>this.animate()); this.controls.update(); this.renderer.render(this.scene,this.camera); this.labelRenderer.render(this.scene,this.camera); }
}
