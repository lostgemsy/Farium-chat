(() => {
  const canvas = document.getElementById('shader-background');
  const gl = canvas?.getContext('webgl', {antialias:true, alpha:false, premultipliedAlpha:false});
  if (!gl) return;
  const vertex = `attribute vec2 position; void main(){ gl_Position=vec4(position,0.0,1.0); }`;
  const fragment = `precision highp float;
uniform vec2 resolution; uniform float time; uniform vec2 pointer; uniform float pulse;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);} 
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);} 
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=noise(p)*a;p=p*2.02+vec2(17.3,9.1);a*=.5;}return v;}
float lineGlow(vec2 p, vec2 a, vec2 b, float w){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);return smoothstep(w,0.,length(pa-ba*h));}
void main(){
 vec2 uv=gl_FragCoord.xy/resolution.xy, asp=vec2(resolution.x/resolution.y,1.); vec2 p=(uv-.5)*asp; float t=time*.18;
 vec2 mp=(pointer-.5)*asp; float md=length(p-mp); float glow=smoothstep(.78,0.,md);
 float f=fbm(p*2.4+vec2(t*.2,-t*.16));
 vec2 q=p; q+=.035*vec2(sin(f*8.+t*1.4),cos(f*7.-t));
 float waves=sin(q.x*5.0+q.y*3.3+f*5.0-t*2.2)+.35*sin(q.y*11.-t*1.7); float surface=smoothstep(-.25,.95,waves*.32+f*.95);
 float ca=pow(fbm(q*6.2+t*.3),2.2);
 vec3 black=vec3(.008,.010,.012), graphite=vec3(.045,.055,.062), steel=vec3(.16,.19,.21), silver=vec3(.62,.67,.70), hi=vec3(.92,.96,.98);
 vec3 color=mix(black,graphite,surface*.9); color=mix(color,steel,smoothstep(.35,.75,surface)*.55); color=mix(color,silver,smoothstep(.68,.96,surface)*.45); color+=hi*ca*.11; color+=hi*glow*.08;
 // molecular nodes and bonds
 for(int i=0;i<8;i++){
   float fi=float(i); vec2 c=vec2(sin(t*(.25+.03*fi)+fi*1.7)*.55,cos(t*(.21+.025*fi)+fi*1.3)*.42); c+=vec2(sin(fi*2.3+t*.08),cos(fi*1.7-t*.07))*.08;
   float d=length(p-c); color+=hi*smoothstep(.028,.0,d)*.32; color+=silver*smoothstep(.08,.015,d)*.05;
   vec2 c2=vec2(sin(t*(.22+.02*fi)+(fi+1.)*1.9)*.55,cos(t*(.18+.03*fi)+(fi+1.)*1.1)*.42); color+=hi*lineGlow(p,c,c2,.006)*.055;
 }
 float vig=smoothstep(1.4,.2,length(p)); color*=mix(.66,1.,vig); color+=hi*pulse*.035;
 gl_FragColor=vec4(color,1.0);
}`;
  function compile(type, src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))console.warn(gl.getShaderInfoLog(s));return s;}
  const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))return;gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const pos=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  const resolution=gl.getUniformLocation(program,'resolution'),time=gl.getUniformLocation(program,'time'),pointer=gl.getUniformLocation(program,'pointer'),pulse=gl.getUniformLocation(program,'pulse');let px=.5,py=.5,tx=.5,ty=.5,p=.0;
  const move=e=>{tx=e.clientX/innerWidth;ty=1-e.clientY/innerHeight;if(e.buttons)p=1};addEventListener('pointermove',move);addEventListener('pointerdown',e=>{move(e);p=1});
  function resize(){const r=Math.min(devicePixelRatio||1,2);canvas.width=Math.floor(innerWidth*r);canvas.height=Math.floor(innerHeight*r);gl.viewport(0,0,canvas.width,canvas.height)} addEventListener('resize',resize);resize();
  let start=performance.now(); function frame(now){px+=(tx-px)*.035;py+=(ty-py)*.035;p*=.94;gl.uniform2f(resolution,canvas.width,canvas.height);gl.uniform1f(time,(now-start)/1000);gl.uniform2f(pointer,px,py);gl.uniform1f(pulse,p);gl.drawArrays(gl.TRIANGLES,0,6);requestAnimationFrame(frame)} requestAnimationFrame(frame);
})();
