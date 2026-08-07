const NOTE_RE=/^[a-zA-Z0-9_-]{1,64}$/;
const RANDOM_ALPHABET="234579abcdefghjkmnpqrstwxyz";
const DEFAULT_MAX_BYTES=256*1024;

export default{async fetch(request,env){return handleRequest(request,env)}};

export async function handleRequest(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path==="/robots.txt")return textResponse("User-agent: *\nDisallow: /\n",200,"text/plain");
  if(path==="/favicon.svg")return textResponse(faviconSvg(),200,"image/svg+xml");
  const note=parseNoteName(path);
  if(!note)return redirectToRandomNote(url);
  if(!env?.NOTES)return textResponse("Missing NOTES KV binding.\n",500,"text/plain");
  if(request.method==="POST")return saveNote(request,env,note);
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:commonHeaders({Allow:"GET, HEAD, POST"})});
  const raw=url.searchParams.has("raw")||isCliClient(request),text=await env.NOTES.get(note);
  if(raw)return text===null?textResponse("Not found.\n",404,"text/plain"):textResponse(text,200,"text/plain");
  return htmlResponse(renderPage(note,text??""));
}

function parseNoteName(path){const note=path.replace(/^\/+|\/+$/g,"");return NOTE_RE.test(note)?note:""}
function redirectToRandomNote(url){const target=new URL(`/${randomNoteName()}`,url);return new Response(null,{status:302,headers:commonHeaders({Location:target.pathname})})}
function randomNoteName(){const bytes=new Uint8Array(5);crypto.getRandomValues(bytes);return Array.from(bytes,b=>RANDOM_ALPHABET[b%RANDOM_ALPHABET.length]).join("")}

async function saveNote(request,env,note){
  const text=await readTextFromRequest(request),max=parsePositiveInt(env.NOTE_MAX_BYTES,DEFAULT_MAX_BYTES);
  if(new TextEncoder().encode(text).length>max)return textResponse(`Note is too large. Limit is ${max} bytes.\n`,413,"text/plain");
  if(text.length===0)await env.NOTES.delete(note);else{const ttl=parsePositiveInt(env.NOTE_TTL_SECONDS,0);await env.NOTES.put(note,text,ttl>0?{expirationTtl:ttl}:undefined)}
  return new Response(null,{status:204,headers:commonHeaders()});
}
async function readTextFromRequest(request){
  const type=request.headers.get("content-type")||"";
  if(type.includes("application/x-www-form-urlencoded")){const form=await request.formData(),v=form.get("text");return typeof v==="string"?v:""}
  return request.text();
}
function isCliClient(request){const ua=request.headers.get("user-agent")||"";return /^curl\//i.test(ua)||/^Wget\//.test(ua)}
function htmlResponse(html){return textResponse(html,200,"text/html")}
function textResponse(body,status,type){return new Response(body,{status,headers:commonHeaders({"Content-Type":`${type}; charset=utf-8`})})}
function commonHeaders(extra={}){return{"Cache-Control":"no-store","X-Robots-Tag":"noindex, nofollow",...extra}}

function renderPage(note,text){
  const safeNote=escapeHtml(note),safeText=escapeHtml(text);
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeNote}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{color-scheme:light dark}*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:#ebeef1}.container{position:absolute;inset:20px;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}.toolbar{display:flex;justify-content:flex-end;gap:4px}.view-button{padding:5px 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:#5b6472;font:12px/1.2 system-ui;cursor:pointer}.view-button[aria-pressed="true"]{border-color:#cfd5dc;background:#fff;color:#1f2937}.workspace{display:grid;flex:1;min-width:0;min-height:0}.workspace[data-mode="edit"] #preview,.workspace[data-mode="preview"] #content{display:none}.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}#content,#preview{width:100%;height:100%;min-width:0;min-height:0;margin:0;overflow:auto;border:1px solid #ddd;background:#fff;color:#111827}#content{padding:20px;resize:none;outline:none;font:16px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview{padding:20px 28px 40px;font:16px/1.65 system-ui;overflow-wrap:anywhere}#preview:empty:before{content:"Nothing to preview";color:#9ca3af}#preview>:first-child{margin-top:0}#preview>:last-child{margin-bottom:0}#preview h1,#preview h2,#preview h3{line-height:1.25}#preview h1{font-size:2em}#preview h2{font-size:1.55em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}#preview h3{font-size:1.25em}#preview p,#preview ul,#preview ol,#preview blockquote,#preview pre{margin:0 0 1em}#preview blockquote{padding-left:1em;border-left:3px solid #cbd5e1;color:#5b6472}#preview code{padding:.12em .35em;border-radius:4px;background:#f1f5f9;font:0.92em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview pre{padding:14px 16px;overflow:auto;border-radius:6px;background:#f1f5f9}#preview pre code{padding:0;background:transparent}#preview a{color:#2563eb}#printable{display:none}@media(max-width:760px){.container{inset:10px}.toolbar{justify-content:center}.workspace[data-mode="split"]{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}@media(prefers-color-scheme:dark){body{background:#333b4d}.view-button{color:#b9c1cd}.view-button[aria-pressed="true"]{border-color:#596274;background:#24262b;color:#fff}#content,#preview{border-color:#495265;background:#24262b;color:#fff}#preview h2{border-bottom-color:#495265}#preview blockquote{border-left-color:#64748b;color:#cbd5e1}#preview code,#preview pre{background:#17191d}#preview pre code{background:transparent}#preview a{color:#93c5fd}}@media print{.container{display:none}#printable{display:block;white-space:pre-wrap;word-break:break-word}}
</style></head><body><div class="container"><div class="toolbar" role="toolbar" aria-label="View mode"><button class="view-button" data-mode-button="edit" aria-pressed="true">Edit</button><button class="view-button" data-mode-button="split" aria-pressed="false">Split</button><button class="view-button" data-mode-button="preview" aria-pressed="false">Preview</button></div><div class="workspace" data-mode="edit"><textarea id="content" spellcheck="false" aria-label="Note editor">${safeText}</textarea><article id="preview" aria-label="Markdown preview"></article></div></div><pre id="printable">${safeText}</pre><script>
const textarea=document.getElementById("content"),printable=document.getElementById("printable"),preview=document.getElementById("preview"),workspace=document.querySelector(".workspace"),buttons=[...document.querySelectorAll("[data-mode-button]")],modeKey="minimalist-web-notepad:view-mode";let saved=textarea.value,inFlight=false,timer=0,renderQueued=false;
function scheduleUpload(delay=700){clearTimeout(timer);timer=setTimeout(uploadContent,delay)}
async function uploadContent(){if(inFlight||saved===textarea.value)return;const next=textarea.value;inFlight=true;try{const body=new URLSearchParams({text:next}),r=await fetch(location.href,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"},body});if(!r.ok)throw new Error("Save failed");saved=next;printable.textContent=next}catch{scheduleUpload(1000)}finally{inFlight=false;if(saved!==textarea.value)scheduleUpload(200)}}
function storedMode(){try{const m=localStorage.getItem(modeKey);return["edit","split","preview"].includes(m)?m:null}catch{return null}}
function setMode(mode,persist=true){workspace.dataset.mode=mode;for(const b of buttons)b.setAttribute("aria-pressed",String(b.dataset.modeButton===mode));if(mode!=="edit"){renderMarkdown(textarea.value);syncPreviewScroll()}if(persist)try{localStorage.setItem(modeKey,mode)}catch{}if(mode!=="preview")textarea.focus()}
function schedulePreview(){if(workspace.dataset.mode==="edit"||renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderMarkdown(textarea.value);syncPreviewScroll()})}
function syncPreviewScroll(){if(workspace.dataset.mode!=="split")return;const a=textarea.scrollHeight-textarea.clientHeight,b=preview.scrollHeight-preview.clientHeight;preview.scrollTop=a>0&&b>0?textarea.scrollTop/a*b:0}
function renderMarkdown(source){const out=document.createDocumentFragment(),lines=source.replace(/\r\n?/g,"\n").split("\n");let i=0;while(i<lines.length){const line=lines[i];if(/^\s*$/.test(line)){i++;continue}const fence=line.match(/^\s*\x60\x60\x60([^\x60]*)$/);if(fence){const rows=[];i++;while(i<lines.length&&!/^\s*\x60\x60\x60\s*$/.test(lines[i]))rows.push(lines[i++]);if(i<lines.length)i++;const pre=document.createElement("pre"),code=document.createElement("code");code.textContent=rows.join("\n");pre.append(code);out.append(pre);continue}const h=line.match(/^(#{1,6})\s+(.*)$/);if(h){const el=document.createElement("h"+h[1].length);inline(el,h[2]);out.append(el);i++;continue}if(/^\s*>/.test(line)){const q=document.createElement("blockquote");while(i<lines.length){const m=lines[i].match(/^\s*>\s?(.*)$/);if(!m)break;if(q.childNodes.length)q.append(document.createElement("br"));inline(q,m[1]);i++}out.append(q);continue}const li=listItem(line);if(li){const list=document.createElement(li.ordered?"ol":"ul");while(i<lines.length){const item=listItem(lines[i]);if(!item||item.ordered!==li.ordered)break;const el=document.createElement("li"),task=item.text.match(/^\[( |x|X)\]\s+(.*)$/);if(task){const cb=document.createElement("input");cb.type="checkbox";cb.disabled=true;cb.checked=task[1].toLowerCase()==="x";el.append(cb);inline(el,task[2])}else inline(el,item.text);list.append(el);i++}out.append(list);continue}const rows=[];while(i<lines.length&&!/^\s*$/.test(lines[i])&&!blockStart(lines[i]))rows.push(lines[i++]);if(!rows.length)rows.push(lines[i++]);const p=document.createElement("p");rows.forEach((r,n)=>{if(n)p.append(document.createElement("br"));inline(p,r)});out.append(p)}preview.replaceChildren(out)}
function blockStart(line){return /^\s*\x60\x60\x60/.test(line)||/^(#{1,6})\s+/.test(line)||/^\s*>/.test(line)||!!listItem(line)}
function listItem(line){let m=line.match(/^\s{0,3}[-+*]\s+(.*)$/);if(m)return{ordered:false,text:m[1]};m=line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);return m?{ordered:true,text:m[1]}:null}
function inline(parent,text){const re=/(\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;let at=0;for(const m of text.matchAll(re)){if(m.index>at)parent.append(document.createTextNode(text.slice(at,m.index)));const t=m[0];if(t.charCodeAt(0)===96){const el=document.createElement("code");el.textContent=t.slice(1,-1);parent.append(el)}else if(t.startsWith("[")){const x=t.match(/^\[([^\]]+)\]\(([^)]+)\)$/),href=x?safeHref(x[2]):"";if(x&&href){const a=document.createElement("a");a.href=href;a.rel="noopener noreferrer";inline(a,x[1]);parent.append(a)}else parent.append(document.createTextNode(t))}else{const el=document.createElement(t.startsWith("**")||t.startsWith("__")?"strong":t.startsWith("~~")?"del":"em"),n=t.startsWith("**")||t.startsWith("__")||t.startsWith("~~")?2:1;inline(el,t.slice(n,-n));parent.append(el)}at=m.index+t.length}if(at<text.length)parent.append(document.createTextNode(text.slice(at)))}
function safeHref(v){try{const u=new URL(v,location.href);return["http:","https:","mailto:"].includes(u.protocol)?u.href:""}catch{return""}}
textarea.addEventListener("input",()=>{printable.textContent=textarea.value;scheduleUpload();schedulePreview()});textarea.addEventListener("scroll",syncPreviewScroll,{passive:true});for(const b of buttons)b.addEventListener("click",()=>setMode(b.dataset.modeButton));window.addEventListener("beforeprint",()=>{printable.textContent=textarea.value});setMode(storedMode()||"edit",false);
</script></body></html>`;
}
function escapeHtml(v){return v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function parsePositiveInt(v,fallback){const n=Number.parseInt(v,10);return Number.isFinite(n)&&n>=0?n:fallback}
function faviconSvg(){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#ebeef1"/><path d="M18 14h28v38H18z" fill="#fff" stroke="#9aa4b2" stroke-width="3"/><path d="M24 24h20M24 32h20M24 40h14" stroke="#475569" stroke-width="3" stroke-linecap="round"/></svg>`}
