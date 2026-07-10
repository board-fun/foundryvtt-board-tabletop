var S=Object.defineProperty;var x=(i,t,e)=>t in i?S(i,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):i[t]=e;var s=(i,t,e)=>x(i,typeof t!="symbol"?t+"":t,e);import{Scene as $}from"./phaser-DMjGVukU.js";import{a as y}from"./types-Zv2_VPAv.js";import{as as m}from"./index-DfNmV7BL.js";import"./react-vendor-_foh5iaC.js";const v=["None","Began","Moved","Ended","Canceled","Stationary"];class M extends ${constructor(){super({key:"DebugOverlay"});s(this,"debugText");s(this,"visible",!0);s(this,"lastFrame",[]);s(this,"isOnDevice",!1);s(this,"gameSceneRef",null);s(this,"lastDebugUpdate",0)}init(e){this.isOnDevice=e.isOnDevice}create(){const e=this.add.rectangle(10,10,420,300,0,.7);e.setOrigin(0,0),e.setScrollFactor(0),this.debugText=this.add.text(20,20,"",{fontSize:"14px",fontFamily:"monospace",color:"#00ff88",lineSpacing:4}),this.debugText.setScrollFactor(0),this.input.keyboard.on("keydown-ESC",()=>{this.visible=!this.visible,e.setVisible(this.visible),this.debugText.setVisible(this.visible)});const a=this.scene.get("Game");this.gameSceneRef=a,a.events.on("contact:frame",c=>{this.lastFrame=c})}update(){var r,g,l,u;if(!this.visible)return;const e=Date.now();if(e-this.lastDebugUpdate<250)return;this.lastDebugUpdate=e;const a=Math.round(this.game.loop.actualFps),c=this.isOnDevice?"BOARD DEVICE":"DESKTOP MOCK",d=((g=(r=this.gameSceneRef)==null?void 0:r.getFoundryLoadTierText)==null?void 0:g.call(r))??"n/a",b=this.lastFrame;let p=0,h=0,n=`Mode: ${c} | FPS: ${a} |

 Build: ${m} | FMap:${d}
`;for(const o of b)o.type===y.Glyph?(p++,n+=`G${o.glyphId} (${o.x|0},${o.y|0}) ${v[o.phase]} ${o.orientation|0}°
`):h++;n=`Mode: ${c} | FPS: ${a} | ${p}G ${h}F |

 Build: ${m} | FMap:${d}
`+n.slice(n.indexOf(`
`)+1);const f=(u=(l=this.gameSceneRef)==null?void 0:l.getProfileText)==null?void 0:u.call(l);f&&(n+=`
prof ms/f: ${f}
`),this.debugText.setText(n)}}export{M as DebugOverlayScene};
