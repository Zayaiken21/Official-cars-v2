const express=require("express");
const cors=require("cors");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const cheerio=require("cheerio");

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:"50mb"}));

const PORT=Number(process.env.PORT||10000);
const ADMIN_SECRET=process.env.ADMIN_SECRET||"";
const DB=path.join(__dirname,"data.json");
const SOURCE="https://www.carstraderny.com/";
const INVENTORY="https://www.carstraderny.com/cars-for-sale";
const ALLOWED_HOST="www.carstraderny.com";
const UA="Official-Cars-Inventory-Sync/4.0 (+authorized dealer inventory referral platform)";
let syncState={running:false,startedAt:null,finishedAt:null,found:0,imported:0,errors:[],log:[]};

function read(){return JSON.parse(fs.readFileSync(DB,"utf8"))}
function write(d){fs.writeFileSync(DB,JSON.stringify(d,null,2))}
function clean(s=""){return String(s).replace(/\s+/g," ").trim()}
function abs(base,href){try{return new URL(href,base).href}catch{return ""}}
function money(s){let m=clean(s).match(/\$\s*([\d,]+(?:\.\d{2})?)/);return m?Number(m[1].replace(/,/g,"")):null}
function number(s){let m=clean(s).replace(/,/g,"").match(/\b(\d{2,7})\b/);return m?Number(m[1]):null}
function token(){return crypto.createHash("sha256").update(ADMIN_SECRET).digest("hex")}
function auth(req,res,next){
  if(!ADMIN_SECRET)return res.status(503).json({error:"Set ADMIN_SECRET in Render Environment Variables first."});
  if(req.headers.authorization?.replace(/^Bearer\s+/,"")!==token())return res.status(401).json({error:"Unauthorized"});
  next()
}
function allowed(url){try{let u=new URL(url);return u.protocol==="https:"&&u.hostname===ALLOWED_HOST}catch{return false}}
async function fetchText(url){
  if(!allowed(url)) throw new Error("Blocked source URL: "+url);
  let r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},redirect:"follow"});
  if(!r.ok)throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text()
}
function addLog(s){syncState.log.push(new Date().toISOString()+"  "+s); if(syncState.log.length>300)syncState.log.shift()}

function imageCandidates($,base){
  const out=[];
  const add=u=>{u=abs(base,String(u||"").trim()); if(!u||!allowed(u))return; if(/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(u)||/images|image|photo|vehicle/i.test(u)) if(!out.includes(u))out.push(u)}
  $('meta[property="og:image"],meta[name="twitter:image"]').each((_,e)=>add($(e).attr("content")));
  $('img').each((_,e)=>{add($(e).attr("src"));add($(e).attr("data-src"));add($(e).attr("data-lazy-src"));add($(e).attr("data-original"));});
  $('[srcset],[data-srcset]').each((_,e)=>{
    String($(e).attr("srcset")||$(e).attr("data-srcset")||"").split(",").forEach(x=>add(x.trim().split(/\s+/)[0]))
  });
  $('script[type="application/ld+json"]').each((_,e)=>{
    try{
      let j=JSON.parse($(e).text().trim()); let arr=[];
      const walk=o=>{if(!o)return;if(Array.isArray(o))return o.forEach(walk);if(typeof o!=="object")return;
        if(o.image)arr.push(...(Array.isArray(o.image)?o.image:[o.image])); Object.values(o).forEach(v=>{if(typeof v==="object")walk(v)})
      }; walk(j); arr.forEach(x=>add(typeof x==="string"?x:x?.url));
    }catch{}
  });
  return out.slice(0,40)
}

function fieldFromText(text,label,nextLabels=[]){
  let s=clean(text), esc=label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  let m=s.match(new RegExp(esc+"\\s*:?\\s*(.*?)(?=\\s+(?:"+nextLabels.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")+")\\b|$)","i"));
  return m?clean(m[1]):""
}
function parseDetail(url,html){
  const $=cheerio.load(html); const text=clean($("body").text());
  let title=clean($("h1").first().text()||$("meta[property='og:title']").attr("content")||"");
  let jsonlds=[];
  $('script[type="application/ld+json"]').each((_,e)=>{try{jsonlds.push(JSON.parse($(e).text()))}catch{}});
  let product={}; const walk=o=>{if(!o||typeof o!=="object")return;if(Array.isArray(o))return o.forEach(walk);if(o["@type"]==="Vehicle"||o["@type"]==="Product")product={...product,...o};Object.values(o).forEach(v=>{if(typeof v==="object")walk(v)})};jsonlds.forEach(walk);

  let price=product.offers?.price??money(text);
  let mileage=product.mileageFromOdometer?.value??null; if(!mileage){let m=text.match(/Mileage\s+([\d,]+)/i);mileage=m?Number(m[1].replace(/,/g,"")):null}
  let year=null,make="",model="";
  let tm=title.match(/\b(19\d{2}|20\d{2})\s+(.+)/); if(tm){year=Number(tm[1]); let parts=tm[2].split(/\s+/);make=parts.shift()||"";model=parts.join(" ")}
  if(product.vehicleConfiguration)model=clean(product.vehicleConfiguration);
  const labels=["Mileage","Engine","Transmission","Drivetrain","Fuel Economy","Exterior","Interior","VIN","Stock","Price"];
  let engine=fieldFromText(text,"Engine",labels.filter(x=>x!=="Engine"));
  let transmission=fieldFromText(text,"Transmission",labels.filter(x=>x!=="Transmission"));
  let drivetrain=fieldFromText(text,"Drivetrain",labels.filter(x=>x!=="Drivetrain"));
  let fuelEconomy=fieldFromText(text,"Fuel Economy",labels.filter(x=>x!=="Fuel Economy"));
  let vin=fieldFromText(text,"VIN",labels.filter(x=>x!=="VIN"));
  let stock=fieldFromText(text,"Stock #",labels.filter(x=>x!=="Stock #"));
  let description=clean($("meta[name='description']").attr("content")||$(".vehicle-description,.description").first().text()||"");
  let features=[];
  $(".features li,.feature-list li,[class*='feature'] li").each((_,e)=>{let x=clean($(e).text());if(x&&x.length<180&&!features.includes(x))features.push(x)});
  const images=imageCandidates($,url);
  return {
    id:"ctny-"+crypto.createHash("sha1").update(url).digest("hex").slice(0,12),
    dealerId:"cars-trader-ny", year, make, model, title, price:Number(price)||null, mileage:Number(mileage)||null,
    engine, transmission, drivetrain, fuelEconomy, vin, stock, description, features:features.slice(0,80),
    images, sourceUrl:url, source:"Cars Trader New York", syncedAt:new Date().toISOString()
  }
}

async function discoverUrls(){
  const pages=new Set([INVENTORY]);
  const sitemapCandidates=[
    "https://www.carstraderny.com/sitemap.xml",
    "https://www.carstraderny.com/sitemap_index.xml",
    "https://www.carstraderny.com/robots.txt"
  ];
  for(const u of sitemapCandidates){
    try{
      let t=await fetchText(u);
      let locs=[...t.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(m=>m[1].trim());
      if(u.endsWith("robots.txt")){
        locs=[...t.matchAll(/Sitemap:\s*(https?:\/\/\S+)/gi)].map(m=>m[1].trim());
        for(const sm of locs){try{let st=await fetchText(sm);[...st.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].forEach(m=>locs.push(m[1].trim()))}catch{}}
      }
      for(const x of locs)if(allowed(x)&&(/cars-for-sale|details\//i.test(x)))pages.add(x);
      addLog("Read source map/robots: "+u);
    }catch(e){addLog("Map unavailable: "+u)}
  }
  // Crawl inventory + pagination links. This handles query/page variants used by the dealer site.
  const queue=[INVENTORY]; const seen=new Set();
  while(queue.length&&seen.size<25){
    const u=queue.shift(); if(seen.has(u)||!allowed(u))continue; seen.add(u);
    try{
      const h=await fetchText(u),$=cheerio.load(h);
      $("a[href]").each((_,e)=>{
        const x=abs(u,$(e).attr("href"));
        if(!allowed(x))return;
        if(/\/details\//i.test(x))pages.add(x);
        if(/cars-for-sale/i.test(x)&&(/page|p=|page=|\/2|\/3/i.test(x)))queue.push(x);
      });
      // common pagination data attributes / rel=next
      $("link[rel=next],a[rel=next]").each((_,e)=>{let x=abs(u,$(e).attr("href"));if(x)queue.push(x)});
    }catch(e){addLog("Inventory page failed: "+u)}
  }
  return [...pages]
}

async function doSync(){
  syncState={running:true,startedAt:new Date().toISOString(),finishedAt:null,found:0,imported:0,errors:[],log:[]};
  addLog("Starting authorized Cars Trader NY inventory sync.");
  let urls=await discoverUrls();
  let details=urls.filter(u=>/\/details\//i.test(u));
  addLog("Discovered "+details.length+" individual vehicle links.");
  const db=read(); const old=new Map((db.vehicles||[]).map(v=>[v.sourceUrl,v]));
  for(let i=0;i<details.length;i++){
    const u=details[i]; syncState.found=details.length;
    try{
      const h=await fetchText(u); const v=parseDetail(u,h);
      if(v.images.length===0)addLog("Warning: no images extracted: "+u);
      old.set(u,v); syncState.imported++;
    }catch(e){syncState.errors.push(u+" — "+e.message)}
    if(i%3===0)await new Promise(r=>setTimeout(r,80));
  }
  db.vehicles=[...old.values()].filter(v=>v.dealerId==="cars-trader-ny");
  db.sourceMeta={...(db.sourceMeta||{}),lastSyncedAt:new Date().toISOString(),discovered:details.length,imported:syncState.imported,errors:syncState.errors.length,syncVersion:"4.0"};
  write(db); syncState.running=false;syncState.finishedAt=new Date().toISOString();
  addLog("Sync complete. "+syncState.imported+" vehicles imported/updated.");
  return db;
}

app.get("/",(req,res)=>res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Official Cars API</title><style>body{margin:0;background:#06101d;color:#dff6ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:40px;text-align:center;border:1px solid #1c496d;border-radius:24px;background:linear-gradient(145deg,#0b1e33,#07111f);box-shadow:0 30px 80px #0008}b{color:#61c7ff}</style></head><body><main><div style="font-size:42px">⚡</div><h1>Official Cars API</h1><p><b>Online</b> · inventory/referral backend</p><p><a style="color:#61c7ff" href="/health">Health check</a> · <a style="color:#61c7ff" href="/admin">Admin</a></p></main></body></html>`));
app.get("/health",(req,res)=>res.json({ok:true,service:"official-cars-api",sync:syncState}));
app.get("/api/public",(req,res)=>{const d=read();res.json({dealers:d.dealers||[],vehicles:d.vehicles||[],sourceMeta:d.sourceMeta||{}})});
app.get("/api/sync-status",auth,(req,res)=>res.json(syncState));
app.post("/api/admin/sync",auth,async(req,res)=>{
  if(syncState.running)return res.status(409).json({error:"A sync is already running",status:syncState});
  doSync().catch(e=>{syncState.running=false;syncState.errors.push(e.message);addLog("FATAL: "+e.message)});
  res.json({ok:true,message:"Sync started",status:syncState});
});
app.post("/api/admin/save",auth,(req,res)=>{if(!req.body||!Array.isArray(req.body.vehicles))return res.status(400).json({error:"Invalid data"});write(req.body);res.json({ok:true})});
app.get("/api/admin/export",auth,(req,res)=>{res.setHeader("Content-Disposition","attachment; filename=official-cars-data.json");res.json(read())});
app.post("/api/admin/login",(req,res)=>{if(!ADMIN_SECRET||req.body?.password!==ADMIN_SECRET)return res.status(401).json({error:"Invalid password"});res.json({token:token()})});
app.get("/api/image",(req,res)=>{
  const u=String(req.query.url||""); if(!allowed(u))return res.status(400).end();
  fetch(u,{headers:{"User-Agent":UA,"Referer":SOURCE}}).then(async r=>{
    if(!r.ok)return res.status(r.status).end();
    res.setHeader("Content-Type",r.headers.get("content-type")||"image/jpeg");
    res.setHeader("Cache-Control","public,max-age=86400");
    res.setHeader("Access-Control-Allow-Origin","*");
    res.send(Buffer.from(await r.arrayBuffer()));
  }).catch(()=>res.status(502).end());
});
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.listen(PORT,"0.0.0.0",()=>console.log("Official Cars API listening on "+PORT));
