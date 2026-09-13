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

// 1. RUTINA LIMPIEZA (48 horas)
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

// 2. ENDPOINTS API

// Obtener la lista de todas las instancias activas en la BD
app.get('/api/instancias', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT LOWER(instancia) as instancia 
      FROM registros_raw 
      WHERE instancia IS NOT NULL AND instancia <> ''
      ORDER BY instancia ASC
    `);
    res.json(rows.map(r => r.instancia));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener comprobantes filtrados por instancia
app.get('/api/comprobantes', async (req, res) => {
  try {
    const instanciaTarget = req.query.instancia || 'JAIRO';

    const query = `
      SELECT 
        hash_largo,
        hash_imagen,
        estado,
        url_imagen,
        timestamp_msg,
        nombre_push,
        usuario_raw,
        usuario_raw_2,
        grupo_raw,
        grupo_raw_2,
        caption,
        instancia,
        conteo
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

// Eliminar un registro de registros_raw
app.delete('/api/comprobantes/:hash', async (req, res) => {
  const { hash } = req.params;
  try {
    await pool.query(`DELETE FROM registros_raw WHERE hash_largo = $1 OR hash_imagen = $1`, [hash]);
    res.json({ success: true, hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. DASHBOARD WEB CON SELECTOR DE INSTANCIAS
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría RAW - Multi-Instancia</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style> body { background-color: #0d131f; } .card-bg { background-color: #161f30; } </style>
</head>
<body class="text-slate-200 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <!-- BARRA SUPERIOR CON SELECTOR -->
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-3">
        <span class="text-3xl">📱</span>
        <div>
          <h1 class="text-xl font-bold text-white tracking-wide">Monitor RAW WhatsApp</h1>
          <p class="text-xs text-slate-400">Filtrado inteligente por cliente / instancia</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <!-- SELECTOR DE INSTANCIAS -->
        <div class="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5">
          <label for="select-instancia" class="text-xs font-semibold text-slate-400">Instancia:</label>
          <select id="select-instancia" onchange="cambiarInstancia(this.value)" class="bg-transparent text-sky-400 font-bold text-sm focus:outline-none cursor-pointer">
            <option value="JAIRO" class="bg-slate-900 text-white">JAIRO</option>
          </select>
        </div>

        <span class="bg-slate-800/80 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300 border border-slate-700">
          Hashes Únicos: <strong id="c-total" class="text-white">0</strong>
        </span>
      </div>
    </div>

    <div id="grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="col-span-full text-center py-12 text-slate-500">Cargando datos RAW...</div>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    let INSTANCIA_ACTUAL = urlParams.get('instancia') || 'JAIRO';

    // Cargar selector dinámico de instancias desde la BD
    async function cargarInstancias() {
      try {
        const res = await fetch('/api/instancias');
        const lista = await res.json();
        
        if (Array.isArray(lista) && lista.length > 0) {
          const select = document.getElementById('select-instancia');
          
          // Asegurar que la instancia actual esté en la lista
          const setInstancias = new Set([...lista, INSTANCIA_ACTUAL.toLowerCase()]);
          
          select.innerHTML = Array.from(setInstancias).map(inst => {
            const nombre = inst.toUpperCase();
            const selected = inst.toLowerCase() === INSTANCIA_ACTUAL.toLowerCase() ? 'selected' : '';
            return \`<option value="\${nombre}" \${selected} class="bg-slate-900 text-white">\${nombre}</option>\`;
          }).join('');
        }
      } catch (e) { console.error('Error cargando instancias:', e); }
    }

    function cambiarInstancia(nuevaInstancia) {
      INSTANCIA_ACTUAL = nuevaInstancia;
      window.history.pushState({}, '', '?instancia=' + encodeURIComponent(nuevaInstancia));
      cargar();
    }

    async function borrarRegistro(hash) {
      if(!confirm('¿Deseas eliminar este registro?')) return;
      try {
        await fetch('/api/comprobantes/' + hash, { method: 'DELETE' });
        cargar();
      } catch(e) { console.error(e); }
    }

    async function cargar() {
      try {
        const res = await fetch('/api/comprobantes?instancia=' + encodeURIComponent(INSTANCIA_ACTUAL));
        const items = await res.json();

        if (!Array.isArray(items)) {
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-rose-400 font-mono text-xs">⚠️ Error: \${items.error || 'Desconocido'}</div>\`;
          return;
        }

        document.getElementById('c-total').innerText = items.length;

        if (items.length === 0) {
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-slate-500">No hay registros RAW recientes para \${INSTANCIA_ACTUAL.toUpperCase()}.</div>\`;
          return;
        }

        const html = items.map(item => {
          const estado = item.estado || 'RECIBIDO';
          const totalConteo = item.conteo || 1;
          
          let badgeColor = 'bg-slate-500/10 text-slate-400 border-slate-500/30';
          if (estado === 'PROCESADO') badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
          if (estado === 'DESCARTADO') badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
          if (estado === 'FALLO') badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/30';

          const badgeHTML = \`<span class="\${badgeColor} border text-[10px] font-bold px-2 py-0.5 rounded-full">\${estado}</span>\`;
          const conteoHTML = \`<span class="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 text-[10px] font-black px-2 py-0.5 rounded-full">\${totalConteo}x</span>\`;

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

          const remitentes = [item.nombre_push || item.usuario_raw];
          if (item.usuario_raw_2 && item.usuario_raw_2 !== item.usuario_raw) remitentes.push(item.usuario_raw_2);

          const grupos = [];
          if (item.grupo_raw) grupos.push(item.grupo_raw);
          if (item.grupo_raw_2 && item.grupo_raw_2 !== item.grupo_raw) grupos.push(item.grupo_raw_2);

          const idBorrado = item.hash_imagen || item.hash_largo;

          return \`
            <div class="card-bg border border-slate-800 rounded-xl p-4 shadow-lg flex flex-col justify-between space-y-3 hover:border-slate-700 transition">
              
              <div class="flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800/80 pb-2">
                <span title="\${item.hash_largo}">\${item.hash_largo ? item.hash_largo.substring(0, 16) : 'N/A'}...</span>
                <div class="flex items-center gap-1.5">
                  \${conteoHTML}
                  \${badgeHTML}
                  <button onclick="borrarRegistro('\${idBorrado}')" class="text-slate-500 hover:text-rose-400 transition p-1 ml-1" title="Eliminar registro">🗑️</button>
                </div>
              </div>

              <div class="flex gap-3 items-start">
                <div class="w-28 h-44 bg-slate-900 rounded-lg overflow-hidden border border-slate-800 flex-shrink-0">
                  \${imgHTML}
                </div>
                
                <div class="flex-1 space-y-2 text-xs overflow-hidden">
                  
                  <div class="border-b border-slate-800/50 pb-1.5">
                    <span class="text-slate-400 text-[10px] block font-semibold mb-0.5">Remitente(s):</span>
                    \${remitentes.map((r, i) => \`
                      <div class="font-bold text-sky-400 truncate text-[11px]" title="\${r}">
                        \${remitentes.length > 1 ? (i + 1) + '. ' : ''}\${r}
                      </div>
                    \`).join('')}
                  </div>
                  
                  <div class="border-b border-slate-800/50 pb-1.5">
                    <span class="text-slate-400 text-[10px] block font-semibold mb-0.5">Grupo / JID:</span>
                    \${grupos.length > 0 ? grupos.map((g, i) => \`
                      <div class="text-slate-300 truncate font-mono text-[10px]" title="\${g}">
                        \${grupos.length > 1 ? (i + 1) + '. ' : ''}\${g}
                      </div>
                    \`).join('') : '<span class="text-slate-600 text-[10px]">Directo (Sin grupo)</span>'}
                  </div>
                  
                  <div>
                    <span class="text-slate-500 text-[10px] block mb-0.5 font-semibold">Texto (Caption):</span>
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

    cargarInstancias();
    cargar();
    setInterval(cargar, 5000);
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[Panel Service] Activo en puerto ${PORT}`));
