/* Art Arena: existing ThemeScene lifecycle adapters. Liquid shader adapted from
   the user-supplied Originkit Liquid Chrome reference; no React dependency. */
(function () {
  'use strict';
  const VERT = 'attribute vec2 a_pos; void main(){gl_Position=vec4(a_pos,0.,1.);}';
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg,uBase,uAccent,uHigh;
float sat(float x){return clamp(x,0.,1.);}
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+34.56);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
float fbm5(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
float fbm3(vec2 p){float s=0.,a=.5;for(int i=0;i<3;i++){s+=a*vnoise(p);p=p*2.07+vec2(4.1,2.3);a*=.5;}return s;}
float body(vec2 p,float t){vec2 q=p;for(int i=0;i<3;i++){q+=2.44*.42*vec2(fbm3(q*1.3+vec2(t*.05,1.7)),fbm3(q*1.3+vec2(4.1,-t*.04)));}return fbm5(q*1.1)+.35*sin(q.x*2.2+q.y*1.6);}
vec3 env(vec3 r){float y=r.y*.5+.5;float band=.5+.5*sin(y*52.);vec3 c=mix(uBase,uAccent,sat(y*1.4-.15));c=mix(c*.35,c,pow(band,.8));c=mix(c,uHigh,pow(sat(1.-abs(r.y-.30)*3.),4.));return mix(c,uBg,pow(sat(.25-r.y),1.4));}
void main(){float ar=uRes.x/max(uRes.y,1.);vec2 uv=gl_FragCoord.xy/uRes;vec2 p=(uv-.5)*vec2(ar,1.)*1.42;float e=2./uRes.y*1.42;float h=body(p,uTime);float hx=body(p+vec2(e,0),uTime),hy=body(p+vec2(0,e),uTime);vec3 N=normalize(vec3(-(hx-h)/e*1.2,-(hy-h)/e*1.2,1.));vec3 V=vec3(0,0,1);vec3 col=env(reflect(-V,N));vec3 L=normalize(vec3(cos(5.044)*.8,sin(5.044)*.6+.3,.7));col+=vec3(1)*pow(sat(dot(reflect(-L,N),V)),90.)*.8;col+=uHigh*pow(sat(1.-dot(N,V)),3.)*.22;gl_FragColor=vec4(clamp(col,0.,1.),1.);}
`;
  function motionAllowed() { return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.anim !== 'off'; }
  class ChromeScene {
    constructor(host, opts) {
      this.host=host;this.theme='chrome';this.custom=opts.custom||null;this.dead=false;this.motion=motionAllowed();this.time=0;this.raf=0;this.last=0;
      this.canvas=document.createElement('canvas');this.canvas.className='aa-chrome-canvas';this.canvas.setAttribute('aria-hidden','true');host.append(this.canvas);
      this.gl=this.canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,powerPreference:'low-power'});
      this._resize=()=>{this.resize();this.draw();};
      this._vis=()=>this.schedule();
      this._lost=e=>{e.preventDefault();this.lost=true;cancelAnimationFrame(this.raf);this.raf=0;};
      this._restored=()=>{this.lost=false;this.init();this.resize();this.draw();this.schedule();};
      this.canvas.addEventListener('webglcontextlost',this._lost);this.canvas.addEventListener('webglcontextrestored',this._restored);
      window.addEventListener('resize',this._resize);document.addEventListener('visibilitychange',this._vis);
      this.reduced=matchMedia('(prefers-reduced-motion: reduce)');this._reduce=()=>this.schedule();this.reduced.addEventListener('change',this._reduce);
      if(this.gl) this.init();
      this.resize();this.draw();this.schedule();
    }
    init() {
      const gl=this.gl;
      const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){gl.deleteShader(s);return null;}return s;};
      const vs=compile(gl.VERTEX_SHADER,VERT),fs=compile(gl.FRAGMENT_SHADER,FRAG);
      if(!vs||!fs){if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);return;}
      const p=gl.createProgram();gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)){gl.deleteProgram(p);return;}
      this.program=p;gl.useProgram(p);this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
      const loc=gl.getAttribLocation(p,'a_pos');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      this.uniforms={};for(const k of ['uRes','uTime','uBg','uBase','uAccent','uHigh'])this.uniforms[k]=gl.getUniformLocation(p,k);
    }
    resize(){const w=this.host.clientWidth||innerWidth,h=this.host.clientHeight||innerHeight;const scale=Math.min(devicePixelRatio||1,1.5,Math.sqrt(480000/(w*h)));this.canvas.width=Math.max(1,Math.round(w*scale));this.canvas.height=Math.max(1,Math.round(h*scale));}
    setPalette(theme,custom){this.custom=custom||null;this.draw();}
    setMotion(on){this.motion=!!on;this.schedule();}
    schedule(){cancelAnimationFrame(this.raf);this.raf=0;this.last=0;if(!this.dead&&!this.lost&&this.program&&this.motion&&!this.reduced.matches&&!document.hidden)this.raf=requestAnimationFrame(t=>this.tick(t));}
    tick(now){if(this.dead)return;if(!this.last)this.last=now;const dt=now-this.last;if(dt>=1000/30){this.time+=Math.min(dt/1000,.1)*.55;this.last=now;this.draw();}this.raf=requestAnimationFrame(t=>this.tick(t));}
    draw(){
      const gold=this.custom&&this.custom.finish==='gold';this.canvas.style.background=gold?'linear-gradient(130deg,#281a06,#e8c45b,#624716)':'linear-gradient(130deg,#121820,#dbe5ef,#45505d)';
      const gl=this.gl;if(!gl||!this.program||this.lost)return;gl.useProgram(this.program);gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.uniform2f(this.uniforms.uRes,this.canvas.width,this.canvas.height);gl.uniform1f(this.uniforms.uTime,this.time);
      const palette=gold?[[.045,.026,.008],[.38,.20,.04],[.90,.64,.22],[1,.96,.79]]:[[.018,.025,.04],[.24,.29,.36],[.69,.78,.88],[.98,.99,1]];
      ['uBg','uBase','uAccent','uHigh'].forEach((k,i)=>gl.uniform3fv(this.uniforms[k],palette[i]));gl.drawArrays(gl.TRIANGLES,0,3);
    }
    dispose(){this.dead=true;cancelAnimationFrame(this.raf);window.removeEventListener('resize',this._resize);document.removeEventListener('visibilitychange',this._vis);this.reduced.removeEventListener('change',this._reduce);this.canvas.removeEventListener('webglcontextlost',this._lost);this.canvas.removeEventListener('webglcontextrestored',this._restored);if(this.gl){if(this.buffer)this.gl.deleteBuffer(this.buffer);if(this.program)this.gl.deleteProgram(this.program);const ext=this.gl.getExtension('WEBGL_lose_context');if(ext)ext.loseContext();}this.canvas.remove();}
  }
  class ComicScene {
    constructor(host,opts){this.host=host;this.theme='comic';this.custom=opts.custom||null;this.motion=motionAllowed();this.dead=false;this.root=document.createElement('div');this.root.className='aa-comic-scene';this.root.setAttribute('aria-hidden','true');
      this.renderStickers();host.append(this.root);
      this._vis=()=>this.updateMotion();this.reduced=matchMedia('(prefers-reduced-motion: reduce)');document.addEventListener('visibilitychange',this._vis);this.reduced.addEventListener('change',this._vis);this.updateMotion();}
    renderStickers(){
      const manga=this.custom&&this.custom.finish==='manga';this.root.classList.toggle('manga',!!manga);this.root.replaceChildren();
      // v72: the manga finish adds the supplied Japanese SFX (ドドン… impact,
      // ポカーン stagger) to the onomatopoeia set, each with its own timing.
      const names=manga?['dodon','nnnn','pokan','nnnnn','nn','nnnnnn','nnn']:['kapow','no','crack','pop','boom','zap','pow'];
      names.forEach((name,index)=>{const i=!manga&&name==='pow'?7:index;const im=document.createElement('img');im.src='/themes/comic/'+(manga?'manga/':'')+name+'.png';im.alt='';
        if(manga){
          im.style.setProperty('--pop-delay',(-index*1.9)+'s');
          im.style.setProperty('--pop-x',([6,58,66,14,78,40,8][index])+'%');
          im.style.setProperty('--pop-y',([26,14,64,58,80,40,78][index])+'%');
          im.style.setProperty('--pop-angle',([-8,10,-6,9,-10,7,-5][index])+'deg');
          im.style.setProperty('--pop-dur',([9.5,7.2,8.6,7.8,6.9,7.4,6.5][index])+'s');
          im.style.setProperty('--impact-x',(index%2?-70:70)+'px');
          if(name==='dodon'||name==='pokan')im.classList.add('sfx');
        }else{
          im.style.setProperty('--pop-delay',(-i*2.8)+'s');im.style.setProperty('--pop-x',([5,78,12,80,4,76,45,57][i])+'%');im.style.setProperty('--pop-y',([12,19,56,68,83,42,6,79][i])+'%');im.style.setProperty('--pop-angle',([-12,10,7,-9,12,-8,5,-6][i])+'deg');
        }
        this.root.append(im);});
    }
    setPalette(theme,custom){const old=this.custom&&this.custom.finish;this.custom=custom||null;if(old!==(this.custom&&this.custom.finish))this.renderStickers();}
    setMotion(on){this.motion=!!on;this.updateMotion();}
    updateMotion(){this.root.classList.toggle('still',!this.motion||this.reduced.matches);this.root.classList.toggle('paused',document.hidden);}
    dispose(){this.dead=true;document.removeEventListener('visibilitychange',this._vis);this.reduced.removeEventListener('change',this._vis);this.root.remove();}
  }
  window.ChromeThemeScene=ChromeScene;window.ComicThemeScene=ComicScene;
})();
