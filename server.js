const express=require('express');
const cors=require('cors');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const cheerio=require('cheerio');

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'30mb'}));

const PORT=Number(process.env.PORT||10000);
const ADMIN_SECRET=process.env.ADMIN_SECRET||'';
const DB=path.join(__dirname,'data.json');
const SOURCE='https://www.carstraderny.com/';
const INVENTORY='https://www.carstraderny.com/cars-for-sale';

const read=()=>JSON.parse(fs.readFileSync(DB,'utf8'));
const write=d=>fs.writeFileSync(DB,JSON.stringify(d,null,2));
const token=()=>crypto.createHash('sha256').update(ADMIN_SECRET).digest('hex');
function auth(req,res,next){
  if(!ADMIN_SECRET)return res.status(503).json({error:'Set ADMIN_SECRET in Render Environment Variables first.'});
  if(req.headers.authorization?.replace(/^Bearer\s+/,'')!==token())return res.status(401).json({error:'Unauthorized'});
  next();
}

function clean(s=''){return String(s).replace(/\s+/g,' ').trim();}
function abs(base,href){try{return new URL(href,base).href}catch{return ''}}
function money(s){const m=clean(s).match(/\$\s*([\d,]+)/);return m?Number(m[1].replace(/,/g,'')):0}
function number(s){const m=clean(s).replace(/,/g,'').match(/\d+(?:\.\d+)?/);return m?Number(m[0]):0}
function uniq(a){return [...new Set(a.filter(Boolean))]}

function imageUrls($,base){
  const out=[];
  $('meta[property="og:image"],meta[name="twitter:image"]').each((_,e)=>out.push(abs(base,$(e).attr('content'))));
  $('img').each((_,e)=>{
    const v=$(e).attr('data-src')||$(e).attr('data-lazy-src')||$(e).attr('src');
    if(v)out.push(abs(base,v));
  });
  $('source').each((_,e)=>{const v=$(e).attr('srcset'); if(v)out.push(abs(base,v.split(',')[0].trim().split(' ')[0]))});
  return uniq(out).filter(x=>/^https:\/\/(cdn\d+\.)?carsforsale\.com\//i.test(x)||/^https:\/\/[^/]*carsforsale\.com\//i.test(x)).slice(0,40);
}

function jsonLd($){
  const vals=[];
  $('script[type="application/ld+json"]').each((_,e)=>{try{const x=JSON.parse($(e).contents().text()); vals.push(x)}catch{}});
  return vals.flatMap(x=>Array.isArray(x)?x:[x]);
}
function ldVehicle(items){
  return items.find(x=>x && (x['@type']==='Vehicle'||x['@type']==='Product'||x.vehicleIdentificationNumber||x.offers))||{};
}

function labeledText($,label){
  let result='';
  $('body *').each((_,el)=>{
    if(result)return;
    const t=clean($(el).clone().children().remove().end().text());
    if(t===label){
      const parent=$(el).parent();
      const children=parent.children().toArray();
      const i=children.indexOf(el);
      if(i>=0 && children[i+1]) result=clean($(children[i+1]).text());
      if(!result){
        const next=$(el).next(); if(next.length) result=clean(next.text());
      }
    }
  });
  return result;
}

function parseDetail(html,url){
  const $=cheerio.load(html);
  const body=clean($('body').text());
  const ld=ldVehicle(jsonLd($));
  const h1=clean($('h1').first().text())||clean(ld.name||'');
  const parts=h1.match(/^(\d{4})\s+([^\s]+)\s+(.+)$/);
  const year=Number((parts&&parts[1])||ld.modelDate||body.match(/\b(19|20)\d{2}\b/)?.[0]||0);
  const make=clean((parts&&parts[2])||ld.manufacturer?.name||ld.manufacturer||'');
  const model=clean((parts&&parts[3])||ld.model||'');
  const price=money($('body').text().match(/Price\s*\$[\d,]+/i)?.[0]||ld.offers?.price||'');
  const mileage=number(body.match(/Mileage\s*([\d,]+)/i)?.[1]||ld.mileageFromOdometer?.value||'');
  const info={
    condition: labeledText($,'Condition') || ld.itemCondition || '',
    engine: labeledText($,'Engine') || ld.vehicleEngine?.name || '',
    transmission: labeledText($,'Transmission') || ld.vehicleTransmission || '',
    drivetrain: labeledText($,'Drivetrain') || ld.driveWheelConfiguration || '',
    fuel: labeledText($,'Fuel') || ld.fuelType || '',
    exteriorColor: labeledText($,'Exterior Color') || ld.color || '',
    interiorColor: labeledText($,'Interior Color') || '',
    stock: labeledText($,'Stock #') || ld.sku || '',
    vin: labeledText($,'VIN') || ld.vehicleIdentificationNumber || '',
  };
  const city=body.match(/CITY\s*(\d+)/i)?.[1]||'';
  const hwy=body.match(/HWY\s*(\d+)/i)?.[1]||'';
  const mpg=city||hwy?`${city||'N/A'} city / ${hwy||'N/A'} hwy`:'';
  const desc=clean($('h2').filter((_,e)=>/^Description$/i.test(clean($(e).text()))).first().nextAll().slice(0,3).text())||'';
  const features=[];
  const fh=$('h2').filter((_,e)=>/^Features$/i.test(clean($(e).text()))).first();
  if(fh.length){fh.nextAll('ul').first().find('li').each((_,e)=>features.push(clean($(e).text())))}
  if(!features.length){
    $('li').each((_,e)=>{const t=clean($(e).text());if(t&&t.length<120&&/[A-Za-z]/.test(t))features.push(t)});
  }
  const images=imageUrls($,url);
  const type=(clean($('body').text().match(/(?:AWD|FWD|4x4|4X4)\s+[^\n]*?\b(SUV|Sedan|Crossover|Mini-Van|Cargo Mini-Van|Hatchback|Wagon|Coupe|Truck)\b/i)?.[1])||'Vehicle');
  const dealerName=clean($('h2').filter((_,e)=>/^Dealership Info$/i.test(clean($(e).text()))).first().next().text())||'Cars Trader New York';
  const id=(url.match(/\/details\/[^/]+\/(\d+)/i)?.[1])||crypto.createHash('sha1').update(url).digest('hex').slice(0,12);
  return {id:`ctny-${id}`,year,make,model,type,price,miles:mileage,engine:info.engine,transmission:info.transmission,drivetrain:info.drivetrain,fuel:info.fuel,mpg,condition:info.condition,exteriorColor:info.exteriorColor,interiorColor:info.interiorColor,stock:info.stock,vin:info.vin,description:desc,features:uniq(features).slice(0,150),images,url,source:'Cars Trader NY',dealerId:'cars-trader-ny',status:'active',lastVerified:new Date().toISOString().slice(0,10)};
}

async function fetchHtml(url){
  const r=await fetch(url,{headers:{'User-Agent':'OfficialCarsAuthorizedImporter/2.0 (authorized inventory sync)'},redirect:'follow'});
  if(!r.ok)throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return await r.text();
}

function listingLinks(html,base){
  const $=cheerio.load(html); const links=[];
  $('a[href]').each((_,a)=>{const href=abs(base,$(a).attr('href'));if(/https:\/\/(www\.)?carstraderny\.com\/details\//i.test(href))links.push(href)});
  return uniq(links);
}
function nextLink(html,base){
  const $=cheerio.load(html); let found='';
  $('a[href]').each((_,a)=>{if(found)return;const text=clean($(a).text()).toLowerCase();const rel=String($(a).attr('rel')||'').toLowerCase();const href=abs(base,$(a).attr('href'));if((text==='next'||text.includes('next')||rel.includes('next'))&&href&&/carstraderny\.com/i.test(href))found=href});
  return found;
}

async function discoverAll(start){
  const pages=[]; const seen=new Set(); let current=start;
  for(let i=0;i<12&&current&&!seen.has(current);i++){
    seen.add(current); const html=await fetchHtml(current); pages.push({url:current,html}); const next=nextLink(html,current); current=next&&next!==current?next:'';
  }
  const links=uniq(pages.flatMap(p=>listingLinks(p.html,p.url)));
  return {pages:pages.map(p=>p.url),links};
}

app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Official Cars API</title><style>body{font-family:Inter,Arial;background:#07111f;color:#fff;padding:48px}a{color:#64c8ff}.ok{display:inline-block;padding:8px 12px;border-radius:999px;background:#123d2b;color:#8ff0b1}</style></head><body><span class="ok">ONLINE</span><h1>⚡ Official Cars API</h1><p>Inventory API is running.</p><p><a href="/api/public">Public inventory JSON</a> · <a href="/admin">Admin panel</a> · <a href="/health">Health</a></p></body></html>`));
app.get('/health',(req,res)=>res.json({ok:true,service:'official-cars-api',time:new Date().toISOString()}));
app.get('/api/public',(req,res)=>{const d=read();res.json({dealers:d.dealers,vehicles:d.vehicles,sourceMeta:d.sourceMeta||{}})});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.post('/api/admin/login',(req,res)=>{if(!ADMIN_SECRET)return res.status(503).json({error:'Set ADMIN_SECRET in Render Environment Variables'});if(req.body.password!==ADMIN_SECRET)return res.status(401).json({error:'Wrong password'});res.json({token:token()})});
app.get('/api/admin/data',auth,(req,res)=>res.json(read()));
app.put('/api/admin/data',auth,(req,res)=>{if(!Array.isArray(req.body?.dealers)||!Array.isArray(req.body?.vehicles))return res.status(400).json({error:'Expected dealers and vehicles arrays'});write(req.body);res.json({ok:true})});
app.post('/api/admin/import-json',auth,(req,res)=>{let incoming=req.body?.data||req.body;if(!Array.isArray(incoming.vehicles))return res.status(400).json({error:'Invalid inventory JSON'});let d=read();for(const x of incoming.dealers||[]){let i=d.dealers.findIndex(a=>a.id===x.id);if(i>=0)d.dealers[i]={...d.dealers[i],...x};else d.dealers.push(x)}for(const v of incoming.vehicles){let i=d.vehicles.findIndex(a=>a.id===v.id);if(i>=0)d.vehicles[i]={...d.vehicles[i],...v};else d.vehicles.push(v)}write(d);res.json({ok:true,dealers:d.dealers.length,vehicles:d.vehicles.length})});
app.get('/api/admin/export',auth,(req,res)=>{res.setHeader('Content-Disposition','attachment; filename="official-cars-backup.json"');res.type('json').send(JSON.stringify(read(),null,2))});

app.post('/api/admin/sync-carstrader',auth,async(req,res)=>{
  const started=Date.now();
  try{
    const {pages,links}=await discoverAll(INVENTORY);
    const records=[]; const errors=[]; const concurrency=4; let cursor=0;
    async function worker(){while(true){const i=cursor++;if(i>=links.length)return;const url=links[i];try{const html=await fetchHtml(url);const v=parseDetail(html,url);if(v.year||v.make||v.model)records.push(v);else errors.push({url,error:'Could not identify vehicle title'});}catch(e){errors.push({url,error:e.message})}}}
    await Promise.all(Array.from({length:Math.min(concurrency,links.length)},worker));
    const d=read();
    const dealer=d.dealers.find(x=>x.id==='cars-trader-ny')||{id:'cars-trader-ny',name:'Cars Trader New York',borough:'Brooklyn',address:'2342 Coney Island Ave, Brooklyn, NY 11223',phone:'(718) 872-5420',website:SOURCE};
    if(!d.dealers.some(x=>x.id===dealer.id))d.dealers.push(dealer);
    for(const v of records){const i=d.vehicles.findIndex(x=>x.id===v.id);if(i>=0)d.vehicles[i]={...d.vehicles[i],...v};else d.vehicles.push(v)}
    d.sourceMeta={...(d.sourceMeta||{}),lastSync:new Date().toISOString(),source:INVENTORY,pagesScanned:pages,linksFound:links.length,recordsImported:records.length,errors,siteReportedTotal:27};
    write(d);
    res.json({ok:true,source:INVENTORY,pagesScanned:pages,linksFound:links.length,recordsImported:records.length,totalVehicles:d.vehicles.length,errors,durationMs:Date.now()-started});
  }catch(e){res.status(502).json({ok:false,error:e.message,durationMs:Date.now()-started})}
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Official Cars API listening on ${PORT}`));
