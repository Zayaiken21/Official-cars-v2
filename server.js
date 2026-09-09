const express=require("express");
const cors=require("cors");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const cheerio=require("cheerio");
const zlib=require("zlib");
const dns=require("dns").promises;

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:"50mb"}));
const PORT=Number(process.env.PORT||10000), DB=path.join(__dirname,"data.json");
const ADMIN_SECRET=process.env.ADMIN_SECRET||"";
const ANALYTICS_SALT=process.env.ANALYTICS_SALT||crypto.randomBytes(16).toString("hex");
const UA="Official-Cars-Authorized-Dealer-Sync/7.0";
let syncState={running:false,startedAt:null,finishedAt:null,found:0,imported:0,errors:[],log:[]};

function read(){return JSON.parse(fs.readFileSync(DB,"utf8"))}
function write(d){fs.writeFileSync(DB,JSON.stringify(d,null,2))}
function ensure(d){
  d.dealers ||= []; d.vehicles ||= []; d.analytics ||= {events:[]}; d.analytics.events ||= [];
  // Migrate legacy vehicle records that used `url` instead of `sourceUrl`.
  let changed=false;
  for(const v of d.vehicles){
    if(!v.sourceUrl && v.url){v.sourceUrl=v.url; changed=true}
    if(!v.url && v.sourceUrl){v.url=v.sourceUrl; changed=true}
    if(!v.sourceUrl && v.dealerUrl){v.sourceUrl=v.dealerUrl; changed=true}
  }
  if(changed){try{fs.writeFileSync(DB,JSON.stringify(d,null,2))}catch{}}
  return d
}
function clean(s=""){return String(s).replace(/\s+/g," ").trim()}
function abs(base,href){try{return new URL(href,base).href}catch{return ""}}
function money(s){let m=clean(s).match(/\$\s*([\d,]+(?:\.\d{2})?)/);return m?Number(m[1].replace(/,/g,"")):null}
function hash(s){return crypto.createHash("sha256").update(String(s)+ANALYTICS_SALT).digest("hex").slice(0,16)}
function token(){return crypto.createHash("sha256").update(ADMIN_SECRET).digest("hex")}
function auth(req,res,next){if(!ADMIN_SECRET)return res.status(503).json({error:"Set ADMIN_SECRET in Render Environment Variables first."});if(req.headers.authorization?.replace(/^Bearer\s+/i,"")!==token())return res.status(401).json({error:"Unauthorized"});next()}
function originOf(u){try{return new URL(u).origin}catch{return ""}}
function hostOf(u){try{return new URL(u).hostname.toLowerCase()}catch{return ""}}
function hostAllowed(u,domains){let h=hostOf(u);return !!h && domains.some(x=>h===x||h.endsWith("."+x))}
function safeHost(host){return /^[a-z0-9.-]+$/i.test(host)&&!host.includes("..")}
async function isPublicHost(host){
  if(!safeHost(host))return false;
  try{let a=await dns.lookup(host,{all:true});return a.length>0&&a.every(x=>!/^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^fc|^fd/i.test(x.address))}
  catch{return false}
}
function dealerDomains(d){return [hostOf(d.website),...(d.allowedDomains||[])].filter(Boolean)}
async function fetchText(url,domains,referer){
  if(!/^https:\/\//i.test(url)||!hostAllowed(url,domains))throw new Error("URL not allowed for this dealer");
  let r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"text/html,application/xml,text/xml,application/json,*/*;q=.7",...(referer?{Referer:referer}:{})},redirect:"follow"});
  if(!r.ok)throw new Error(`HTTP ${r.status} ${url}`);
  let b=Buffer.from(await r.arrayBuffer()),enc=(r.headers.get("content-encoding")||"").toLowerCase();
  try{if(enc.includes("gzip"))b=zlib.gunzipSync(b);else if(enc.includes("deflate"))b=zlib.inflateSync(b)}catch{}
  return b.toString("utf8")
}
function log(s){syncState.log.push(new Date().toISOString()+"  "+s);if(syncState.log.length>800)syncState.log.shift()}
function parseJsonLd($){
  let out=[];
  $('script[type="application/ld+json"]').each((_,e)=>{try{let j=JSON.parse($(e).text().trim());out.push(j)}catch{}});
  return out
}
function flatten(o,out=[]){if(!o)return out;if(Array.isArray(o)){o.forEach(x=>flatten(x,out));return out}if(typeof o==="object"){out.push(o);Object.values(o).forEach(x=>{if(typeof x==="object")flatten(x,out)})}return out}
function firstType(nodes,types){return nodes.find(x=>types.includes(String(x["@type"]||"").toLowerCase())||String(x["@type"]||"").toLowerCase().split("/").some(t=>types.includes(t)))}
function businessInfo(url,html){
  const $=cheerio.load(html), nodes=flatten(parseJsonLd($));
  const b=firstType(nodes,["organization","localbusiness","automotivedealer","auto dealer","store"]);
  const name=clean(b?.name||$('meta[property="og:site_name"]').attr("content")||$('meta[name="application-name"]').attr("content")||$("title").first().text().replace(/\s*[|•-].*$/,""));
  const address=b?.address||{}; const addr=typeof address==="string"?address:[address.streetAddress,address.addressLocality,address.addressRegion,address.postalCode,address.addressCountry].filter(Boolean).join(", ");
  let logo=typeof b?.logo==="string"?b.logo:b?.logo?.url||$('meta[property="og:image"]').attr("content")||$("img").first().attr("src")||"";
  let phone=b?.telephone||$('a[href^="tel:"]').first().attr("href")?.replace(/^tel:/i,"")||"";
  let website=b?.url||url;
  let social=[]; if(Array.isArray(b?.sameAs))social=b.sameAs.filter(x=>/^https?:\/\//.test(x));
  return {name:clean(name),address:clean(addr),phone:clean(phone),website:abs(url,website)||url,logo:abs(url,logo),social};
}
function imageCandidates($,base,domains){
  let out=[],add=u=>{u=abs(base,String(u||"").trim());if(!u||!hostAllowed(u,domains))return;if(/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(u)||/image|photo|vehicle|media|inventory/i.test(u))if(!out.includes(u))out.push(u)};
  $('meta[property="og:image"],meta[name="twitter:image"]').each((_,e)=>add($(e).attr("content")));
  $("img").each((_,e)=>["src","data-src","data-lazy-src","data-original","data-image"].forEach(k=>add($(e).attr(k))));
  $("[srcset],[data-srcset]").each((_,e)=>String($(e).attr("srcset")||$(e).attr("data-srcset")||"").split(",").forEach(x=>add(x.trim().split(/\s+/)[0])));
  parseJsonLd($).forEach(j=>flatten(j).forEach(o=>{let im=o.image;if(im)(Array.isArray(im)?im:[im]).forEach(x=>add(typeof x==="string"?x:x?.url))}));
  return out.slice(0,80)
}
function valueAfter(text,label,next){let s=clean(text),i=s.toLowerCase().indexOf(label.toLowerCase());if(i<0)return"";let rest=s.slice(i+label.length).replace(/^\s*:?\s*/,""),end=rest.length;for(const n of next){let j=rest.toLowerCase().indexOf(n.toLowerCase());if(j>=0)end=Math.min(end,j)}return clean(rest.slice(0,end))}
function parseVehicle(url,html,dealer){
  const $=cheerio.load(html),text=clean($("body").text()),nodes=flatten(parseJsonLd($));
  const prod=firstType(nodes,["vehicle","product"])||{};
  let title=clean($("h1").first().text()||$('meta[property="og:title"]').attr("content")||prod.name||"");
  let year=prod.vehicleModelDate?Number(String(prod.vehicleModelDate).slice(0,4)):null,make=clean(prod.brand?.name||prod.manufacturer||""),model=clean(prod.model||"");
  let tm=title.match(/\b(19\d{2}|20\d{2})\s+([A-Za-z][\w-]*)\s+(.+)/);if(tm){year=year||Number(tm[1]);make=make||tm[2];model=model||tm[3]}
  let price=prod.offers?.price??money(text), mileage=prod.mileageFromOdometer?.value??null;
  if(!mileage){let m=text.match(/Mileage\s*:?\s*([\d,]+)/i);mileage=m?Number(m[1].replace(/,/g,"")):null}
  const labels=["Mileage","Engine","Transmission","Drivetrain","Fuel Economy","Exterior","Interior","VIN","Stock #","Stock","Price"];
  let description=clean(prod.description||$('meta[name="description"]').attr("content")||$(".vehicle-description,.description,[class*='description']").first().text());
  let features=[];$(".features li,.feature-list li,[class*='feature'] li").each((_,e)=>{let x=clean($(e).text());if(x&&x.length<200&&!features.includes(x))features.push(x)});
  return {id:crypto.createHash("sha1").update(url).digest("hex").slice(0,16),dealerId:dealer.id,title,year,make,model,
    bodyStyle:clean(prod.bodyType||valueAfter(text,"Body Style",labels)),price:Number(price)||null,mileage:Number(mileage)||null,
    engine:clean(prod.vehicleEngine?.name||valueAfter(text,"Engine",labels)),transmission:clean(valueAfter(text,"Transmission",labels)),
    drivetrain:clean(prod.driveWheelConfiguration||valueAfter(text,"Drivetrain",labels)),fuel:clean(prod.fuelType||""),
    fuelEconomy:clean(valueAfter(text,"Fuel Economy",labels)),vin:clean(prod.vehicleIdentificationNumber||valueAfter(text,"VIN",labels)),
    stock:clean(valueAfter(text,"Stock #",labels)||valueAfter(text,"Stock",labels)),description,features:features.slice(0,100),
    images:imageCandidates($,url,dealerDomains(dealer)),sourceUrl:url,source:dealer.name,status:"active",syncedAt:new Date().toISOString()}
}
async function discoverSitemaps(home,domains){
  let maps=[],seen=new Set(),queue=[new URL("/robots.txt",home).href,new URL("/sitemap.xml",home).href,new URL("/sitemap_index.xml",home).href];
  while(queue.length&&seen.size<30){let u=queue.shift();if(seen.has(u)||!hostAllowed(u,domains))continue;seen.add(u);try{let x=await fetchText(u,domains,home);if(u.endsWith("/robots.txt")){for(const m of x.matchAll(/^\s*Sitemap:\s*(\S+)/gim))queue.push(abs(u,m[1]))}else{let $=cheerio.load(x,{xmlMode:true});$("loc").each((_,e)=>{let v=abs(u,clean($(e).text()));if(hostAllowed(v,domains)&&/sitemap/i.test(v))queue.push(v)});maps.push(u)}}catch{}}
  return maps
}
async function discoverVehicleUrls(dealer){
  const domains=dealerDomains(dealer),home=dealer.website,urls=new Set(),maps=await discoverSitemaps(home,domains);
  for(const m of maps){try{let x=await fetchText(m,domains,home),$=cheerio.load(x,{xmlMode:true});$("loc").each((_,e)=>{let u=abs(m,clean($(e).text()));if(hostAllowed(u,domains)&&(/\/details\//i.test(u)||/vehicle|inventory|cars-for-sale|used-cars|new-cars/i.test(u)))urls.add(u)})}catch{}}
  let queue=[home],seen=new Set();for(let pass=0;queue.length&&pass<80;pass++){let u=queue.shift();if(seen.has(u)||!hostAllowed(u,domains))continue;seen.add(u);try{let h=await fetchText(u,domains,home),$=cheerio.load(h);$("a[href]").each((_,e)=>{let v=abs(u,$(e).attr("href"));if(!hostAllowed(v,domains))return;if(/\/details\//i.test(v)||/\/vehicle[-_/]|\/inventory\/|\/used[-_]cars|\/cars[-_]for[-_]sale/i.test(v))urls.add(v);if(/page=|\/page\/|p=\d+|inventory|cars-for-sale|used-cars/i.test(v)&&queue.length<100)queue.push(v)})}catch{}}
  // Prefer URLs that look like actual listings; cap protects a dealer site from runaway crawling.
  return [...urls].filter(u=>!/\.(xml|pdf|jpg|jpeg|png|webp|css|js)(\?|$)/i.test(u)).slice(0,1000)
}
async function syncDealer(dealer){
  const urls=await discoverVehicleUrls(dealer);log(`${dealer.name}: discovered ${urls.length} candidate listing URLs.`);
  let d=ensure(read()),old=new Map((d.vehicles||[]).filter(v=>v.dealerId===dealer.id).map(v=>[v.sourceUrl,v]));
  let ok=0;
  for(let i=0;i<urls.length;i++){try{let h=await fetchText(urls[i],dealerDomains(dealer),dealer.website),v=parseVehicle(urls[i],h,dealer);
      // Don't import arbitrary category pages as vehicles unless they look like a vehicle detail.
      if(!v.title || (!v.price&&!v.vin&&!v.stock&&v.images.length<2))continue;
      old.set(urls[i],v);ok++;
    }catch(e){syncState.errors.push(`${dealer.name}: ${urls[i]} — ${e.message}`)}
    if(i%8===0)await new Promise(r=>setTimeout(r,80))
  }
  d.vehicles=(d.vehicles||[]).filter(v=>v.dealerId!==dealer.id).concat([...old.values()]);
  dealer.lastSyncedAt=new Date().toISOString();dealer.lastSyncCount=ok;dealer.syncErrors=syncState.errors.filter(x=>x.startsWith(dealer.name+":")).length;
  d.dealers=d.dealers.map(x=>x.id===dealer.id?dealer:x);d.sourceMeta={...(d.sourceMeta||{}),lastSyncedAt:new Date().toISOString()};
  write(d);return ok
}
async function syncAll(){
  syncState={running:true,startedAt:new Date().toISOString(),finishedAt:null,found:0,imported:0,errors:[],log:[]};
  try{let d=ensure(read());for(const dealer of d.dealers.filter(x=>x.enabled!==false)){let n=await syncDealer(dealer);syncState.imported+=n;syncState.found+=dealer.lastSyncCount||0}
  }catch(e){syncState.errors.push(e.message);log("FATAL "+e.message)}
  syncState.running=false;syncState.finishedAt=new Date().toISOString();log(`All dealer syncs complete · ${syncState.imported} records updated.`)
}
function event(req,b){try{let d=ensure(read()),type=String(b.type||"").slice(0,40);if(!["page_view","vehicle_view","outbound_click","search","filter"].includes(type))return;d.analytics.events.push({ts:new Date().toISOString(),type,vehicleId:String(b.vehicleId||"").slice(0,80),dealerId:String(b.dealerId||"").slice(0,80),page:String(b.page||"").slice(0,120),filter:String(b.filter||"").slice(0,500),session:hash(b.sessionId||crypto.randomUUID()),referrer:String(b.referrer||"").slice(0,250)});if(d.analytics.events.length>100000)d.analytics.events=d.analytics.events.slice(-100000);write(d)}catch{}}
function startDate(q){let now=new Date(),d=new Date(now);if(q==="day")d.setHours(0,0,0,0);else if(q==="week"){d.setHours(0,0,0,0);d.setDate(d.getDate()-d.getDay())}else if(q==="month"){d.setHours(0,0,0,0);d.setDate(1)}else if(q==="year"){d.setHours(0,0,0,0);d.setMonth(0,1)}else d=new Date(0);return d}
function analytics(q){let d=ensure(read()),ev=d.analytics.events.filter(e=>new Date(e.ts)>=startDate(q.range||"month")&&new Date(e.ts)<=new Date());if(q.dealerId)ev=ev.filter(e=>e.dealerId===q.dealerId);if(q.vehicleId)ev=ev.filter(e=>e.vehicleId===q.vehicleId);let views=ev.filter(e=>e.type==="vehicle_view"),clicks=ev.filter(e=>e.type==="outbound_click"),pages=ev.filter(e=>e.type==="page_view"),m={};[...views,...clicks].forEach(e=>{if(e.vehicleId)m[e.vehicleId]=(m[e.vehicleId]||0)+(e.type==="outbound_click"?3:1)});let vm=new Map(d.vehicles.map(v=>[v.id,v]));return {totalEvents:ev.length,pageViews:pages.length,vehicleViews:views.length,outboundClicks:clicks.length,uniqueSessions:new Set(ev.map(e=>e.session)).size,hotVehicles:Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,100).map(([id,score])=>{let v=vm.get(id)||{};return{id,title:v.title||"",dealerId:v.dealerId||"",views:views.filter(e=>e.vehicleId===id).length,clicks:clicks.filter(e=>e.vehicleId===id).length,score,price:v.price,sourceUrl:v.sourceUrl||""}})}}
function csv(x){x=String(x??"");return /[",\n]/.test(x)?`"${x.replace(/"/g,'""')}"`:x}

app.get("/",(req,res)=>res.send(`<html><head><meta name="viewport" content="width=device-width"><title>Official Cars API</title><style>body{margin:0;background:#06101d;color:#dff6ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:42px;text-align:center;border:1px solid #2b8cff66;border-radius:26px;background:linear-gradient(145deg,#102a44,#07111e);box-shadow:0 30px 100px #0008}a{color:#72d8ff}</style></head><body><main><div style="font-size:44px">⚡</div><h1>Official Cars API</h1><p>Online · dealer sync · inventory · referral analytics</p><p><a href="/health">Health</a> · <a href="/admin">Control Center</a></p></main></body></html>`));
app.get("/health",(req,res)=>res.json({ok:true,service:"official-cars-api",version:"6.0",sync:syncState}));
function isLikelyListingUrl(u,dealer){
  try{
    const x=new URL(u), base=new URL(dealer.website);
    if(x.origin===base.origin && x.pathname.replace(/\/+$/,"")===(base.pathname.replace(/\/+$/,"")||"")) return false;
    if(/\/(cars-for-sale|inventory|used-cars|new-cars|vehicles?|cars?)\/?$/i.test(x.pathname)) return false;
    return /vehicle|inventory|details?|used|stock|vin|cars-for-sale|auto|listing|\d{4}/i.test(x.pathname+x.search);
  }catch{return false}
}
app.get("/api/public",(req,res)=>{let d=ensure(read());res.json({dealers:d.dealers,vehicles:d.vehicles,sourceMeta:d.sourceMeta||{}})});
app.post("/api/track",(req,res)=>{event(req,req.body||{});res.status(204).end()});
app.get("/go/:id",(req,res)=>{
  let d=ensure(read()),v=d.vehicles.find(x=>x.id===req.params.id),dealer=d.dealers.find(x=>x.id===v?.dealerId);
  const target=v?.sourceUrl||v?.url||"";
  if(!v||!dealer||!target||!hostAllowed(target,dealerDomains(dealer))||!isLikelyListingUrl(target,dealer))return res.status(404).send("Vehicle listing unavailable");
  event(req,{type:"outbound_click",vehicleId:v.id,dealerId:v.dealerId,page:"vehicle",sessionId:req.query.s||""});
  res.redirect(302,target);
});
app.get("/api/image",async(req,res)=>{let u=String(req.query.url||""),d=ensure(read()),dealer=d.dealers.find(x=>hostAllowed(u,dealerDomains(x)));if(!dealer)return res.status(400).end();try{let r=await fetch(u,{headers:{"User-Agent":UA,"Referer":dealer.website}});if(!r.ok)return res.status(r.status).end();let ct=r.headers.get("content-type")||"image/jpeg";if(!ct.startsWith("image/"))return res.status(415).end();res.setHeader("Content-Type",ct);res.setHeader("Cache-Control","public,max-age=86400");res.send(Buffer.from(await r.arrayBuffer()))}catch{res.status(502).end()}});
app.post("/api/admin/login",(req,res)=>{if(!ADMIN_SECRET||req.body?.password!==ADMIN_SECRET)return res.status(401).json({error:"Invalid password"});res.json({token:token()})});
app.get("/api/sync-status",auth,(req,res)=>res.json(syncState));
app.post("/api/admin/sync",auth,(req,res)=>{if(!syncState.running)syncAll();res.json({ok:true,status:syncState})});
app.get("/api/admin/analytics",auth,(req,res)=>res.json({range:req.query.range||"month",summary:analytics(req.query)}));
app.get("/api/admin/analytics.csv",auth,(req,res)=>{let d=ensure(read()),q=req.query,start=startDate(q.range||"month"),ev=d.analytics.events.filter(e=>new Date(e.ts)>=start&&new Date(e.ts)<=new Date());if(q.dealerId)ev=ev.filter(e=>e.dealerId===q.dealerId);if(q.vehicleId)ev=ev.filter(e=>e.vehicleId===q.vehicleId);let rows=["timestamp,event,vehicle_id,dealer_id,page,filter,session_hash,referrer"];ev.forEach(e=>rows.push([e.ts,e.type,e.vehicleId,e.dealerId,e.page,e.filter,e.session,e.referrer].map(csv).join(",")));res.setHeader("Content-Type","text/csv");res.setHeader("Content-Disposition","attachment; filename=official-cars-analytics.csv");res.send(rows.join("\n"))});
app.get("/api/admin/export",auth,(req,res)=>res.json(read()));
app.post("/api/admin/save",auth,(req,res)=>{if(!req.body||!Array.isArray(req.body.dealers)||!Array.isArray(req.body.vehicles))return res.status(400).json({error:"Invalid data"});write(ensure(req.body));res.json({ok:true})});
app.post("/api/admin/add-dealer",auth,async(req,res)=>{
  try{
    let raw=String(req.body?.url||"").trim();if(!/^https:\/\//i.test(raw))return res.status(400).json({error:"Enter the dealer's HTTPS website URL."});
    let u=new URL(raw);if(!(await isPublicHost(u.hostname)))return res.status(400).json({error:"That website host could not be verified as a public website."});
    u=new URL("/",u.origin);let website=u.href;let d=ensure(read()),domains=[u.hostname.toLowerCase()];let html=await fetchText(website,domains),info=businessInfo(website,html);
    let id=crypto.createHash("sha1").update(u.origin).digest("hex").slice(0,12),dealer={id:"dealer-"+id,name:info.name||u.hostname,address:info.address||"",phone:info.phone||"",website,logo:info.logo||"",social:info.social||[],allowedDomains:domains,enabled:true,createdAt:new Date().toISOString(),lastSyncedAt:null,lastSyncCount:0,syncErrors:0};
    let idx=d.dealers.findIndex(x=>x.id===dealer.id);if(idx>=0)d.dealers[idx]={...d.dealers[idx],...dealer};else d.dealers.push(dealer);write(d);
    res.json({ok:true,dealer});
  }catch(e){res.status(400).json({error:"Could not read that website: "+e.message})}
});
app.post("/api/admin/sync-dealer",auth,(req,res)=>{let d=ensure(read()),dealer=d.dealers.find(x=>x.id===req.body?.dealerId);if(!dealer)return res.status(404).json({error:"Dealer not found"});if(syncState.running)return res.status(409).json({error:"Another sync is already running"});syncState={running:true,startedAt:new Date().toISOString(),finishedAt:null,found:0,imported:0,errors:[],log:[]};syncDealer(dealer).then(n=>{syncState.imported=n;syncState.found=n;syncState.running=false;syncState.finishedAt=new Date().toISOString();log(`Dealer sync complete · ${n} vehicles.`)}).catch(e=>{syncState.errors.push(e.message);syncState.running=false;syncState.finishedAt=new Date().toISOString();log("FATAL "+e.message)});res.json({ok:true})});
app.delete("/api/admin/dealer/:id",auth,(req,res)=>{let d=ensure(read());d.dealers=d.dealers.filter(x=>x.id!==req.params.id);d.vehicles=d.vehicles.filter(x=>x.dealerId!==req.params.id);write(d);res.json({ok:true})});
app.get("/api/admin/source/:id",auth,(req,res)=>{
  const d=ensure(read()),v=d.vehicles.find(x=>x.id===req.params.id),dealer=d.dealers.find(x=>x.id===v?.dealerId),target=v?.sourceUrl||v?.url||"";
  if(!v||!dealer||!target||!hostAllowed(target,dealerDomains(dealer)))return res.status(404).json({error:"Source listing unavailable"});
  res.json({ok:true,url:target,dealer:{id:dealer.id,name:dealer.name,website:dealer.website}});
});
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.listen(PORT,"0.0.0.0",()=>console.log("Official Cars API v6 listening on "+PORT));
