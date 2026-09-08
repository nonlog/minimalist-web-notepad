const NOTE_RE=/^[a-zA-Z0-9_-]{1,64}$/;
const RANDOM_ALPHABET="234579abcdefghjkmnpqrstwxyz";
const DEFAULT_MAX_BYTES=256*1024;
const VIEW_KEY_PREFIX="@view:";
const VIEW_MODES=new Set(["edit","split","preview"]);
const DEFAULT_NOTE_HOST="note.414222.xyz";
const DEFAULT_FILE_HOST="file.414222.xyz";
const DEFAULT_FILE_MAX_BYTES=95*1024*1024;
const FILE_PREFIX="tmp/";
const FILE_TTLS=new Map([["1h",60*60],["24h",24*60*60],["7d",7*24*60*60]]);

export default{
  async fetch(request,env){return handleRequest(request,env)},
  async scheduled(_controller,env,ctx){ctx.waitUntil(cleanupExpiredFiles(env))}
};

export async function handleRequest(request,env){
  const url=new URL(request.url),path=url.pathname,host=url.hostname.toLowerCase();
  if(host===fileHost(env))return handleFileHost(request,env,url);
  if(path==="/robots.txt")return textResponse("User-agent: *\nDisallow: /\n",200,"text/plain");
  if(path==="/favicon.svg")return textResponse(faviconSvg(),200,"image/svg+xml");
  if(path==="/share")return host===noteHost(env)?handleSharePage(request):textResponse("Not found.\n",404,"text/plain");
  if(path==="/api/share")return host===noteHost(env)?handleShareUpload(request,env,url):textResponse("Not found.\n",404,"text/plain");
  const note=parseNoteName(path);
  if(!note)return redirectToRandomNote(url);
  if(!env?.NOTES)return textResponse("Missing NOTES KV binding.\n",500,"text/plain");
  if(request.method==="POST")return url.searchParams.has("view")?saveViewMode(request,env,note):saveNote(request,env,note);
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:commonHeaders({Allow:"GET, HEAD, POST"})});
  const raw=url.searchParams.has("raw")||isCliClient(request);
  if(raw){const text=await env.NOTES.get(note);return text===null?textResponse("Not found.\n",404,"text/plain"):textResponse(text,200,"text/plain")}
  const [text,storedView]=await Promise.all([env.NOTES.get(note),env.NOTES.get(viewKey(note))]);
  return htmlResponse(renderPage(note,text??"",normalizeViewMode(storedView),noteHost(env)));
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
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:commonHeaders({"Content-Type":"application/json; charset=utf-8"})})}
function noteHost(env){return String(env?.FILE_UPLOAD_HOST||DEFAULT_NOTE_HOST).toLowerCase()}
function fileHost(env){return String(env?.FILE_DOWNLOAD_HOST||DEFAULT_FILE_HOST).toLowerCase()}
function fileMaxBytes(env){return parsePositiveInt(env?.FILE_MAX_BYTES,DEFAULT_FILE_MAX_BYTES)}

function handleSharePage(request){
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:commonHeaders({Allow:"GET, HEAD"})});
  return htmlResponse(renderSharePage());
}

async function handleShareUpload(request,env,url){
  if(request.method!=="PUT")return new Response(null,{status:405,headers:commonHeaders({Allow:"PUT"})});
  if(!env?.TEMP_FILES)return textResponse("Missing TEMP_FILES R2 binding.\n",500,"text/plain");
  if(!request.body)return textResponse("Missing file body.\n",400,"text/plain");
  const ttlName=url.searchParams.get("ttl")||"24h",ttl=FILE_TTLS.get(ttlName);
  if(!ttl)return textResponse("Invalid expiry.\n",400,"text/plain");
  const filename=sanitizeFilename(url.searchParams.get("name")||"file"),max=fileMaxBytes(env);
  const contentLength=Number.parseInt(request.headers.get("content-length")||"",10);
  if(Number.isFinite(contentLength)&&contentLength>max)return textResponse(`File is too large. Limit is ${max} bytes.\n`,413,"text/plain");
  const expiresAt=Math.floor(Date.now()/1000)+ttl,id=crypto.randomUUID().replaceAll("-","");
  const key=`${FILE_PREFIX}${expiresAt}/${id}`;
  try{
    await env.TEMP_FILES.put(key,request.body,{
      httpMetadata:{contentType:normalizeContentType(request.headers.get("content-type"))},
      customMetadata:{filename,expiresAt:String(expiresAt)}
    });
  }catch(error){
    console.error(JSON.stringify({event:"temp_file_upload_failed",message:String(error?.message||error)}));
    return textResponse("Upload failed.\n",500,"text/plain");
  }
  const token=`${expiresAt.toString(36)}-${id}`,downloadUrl=`https://${fileHost(env)}/f/${token}/${encodeURIComponent(filename)}`;
  return jsonResponse({url:downloadUrl,markdown:`[${escapeMarkdownLabel(filename)}](${downloadUrl})`,expiresAt:new Date(expiresAt*1000).toISOString()});
}

async function handleFileHost(request,env,url){
  if(url.pathname==="/robots.txt")return textResponse("User-agent: *\nDisallow: /\n",200,"text/plain");
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:commonHeaders({Allow:"GET, HEAD"})});
  if(!env?.TEMP_FILES)return textResponse("Missing TEMP_FILES R2 binding.\n",500,"text/plain");
  const parsed=parseFilePath(url.pathname);
  if(!parsed)return textResponse("Not found.\n",404,"text/plain");
  const now=Math.floor(Date.now()/1000);
  if(parsed.expiresAt<=now)return textResponse("This file has expired.\n",410,"text/plain");
  const key=`${FILE_PREFIX}${parsed.expiresAt}/${parsed.id}`;
  const object=request.method==="HEAD"?await env.TEMP_FILES.head(key):await env.TEMP_FILES.get(key);
  if(!object)return textResponse("Not found.\n",404,"text/plain");
  const filename=sanitizeFilename(object.customMetadata?.filename||"download"),headers=new Headers(commonHeaders({
    "Content-Type":normalizeContentType(object.httpMetadata?.contentType),
    "Content-Disposition":contentDisposition(filename),
    "X-Content-Type-Options":"nosniff",
    "Content-Security-Policy":"sandbox; default-src 'none'"
  }));
  if(Number.isFinite(object.size))headers.set("Content-Length",String(object.size));
  if(object.httpEtag)headers.set("ETag",object.httpEtag);
  return new Response(request.method==="HEAD"?null:object.body,{status:200,headers});
}

export async function cleanupExpiredFiles(env,now=Math.floor(Date.now()/1000)){
  if(!env?.TEMP_FILES)return 0;
  let deleted=0;
  for(let batch=0;batch<20;batch++){
    const page=await env.TEMP_FILES.list({prefix:FILE_PREFIX,limit:1000}),keys=[];
    for(const object of page.objects||[]){
      const expiresAt=parseExpiryFromKey(object.key);
      if(expiresAt===null)continue;
      if(expiresAt>now)break;
      keys.push(object.key);
    }
    if(!keys.length)break;
    await env.TEMP_FILES.delete(keys);
    deleted+=keys.length;
    if(keys.length<(page.objects||[]).length)break;
  }
  if(deleted)console.log(JSON.stringify({event:"temp_file_cleanup",deleted}));
  return deleted;
}

function parseFilePath(path){
  const match=path.match(/^\/f\/([0-9a-z]+)-([0-9a-f]{32})(?:\/[^/]*)?$/i);
  if(!match)return null;
  const expiresAt=Number.parseInt(match[1],36);
  return Number.isSafeInteger(expiresAt)&&expiresAt>0?{expiresAt,id:match[2].toLowerCase()}:null;
}
function parseExpiryFromKey(key){const match=key.match(/^tmp\/(\d+)\/[0-9a-f]{32}$/i);if(!match)return null;const value=Number(match[1]);return Number.isSafeInteger(value)?value:null}
export function sanitizeFilename(value){
  let name=String(value||"").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g,"").replace(/[\\/:*?"<>|]/g,"_").trim().replace(/[. ]+$/g,"");
  if(!name)name="file";
  if(name.length>180)name=name.slice(0,180);
  return name;
}
function normalizeContentType(value){const type=String(value||"").split(";",1)[0].trim().toLowerCase();return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)?type:"application/octet-stream"}
function contentDisposition(filename){return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`}
function escapeMarkdownLabel(value){return value.replace(/([\[\]\\])/g,"\\$1")}

function renderSharePage(){return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><title>Temporary file share</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:#ebeef1;color:#111827;font:15px/1.5 system-ui}.card{width:min(680px,100%);margin:4vh auto;padding:24px;border:1px solid #d8dde4;border-radius:12px;background:#fff}.top{display:flex;align-items:center;justify-content:space-between;gap:16px}.top a{color:#5b6472;text-decoration:none}h1{margin:0;font-size:1.55rem}p{color:#5b6472}.drop{display:grid;place-items:center;min-height:180px;margin:22px 0 14px;padding:24px;border:2px dashed #c8d0da;border-radius:10px;text-align:center;cursor:pointer;touch-action:manipulation}.drop.drag{border-color:#2563eb;background:#eff6ff}.drop strong{display:block}.drop small{display:block;margin-top:6px;color:#6b7280}.controls{display:flex;gap:10px;align-items:end}.field{flex:1}.field label{display:block;margin-bottom:5px;color:#5b6472;font-size:12px}select,button,input{min-height:42px;border:1px solid #cfd5dc;border-radius:8px;background:#fff;color:#111827;font:inherit}select,input{width:100%;padding:8px 10px}button{padding:8px 14px;cursor:pointer}button.primary{border-color:#111827;background:#111827;color:#fff}button:disabled{opacity:.55;cursor:not-allowed}.progress{height:6px;margin-top:14px;overflow:hidden;border-radius:999px;background:#e5e7eb}.bar{height:100%;width:0;background:#111827;transition:width .15s}.status{min-height:22px;margin-top:9px;color:#5b6472}.result{display:none;margin-top:18px;padding-top:18px;border-top:1px solid #e5e7eb}.row{display:flex;gap:8px;margin-top:8px}.row input{min-width:0}.row button{flex:0 0 auto}.meta{margin-top:8px;color:#6b7280;font-size:12px}@media(max-width:560px){body{padding:8px}.card{margin:0;padding:16px;border-radius:10px}.controls{align-items:stretch;flex-direction:column}.drop{min-height:150px;margin-top:16px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto}}@media(prefers-color-scheme:dark){body{background:#333b4d;color:#fff}.card,select,button,input{border-color:#495265;background:#24262b;color:#fff}.drop{border-color:#596274}.drop.drag{border-color:#93c5fd;background:#172033}.top a,p,.field label,.status,.meta,.drop small{color:#b9c1cd}button.primary{border-color:#e5e7eb;background:#e5e7eb;color:#111827}.progress{background:#3b4250}.bar{background:#e5e7eb}.result{border-top-color:#495265}}</style></head><body><main class="card"><div class="top"><h1>Temporary file share</h1><a href="/">Notes</a></div><p>Upload one file up to 95 MiB. Anyone with the download link can access it until it expires.</p><input id="file" type="file" hidden><div id="drop" class="drop" role="button" tabindex="0"><div><strong id="file-name">Drop a file here or choose a file</strong><small id="file-meta">One file per link</small></div></div><div class="controls"><div class="field"><label for="ttl">Expires after</label><select id="ttl"><option value="1h">1 hour</option><option value="24h" selected>24 hours</option><option value="7d">7 days</option></select></div><button id="upload" class="primary" disabled>Upload</button></div><div class="progress" aria-hidden="true"><div id="bar" class="bar"></div></div><div id="status" class="status" aria-live="polite"></div><section id="result" class="result"><strong>Share link</strong><div class="row"><input id="link" readonly><button data-copy="link">Copy</button></div><div class="meta" id="expiry"></div><div class="row"><input id="markdown" readonly><button data-copy="markdown">Copy Markdown</button></div></section></main><script>
const MAX=95*1024*1024,fileInput=document.getElementById("file"),drop=document.getElementById("drop"),fileName=document.getElementById("file-name"),fileMeta=document.getElementById("file-meta"),ttl=document.getElementById("ttl"),upload=document.getElementById("upload"),bar=document.getElementById("bar"),status=document.getElementById("status"),result=document.getElementById("result"),link=document.getElementById("link"),markdown=document.getElementById("markdown"),expiry=document.getElementById("expiry");let selected=null;
function choose(file){selected=file||null;result.style.display="none";bar.style.width="0";if(!file){fileName.textContent="Drop a file here or choose a file";fileMeta.textContent="One file per link";upload.disabled=true;return}fileName.textContent=file.name;fileMeta.textContent=formatBytes(file.size)+(file.type?" · "+file.type:"");upload.disabled=file.size>MAX;status.textContent=file.size>MAX?"This file is larger than the 95 MiB limit.":""}
function formatBytes(n){if(n<1024)return n+" B";if(n<1024*1024)return(n/1024).toFixed(1)+" KiB";return(n/1024/1024).toFixed(1)+" MiB"}
function openPicker(){fileInput.click()}drop.addEventListener("click",openPicker);drop.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openPicker()}});fileInput.addEventListener("change",()=>choose(fileInput.files[0]));for(const type of["dragenter","dragover"]){drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("drag")})}for(const type of["dragleave","drop"]){drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("drag")})}drop.addEventListener("drop",e=>choose(e.dataTransfer.files[0]));
upload.addEventListener("click",()=>{if(!selected||selected.size>MAX)return;upload.disabled=true;status.textContent="Uploading…";bar.style.width="0";const url=new URL("/api/share",location.origin);url.searchParams.set("ttl",ttl.value);url.searchParams.set("name",selected.name);const xhr=new XMLHttpRequest();xhr.open("PUT",url);xhr.setRequestHeader("Content-Type",selected.type||"application/octet-stream");xhr.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=Math.round(e.loaded/e.total*100)+"%"};xhr.onload=()=>{upload.disabled=false;if(xhr.status<200||xhr.status>=300){status.textContent=xhr.responseText.trim()||"Upload failed.";return}const data=JSON.parse(xhr.responseText);bar.style.width="100%";status.textContent="Uploaded.";link.value=data.url;markdown.value=data.markdown;expiry.textContent="Expires "+new Date(data.expiresAt).toLocaleString();result.style.display="block"};xhr.onerror=()=>{upload.disabled=false;status.textContent="Upload failed."};xhr.send(selected)});
for(const button of document.querySelectorAll("[data-copy]")){button.addEventListener("click",async()=>{const target=document.getElementById(button.dataset.copy);await navigator.clipboard.writeText(target.value);const old=button.textContent;button.textContent="Copied";setTimeout(()=>button.textContent=old,1200)})}
</script></body></html>`}

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

function renderPage(note,text,viewMode="edit",shareHost=DEFAULT_NOTE_HOST){
  const safeNote=escapeHtml(note),safeText=escapeHtml(text),safeShareHost=escapeHtml(shareHost),editPressed=viewMode==="edit",splitPressed=viewMode==="split",previewPressed=viewMode==="preview";
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><title>${safeNote}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{color-scheme:light dark;--app-height:100dvh;--page-gap:20px}*{box-sizing:border-box}html,body{width:100%;height:100%;min-height:100%;overflow:hidden;-webkit-text-size-adjust:100%}body{position:relative;height:var(--app-height,100dvh);margin:0;background:#ebeef1;overscroll-behavior:none}.container{position:absolute;top:max(var(--page-gap),env(safe-area-inset-top,0px));right:max(var(--page-gap),env(safe-area-inset-right,0px));bottom:max(var(--page-gap),env(safe-area-inset-bottom,0px));left:max(var(--page-gap),env(safe-area-inset-left,0px));display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}.toolbar{display:flex;flex:0 0 auto;justify-content:flex-end;gap:6px;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.toolbar::-webkit-scrollbar{display:none}.view-button,.share-link{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:6px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:#5b6472;font:12px/1.2 system-ui;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.share-link{text-decoration:none}.view-button[aria-pressed="true"]{border-color:#cfd5dc;background:#fff;color:#1f2937}.workspace{display:grid;flex:1;width:100%;min-width:0;min-height:0;overflow:hidden}.workspace[data-mode="edit"] #preview,.workspace[data-mode="preview"] #content{display:none}.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}#content,#preview{width:100%;max-width:100%;height:100%;min-width:0;min-height:0;margin:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;border:1px solid #ddd;background:#fff;color:#111827}#content{padding:20px;resize:none;outline:none;font:16px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview{padding:20px 28px 40px;font:16px/1.65 system-ui;overflow-wrap:anywhere}#preview:empty:before{content:"Nothing to preview";color:#9ca3af}#preview>:first-child{margin-top:0}#preview>:last-child{margin-bottom:0}#preview h1,#preview h2,#preview h3{line-height:1.25}#preview h1{font-size:2em}#preview h2{font-size:1.55em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}#preview h3{font-size:1.25em}#preview p,#preview ul,#preview ol,#preview blockquote,#preview pre{margin:0 0 1em}#preview li>ul,#preview li>ol{margin:.25em 0 0;padding-left:1.4em}#preview blockquote{padding-left:1em;border-left:3px solid #cbd5e1;color:#5b6472}#preview code{padding:.12em .35em;border-radius:4px;background:#f1f5f9;font:0.92em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}#preview pre{padding:14px 16px;overflow:auto;border-radius:6px;background:#f1f5f9}#preview pre code{padding:0;background:transparent}#preview hr{border:0;border-top:1px solid #d1d5db;margin:1.5em 0}#preview a{color:#2563eb}#printable{display:none}@media(pointer:coarse){.view-button,.share-link{min-height:44px}}@media(max-width:760px){:root{--page-gap:8px}.container{gap:8px}.toolbar{justify-content:stretch;gap:6px}.view-button,.share-link{flex:1 1 0;min-width:0;min-height:44px;padding:8px;font-size:13px}.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:8px}#content{padding:14px 12px 18px;font-size:16px;line-height:1.55}#preview{padding:14px 14px 24px;font-size:15px;line-height:1.6}#preview h1{font-size:1.65em}#preview h2{font-size:1.35em}#preview h3{font-size:1.15em}#preview ul,#preview ol{padding-left:1.35em}#preview li>ul,#preview li>ol{padding-left:1.2em}#preview pre{padding:12px}}@media(max-width:760px) and (orientation:landscape) and (min-width:640px){.workspace[data-mode="split"]{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr)}}@media(max-height:520px) and (orientation:landscape){:root{--page-gap:6px}.container{gap:6px}.view-button,.share-link{min-height:36px;padding-block:5px}}@media(prefers-color-scheme:dark){body{background:#333b4d}.view-button,.share-link{color:#b9c1cd}.view-button[aria-pressed="true"]{border-color:#596274;background:#24262b;color:#fff}#content,#preview{border-color:#495265;background:#24262b;color:#fff}#preview h2{border-bottom-color:#495265}#preview blockquote{border-left-color:#64748b;color:#cbd5e1}#preview code,#preview pre{background:#17191d}#preview pre code{background:transparent}#preview hr{border-top-color:#495265}#preview a{color:#93c5fd}}@media print{.container{display:none}#printable{display:block;white-space:pre-wrap;word-break:break-word}}
</style></head><body><div class="container"><div class="toolbar" role="toolbar" aria-label="Note actions"><a class="share-link" href="https://${safeShareHost}/share" target="_blank" rel="noopener">Share</a><button class="view-button" data-mode-button="edit" aria-pressed="${editPressed}">Edit</button><button class="view-button" data-mode-button="split" aria-pressed="${splitPressed}">Split</button><button class="view-button" data-mode-button="preview" aria-pressed="${previewPressed}">Preview</button></div><div class="workspace" data-mode="${viewMode}"><textarea id="content" spellcheck="false" aria-label="Note editor">${safeText}</textarea><article id="preview" aria-label="Markdown preview"></article></div></div><pre id="printable">${safeText}</pre><script>
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
