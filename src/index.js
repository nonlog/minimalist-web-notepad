const NOTE_RE=/^[a-zA-Z0-9_-]{1,64}$/;
const RANDOM_ALPHABET="234579abcdefghjkmnpqrstwxyz";
const DEFAULT_MAX_BYTES=256*1024;
const VIEW_KEY_PREFIX="@view:";
const VIEW_MODES=new Set(["edit","split","preview"]);

export default{async fetch(request,env){return handleRequest(request,env)}};

export async function handleRequest(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path==="/robots.txt")return textResponse("User-agent: *\nDisallow: /\n",200,"text/plain");
  if(path==="/favicon.svg")return textResponse(faviconSvg(),200,"image/svg+xml");
  const note=parseNoteName(path);
  if(!note)return redirectToRandomNote(url);
  if(!env?.NOTES)return textResponse("Missing NOTES KV binding.\n",500,"text/plain");
  if(request.method==="POST")return url.searchParams.has("view")?saveViewMode(request,env,note):saveNote(request,env,note);
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:commonHeaders({Allow:"GET, HEAD, POST"})});
  const raw=url.searchParams.has("raw")||isCliClient(request);
  if(raw){const text=await env.NOTES.get(note);return text===null?textResponse("Not found.\n",404,"text/plain"):textResponse(text,200,"text/plain")}
  const [text,storedView]=await Promise.all([env.NOTES.get(note),env.NOTES.get(viewKey(note))]);
  return htmlResponse(renderPage(note,text??"",normalizeViewMode(storedView)));
}

function parseNoteName(path){const note=path.replace(/^\/+|\/+$/g,"");return NOTE_RE.test(note)?note:""}
function viewKey(note){return VIEW_KEY_PREFIX+note}
export function normalizeViewMode(value){return VIEW_MODES.has(value)?value:"edit"}
function redirectToRandomNote(url){const target=new URL(`/${randomNoteName()}`,url);return new Response(null,{status:302,headers:commonHeaders({Location:target.pathname})})}
function randomNoteName(){const bytes=new Uint8Array(5);crypto.getRandomValues(bytes);return Array.from(bytes,b=>RANDOM_ALPHABET[b%RANDOM_ALPHABET.length]).join("")}

async function saveNote(request,env,note){
  const text=await readTextFromRequest(request),max=parsePositiveInt(env.NOTE_MAX_BYTES,DEFAULT_MAX_BYTES);
  if(new TextEncoder().encode(text).length>max)return textResponse(`Note is too large. Limit is ${max} bytes.\n`,413,"text/plain");
  if(text.length===0)await Promise.all([env.NOTES.delete(note),env.NOTES.delete(viewKey(note))]);else{const ttl=parsePositiveInt(env.NOTE_TTL_SECONDS,0);await env.NOTES.put(note,text,ttl>0?{expirationTtl:ttl}:undefined)}
  return new Response(null,{status:204,headers:commonHeaders()});
}
async function saveViewMode(request,env,note){
  const type=request.headers.get("content-type")||"";
  let mode="";
  if(type.includes("application/x-www-form-urlencoded")){const form=await request.formData(),value=form.get("mode");mode=typeof value==="string"?value:""}else mode=(await request.text()).trim();
  if(!VIEW_MODES.has(mode))return textResponse("Invalid view mode.\n",400,"text/plain");
  const key=viewKey(note);
  if(mode==="edit")await env.NOTES.delete(key);else{const ttl=parsePositiveInt(env.NOTE_TTL_SECONDS,0);await env.NOTES.put(key,mode,ttl>0?{expirationTtl:ttl}:undefined)}
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

export function getMarkdownListEdit(value,selectionStart,selectionEnd){
  if(selectionStart!==selectionEnd)return null;
  const lineStart=value.lastIndexOf("\n",Math.max(0,selectionStart-1))+1;
  const nextBreak=value.indexOf("\n",selectionStart),lineEnd=nextBreak===-1?value.length:nextBreak;
  const beforeLine=value.slice(0,lineStart),fences=beforeLine.match(/^\s*```/gm);
  if(fences&&fences.length%2===1)return null;
  const line=value.slice(lineStart,lineEnd),cursorInLine=selectionStart-lineStart,beforeCursor=line.slice(0,cursorInLine),afterCursor=line.slice(cursorInLine);
  const match=beforeCursor.match(/^(\s*)(?:(\d+)([.)])|([-+*]))\s+(\[(?: |x|X)\]\s+)?(.*)$/);
  if(!match)return null;
  const indent=match[1],ordered=match[2]!==undefined,delimiter=match[3]||"",bullet=match[4]||"",task=match[5]||"",content=match[6];
  if(/^\s*$/.test(content+afterCursor))return{start:lineStart,end:lineEnd,text:indent,cursor:lineStart+indent.length};
  const marker=ordered?`${Number(match[2])+1}${delimiter}`:bullet,nextTask=task?"[ ] ":"",insert=`\n${indent}${marker} ${nextTask}`;
  return{start:selectionStart,end:selectionEnd,text:insert,cursor:selectionStart+insert.length};
}

export function isMarkdownHorizontalRule(line){
  return /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

export function parseMarkdownListItem(line){
  const match=line.match(/^([ \t]*)([-+*]|\d+[.)])\s+(.*)$/);
  if(!match)return null;
  const indent=Array.from(match[1],char=>char==="\t"?4:1).reduce((sum,n)=>sum+n,0);
  return{indent,ordered:/^\d/.test(match[2]),text:match[3]};
}

export function canUseUnderscoreEmphasis(text,start,length){
  const before=start>0?text[start-1]:"",after=text[start+length]||"";
  return !/[A-Za-z0-9]/.test(before)&&!/[A-Za-z0-9]/.test(after);
}

function renderPage(note,text,viewMode="edit"){
  const safeNote=escapeHtml(note),safeText=escapeHtml(text),editPressed=viewMode==="edit",splitPressed=viewMode==="split",previewPressed=viewMode==="preview";
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><title>${safeNote}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{color-scheme:light dark;--app-height:100dvh;--page-gap:20px}*{box-sizing:border-box}html,body{width:100%;height:100%;min-height:100%;overflow:hidden;-webkit-text-size-adjust:100%}body{position:relative;height:var(--app-height,100dvh);margin:0;background:#ebeef1;overscroll-behavior:none}.container{position:absolute;top:max(var(--page-gap),env(safe-area-inset-top,0px));right:max(var(--page-gap),env(safe-area-inset-right,0px));bottom:max(var(--page-gap),env(safe-area-inset-bottom,0px));left:max(var(--page-gap),env(safe-area-inset-left,0px));display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}.toolbar{display:flex;flex:0 0 auto;justify-content:flex-end;gap:6px;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.toolbar::-webkit-scrollbar{display:none}.view-button{min-height:36px;padding:6px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:#5b6472;font:12px/1.2 system-ui;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.view-button[aria-pressed="true"]{border-color:#cfd5dc;background:#fff;color:#1f2937}.workspace{display:grid;flex:1;width:100%;min-width:0;min-height:0;overflow:hidden}.workspace[data-mode="edit"] #preview,.workspace[data-mode="preview"] #content{display:none}.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}#content,#preview{width:100%;max-width:100%;height:100%;min-width:0;min-height:0;margin:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;border:1px solid #ddd;background:#fff;color:#111827}#content{padding:20px;resize:none;outline:none;font:16px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview{padding:20px 28px 40px;font:16px/1.65 system-ui;overflow-wrap:anywhere}#preview:empty:before{content:"Nothing to preview";color:#9ca3af}#preview>:first-child{margin-top:0}#preview>:last-child{margin-bottom:0}#preview h1,#preview h2,#preview h3{line-height:1.25}#preview h1{font-size:2em}#preview h2{font-size:1.55em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}#preview h3{font-size:1.25em}#preview p,#preview ul,#preview ol,#preview blockquote,#preview pre{margin:0 0 1em}#preview li>ul,#preview li>ol{margin:.25em 0 0;padding-left:1.4em}#preview blockquote{padding-left:1em;border-left:3px solid #cbd5e1;color:#5b6472}#preview code{padding:.12em .35em;border-radius:4px;background:#f1f5f9;font:0.92em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview pre{padding:14px 16px;overflow:auto;border-radius:6px;background:#f1f5f9}#preview pre code{padding:0;background:transparent}#preview hr{border:0;border-top:1px solid #d1d5db;margin:1.5em 0}#preview a{color:#2563eb}#printable{display:none}@media(pointer:coarse){.view-button{min-height:44px}}@media(max-width:760px){:root{--page-gap:8px}.container{gap:8px}.toolbar{justify-content:stretch;gap:6px}.view-button{flex:1 1 0;min-width:0;min-height:44px;padding:8px;font-size:13px}.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:8px}#content{padding:14px 12px 18px;font-size:16px;line-height:1.55}#preview{padding:14px 14px 24px;font-size:15px;line-height:1.6}#preview h1{font-size:1.65em}#preview h2{font-size:1.35em}#preview h3{font-size:1.15em}#preview ul,#preview ol{padding-left:1.35em}#preview li>ul,#preview li>ol{padding-left:1.2em}#preview pre{padding:12px}}@media(max-width:760px) and (orientation:landscape) and (min-width:640px){.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr)}}@media(max-height:520px) and (orientation:landscape){:root{--page-gap:6px}.container{gap:6px}.view-button{min-height:36px;padding-block:5px}}@media(prefers-color-scheme:dark){body{background:#333b4d}.view-button{color:#b9c1cd}.view-button[aria-pressed="true"]{border-color:#596274;background:#24262b;color:#fff}#content,#preview{border-color:#495265;background:#24262b;color:#fff}#preview h2{border-bottom-color:#495265}#preview blockquote{border-left-color:#64748b;color:#cbd5e1}#preview code,#preview pre{background:#17191d}#preview pre code{background:transparent}#preview hr{border-top-color:#495265}#preview a{color:#93c5fd}}@media print{.container{display:none}#printable{display:block;white-space:pre-wrap;word-break:break-word}}
</style></head><body><div class="container"><div class="toolbar" role="toolbar" aria-label="View mode"><button class="view-button" data-mode-button="edit" aria-pressed="${editPressed}">Edit</button><button class="view-button" data-mode-button="split" aria-pressed="${splitPressed}">Split</button><button class="view-button" data-mode-button="preview" aria-pressed="${previewPressed}">Preview</button></div><div class="workspace" data-mode="${viewMode}"><textarea id="content" spellcheck="false" aria-label="Note editor">${safeText}</textarea><article id="preview" aria-label="Markdown preview"></article></div></div><pre id="printable">${safeText}</pre><script>
${getMarkdownListEdit.toString()}
${isMarkdownHorizontalRule.toString()}
${parseMarkdownListItem.toString()}
${canUseUnderscoreEmphasis.toString()}
const textarea=document.getElementById("content"),printable=document.getElementById("printable"),preview=document.getElementById("preview"),workspace=document.querySelector(".workspace"),buttons=[...document.querySelectorAll("[data-mode-button]")],initialMode="${viewMode}",visualViewport=window.visualViewport;let saved=textarea.value,inFlight=false,timer=0,renderQueued=false;
function syncAppHeight(){if(visualViewport&&visualViewport.scale!==1)return;const height=visualViewport?.height||window.innerHeight;document.documentElement.style.setProperty("--app-height",height+"px")}
function scheduleUpload(delay=700){clearTimeout(timer);timer=setTimeout(uploadContent,delay)}
async function uploadContent(){if(inFlight||saved===textarea.value)return;const next=textarea.value;inFlight=true;try{const body=new URLSearchParams({text:next}),r=await fetch(location.href,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"},body});if(!r.ok)throw new Error("Save failed");saved=next;printable.textContent=next}catch{scheduleUpload(1000)}finally{inFlight=false;if(saved!==textarea.value)scheduleUpload(200)}}
function persistViewMode(mode){const url=new URL(location.href);url.search="";url.searchParams.set("view","1");const body=new URLSearchParams({mode});fetch(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"},body}).then(r=>{if(!r.ok)throw new Error("View mode save failed")}).catch(()=>{})}
function setMode(mode,persist=true,focusEditor=true){workspace.dataset.mode=mode;for(const b of buttons)b.setAttribute("aria-pressed",String(b.dataset.modeButton===mode));if(mode!=="edit"){renderMarkdown(textarea.value);syncPreviewScroll()}if(persist)persistViewMode(mode);if(focusEditor&&mode!=="preview")textarea.focus()}
function schedulePreview(){if(workspace.dataset.mode==="edit"||renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderMarkdown(textarea.value);syncPreviewScroll()})}
function syncPreviewScroll(){if(workspace.dataset.mode!=="split")return;const a=textarea.scrollHeight-textarea.clientHeight,b=preview.scrollHeight-preview.clientHeight;preview.scrollTop=a>0&&b>0?textarea.scrollTop/a*b:0}
function renderMarkdown(source){const out=document.createDocumentFragment(),lines=source.replace(/\r\n?/g,"\n").split("\n");let i=0;while(i<lines.length){const line=lines[i];if(/^\s*$/.test(line)){i++;continue}const fence=line.match(/^\s*\x60\x60\x60([^\x60]*)$/);if(fence){const rows=[];i++;while(i<lines.length&&!/^\s*\x60\x60\x60\s*$/.test(lines[i]))rows.push(lines[i++]);if(i<lines.length)i++;const pre=document.createElement("pre"),code=document.createElement("code");code.textContent=rows.join("\n");pre.append(code);out.append(pre);continue}if(isMarkdownHorizontalRule(line)){out.append(document.createElement("hr"));i++;continue}const h=line.match(/^(#{1,6})\s+(.*)$/);if(h){const el=document.createElement("h"+h[1].length);inline(el,h[2]);out.append(el);i++;continue}if(/^\s*>/.test(line)){const q=document.createElement("blockquote");while(i<lines.length){const m=lines[i].match(/^\s*>\s?(.*)$/);if(!m)break;if(q.childNodes.length)q.append(document.createElement("br"));inline(q,m[1]);i++}out.append(q);continue}if(listItem(line)){const parsed=renderList(lines,i);out.append(parsed.node);i=parsed.next;continue}const rows=[];while(i<lines.length&&!/^\s*$/.test(lines[i])&&!blockStart(lines[i]))rows.push(lines[i++]);if(!rows.length)rows.push(lines[i++]);const p=document.createElement("p");rows.forEach((r,n)=>{if(n)p.append(document.createElement("br"));inline(p,r)});out.append(p)}preview.replaceChildren(out)}
function renderList(lines,start){const first=listItem(lines[start]),base=first.indent,list=document.createElement(first.ordered?"ol":"ul");let i=start;while(i<lines.length){const item=listItem(lines[i]);if(!item||item.indent!==base||item.ordered!==first.ordered)break;const el=document.createElement("li");appendListItem(el,item.text);i++;while(i<lines.length){const child=listItem(lines[i]);if(!child||child.indent<=base)break;const nested=renderList(lines,i);el.append(nested.node);i=nested.next}list.append(el)}return{node:list,next:i}}
function appendListItem(el,text){const task=text.match(/^\[( |x|X)\]\s+(.*)$/);if(task){const cb=document.createElement("input");cb.type="checkbox";cb.disabled=true;cb.checked=task[1].toLowerCase()==="x";el.append(cb);inline(el,task[2])}else inline(el,text)}
function blockStart(line){return /^\s*\x60\x60\x60/.test(line)||isMarkdownHorizontalRule(line)||/^(#{1,6})\s+/.test(line)||/^\s*>/.test(line)||!!listItem(line)}
function listItem(line){return parseMarkdownListItem(line)}
function inline(parent,text){const re=/(\\[\x5c\x60*_{}\[\]()#+\-.!>]|\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;let at=0,m;while((m=re.exec(text))){const t=m[0],underscore=t.startsWith("_")&&t.endsWith("_");if(underscore&&!canUseUnderscoreEmphasis(text,m.index,t.length)){re.lastIndex=m.index+1;continue}if(m.index>at)parent.append(document.createTextNode(text.slice(at,m.index)));if(t.charCodeAt(0)===92)parent.append(document.createTextNode(t.slice(1)));else if(t.charCodeAt(0)===96){const el=document.createElement("code");el.textContent=t.slice(1,-1);parent.append(el)}else if(t.startsWith("[")){const x=t.match(/^\[([^\]]+)\]\(([^)]+)\)$/),href=x?safeHref(x[2]):"";if(x&&href){const a=document.createElement("a");a.href=href;a.rel="noopener noreferrer";inline(a,x[1]);parent.append(a)}else parent.append(document.createTextNode(t))}else{const el=document.createElement(t.startsWith("**")||t.startsWith("__")?"strong":t.startsWith("~~")?"del":"em"),n=t.startsWith("**")||t.startsWith("__")||t.startsWith("~~")?2:1;inline(el,t.slice(n,-n));parent.append(el)}at=m.index+t.length}if(at<text.length)parent.append(document.createTextNode(text.slice(at)))}
function safeHref(v){try{const u=new URL(v,location.href);return["http:","https:","mailto:"].includes(u.protocol)?u.href:""}catch{return""}}
function editorChanged(){printable.textContent=textarea.value;scheduleUpload();schedulePreview()}
function handleListEnter(event){
  if(event.key!=="Enter"||event.isComposing||event.altKey||event.ctrlKey||event.metaKey)return;
  const edit=getMarkdownListEdit(textarea.value,textarea.selectionStart,textarea.selectionEnd);
  if(!edit)return;
  event.preventDefault();
  textarea.setRangeText(edit.text,edit.start,edit.end,"preserve");
  textarea.setSelectionRange(edit.cursor,edit.cursor);
  editorChanged();
}
textarea.addEventListener("keydown",handleListEnter);textarea.addEventListener("input",editorChanged);textarea.addEventListener("scroll",syncPreviewScroll,{passive:true});for(const b of buttons)b.addEventListener("click",()=>setMode(b.dataset.modeButton));visualViewport?.addEventListener("resize",syncAppHeight,{passive:true});window.addEventListener("resize",syncAppHeight,{passive:true});window.addEventListener("orientationchange",syncAppHeight,{passive:true});window.addEventListener("beforeprint",()=>{printable.textContent=textarea.value});syncAppHeight();setMode(initialMode,false,false);
</script></body></html>`;
}
function escapeHtml(v){return v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function parsePositiveInt(v,fallback){const n=Number.parseInt(v,10);return Number.isFinite(n)&&n>=0?n:fallback}
function faviconSvg(){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#ebeef1"/><path d="M18 14h28v38H18z" fill="#fff" stroke="#9aa4b2" stroke-width="3"/><path d="M24 24h20M24 32h20M24 40h14" stroke="#475569" stroke-width="3" stroke-linecap="round"/></svg>`}
