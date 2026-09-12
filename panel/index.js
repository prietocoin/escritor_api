const express = require('express');
const { Pool } = require('pg');

// Conexión a PostgreSQL
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
// 1. RUTINA DE MANTENIMIENTO AUTOMÁTICO
// ==========================================
async function ejecutarLimpieza48h() {
  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
  try {
    // 1. Borra comprobantes procesados antiguos (48h)
    const resTest = await pool.query(
      `DELETE FROM ${targetTable} WHERE creado_en < NOW() - INTERVAL '48 hours'`
    );

    // 2. Borra raw antiguos (48h ajustado al formato timestamp_msg)
    const resRaw = await pool.query(`
      DELETE FROM registros_raw 
      WHERE to_timestamp(
        CASE 
          WHEN timestamp_msg > 9999999999 THEN timestamp_msg / 1000 
          ELSE timestamp_msg 
        END
      ) < NOW() - INTERVAL '48 hours'
    `);

    // 3. Purga inmediata de texto plano o registros sin imagen
    const resSinImagen = await pool.query(
      `DELETE FROM registros_raw WHERE url_imagen IS NULL OR url_imagen = ''`
    );

    if (resRaw.rowCount > 0 || resTest.rowCount > 0 || resSinImagen.rowCount > 0) {
      console.log(`[Panel Purga OK] Purgados: ${resTest.rowCount} en ${targetTable}, ${resRaw.rowCount} en registros_raw y ${resSinImagen.rowCount} vacíos/texto.`);
    }
  } catch (err) {
    console.error('[Panel Purga Error]:', err.message);
  }
}
// Ejecutar cada 30 minutos
setInterval(ejecutarLimpieza48h, 30 * 60 * 1000);
// Ejecutar una vez al arrancar
ejecutarLimpieza48h();

// ==========================================
// 2. API ENDPOINTS
// ==========================================

// Endpoint de diagnóstico para revisar columnas
app.get('/api/esquema', async (req, res) => {
  try {
    const query = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'registros_raw';
    `;
    const { rows } = await pool.query(query);
    res.json({ mensaje: "Columnas reales en registros_raw", columnas: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Principal: Cruce de datos Raw + IA (Filtrado por Instancia JAIRO)
app.get('/api/comprobantes', async (req, res) => {
  try {
    const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
    
    const query = `
      SELECT 
        r.hash_largo,
        CASE 
          WHEN r.url_imagen IS NULL OR r.url_imagen = '' THEN 'DESCARTADO'
          WHEN c.hash_largo IS NULL AND r.estado = 'PROCESADO' THEN 'DESCARTADO'
          ELSE COALESCE(r.estado, 'DESCARTADO')
        END AS estado,
        r.url_imagen,
        r.timestamp_msg,
        r.nombre_push,
        r.usuario_raw,
        r.usuario_raw_2,
        r.grupo_raw,
        r.grupo_raw_2,
        r.caption,
        c.monto,
        c.moneda,
        c.banco,
        c.referencia,
        c.titular,
        c.creado_en
      FROM registros_raw r
      LEFT JOIN ${targetTable} c ON r.hash_largo = c.hash_largo
      WHERE (
        r.usuario_raw ILIKE '%JAIRO%' 
        OR r.usuario_raw_2 ILIKE '%JAIRO%' 
        OR r.grupo_raw ILIKE '%JAIRO%' 
        OR r.grupo_raw_2 ILIKE '%JAIRO%'
        OR r.nombre_push ILIKE '%JAIRO%'
      )
      ORDER BY r.timestamp_msg DESC NULLS LAST
      LIMIT 60
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('[API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API Eliminar Registro manualmente
app.delete('/api/comprobantes/:hash', async (req, res) => {
  const { hash } = req.params;
  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
  try {
    await pool.query(`DELETE FROM ${targetTable} WHERE hash_largo = $1`, [hash]);
    await pool.query(`DELETE FROM registros_raw WHERE hash_largo = $1`, [hash]);
    res.json({ success: true, hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. DASHBOARD WEB (Interfaz Gráfica)
// ==========================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría Visor IA</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style> body { background-color: #0d131f; } .card-bg { background-color: #161f30; } </style>
</head>
<body class="text-slate-200 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <!-- Topbar -->
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-2">
        <span class="text-2xl">🎟️</span>
        <div>
          <h1 class="text-xl font-bold text-white tracking-wide">Auditoría Visor IA</h1>
          <p class="text-xs text-slate-400">Instancia JAIRO - Raw + Extracción IA</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs font-semibold">
        <span class="bg-slate-800/80 px-3 py-1.5 rounded-full text-slate-300">Total: <strong id="c-total" class="text-white">0</strong></span>
        <span class="bg-emerald-950 border border-emerald-800/80 text-emerald-400 px-3 py-1.5 rounded-full">Procesados: <strong id="c-procesados">0</strong></span>
        <span class="bg-rose-950 border border-rose-800/80 text-rose-400 px-3 py-1.5 rounded-full">Fallos: <strong id="c-fallos">0</strong></span>
        <span class="bg-amber-950 border border-amber-800/80 text-amber-400 px-3 py-1.5 rounded-full">Descartados: <strong id="c-descartados">0</strong></span>
      </div>
    </div>

    <!-- Grid Container -->
    <div id="grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="col-span-full text-center py-12 text-slate-500">Cargando datos...</div>
    </div>
  </div>

  <script>
    async function borrarRegistro(hash) {
      if(!confirm('¿Deseas eliminar este registro permanentemente?')) return;
      try {
        await fetch('/api/comprobantes/' + hash, { method: 'DELETE' });
        cargar();
      } catch(e) { console.error(e); }
    }

    async function cargar() {
      try {
        const res = await fetch('/api/comprobantes');
        const items = await res.json();

        if (!Array.isArray(items)) {
          document.getElementById('c-total').innerText = '0';
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-rose-400 font-mono text-xs">⚠️ Error: \${items.error || 'Desconocido'}</div>\`;
          return;
        }

        let procesados = 0, fallos = 0, descartados = 0;
        document.getElementById('c-total').innerText = items.length;

        if (items.length === 0) {
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-slate-500">No hay comprobantes de JAIRO en las últimas 48 horas.</div>\`;
          return;
        }

        const html = items.map(item => {
          const estado = item.estado || 'DESCARTADO';
          if (estado === 'PROCESADO') procesados++;
          else if (estado === 'FALLO') fallos++;
          else descartados++;

          let badgeHTML = '';
          if (estado === 'PROCESADO') badgeHTML = '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">✓ PROCESADO</span>';
          else if (estado === 'DESCARTADO') badgeHTML = '<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">🚫 DESCARTADO</span>';
          else badgeHTML = '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">❌ FALLO</span>';

          // Formateo de fecha
          let fechaTexto = 'Sin Fecha';
          if (item.creado_en) {
            fechaTexto = new Date(item.creado_en).toLocaleString('es-ES');
          } else if (item.timestamp_msg) {
            const ts = Number(item.timestamp_msg);
            fechaTexto = new Date(ts > 9999999999 ? ts : ts * 1000).toLocaleString('es-ES');
          }

          // Formateo de imagen
          let imgHTML = '<div class="w-full h-full flex items-center justify-center text-[10px] text-slate-600 font-mono">Sin Imagen</div>';
          if (item.url_imagen) {
            const src = item.url_imagen.startsWith('http') || item.url_imagen.startsWith('data:') 
              ? item.url_imagen 
              : 'data:image/jpeg;base64,' + item.url_imagen;
            imgHTML = \`<img src="\${src}" class="w-full h-full object-cover cursor-pointer hover:scale-105 transition" onclick="window.open(this.src)" title="Click para abrir imagen"/>\`;
          }

          // Fallbacks para datos RAW
          const remitenteNombre = item.nombre_push || 'Anónimo';
          const usuarioID = item.usuario_raw_2 || item.usuario_raw || '';
          const grupoID = item.grupo_raw_2 || item.grupo_raw || null;

          return \`
            <div class="card-bg border border-slate-800 rounded-xl p-4 shadow-lg flex flex-col justify-between space-y-3 hover:border-slate-700 transition">
              
              <!-- Header -->
              <div class="flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800/80 pb-2">
                <span title="\${item.hash_largo}">\${item.hash_largo ? item.hash_largo.substring(0, 16) : 'N/A'}...</span>
                <div class="flex items-center gap-2">
                  \${badgeHTML}
                  <button onclick="borrarRegistro('\${item.hash_largo}')" class="text-slate-500 hover:text-rose-400 transition p-1" title="Eliminar registro">🗑️</button>
                </div>
              </div>

              <!-- Body -->
              <div class="flex gap-3 items-start">
                <!-- Imagen -->
                <div class="w-24 h-36 bg-slate-900 rounded-lg overflow-hidden border border-slate-800 flex-shrink-0">
                  \${imgHTML}
                </div>
                
                <!-- Detalles -->
                <div class="flex-1 space-y-2 text-xs overflow-hidden">
                  
                  <!-- Info RAW WhatsApp -->
                  <div class="bg-slate-900/70 p-2 rounded border border-slate-800/70 space-y-1 font-mono text-[10px]">
                    <div class="flex justify-between items-center">
                      <span class="text-slate-400 font-sans">Remitente:</span>
                      <span class="font-bold text-sky-400 truncate max-w-[110px]" title="\${remitenteNombre} (\${usuarioID})">
                        \${remitenteNombre}
                      </span>
                    </div>

                    \${grupoID ? \`
                      <div class="flex justify-between items-center text-slate-400">
                        <span class="font-sans">Grupo:</span>
                        <span class="text-slate-300 truncate max-w-[110px]" title="\${grupoID}">\${grupoID}</span>
                      </div>
                    \` : ''}

                    \${item.caption ? \`
                      <div class="text-[9px] text-slate-300 italic truncate pt-0.5 border-t border-slate-800/50" title="\${item.caption}">
                        "\${item.caption}"
                      </div>
                    \` : ''}
                  </div>

                  <!-- Info IA -->
                  <div class="space-y-1">
                    <div class="flex justify-between items-baseline">
                      <span class="text-slate-400 font-medium">Monto:</span>
                      <span class="font-bold text-sm \${item.monto ? 'text-emerald-400' : 'text-slate-500 italic'}">
                        \${item.monto ? item.monto + ' ' + (item.moneda||'') : 'N/A'}
                      </span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-slate-400">Banco:</span>
                      <span class="font-semibold text-slate-200 truncate max-w-[110px]">\${item.banco || '—'}</span>
                    </div>
                    <div class="flex justify-between font-mono text-[11px]">
                      <span class="text-slate-400">Ref:</span>
                      <span class="text-amber-300 font-bold truncate max-w-[110px]">\${item.referencia || '—'}</span>
                    </div>
                  </div>

                </div>
              </div>

              <!-- Footer -->
              <div class="text-[10px] text-slate-500 font-mono text-right pt-1 border-t border-slate-800/50">
                \${fechaTexto}
              </div>

            </div>
          \`;
        }).join('');

        document.getElementById('grid-container').innerHTML = html;
        document.getElementById('c-procesados').innerText = procesados;
        document.getElementById('c-fallos').innerText = fallos;
        document.getElementById('c-descartados').innerText = descartados;
      } catch(e) { console.error(e); }
    }

    cargar();
    setInterval(cargar, 5000);
  </script>
</body>
</html>
  `);
});

// Iniciar servidor
app.listen(PORT, () => console.log(`[Panel Service] Activo en puerto ${PORT}`));
