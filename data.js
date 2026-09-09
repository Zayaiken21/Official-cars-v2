window.OFFICIAL_CARS = { dealers: [], vehicles: [] };
async function loadOfficialCars(){
  try { const r=await fetch('/api/inventory'); if(r.ok){ window.OFFICIAL_CARS=await r.json(); return; } } catch(e){}
  try { const r=await fetch('data.json'); if(r.ok){ const d=await r.json(); window.OFFICIAL_CARS=d; } } catch(e){}
}
