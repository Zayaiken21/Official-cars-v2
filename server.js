const express=require('express');
const cors=require('cors');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const cheerio=require('cheerio');
const zlib=require('zlib');
const dns=require('dns').promises;
let webpush=null; try{webpush=require('web-push')}catch{}

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'50mb'}));
const PORT=Number(process.env.PORT||10000),DB=path.join(__dirname,'data.json');
const ADMIN_SECRET=process.env.ADMIN_SECRET||'';
const ANALYTICS_SALT=process.env.ANALYTICS_SALT||crypto.randomBytes(16).toString('hex');
const UA='Official-Cars-Authorized-Dealer-Sync/10.0';
const GH={token:process.env.GITHUB_TOKEN||'',owner:process.env.GITHUB_OWNER||'',repo:process.env.GITHUB_REPO||'',branch:process.env.GITHUB_BRANCH||'main',file:process.env.GITHUB_DATA_PATH||'official-cars-data.json'};
const PUSH={publicKey:process.env.VAPID_PUBLIC_KEY||'',privateKey:process.env.VAPID_PRIVATE_KEY||'',subject:process.env.VAPID_SUBJECT||'mailto:admin@officialcars.example'};
let syncState={running:false,startedAt:null,finishedAt:null,found:0,imported:0,skipped:0,errors:[],log:[],currentDealer:null,currentUrl:null,totalUrls:0,processed:0,phase:'idle',lastHeartbeat:null};
let persistTimer=null,persistBusy=false;

function read(){return JSON.parse(fs.readFileSync(DB,'utf8'))}
function write(d){fs.writeFileSync(DB,JSON.stringify(d,null,2))}
function clean(s=''){return String(s).replace(/\s+/g,' ').trim()}
function abs(base,href){try{return new URL(href,base).href}catch{return ''}}
function hostOf(u){try{return new URL(u).hostname.toLowerCase()}catch{return ''}}
function hostAllowed(u,domains){let h=hostOf(u);return !!h&&domains.some(x=>h===x||h.endsWith('.'+x))}
function dealerDomains(d){return [hostOf(d.website),...(d.allowedDomains||[])].filter(Boolean)}
function safeHost(host){return /^[a-z0-9.-]+$/i.test(host)&&!host.includes('..')}
async function isPublicHost(host){if(!safeHost(host))return false;try{let a=await dns.lookup(host,{all:true});return a.length>0&&a.every(x=>!/^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^fc|^fd/i.test(x.address))}catch{return false}}
function hash(s){return crypto.createHash('sha256').update(String(s)+ANALYTICS_SALT).digest('hex').slice(0,16)}
function token(){return crypto.createHash('sha256').update(ADMIN_SECRET).digest('hex')}
function auth(req,res,next){if(!ADMIN_SECRET)return res.status(503).json({error:'Set ADMIN_SECRET in Render Environment Variables first.'});if(req.headers.authorization?.replace(/^Bearer\s+/i,'')!==token())return res.status(401).json({error:'Unauthorized'});next()}
function log(s){syncState.log.push(new Date().toISOString()+'  '+s);if(syncState.log.length>1000)syncState.log.shift()}
function money(s){let m=clean(s).match(/\$\s*([\d,]+(?:\.\d{2})?)/);return m?Number(m[1].replace(/,/g,'')):null}
function num(s){if(s===null||s===undefined||s==='')return null;let m=String(s).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null}
async function fetchText(url,domains,referer){if(!/^https:\/\//i.test(url)||!hostAllowed(url,domains))throw new Error('URL not allowed for this dealer');const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),20000);try{let r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html,application/xml,text/xml,application/json,*/*;q=.7',...(referer?{Referer:referer}:{})},redirect:'follow',signal:ac.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);let ab=await r.arrayBuffer();if(ab.byteLength>15*1024*1024)throw new Error('Response exceeded the 15 MB safety limit');let b=Buffer.from(ab),enc=(r.headers.get('content-encoding')||'').toLowerCase();try{if(enc.includes('gzip'))b=zlib.gunzipSync(b);else if(enc.includes('deflate'))b=zlib.inflateSync(b)}catch{}return b.toString('utf8')}catch(e){if(e.name==='AbortError')throw new Error('Request timed out after 20 seconds');throw e}finally{clearTimeout(timer)}}
function parseJsonLd($){let out=[];$('script[type="application/ld+json"]').each((_,e)=>{try{let raw=$(e).text().trim();if(raw)out.push(JSON.parse(raw))}catch{}});return out}
function flatten(o,out=[]){if(!o)return out;if(Array.isArray(o)){o.forEach(x=>flatten(x,out));return out}if(typeof o==='object'){out.push(o);Object.values(o).forEach(x=>{if(x&&typeof x==='object')flatten(x,out)})}return out}
function types(o){return String(o?.['@type']||'').toLowerCase().split(/[,\s]+/)}
function firstType(nodes,typesWanted){return nodes.find(x=>types(x).some(t=>typesWanted.includes(t)))}
function normalizeState(v){
  let x=clean(v).replace(/\./g,'');
  const m={'new york':'NY','ny':'NY','new jersey':'NJ','nj':'NJ','connecticut':'CT','ct':'CT','pennsylvania':'PA','pa':'PA','massachusetts':'MA','ma':'MA','california':'CA','ca':'CA','florida':'FL','fl':'FL','texas':'TX','tx':'TX','georgia':'GA','ga':'GA','illinois':'IL','il':'IL','virginia':'VA','va':'VA','maryland':'MD','md':'MD','delaware':'DE','de':'DE','north carolina':'NC','nc':'NC'};
  return m[x.toLowerCase()]||x;
}
function addressObject(a){if(!a)return null;if(typeof a==='string')return {formatted:clean(a)};let f=[a.streetAddress,a.addressLocality,a.addressRegion,a.postalCode,a.addressCountry].filter(Boolean);return f.length?{formatted:clean(f.join(', ')),streetAddress:clean(a.streetAddress),city:clean(a.addressLocality),state:normalizeState(a.addressRegion),postalCode:clean(a.postalCode),country:clean(a.addressCountry),latitude:num(a.geo?.latitude),longitude:num(a.geo?.longitude)}:null}
function extractLocations(nodes,baseUrl){let out=[];const add=(x,kind='location')=>{if(!x)return;let a=addressObject(x.address||x);let phone=clean(x.telephone||x.phone||'');let name=clean(x.name||'');let website=abs(baseUrl,x.url||'');let lat=num(x.geo?.latitude),lon=num(x.geo?.longitude);if(a||phone||name||lat!==null){let key=(a?.formatted||'')+'|'+phone+'|'+name;if(!out.some(v=>(v.address?.formatted||'')+'|'+v.phone+'|'+v.name===key))out.push({name,address:a||{formatted:''},phone,website,latitude:lat,longitude:lon,kind})}};
  nodes.forEach(x=>{if(types(x).some(t=>['organization','localbusiness','automotivedealer','store','department'].includes(t))){add(x);if(Array.isArray(x.location))x.location.forEach(y=>add(y,'location'));if(x.location&&typeof x.location==='object'&&!Array.isArray(x.location))add(x.location,'location');if(Array.isArray(x.department))x.department.forEach(y=>add(y,'department'));if(x.subOrganization)Array.isArray(x.subOrganization)?x.subOrganization.forEach(y=>add(y,'location')):add(x.subOrganization,'location')}});
  return out}
function businessInfo(url,html){const $=cheerio.load(html),nodes=flatten(parseJsonLd($)),b=firstType(nodes,['organization','localbusiness','automotivedealer','store']);let locs=extractLocations(nodes,url);let address=addressObject(b?.address)||locs.find(x=>x.address?.formatted)?.address||null;
  let phone=clean(b?.telephone||$('a[href^="tel:"]').first().attr('href')?.replace(/^tel:/i,'')||locs.find(x=>x.phone)?.phone||'');
  if(!phone){let mt=$('body').text().match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);if(mt)phone=clean(mt[0])}
  if(!address){let av=$('address').first().text();if(av)address=addressObject(av)}
let logo=typeof b?.logo==='string'?b.logo:b?.logo?.url||$('meta[property="og:image"]').attr('content')||'';let name=clean(b?.name||$('meta[property="og:site_name"]').attr('content')||$('meta[name="application-name"]').attr('content')||$('title').first().text().replace(/\s*[|•-].*$/,''));let website=abs(url,b?.url)||url;let social=[];if(Array.isArray(b?.sameAs))social=b.sameAs.filter(x=>/^https?:\/\//.test(x));if(!locs.length&&address)locs=[{name,address,phone,website,latitude:address.latitude,longitude:address.longitude,kind:'primary'}];return{name,address:address?.formatted||'',phone,website,logo:abs(url,logo),social,locations:locs}}
function imageCandidates($,base,vehicleNodes=[],vehicleTitle=''){
  const map=new Map();
  const hardBad=/logo|favicon|sprite|avatar|tracking|pixel|storefront|showroom|dealer[-_ ]?(building|office)|building[-_ ]?photo|service[-_ ]?center|finance|team|staff|headquarters/i;
  const carSignals=/vehicle|inventory|car[-_ ]?photo|auto|automotive|used[-_ ]?car|new[-_ ]?car|stock|vin|gallery|listing|walkaround|360|photo[-_ ]?\d|motor|sedan|suv|truck|coupe|hatchback|convertible/i;
  const titleWords=clean(vehicleTitle).toLowerCase().split(/\s+/).filter(x=>x.length>2);
  const add=(raw,score=0,context='',structured=false)=>{
    let u=String(raw||'').trim(); if(!u)return;
    if(u.includes(' '))u=u.split(/\s+/)[0];
    u=abs(base,u); if(!/^https:\/\//i.test(u))return;
    let low=(u+' '+context).toLowerCase();
    if(hardBad.test(low))return;
    // Social/brand previews are deliberately excluded: they frequently show the storefront.
    if(!structured && /social preview|og:image|twitter:image/i.test(context))return;
    if(!(/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(u)||/image|photo|vehicle|media|inventory|cdn|dealerimage|gallery/i.test(low)))return;
    let n=score+(carSignals.test(low)?35:0)+(titleWords.filter(w=>low.includes(w)).length*8);
    map.set(u,Math.max(map.get(u)||0,n));
  };
  vehicleNodes.forEach(o=>{
    let im=o.image;
    if(im)(Array.isArray(im)?im:[im]).forEach(x=>add(typeof x==='string'?x:x?.url,160,'structured vehicle image',true));
  });
  $('img,source').each((_,e)=>{
    let ctx=[$(e).attr('alt'),$(e).attr('title'),$(e).attr('aria-label'),$(e).attr('class'),$(e).attr('id'),
      $(e).parent().attr('class'),$(e).parent().attr('aria-label')].filter(Boolean).join(' ');
    ['data-photo','data-image','data-original','data-flickity-lazyload','data-lazy','data-src','data-lazy-src','data-url','src','srcset','data-srcset'].forEach(k=>{
      let val=$(e).attr(k);
      if(k.includes('srcset'))String(val||'').split(',').forEach(x=>add(x.trim().split(/\s+/)[0],65,ctx));
      else add(val,65,ctx);
    });
  });
  // Dealer platforms often put the gallery in JSON strings rather than img tags.
  $('script:not([type="application/ld+json"])').each((_,e)=>{
    let raw=$(e).text()||'';
    let urls=raw.match(/https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\\\s<>]*)?/gi)||[];
    urls.slice(0,250).forEach(u=>add(u,45,'embedded inventory gallery'));
  });
  // Background images are accepted only when the surrounding element looks like a vehicle gallery.
  $('[style*="background-image"],[data-images],[data-photos]').each((_,e)=>{
    let raw=$(e).attr('style')||$(e).attr('data-images')||$(e).attr('data-photos')||'',ctx=$(e).attr('class')||'';
    if(!carSignals.test(ctx))return;
    String(raw).match(/https?:[^"' )\\]+/g)?.forEach(u=>add(u,50,ctx));
  });
  return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,60).map(x=>x[0]);
}
function prop(nodes,name){let n=nodes.find(x=>clean(x.name).toLowerCase()===name.toLowerCase());return n?.value??n?.valueReference??''}
function textValue(text,labels){for(let i=0;i<labels.length;i++){let m=text.match(new RegExp(labels[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*[:\\-]?\\s*([^|\\n]{1,120})','i'));if(m)return clean(m[1])}return ''}
function parseVehicle(url,html,dealer){const $=cheerio.load(html),text=clean($('body').text()),nodes=flatten(parseJsonLd($));let prod=firstType(nodes,['vehicle','product'])||{};let title=clean(prod.name||$('h1').first().text()||$('meta[property="og:title"]').attr('content')||'');let tm=title.match(/\b(19\d{2}|20\d{2})\s+([^\s]+)\s+(.+)/);let year=num(prod.vehicleModelDate)||num(tm?.[1]),make=clean(prod.brand?.name||prod.manufacturer||tm?.[2]||''),model=clean(prod.model||tm?.[3]||'');let offer=prod.offers?.price??prod.offers?.priceSpecification?.price;let price=num(offer)||money(text);let mileage=num(prod.mileageFromOdometer?.value)||num(text.match(/(?:Mileage|Odometer)\s*[:\-]?\s*([\d,]+)/i)?.[1])||num(text.match(/([\d]{1,3}(?:,\d{3})+)\s*(?:miles|mi)\b/i)?.[1]);let engine=clean(prod.vehicleEngine?.name||prop(nodes,'Engine')||textValue(text,['Engine','Engine Type']));let transmission=clean(prod.vehicleTransmission||prop(nodes,'Transmission')||textValue(text,['Transmission']));let drivetrain=clean(prod.driveWheelConfiguration||prop(nodes,'Drivetrain')||textValue(text,['Drivetrain','Drive Type'])).replace(/^https?:\/\/schema.org\//i,'').replace(/Configuration$/i,'').replace(/([a-z])([A-Z])/g,'$1 $2');let fuel=clean(prod.fuelType||prop(nodes,'Fuel Type')||textValue(text,['Fuel Type']));let bodyStyle=clean(prod.bodyType||prop(nodes,'Body Style')||textValue(text,['Body Style','Style']));let vin=clean(prod.vehicleIdentificationNumber||prop(nodes,'VIN')||textValue(text,['VIN']));let stock=clean(prop(nodes,'Stock')||prop(nodes,'Stock #')||textValue(text,['Stock #','Stock']));let hp=num(prop(nodes,'Horsepower')||prop(nodes,'Horsepower @ RPM')||text.match(/Horsepower\s*[:\-]?\s*([\d]+)/i)?.[1]);let torque=num(prop(nodes,'Torque')||text.match(/Torque\s*[:\-]?\s*([\d]+)/i)?.[1]);let doors=num(prod.numberOfDoors);let city=num(prop(nodes,'Fuel Economy (City)')||text.match(/City\)?\s*[^\d]{0,15}(\d+)\s*MPG/i)?.[1]);let highway=num(prop(nodes,'Fuel Economy (Highway)')||text.match(/Highway\)?\s*[^\d]{0,15}(\d+)\s*MPG/i)?.[1]);let tank=prop(nodes,'Fuel Tank Capacity')||text.match(/Fuel Tank Capacity\s*[:\-]?\s*([\d.]+\s*gallons?)/i)?.[1]||'';let description=clean(prod.description||$('meta[name="description"]').attr('content')||$('.vehicle-description,.description,[class*="description"]').first().text());let features=[];$('.features li,.feature-list li,[class*="feature"] li').each((_,e)=>{let x=clean($(e).text());if(x&&x.length<200&&!features.includes(x))features.push(x)});let locations=extractLocations(nodes,url);let loc=locations[0]||null;return{id:crypto.createHash('sha1').update(url).digest('hex').slice(0,16),dealerId:dealer.id,title,year,make,model,bodyStyle,price,mileage,engine,transmission,drivetrain,fuel,fuelEconomy:[city&&`City ${city} MPG`,highway&&`Highway ${highway} MPG`].filter(Boolean).join(' · '),cityMpg:city,highwayMpg:highway,horsepower:hp,torque,doors,fuelTankCapacity:clean(tank),vin,stock,description,features:features.slice(0,150),images:imageCandidates($,url,nodes,title),sourceUrl:url,source:dealer.name,status:'active',syncedAt:new Date().toISOString(),firstSeenAt:null,lastSeenAt:new Date().toISOString(),isNew:false,location:loc?.address?.formatted||'',locationName:loc?.name||'',locationId:loc?crypto.createHash('sha1').update((loc.address?.formatted||'')+'|'+dealer.id).digest('hex').slice(0,12):''}}
async function discoverSitemaps(home,domains){let maps=[],seen=new Set(),queue=[new URL('/robots.txt',home).href,new URL('/sitemap.xml',home).href,new URL('/sitemap_index.xml',home).href];while(queue.length&&seen.size<60){let u=queue.shift();if(seen.has(u)||!hostAllowed(u,domains))continue;seen.add(u);try{let x=await fetchText(u,domains,home);if(u.endsWith('/robots.txt')){for(const m of x.matchAll(/^\s*Sitemap:\s*(\S+)/gim))queue.push(abs(u,m[1]))}else{let $=cheerio.load(x,{xmlMode:true});$('loc').each((_,e)=>{let v=abs(u,clean($(e).text()));if(hostAllowed(v,domains)&&/sitemap/i.test(v))queue.push(v)});maps.push(u)}}catch{}}return maps}
function likelyVehicleUrl(u){return /\/details?\//i.test(u)||/\/vehicle[-_/]/i.test(u)||/\/inventory\/[^/?]+/i.test(u)||/\/used[-_]?cars?\/[^/?]+/i.test(u)||/\/new[-_]?cars?\/[^/?]+/i.test(u)||/\/cars[-_]?for[-_]sale\/[^/?]+/i.test(u)||/\/(?:19|20)\d{2}[-_]/i.test(u)}
async function discoverVehicleUrls(dealer){
  const domains=dealerDomains(dealer),home=dealer.website,urls=new Set(),maps=await discoverSitemaps(home,domains);
  for(const m of maps){try{let x=await fetchText(m,domains,home),$=cheerio.load(x,{xmlMode:true});$('loc').each((_,e)=>{let u=abs(m,clean($(e).text()));if(hostAllowed(u,domains)&&!(/\.(xml|pdf|jpg|jpeg|png|webp|css|js)(\?|$)/i.test(u))&&(likelyVehicleUrl(u)||/vehicle|inventory|cars-for-sale|used-cars|new-cars|listing|stock|vin/i.test(u)))urls.add(u)})}catch{}}
  let queue=[home],seen=new Set();
  for(let pass=0;queue.length&&pass<220;pass++){syncState.lastHeartbeat=new Date().toISOString();
    let u=queue.shift();if(seen.has(u)||!hostAllowed(u,domains))continue;seen.add(u);
    try{let h=await fetchText(u,domains,home),$=cheerio.load(h);$('a[href]').each((_,e)=>{let v=abs(u,$(e).attr('href'));if(!hostAllowed(v,domains)||/\.(xml|pdf|jpg|jpeg|png|webp|css|js)(\?|$)/i.test(v))return;if(likelyVehicleUrl(v))urls.add(v);if(/inventory|cars-for-sale|used-cars|new-cars|vehicles|listing|stock|vin|page=|\/page\//i.test(v)&&queue.length<400)queue.push(v)})}
    catch(e){log(`Discovery skipped ${u}: ${e.message}`)}
  }
  return [...urls].filter(u=>isLikelyListingUrl(u,dealer)).slice(0,2500)
}
async function discoverLocationLinks(dealer){const domains=dealerDomains(dealer),seen=new Set(),q=[dealer.website],out=[];for(let i=0;q.length&&i<20;i++){syncState.lastHeartbeat=new Date().toISOString();let u=q.shift();if(seen.has(u))continue;seen.add(u);try{let h=await fetchText(u,domains,dealer.website),$=cheerio.load(h);$('a[href]').each((_,e)=>{let v=abs(u,$(e).attr('href')),t=clean($(e).text());if(hostAllowed(v,domains)&&/(location|locations|contact|stores?|dealerships?)/i.test(t+' '+v)&&!seen.has(v))q.push(v)});out.push({url:u,html:h})}catch{}}return out}
async function geocode(address){
  if(!address||/\b(not found|unavailable)\b/i.test(address))return null;
  try{
    let q=String(address);
    if(!/\bUSA\b|\bUnited States\b/i.test(q))q+=', USA';
    let r=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=us&q='+encodeURIComponent(q),{
      headers:{'User-Agent':'Official-Cars/10.0 authorized-dealer-directory (contact: admin@officialcars.example)','Accept':'application/json'}
    });
    if(!r.ok)return null;
    let j=await r.json(),x=j[0];if(!x)return null;
    let lat=Number(x.lat),lon=Number(x.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
    return {latitude:lat,longitude:lon,geocodeDisplayName:clean(x.display_name),geocodeAddress:x.address||{}};
  }catch{return null}
}
async function enrichDealerLocations(dealer,homeHtml){
  let nodes=flatten(parseJsonLd(cheerio.load(homeHtml))),locs=extractLocations(nodes,dealer.website);
  for(const p of await discoverLocationLinks(dealer)){
    let n=extractLocations(flatten(parseJsonLd(cheerio.load(p.html))),p.url);
    locs.push(...n);
  }
  // Also scan visible location/contact text for phone/address anchors without treating arbitrary city names as states.
  const $=cheerio.load(homeHtml);
  let visiblePhone=clean($('a[href^="tel:"]').first().attr('href')?.replace(/^tel:/i,'')||'');
  if(visiblePhone&&!locs.some(x=>x.phone===visiblePhone))locs.push({name:dealer.name,address:{formatted:dealer.address||''},phone:visiblePhone,website:dealer.website,kind:'contact'});
  let uniq=[];
  for(let l of locs){
    if(l.address?.state)l.address.state=normalizeState(l.address.state);
    let key=[l.address?.streetAddress,l.address?.city,l.address?.state,l.address?.postalCode,l.phone,l.name].map(clean).join('|').toLowerCase();
    if(!key.replace(/\|/g,'')||uniq.some(x=>[x.address?.streetAddress,x.address?.city,x.address?.state,x.address?.postalCode,x.phone,x.name].map(clean).join('|').toLowerCase()===key))continue;
    if(l.latitude==null&&l.address?.formatted){
      let g=await geocode(l.address.formatted);
      if(g){l.latitude=g.latitude;l.longitude=g.longitude;l.geocodeDisplayName=g.geocodeDisplayName}
    }
    l.id='loc-'+crypto.createHash('sha1').update(key).digest('hex').slice(0,12);
    uniq.push(l);
  }
  if(!uniq.length&&dealer.address){
    let g=await geocode(dealer.address);
    uniq=[{id:'loc-'+crypto.createHash('sha1').update(dealer.address).digest('hex').slice(0,12),name:dealer.name,address:{formatted:dealer.address},phone:dealer.phone,website:dealer.website,...(g||{})}];
  }
  return uniq.slice(0,100);
}
async function syncDealer(dealer,locationFilter=''){
  syncState.currentDealer=dealer.id;syncState.phase='profile';log(`${dealer.name}: reading business profile and locations…`);
  let homeHtml=await fetchText(dealer.website,dealerDomains(dealer));
  let info=businessInfo(dealer.website,homeHtml);
  dealer.name=info.name||dealer.name;dealer.address=info.address||dealer.address||'';dealer.phone=info.phone||dealer.phone||'';dealer.logo=info.logo||dealer.logo||'';dealer.social=info.social||dealer.social||[];
  dealer.locations=await enrichDealerLocations(dealer,homeHtml);
  if(!dealer.locations.length&&dealer.address){let g=await geocode(dealer.address);dealer.locations=[{id:'loc-primary',name:dealer.name,address:{formatted:dealer.address},phone:dealer.phone,website:dealer.website,...(g||{})}]}
  syncState.phase='discovering';let urls=await discoverVehicleUrls(dealer);
  if(locationFilter){
    const chosen=dealer.locations.find(l=>l.id===locationFilter||l.address?.formatted===locationFilter||l.name===locationFilter);
    if(chosen){
      const terms=[chosen.address?.city,chosen.address?.state,chosen.address?.postalCode,chosen.name].filter(Boolean).map(x=>String(x).toLowerCase());
      // Do not discard URLs solely because a location isn't in the URL; keep them unless they clearly point to another location.
      urls=urls.filter(u=>!/(brooklyn|queens|bronx|manhattan|staten[-_ ]?island|new[-_ ]?york|new[-_ ]?jersey|connecticut|pennsylvania)/i.test(u)||terms.some(t=>u.toLowerCase().includes(t)));
    }
  }
  syncState.totalUrls=urls.length;syncState.found=urls.length;syncState.processed=0;log(`${dealer.name}: discovered ${urls.length} candidate vehicle listing URLs.`);
  let d=ensure(read()),old=new Map((d.vehicles||[]).filter(v=>v.dealerId===dealer.id).map(v=>[v.sourceUrl||v.url,v]));
  let ok=0,skipped=0,newOnes=[],cursor=0,concurrency=5;
  const worker=async()=>{
    while(true){
      let i=cursor++;if(i>=urls.length)return;let url=urls[i];syncState.phase='importing';syncState.currentUrl=url;
      try{
        let h=await fetchText(url,dealerDomains(dealer),dealer.website),v=parseVehicle(url,h,dealer);
        if(!v.title||(!v.year&&!v.vin&&!v.stock)||(!v.price&&!v.vin&&!v.stock)){skipped++;continue}
        let prior=old.get(url),now=new Date().toISOString();
        v.firstSeenAt=prior?.firstSeenAt||now;v.isNew=(Date.now()-new Date(v.firstSeenAt).getTime())<14*86400000;v.lastSeenAt=now;
        if(!v.images.length&&prior?.images?.length)v.images=prior.images;
        v.imageCount=v.images.length;v.sourceVerified=true;
        // Associate the listing with the best matching dealer location.
        let ploc=v.location||'';
        let chosen=(dealer.locations||[]).find(l=>ploc&&l.address?.formatted&&ploc.toLowerCase()===l.address.formatted.toLowerCase())||
          (dealer.locations||[]).find(l=>ploc&&l.address?.city&&ploc.toLowerCase().includes(l.address.city.toLowerCase()));
        if(chosen){v.locationId=chosen.id;v.location=chosen.address?.formatted||v.location;v.locationName=chosen.name||dealer.name}
        dealer.allowedImageDomains=[...new Set([...(dealer.allowedImageDomains||[]),...v.images.map(hostOf).filter(Boolean)])];
        old.set(url,{...prior,...v});ok++;if(!prior)newOnes.push(v);
      }catch(e){syncState.errors.push(`${dealer.name}: ${url} — ${e.message}`)}
      finally{syncState.processed++;syncState.lastHeartbeat=new Date().toISOString();if(syncState.processed%10===0)log(`${dealer.name}: ${syncState.processed}/${urls.length} pages processed · ${ok} imported · ${syncState.errors.length} errors`)}
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,Math.max(1,urls.length))},worker));
  // Read the latest DB so analytics recorded during a sync cannot be overwritten.
  d=ensure(read());
  d.vehicles=(d.vehicles||[]).filter(v=>v.dealerId!==dealer.id).concat([...old.values()]);
  dealer.lastSyncedAt=new Date().toISOString();dealer.lastSyncCount=ok;
  dealer.syncErrors=syncState.errors.length;dealer.syncStatus=syncState.errors.length&&ok===0?'failed':syncState.errors.length?'partial':'success';
  dealer.lastSyncPhotoCount=[...old.values()].reduce((n,v)=>n+(v.images?.length||0),0);
  d.dealers=d.dealers.map(x=>x.id===dealer.id?dealer:x);d.sourceMeta={...(d.sourceMeta||{}),lastSyncedAt:new Date().toISOString(),lastSyncVersion:10};
  write(d);schedulePersist();syncState.imported=ok;syncState.skipped=skipped;syncState.phase='complete';syncState.currentUrl=null;
  log(`${dealer.name}: complete · ${ok} vehicles · ${skipped} skipped · ${newOnes.length} new · ${dealer.lastSyncPhotoCount} vehicle photos.`);
  if(newOnes.length)notifyAll({title:`New cars at ${dealer.name}`,body:`${newOnes.length} new vehicle${newOnes.length===1?'':'s'} just arrived on Official Cars.`,url:'https://zayaiken21.github.io/Official-Cars/#/cars'}).catch(()=>{});
  return ok;
}
function ensure(d){d.dealers??=[];d.vehicles??=[];for(const dl of d.dealers){for(const l of (dl.locations||[])){if(l.address?.state)l.address.state=normalizeState(l.address.state)}}d.analytics??={events:[]};d.analytics.events??=[];d.pushSubscriptions??=[];for(const v of d.vehicles){if(!v.sourceUrl&&v.url)v.sourceUrl=v.url;if(!v.url&&v.sourceUrl)v.url=v.sourceUrl;if(!v.firstSeenAt)v.firstSeenAt=v.syncedAt||new Date().toISOString();v.isNew=(Date.now()-new Date(v.firstSeenAt).getTime())<14*86400000}return d}
function schedulePersist(){if(!GH.token||!GH.owner||!GH.repo)return;if(persistTimer)return;persistTimer=setTimeout(()=>{persistTimer=null;persistGithub().catch(e=>log('GitHub persistence: '+e.message))},5000)}
async function ghApi(method,url,body){let r=await fetch(url,{method,headers:{Authorization:`Bearer ${GH.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});let j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||`GitHub HTTP ${r.status}`);return j}
async function persistGithub(){if(persistBusy||!GH.token||!GH.owner||!GH.repo)return;persistBusy=true;try{let data=ensure(read()),content=Buffer.from(JSON.stringify({version:9,updatedAt:new Date().toISOString(),dealers:data.dealers,vehicles:data.vehicles,analytics:data.analytics,sourceMeta:data.sourceMeta||{}})).toString('base64'),url=`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.file}`;let existing;try{existing=await ghApi('GET',url+'?ref='+encodeURIComponent(GH.branch))}catch{};let body={message:'chore: persist Official Cars data',content,branch:GH.branch};if(existing?.sha)body.sha=existing.sha;await ghApi('PUT',url,body);log('Persistent data snapshot committed to GitHub.')}finally{persistBusy=false}}
async function restoreGithub(){if(!GH.token||!GH.owner||!GH.repo)return;try{let j=await ghApi('GET',`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.file}?ref=${encodeURIComponent(GH.branch)}`);let remote=JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8'));if(remote?.dealers||remote?.vehicles){let local=ensure(read()),merged={dealers:remote.dealers||local.dealers,vehicles:remote.vehicles||local.vehicles,analytics:remote.analytics||local.analytics,sourceMeta:remote.sourceMeta||local.sourceMeta};write(ensure(merged));log('Restored persistent data from GitHub.')}}catch(e){log('GitHub restore skipped: '+e.message)}}
function event(req,b){try{let d=ensure(read()),type=String(b.type||'').slice(0,40);if(!['page_view','vehicle_view','outbound_click','search','filter','dealer_view','install_prompt','push_subscribe'].includes(type))return;let v=d.vehicles.find(x=>x.id===b.vehicleId),dealer=d.dealers.find(x=>x.id===b.dealerId);let session=hash(b.sessionId||crypto.randomUUID()),vehicleName=String(b.vehicleName||v?.title||[v?.year,v?.make,v?.model].filter(Boolean).join(' ')||'').slice(0,200),dealerName=String(b.dealerName||dealer?.name||'').slice(0,200),page=String(b.page||'').slice(0,120);
    // Idempotency: repeated SPA renders/reloads do not inflate page/dealer views for the same session.
    if(['page_view','dealer_view'].includes(type)){
      let cutoff=Date.now()-30*60*1000;
      let duplicate=d.analytics.events.some(e=>e.session===session&&e.type===type&&e.page===page&&e.dealerId===String(b.dealerId||'')&&new Date(e.ts).getTime()>=cutoff);
      if(duplicate)return;
    }
    d.analytics.events.push({ts:new Date().toISOString(),type,vehicleId:String(b.vehicleId||'').slice(0,80),vehicleName,dealerId:String(b.dealerId||'').slice(0,80),dealerName,page,filter:String(b.filter||'').slice(0,1000),session,referrer:String(b.referrer||'').slice(0,250)});if(d.analytics.events.length>100000)d.analytics.events=d.analytics.events.slice(-100000);write(d);schedulePersist()}catch{}}
function startDate(q){let now=new Date(),d=new Date(now);if(q==='day')d.setHours(0,0,0,0);else if(q==='week'){d.setHours(0,0,0,0);d.setDate(d.getDate()-d.getDay())}else if(q==='month'){d.setHours(0,0,0,0);d.setDate(1)}else if(q==='year'){d.setHours(0,0,0,0);d.setMonth(0,1)}else d=new Date(0);return d}
function analytics(q){let d=ensure(read()),ev=d.analytics.events.filter(e=>new Date(e.ts)>=startDate(q.range||'month')&&new Date(e.ts)<=new Date());if(q.dealerId)ev=ev.filter(e=>e.dealerId===q.dealerId);if(q.vehicleId)ev=ev.filter(e=>e.vehicleId===q.vehicleId);let views=ev.filter(e=>e.type==='vehicle_view'),clicks=ev.filter(e=>e.type==='outbound_click'),pages=ev.filter(e=>e.type==='page_view'),dv=ev.filter(e=>e.type==='dealer_view'),m={};[...views,...clicks].forEach(e=>{if(e.vehicleId)m[e.vehicleId]=(m[e.vehicleId]||0)+(e.type==='outbound_click'?3:1)});let vm=new Map(d.vehicles.map(v=>[v.id,v]));return{totalEvents:ev.length,pageViews:pages.length,vehicleViews:views.length,outboundClicks:clicks.length,dealerViews:dv.length,uniqueSessions:new Set(ev.map(e=>e.session)).size,hotVehicles:Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,100).map(([id,score])=>{let v=vm.get(id)||{};return{id,title:v.title||'',dealerId:v.dealerId||'',views:views.filter(e=>e.vehicleId===id).length,clicks:clicks.filter(e=>e.vehicleId===id).length,score,price:v.price,sourceUrl:v.sourceUrl||''}}),recentEvents:ev.slice(-200).reverse()}}
function csv(x){x=String(x??'');return /[",\n]/.test(x)?`"${x.replace(/"/g,'""')}"`:x}
function isLikelyListingUrl(u,dealer){try{let x=new URL(u),base=new URL(dealer.website);if(x.origin===base.origin&&x.pathname.replace(/\/+$/,'')===(base.pathname.replace(/\/+$/,'')||''))return false;if(/\/(cars-for-sale|inventory|used-cars|new-cars|vehicles?|cars?)\/?$/i.test(x.pathname))return false;return likelyVehicleUrl(u)||/stock|vin|listing|\d{4}/i.test(x.pathname+x.search)}catch{return false}}
function findVehicleImageAuthorized(u,d){return d.vehicles.some(v=>(v.images||[]).includes(u))}

app.get('/',(req,res)=>res.send(`<html><head><meta name="viewport" content="width=device-width"><title>Official Cars API</title><style>body{margin:0;background:#06101d;color:#dff6ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:42px;text-align:center;border:1px solid #2b8cff66;border-radius:26px;background:linear-gradient(145deg,#102a44,#07111e);box-shadow:0 30px 100px #0008}a{color:#72d8ff}</style></head><body><main><div style="font-size:44px">⚡</div><h1>Official Cars API</h1><p>Online · live dealer sync · inventory · referral analytics · persistent data</p><p><a href="/health">Health</a> · <a href="/admin">Control Center</a></p></main></body></html>`));
app.get('/health',(req,res)=>res.json({ok:true,service:'official-cars-api',version:'10.0.0',sync:syncState,persistence:{github:!!(GH.token&&GH.owner&&GH.repo),file:GH.file},push:{configured:!!(PUSH.publicKey&&PUSH.privateKey&&webpush)}}));
app.get('/api/public',(req,res)=>{let d=ensure(read());res.json({dealers:d.dealers,vehicles:d.vehicles,sourceMeta:d.sourceMeta||{},pushPublicKey:PUSH.publicKey||'',install:{supported:true}})});
app.post('/api/track',(req,res)=>{event(req,req.body||{});res.status(204).end()});
app.get('/go/:id',(req,res)=>{let d=ensure(read()),v=d.vehicles.find(x=>x.id===req.params.id),dealer=d.dealers.find(x=>x.id===v?.dealerId),target=v?.sourceUrl||v?.url||'';if(!v||!dealer||!target||!hostAllowed(target,dealerDomains(dealer))||!isLikelyListingUrl(target,dealer))return res.status(404).send('Vehicle listing unavailable');event(req,{type:'outbound_click',vehicleId:v.id,vehicleName:v.title,dealerId:v.dealerId,dealerName:dealer.name,page:'vehicle',sessionId:req.query.s||''});res.redirect(302,target)});
app.get('/api/image',async(req,res)=>{let u=String(req.query.url||''),d=ensure(read());if(!findVehicleImageAuthorized(u,d))return res.status(403).end();let vehicle=d.vehicles.find(v=>(v.images||[]).includes(u)),dealer=d.dealers.find(x=>x.id===vehicle?.dealerId);if(!dealer)return res.status(400).end();try{const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),20000);let r=await fetch(u,{headers:{'User-Agent':UA,'Referer':vehicle?.sourceUrl||dealer.website},redirect:'follow',signal:ac.signal});clearTimeout(timer);if(!r.ok)return res.status(r.status).end();let ct=r.headers.get('content-type')||'image/jpeg';if(!ct.startsWith('image/'))return res.status(415).end();res.setHeader('Content-Type',ct);res.setHeader('Cache-Control','public,max-age=604800,stale-while-revalidate=86400');res.send(Buffer.from(await r.arrayBuffer()))}catch{res.status(502).end()}});
app.post('/api/admin/login',(req,res)=>{if(!ADMIN_SECRET||req.body?.password!==ADMIN_SECRET)return res.status(401).json({error:'Invalid password'});res.json({token:token()})});
app.get('/api/sync-status',auth,(req,res)=>{if(syncState.running&&syncState.lastHeartbeat&&Date.now()-new Date(syncState.lastHeartbeat).getTime()>5*60*1000){syncState.running=false;syncState.phase='stale-recovered';syncState.finishedAt=new Date().toISOString();log('Automatic stale-sync recovery triggered after 5 minutes without progress.');schedulePersist()}res.json(syncState)});
app.post('/api/admin/sync-reset',auth,(req,res)=>{if(syncState.running&&syncState.lastHeartbeat&&Date.now()-new Date(syncState.lastHeartbeat).getTime()<5*60*1000)return res.status(409).json({error:'Sync is still within the safety window; wait or inspect its live progress.'});syncState.running=false;syncState.phase='recovered';syncState.finishedAt=new Date().toISOString();syncState.currentUrl=null;log('Admin recovered stale sync state.');schedulePersist();res.json({ok:true,message:'Stale sync state cleared. A new sync can now be started.'})});
app.post('/api/admin/sync',auth,(req,res)=>{if(!syncState.running)syncAll();res.json({ok:true,status:syncState})});
app.post('/api/admin/sync-dealer',auth,(req,res)=>{let d=ensure(read()),dealer=d.dealers.find(x=>x.id===req.body?.dealerId);if(!dealer)return res.status(404).json({error:'Dealer not found'});if(syncState.running)return res.status(409).json({error:'Another sync is already running'});startSyncState(dealer);syncDealer(dealer, String(req.body?.location||'')).then(n=>finishSync(n)).catch(e=>{syncState.errors.push(e.message);syncState.phase='failed';syncState.running=false;syncState.finishedAt=new Date().toISOString();log('FATAL '+e.message);schedulePersist()});res.json({ok:true,dealerId:dealer.id})});
function startSyncState(dealer){syncState={running:true,startedAt:new Date().toISOString(),finishedAt:null,found:0,imported:0,skipped:0,errors:[],log:[],currentDealer:dealer.id,currentUrl:null,totalUrls:0,processed:0,phase:'starting',lastHeartbeat:new Date().toISOString()}}
function finishSync(n){syncState.imported=n;syncState.running=false;syncState.finishedAt=new Date().toISOString();syncState.phase='complete';log(`Sync complete · ${n} vehicles imported.`);schedulePersist()}
async function syncAll(){startSyncState({id:'all'});try{let d=ensure(read());let totalImported=0;for(const dealer of d.dealers.filter(x=>x.enabled!==false)){syncState.currentDealer=dealer.id;let n=await syncDealer(dealer);totalImported+=n;syncState.imported=totalImported}syncState.running=false;syncState.finishedAt=new Date().toISOString();syncState.phase='complete';log('All enabled dealer syncs complete.');schedulePersist()}catch(e){syncState.errors.push(e.message);syncState.running=false;syncState.finishedAt=new Date().toISOString();syncState.phase='failed';log('FATAL '+e.message);schedulePersist()}}
app.get('/api/admin/analytics',auth,(req,res)=>res.json({range:req.query.range||'month',summary:analytics(req.query)}));
app.get('/api/admin/analytics.csv',auth,(req,res)=>{let d=ensure(read()),q=req.query,start=startDate(q.range||'month'),ev=d.analytics.events.filter(e=>new Date(e.ts)>=start&&new Date(e.ts)<=new Date());if(q.dealerId)ev=ev.filter(e=>e.dealerId===q.dealerId);if(q.vehicleId)ev=ev.filter(e=>e.vehicleId===q.vehicleId);let rows=['timestamp,event,vehicle_id,vehicle_name,dealer_id,dealer_name,page,filter,session_hash,referrer'];ev.forEach(e=>rows.push([e.ts,e.type,e.vehicleId,e.vehicleName,e.dealerId,e.dealerName,e.page,e.filter,e.session,e.referrer].map(csv).join(',')));res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=official-cars-analytics.csv');res.send(rows.join('\n'))});
app.get('/api/admin/export',auth,(req,res)=>res.json(read()));
app.post('/api/admin/save',auth,(req,res)=>{if(!req.body||!Array.isArray(req.body.dealers)||!Array.isArray(req.body.vehicles))return res.status(400).json({error:'Invalid data'});write(ensure(req.body));schedulePersist();res.json({ok:true})});
app.post('/api/admin/add-dealer',auth,async(req,res)=>{try{let raw=String(req.body?.url||'').trim();if(!/^https:\/\//i.test(raw))return res.status(400).json({error:"Enter the dealer's HTTPS website URL."});let u=new URL(raw);if(!(await isPublicHost(u.hostname)))return res.status(400).json({error:'That website host could not be verified as a public website.'});u=new URL('/',u.origin);let website=u.href,d=ensure(read()),domains=[u.hostname.toLowerCase()];let html=await fetchText(website,domains),info=businessInfo(website,html),id=crypto.createHash('sha1').update(u.origin).digest('hex').slice(0,12),dealer={id:'dealer-'+id,name:info.name||u.hostname,address:info.address||'',phone:info.phone||'',website,logo:info.logo||'',social:info.social||[],locations:info.locations||[],allowedDomains:domains,enabled:true,createdAt:new Date().toISOString(),lastSyncedAt:null,lastSyncCount:0,syncErrors:0,syncStatus:'added'};dealer.locations=await enrichDealerLocations(dealer,html);let idx=d.dealers.findIndex(x=>x.id===dealer.id),isNewDealer=idx<0;if(idx>=0)d.dealers[idx]={...d.dealers[idx],...dealer};else d.dealers.push(dealer);write(d);schedulePersist();if(isNewDealer)notifyAll({title:'New dealer on Official Cars',body:`${dealer.name} is now a participating dealer.`,url:'https://zayaiken21.github.io/Official-Cars/#/dealers'}).catch(()=>{});res.json({ok:true,dealer})}catch(e){res.status(400).json({error:'Could not read that website: '+e.message})}});
app.get('/api/admin/source/:id',auth,(req,res)=>{let d=ensure(read()),v=d.vehicles.find(x=>x.id===req.params.id),dealer=d.dealers.find(x=>x.id===v?.dealerId),target=v?.sourceUrl||v?.url||'';if(!v||!dealer||!target||!hostAllowed(target,dealerDomains(dealer))||!isLikelyListingUrl(target,dealer))return res.status(404).json({error:'Source listing unavailable'});res.json({ok:true,url:target,dealer:{id:dealer.id,name:dealer.name,website:dealer.website}})});
app.get('/api/push/public-key',(req,res)=>res.json({publicKey:PUSH.publicKey||''}));
app.post('/api/push/subscribe',(req,res)=>{if(!webpush||!PUSH.publicKey||!PUSH.privateKey)return res.status(503).json({error:'Push notifications are not configured on this server.'});let d=ensure(read());d.pushSubscriptions??=[];let sub=req.body?.subscription;if(!sub?.endpoint)return res.status(400).json({error:'Invalid subscription'});d.pushSubscriptions=d.pushSubscriptions.filter(x=>x.endpoint!==sub.endpoint);d.pushSubscriptions.push({endpoint:sub.endpoint,subscription:sub,createdAt:new Date().toISOString()});d.pushSubscriptions=d.pushSubscriptions.slice(-5000);write(d);schedulePersist();res.json({ok:true})});
app.post('/api/admin/test-notification',auth,async(req,res)=>{let n=await notifyAll({title:'Official Cars',body:'Test notification: your Official Cars alerts are working.',url:'https://zayaiken21.github.io/Official-Cars/#/cars'});res.json({ok:true,sent:n})});
async function notifyAll(payload){if(!webpush||!PUSH.publicKey||!PUSH.privateKey)return 0;webpush.setVapidDetails(PUSH.subject,PUSH.publicKey,PUSH.privateKey);let d=ensure(read()),subs=d.pushSubscriptions||[],sent=0,keep=[];for(const s of subs){try{await webpush.sendNotification(s.subscription,JSON.stringify(payload));sent++;keep.push(s)}catch(e){if(![404,410].includes(e.statusCode))keep.push(s)}}d.pushSubscriptions=keep;write(d);schedulePersist();return sent}
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
(async()=>{ensure(read());await restoreGithub();app.listen(PORT,'0.0.0.0',()=>console.log('Official Cars API v8 listening on '+PORT));})();
