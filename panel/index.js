const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. RUTINA LIMPIEZA (Solo RAW)
// ==========================================
async function ejecutarLimpieza48h() {
  try {
    const resRaw = await pool.query(`
      DELETE FROM registros_raw 
      WHERE to_timestamp(
        CASE 
          WHEN timestamp_msg > 9999999999 THEN timestamp_msg / 1000 
          ELSE timestamp_msg 
        END
      ) < NOW() - INTERVAL '48 hours'
    `);
    if (resRaw.rowCount > 0) console.log(`[Limpieza] Purgados ${resRaw.rowCount} registros en registros_raw.`);
  } catch (err) {
    console.error('[Limpieza Error]:', err.message);
  }
}
setInterval(ejecutarLimpieza48h, 30 * 60 * 1000);

// ==========================================
// 2. API ENDPOINTS (Filtrado estricto por instancia)
// ==========================================
app.get('/api/comprobantes', async (req, res) => {
  try {
    const instanciaTarget = req.query.instancia || 'JAIRO';

    // Búsqueda insensible a mayúsculas/minúsculas para evitar descalces
    const query = `
      SELECT 
        hash_largo,
        estado,
        url_imagen,
        timestamp_msg,
        nombre_push,
        usuario_raw,
        usuario_raw_2,
        grupo_raw,
        grupo_raw_2,
        caption,
        instancia
      FROM registros_raw
      WHERE LOWER(instancia) = LOWER($1)
      ORDER BY timestamp_msg DESC
      LIMIT 60
    `;
    const { rows } = await pool.query(query, [instanciaTarget]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Elimina únicamente de registros_raw
app.delete('/api/comprobantes/:hash', async (req, res) => {
  const { hash } = req.params;
  try {
    await pool.query(`DELETE FROM registros_raw WHERE hash_largo = $1`, [hash]);
    res.json({ success: true, hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. DASHBOARD WEB (Solo Imagen y Datos RAW)
// ==========================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría RAW - Panel</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style> body { background-color: #0d131f; } .card-bg { background-color: #161f30; } </style>
</head>
<body class="text-slate-200 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-2">
        <span class="text-2xl">📱</span>
        <div>
          <h1 class="text-xl font-bold text-white tracking-wide">Monitor RAW WhatsApp</h1>
          <p class="text-xs text-slate-400">Instancia: <span id="lbl-instancia" class="text-sky-400 font-bold">JAIRO</span> - Solo imágenes y textos originales</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs font-semibold">
        <span class="bg-slate-800/80 px-3 py-1.5 rounded-full text-slate-300">Total Visualizados: <strong id="c-total" class="text-white">0</strong></span>
      </div>
    </div>

    <div id="grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="col-span-full text-center py-12 text-slate-500">Cargando datos RAW...</div>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const INSTANCIA = urlParams.get('instancia') || 'JAIRO';
    document.getElementById('lbl-instancia').innerText = INSTANCIA;

    async function borrarRegistro(hash) {
      if(!confirm('¿Deseas eliminar este registro?')) return;
      try {
        await fetch('/api/comprobantes/' + hash, { method: 'DELETE' });
        cargar();
      } catch(e) { console.error(e); }
    }

    async function cargar() {
      try {
        const res = await fetch('/api/comprobantes?instancia=' + encodeURIComponent(INSTANCIA));
        const items = await res.json();

        if (!Array.isArray(items)) {
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-rose-400 font-mono text-xs">⚠️ Error: \${items.error || 'Desconocido'}</div>\`;
          return;
        }

        document.getElementById('c-total').innerText = items.length;

        if (items.length === 0) {
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-slate-500">No hay registros RAW recientes para \${INSTANCIA}.</div>\`;
          return;
        }

        const html = items.map(item => {
          const estado = item.estado || 'RECIBIDO';
          
          let badgeColor = 'bg-slate-500/10 text-slate-400 border-slate-500/30';
          if (estado === 'PROCESADO') badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
          if (estado === 'DESCARTADO') badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
          if (estado === 'FALLO') badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/30';

          const badgeHTML = \`<span class="\${badgeColor} border text-[10px] font-bold px-2 py-0.5 rounded-full">\${estado}</span>\`;

          let fechaTexto = 'Sin Fecha';
          if (item.timestamp_msg) {
            const ts = Number(item.timestamp_msg);
            fechaTexto = new Date(ts > 9999999999 ? ts : ts * 1000).toLocaleString('es-ES');
          }

          let imgHTML = '<div class="w-full h-full flex items-center justify-center text-[10px] text-slate-600 font-mono">Sin Imagen</div>';
          if (item.url_imagen) {
            const src = item.url_imagen.startsWith('http') || item.url_imagen.startsWith('data:') 
              ? item.url_imagen 
              : 'data:image/jpeg;base64,' + item.url_imagen;
            imgHTML = \`<img src="\${src}" class="w-full h-full object-cover cursor-pointer hover:scale-105 transition" onclick="window.open(this.src)" title="Click para expandir"/>\`;
          }

          const remitenteNombre = item.nombre_push || 'Anónimo';
          const usuarioID = item.usuario_raw_2 || item.usuario_raw || '';
          const grupoID = item.grupo_raw_2 || item.grupo_raw || null;

          return \`
            <div class="card-bg border border-slate-800 rounded-xl p-4 shadow-lg flex flex-col justify-between space-y-3 hover:border-slate-700 transition">
              
              <div class="flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800/80 pb-2">
                <span title="\${item.hash_largo}">\${item.hash_largo ? item.hash_largo.substring(0, 16) : 'N/A'}...</span>
                <div class="flex items-center gap-2">
                  \${badgeHTML}
                  <button onclick="borrarRegistro('\${item.hash_largo}')" class="text-slate-500 hover:text-rose-400 transition p-1" title="Eliminar registro">🗑️</button>
                </div>
              </div>

              <div class="flex gap-3 items-start">
                <div class="w-28 h-40 bg-slate-900 rounded-lg overflow-hidden border border-slate-800 flex-shrink-0">
                  \${imgHTML}
                </div>
                
                <div class="flex-1 space-y-2 text-xs overflow-hidden">
                  <div class="flex justify-between items-center border-b border-slate-800/50 pb-1">
                    <span class="text-slate-400">Remitente:</span>
                    <span class="font-bold text-sky-400 truncate pl-2" title="\${usuarioID}">\${remitenteNombre}</span>
                  </div>
                  
                  \${grupoID ? \`
                    <div class="flex justify-between items-center border-b border-slate-800/50 pb-1">
                      <span class="text-slate-400">Grupo:</span>
                      <span class="text-slate-300 truncate pl-2" title="\${item.grupo_raw}">\${grupoID}</span>
                    </div>
                  \` : ''}
                  
                  <div class="pt-1">
                    <span class="text-slate-500 text-[10px] block mb-1">Texto (Caption):</span>
                    <div class="bg-slate-900 p-2 rounded text-slate-300 text-[11px] max-h-16 overflow-y-auto italic border border-slate-800">
                      \${item.caption ? item.caption : '<span class="text-slate-600">Sin texto...</span>'}
                    </div>
                  </div>
                </div>
              </div>

              <div class="text-[10px] text-slate-500 font-mono text-right pt-1 border-t border-slate-800/50">
                \${fechaTexto}
              </div>
            </div>
          \`;
        }).join('');

        document.getElementById('grid-container').innerHTML = html;
      } catch(e) { console.error(e); }
    }

    cargar();
    setInterval(cargar, 5000);
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[Panel Service] Activo en puerto ${PORT}`));
