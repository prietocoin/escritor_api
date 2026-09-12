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
// HERRAMIENTA DE DIAGNÓSTICO (IDEA TUYA)
// ==========================================
// Visita: tu-dominio.com/api/esquema
app.get('/api/esquema', async (req, res) => {
  try {
    const query = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'registros_raw';
    `;
    const { rows } = await pool.query(query);
    res.json({
      mensaje: "Columnas reales en tu tabla registros_raw",
      columnas: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rutina de autodestrucción (48 Horas)
async function ejecutarLimpieza48h() {
  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
  try {
    const resTest = await pool.query(`DELETE FROM ${targetTable} WHERE creado_en < NOW() - INTERVAL '48 hours'`);
    // temporalmente desactivamos el borrado raw hasta saber qué columna de fecha usar
    // const resRaw = await pool.query(`DELETE FROM registros_raw WHERE creado_en < NOW() - INTERVAL '48 hours'`);
  } catch (err) {
    console.error('[Panel Purga Error]:', err.message);
  }
}
setInterval(ejecutarLimpieza48h, 30 * 60 * 1000);

// API UNIFICADA SEGURA
app.get('/api/comprobantes', async (req, res) => {
  try {
    const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
    
    // Usamos c.creado_en para evitar el crash de r.creado_en
    const query = `
      SELECT 
        r.hash_largo,
        r.estado,
        c.creado_en AS fecha_raw,
        c.monto,
        c.moneda,
        c.banco,
        c.referencia,
        c.titular
      FROM registros_raw r
      LEFT JOIN ${targetTable} c ON r.hash_largo = c.hash_largo
      ORDER BY c.creado_en DESC NULLS LAST
      LIMIT 50
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('[API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API Eliminar Registro
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

// DASHBOARD UNIFICADO
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría Unificada Visor IA</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style> body { background-color: #0d131f; } .card-bg { background-color: #161f30; } </style>
</head>
<body class="text-slate-200 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-2">
        <span class="text-2xl">🎟️</span>
        <div>
          <h1 class="text-xl font-bold text-white tracking-wide">Auditoría Visor IA</h1>
          <p class="text-xs text-slate-400">Estado Raw + Extracción IA en una sola vista</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs font-semibold">
        <span class="bg-slate-800/80 px-3 py-1.5 rounded-full text-slate-300">Total: <strong id="c-total" class="text-white">0</strong></span>
        <span class="bg-emerald-950 border border-emerald-800/80 text-emerald-400 px-3 py-1.5 rounded-full">Procesados: <strong id="c-procesados">0</strong></span>
        <span class="bg-rose-950 border border-rose-800/80 text-rose-400 px-3 py-1.5 rounded-full">Fallos: <strong id="c-fallos">0</strong></span>
        <span class="bg-amber-950 border border-amber-800/80 text-amber-400 px-3 py-1.5 rounded-full">Descartados: <strong id="c-descartados">0</strong></span>
      </div>
    </div>
    <div id="grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="col-span-full text-center py-12 text-slate-500">Cargando datos unificados...</div>
    </div>
  </div>

  <script>
    async function borrarRegistro(hash) {
      if(!confirm('¿Deseas eliminar este registro de ambas tablas?')) return;
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
          document.getElementById('grid-container').innerHTML = \`<div class="col-span-full text-center py-12 text-slate-500">No hay comprobantes en la BD.</div>\`;
          return;
        }

        const html = items.map(item => {
          const estado = item.estado || 'PROCESADO';
          if (estado === 'PROCESADO') procesados++;
          else if (estado === 'FALLO') fallos++;
          else if (estado === 'DESCARTADO') descartados++;

          let badgeHTML = '';
          if (estado === 'PROCESADO') badgeHTML = '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">✓ PROCESADO</span>';
          else if (estado === 'DESCARTADO') badgeHTML = '<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">🚫 DESCARTADO</span>';
          else badgeHTML = '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">❌ FALLO</span>';

          const fechaTexto = item.fecha_raw 
            ? new Date(item.fecha_raw).toLocaleString('es-ES') 
            : 'Esperando validación...';

          return \`
            <div class="card-bg border border-slate-800 rounded-xl p-4 shadow-lg flex flex-col justify-between space-y-3 hover:border-slate-700 transition">
              <!-- Encabezado con Hash y Estado -->
              <div class="flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800/80 pb-2">
                <span title="\${item.hash_largo}">\${item.hash_largo ? item.hash_largo.substring(0, 16) : 'N/A'}...</span>
                <div class="flex items-center gap-2">
                  \${badgeHTML}
                  <button onclick="borrarRegistro('\${item.hash_largo}')" class="text-slate-500 hover:text-rose-400 transition p-1" title="Eliminar de la BD">🗑️</button>
                </div>
              </div>

              <!-- Cuerpo: Extracción de comprobantes_test -->
              <div class="space-y-1.5 text-xs">
                <div class="flex justify-between items-baseline">
                  <span class="text-slate-400 font-medium">Monto:</span>
                  <span class="font-bold text-sm \${item.monto ? 'text-emerald-400' : 'text-slate-500 italic'}">
                    \${item.monto ? item.monto + ' ' + (item.moneda||'') : 'N/A'}
                  </span>
                </div>
                <div class="flex justify-between">
                  <span class="text-slate-400">Banco:</span>
                  <span class="font-semibold text-slate-200 truncate max-w-[140px]">\${item.banco || '—'}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-slate-400">Titular:</span>
                  <span class="text-slate-300 truncate max-w-[140px]">\${item.titular || '—'}</span>
                </div>
                <div class="flex justify-between font-mono text-[11px]">
                  <span class="text-slate-400">Ref:</span>
                  <span class="text-sky-400 font-bold truncate max-w-[140px]">\${item.referencia || '—'}</span>
                </div>
              </div>

              <!-- Pie: Timestamp -->
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

app.listen(PORT, () => console.log(`[Panel Service] Activo en puerto ${PORT}`));
