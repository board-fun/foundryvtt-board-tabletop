var v=Object.defineProperty;var y=(i,t,e)=>t in i?v(i,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):i[t]=e;var s=(i,t,e)=>y(i,typeof t!="symbol"?t+"":t,e);import{Scene as D}from"./phaser-DMjGVukU.js";import{a as F}from"./types-Zv2_VPAv.js";import{av as $}from"./index-BKkDyjfC.js";import"./react-vendor-_foh5iaC.js";const T=["None","Began","Moved","Ended","Canceled","Stationary"];class _ extends D{constructor(){super({key:"DebugOverlay"});s(this,"debugText");s(this,"visible",!0);s(this,"lastFrame",[]);s(this,"isOnDevice",!1);s(this,"gameSceneRef",null);s(this,"lastDebugUpdate",0)}init(e){this.isOnDevice=e.isOnDevice}create(){const e=this.add.rectangle(10,10,420,300,0,.7);e.setOrigin(0,0),e.setScrollFactor(0),this.debugText=this.add.text(20,20,"",{fontSize:"14px",fontFamily:"monospace",color:"#00ff88",lineSpacing:4}),this.debugText.setScrollFactor(0),this.input.keyboard.on("keydown-ESC",()=>{this.visible=!this.visible,e.setVisible(this.visible),this.debugText.setVisible(this.visible)});const a=this.scene.get("Game");this.gameSceneRef=a,a.events.on("contact:frame",c=>{this.lastFrame=c})}update(){var r,u,l,S,d,b;if(!this.visible)return;const e=Date.now();if(e-this.lastDebugUpdate<250)return;this.lastDebugUpdate=e;const a=Math.round(this.game.loop.actualFps),c=this.isOnDevice?"BOARD DEVICE":"DESKTOP MOCK",p=((u=(r=this.gameSceneRef)==null?void 0:r.getFoundryLoadTierText)==null?void 0:u.call(r))??"n/a",h=((S=(l=this.gameSceneRef)==null?void 0:l.getZoomText)==null?void 0:S.call(l))??"n/a",x=this.lastFrame;let f=0,g=0,o=`Mode: ${c} | FPS: ${a} |

 Build: ${$} | FMap:${p} | Zoom:${h}
`;for(const n of x)n.type===F.Glyph?(f++,o+=`G${n.glyphId} (${n.x|0},${n.y|0}) ${T[n.phase]} ${n.orientation|0}°
`):g++;o=`Mode: ${c} | FPS: ${a} | ${f}G ${g}F |

 Build: ${$} | FMap:${p} | Zoom:${h}
`+o.slice(o.indexOf(`
`)+1);const m=(b=(d=this.gameSceneRef)==null?void 0:d.getProfileText)==null?void 0:b.call(d);m&&(o+=`
prof ms/f: ${m}
`),this.debugText.setText(o)}}export{_ as DebugOverlayScene};
