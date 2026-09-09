const express=require("express");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const {URL}=require("url");

const app=express();
const PORT=process.env.PORT||3000;
const ROOT=__dirname;
const DATA=path.join(ROOT,"data.json");
const SESSION_SECRET=process.env.SESSION_SECRET||"change-me-in-production";
const SESSION_MS=8*60*60*1000;

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(ROOT));

function readData(){return JSON.parse(fs.readFileSync(DATA,"utf8"))}
function writeData(d){d.lastSynced=new Date().toISOString();fs.writeFileSync(DATA,JSON.stringify(d,null,2))}

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
  return {salt,hash:crypto.scryptSync(password,salt,64).toString("hex")}
}
function verifyPassword(password,stored){
  const h=crypto.scryptSync(password,stored.salt,64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h,"hex"),Buffer.from(stored.hash,"hex"));
}
function cookieSig(value){return crypto.createHmac("sha256",SESSION_SECRET).update(value).digest("hex")}
function setSession(res){
  const value=Date.now()+"."+crypto.randomBytes(18).toString("hex");
  res.setHeader("Set-Cookie",`oc_session=${value}.${cookieSig(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS/1000}`);
}
function authed(req,res,next){
  const c=req.headers.cookie||"", m=c.match(/(?:^|;\s*)oc_session=([^;]+)/);
  if(!m) return res.status(401).json({error:"Not authenticated"});
  const raw=m[1], i=raw.lastIndexOf(".");
  if(i<0) return res.status(401).json({error:"Not authenticated"});
  const value=raw.slice(0,i), sig=raw.slice(i+1);
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(cookieSig(value)))) return res.status(401).json({error:"Not authenticated"});
  const ts=Number(value.split(".")[0]);
  if(!ts || Date.now()-ts>SESSION_MS) return res.status(401).json({error:"Session expired"});
  next();
}

const authFile=path.join(ROOT,".admin-auth.json");
app.get("/api/setup-status",(req,res)=>res.json({configured:fs.existsSync(authFile)}));
app.post("/api/setup", (req,res)=>{
  if(fs.existsSync(authFile)) return res.status(409).json({error:"Admin password already configured"});
  const password=String(req.body.password||"");
  if(password.length<10) return res.status(400).json({error:"Use a password of at least 10 characters."});
  fs.writeFileSync(authFile,JSON.stringify(hashPassword(password),null,2),{mode:0o600});
  setSession(res); res.json({ok:true});
});
app.post("/api/login",(req,res)=>{
  if(!fs.existsSync(authFile)) return res.status(400).json({error:"Run setup first"});
  const password=String(req.body.password||"");
  if(!verifyPassword(password,JSON.parse(fs.readFileSync(authFile,"utf8")))) return res.status(401).json({error:"Incorrect password"});
  setSession(res);res.json({ok:true});
});
app.post("/api/logout",(req,res)=>{res.setHeader("Set-Cookie","oc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");res.json({ok:true})});
app.get("/api/inventory",(req,res)=>res.json(readData()));
app.get("/api/admin/data",authed,(req,res)=>res.json(readData()));
app.post("/api/admin/save",authed,(req,res)=>{
  if(!req.body || !Array.isArray(req.body.vehicles) || !Array.isArray(req.body.dealers)) return res.status(400).json({error:"Invalid inventory JSON"});
  const current=readData();
  const next={...req.body,version:2,source:current.source};
  writeData(next);res.json({ok:true,lastSynced:next.lastSynced,count:next.vehicles.length});
});

function absolute(base,href){try{return new URL(href,base).href}catch{return null}}
function clean(s){return (s||"").replace(/\s+/g," ").trim()}
function money(s){const m=String(s).replace(/,/g,"").match(/\$([0-9]+(?:\.[0-9]{2})?)/);return m?Number(m[1]):null}
function miles(s){const m=String(s).replace(/,/g,"").match(/([0-9]{2,6})\s*miles?/i);return m?Number(m[1]):null}
function parseTitle(s){
  const m=clean(s).match(/^((?:19|20)\d{2})\s+(.+)$/);return m?{year:Number(m[1]),title:m[2]}:{year:null,title:clean(s)}
}
function parseGeneric(html,sourceUrl){
  const cheerio=require("cheerio"); const $=cheerio.load(html); const out=[];
  const seen=new Set();
  $("a[href*='/details/'], a[href*='/vehicle/'], a[href*='/inventory/']").each((_,a)=>{
    const href=absolute(sourceUrl,$(a).attr("href")); if(!href||seen.has(href)) return;
    const card=$(a).closest("article,li,.vehicle,.vehicle-card,.inventory-item,.listing,.car").first();
    const text=clean(card.text()||$(a).parent().text()||$(a).text());
    const parsed=parseTitle(clean($(a).text())||text);
    const p=money(text), mi=miles(text);
    if(parsed.year && parsed.title.length>2){seen.add(href);out.push({title:`${parsed.year} ${parsed.title}`,year:parsed.year,price:p,mileage:mi,sourceUrl:href,raw:text.slice(0,1500)})}
  });
  // JSON-LD fallback
  $("script[type='application/ld+json']").each((_,el)=>{
    try{
      const j=JSON.parse($(el).contents().text()); const arr=Array.isArray(j)?j:(j["@graph"]||[j]);
      arr.forEach(x=>{if(x&&x["@type"]==="Vehicle"){
        const title=clean([x.vehicleModelDate,x.brand&&x.brand.name,x.model,x.name].filter(Boolean).join(" "));
        if(title && !out.some(v=>v.title===title)) out.push({title,year:Number(x.vehicleModelDate)||null,price:x.offers&&Number(x.offers.price)||null,mileage:x.mileageFromOdometer&&Number(x.mileageFromOdometer.value)||null,sourceUrl:absolute(sourceUrl,x.url)||sourceUrl,raw:"JSON-LD Vehicle"});
      }});
    }catch{}
  });
  return out;
}
app.post("/api/admin/import",authed,async(req,res)=>{
  const sourceUrl=String(req.body.url||"").trim();
  if(!/^https?:\/\//i.test(sourceUrl)) return res.status(400).json({error:"Enter a full http(s) URL"});
  try{
    const r=await fetch(sourceUrl,{headers:{"User-Agent":"OfficialCarsAuthorizedInventoryBot/1.0"}});
    if(!r.ok) throw new Error(`Source returned HTTP ${r.status}`);
    const html=await r.text(); const found=parseGeneric(html,sourceUrl);
    if(!found.length) return res.status(422).json({error:"No vehicle cards were detected. Ask the dealer for an authorized CSV/API/feed URL or provide a site-specific parser."});
    res.json({ok:true,found});
  }catch(e){res.status(502).json({error:e.message})}
});

app.get("/admin",(req,res)=>res.sendFile(path.join(ROOT,"admin.html")));
app.listen(PORT,()=>console.log(`Official Cars running on http://localhost:${PORT}`));
