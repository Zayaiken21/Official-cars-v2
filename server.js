const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),crypto=require('crypto'),cheerio=require('cheerio');
const app=express(); app.use(cors()); app.use(express.json({limit:'20mb'}));
const PORT=process.env.PORT||10000, ADMIN_SECRET=process.env.ADMIN_SECRET||'', DB=path.join(__dirname,'data.json');
const read=()=>JSON.parse(fs.readFileSync(DB,'utf8')); const write=d=>fs.writeFileSync(DB,JSON.stringify(d,null,2));
const token=()=>crypto.createHash('sha256').update(ADMIN_SECRET).digest('hex');
function auth(req,res,next){if(!ADMIN_SECRET)return res.status(503).json({error:'Set ADMIN_SECRET in Render'}); if(req.headers.authorization?.replace('Bearer ','')!==token())return res.status(401).json({error:'Unauthorized'}); next();}
app.get('/',(req,res)=>res.type('html').send('<!doctype html><html><head><title>Official Cars API</title><meta name="viewport" content="width=device-width"></head><body style="font-family:Arial;padding:40px"><h1>⚡ Official Cars API is online</h1><p>Public API: <code>/api/public</code></p><p>Health: <code>/health</code></p><p>Admin: <a href="/admin">/admin</a></p></body></html>'));
app.get('/health',(req,res)=>res.json({ok:true,service:'official-cars-api',time:new Date().toISOString()}));
app.get('/api/public',(req,res)=>{const d=read();res.json({dealers:d.dealers,vehicles:d.vehicles,sourceMeta:d.sourceMeta||{}})});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.post('/api/admin/login',(req,res)=>{if(!ADMIN_SECRET)return res.status(503).json({error:'Set ADMIN_SECRET in Render Environment Variables'});if(req.body.password!==ADMIN_SECRET)return res.status(401).json({error:'Wrong password'});res.json({token:token()})});
app.get('/api/admin/data',auth,(req,res)=>res.json(read()));
app.put('/api/admin/data',auth,(req,res)=>{if(!req.body?.dealers||!req.body?.vehicles)return res.status(400).json({error:'Expected dealers and vehicles arrays'});write(req.body);res.json({ok:true})});
app.post('/api/admin/import-json',auth,(req,res)=>{let incoming=req.body?.data||req.body;if(!Array.isArray(incoming.vehicles))return res.status(400).json({error:'Invalid inventory JSON'});let d=read();for(const x of incoming.dealers||[]){let i=d.dealers.findIndex(a=>a.id===x.id);if(i>=0)d.dealers[i]={...d.dealers[i],...x};else d.dealers.push(x)}for(const v of incoming.vehicles){let i=d.vehicles.findIndex(a=>a.id===v.id);if(i>=0)d.vehicles[i]={...d.vehicles[i],...v};else d.vehicles.push(v)}write(d);res.json({ok:true,dealers:d.dealers.length,vehicles:d.vehicles.length})});
app.get('/api/admin/export',auth,(req,res)=>{res.setHeader('Content-Disposition','attachment; filename="official-cars-backup.json"');res.type('json').send(JSON.stringify(read(),null,2))});

// Authorized-source importer. It extracts visible listing links/text; dealer permission should be maintained in your agreement.
app.post('/api/admin/import-url',auth,async(req,res)=>{try{
 const source=req.body?.url;if(!source||!/^https:\/\/(www\.)?carstraderny\.com\//i.test(source))return res.status(400).json({error:'Use the authorized Cars Trader NY HTTPS source URL'});
 const html=await (await fetch(source,{headers:{'User-Agent':'OfficialCarsAuthorizedImporter/1.0'}})).text(); const $=cheerio.load(html); let out=[];
 $('a').each((_,a)=>{const href=$(a).attr('href')||'',text=$(a).text().replace(/\s+/g,' ').trim(); if(/\/details\//i.test(href)&&text){out.push({href:new URL(href,source).href,text})}});
 const d=read(); res.json({ok:true,found:[...new Map(out.map(x=>[x.href,x])).values()],message:'Use the authorized feed/HTML fields to populate full records. No credentials are stored.'});
}catch(e){res.status(502).json({error:'Could not import source',detail:e.message})}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Official Cars API listening on ${PORT}`));