const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// 1. Conexión a Base de Datos PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// 2. Conexión a Redis
const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// Selección aleatoria de API Key para Gemini
function getRandomGenAI() {
  const keysString = process.env.GEMINI_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = keysString.split(',').map(k => k.trim()).filter(Boolean);

  if (keys.length === 0) {
    throw new Error('No se ha configurado ninguna API Key válida.');
  }

  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  return new GoogleGenerativeAI(randomKey);
}

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

if (!SYSTEM_PROMPT) {
  console.warn('[Lector Worker Warning] SYSTEM_PROMPT no está definido en las variables de entorno.');
}

// 3. Worker de Análisis con IA y Persistencia
const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';

  try {
    await new Promise(resolve => setTimeout(resolve, 1500));

    const cleanBase64 = imageBase64 && imageBase64.includes(',') 
      ? imageBase64.split(',')[1] 
      : imageBase64;

    if (!cleanBase64) {
      throw new Error('Payload de imagen inválido o sin contenido Base64.');
    }

    const genAI = getRandomGenAI();

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash-lite',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: 'application/json' }
    });

    const imagePart = {
      inlineData: {
        data: cleanBase64.trim(),
        mimeType: mimeType || 'image/jpeg'
      }
    };

    const result = await model.generateContent([imagePart]);
    const responseText = result.response.text();
    const data = JSON.parse(responseText);

    if (data.valido === true) {
      await pool.query(
        `INSERT INTO ${targetTable} (hash_largo, monto, moneda, banco, referencia, titular, creado_en)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (hash_largo) DO NOTHING`,
        [hash_largo, data.monto, data.moneda, data.banco, data.referencia, data.titular]
      );

      await pool.query(`UPDATE registros_raw SET estado = 'PROCESADO' WHERE hash_largo = $1`, [hash_largo]);
      console.log(`[Lector Worker OK] Guardado en ${targetTable}: ${hash_largo}`);
    } else {
      await pool.query(`UPDATE registros_raw SET estado = 'DESCARTADO' WHERE hash_largo = $1`, [hash_largo]);
      console.log(`[Lector Worker] Registro descartado: ${hash_largo}`);
    }

  } catch (err) {
    console.error(`[Lector Worker Error] Tarea ${hash_largo} falló:`, err.message);
    await pool.query(`UPDATE registros_raw SET estado = 'FALLO' WHERE hash_largo = $1`, [hash_largo]);
    throw err;
  }
}, { connection, concurrency: 2 });

console.log('[Lector Worker Service] Escuchando tareas de análisis IA...');

// 4. Rutina de Autodestrucción a las 48 Horas
async function ejecutarLimpieza48h() {
  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
  try {
    const resTest = await pool.query(
      `DELETE FROM ${targetTable} WHERE creado_en < NOW() - INTERVAL '48 hours'`
    );
    const resRaw = await pool.query(
      `DELETE FROM registros_raw WHERE creado_en < NOW() - INTERVAL '48 hours'`
    );
    if (resRaw.rowCount > 0 || resTest.rowCount > 0) {
      console.log(`[Autodestrucción 48h] Purgados ${resTest.rowCount} registros en ${targetTable} y ${resRaw.rowCount} en registros_raw.`);
    }
  } catch (err) {
    console.error('[Autodestrucción Error]:', err.message);
  }
}
ejecutarLimpieza48h();
setInterval(ejecutarLimpieza48h, 30 * 60 * 1000);

// 5. Servidor Web Express y API REST
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// API: Obtener registros unificados con imagen y datos
app.get('/api/comprobantes', async (req, res) => {
  try {
    const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
    const query = `
      SELECT 
        r.hash_largo,
        r.estado,
        r.imagen_base64,
        r.creado_en,
        c.monto,
        c.moneda,
        c.banco,
        c.referencia,
        c.titular
      FROM registros_raw r
      LEFT JOIN ${targetTable} c ON r.hash_largo = c.hash_largo
      ORDER BY r.creado_en DESC
      LIMIT 60
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('[API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Eliminar manualmente un registro (Base de datos y estado)
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

// Interfaz Gráfica de Auditoría
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría Visor IA</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0d131f; }
    .card-bg { background-color: #161f30; }
  </style>
</head>
<body class="text-slate-200 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <!-- Header -->
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-2">
        <span class="text-2xl">🎟️</span>
        <h1 class="text-xl font-bold text-white tracking-wide">Auditoría Visor IA</h1>
      </div>
      
      <div class="flex flex-wrap items-center gap-3 text-xs font-semibold">
        <span class="bg-slate-800/80 px-3 py-1.5 rounded-full text-slate-300">Total: <strong id="c-total" class="text-white">0</strong></span>
        <span class="bg-emerald-950 border border-emerald-800/80 text-emerald-400 px-3 py-1.5 rounded-full">Procesados: <strong id="c-procesados">0</strong></span>
        <span class="bg-rose-950 border border-rose-800/80 text-rose-400 px-3 py-1.5 rounded-full">Fallos: <strong id="c-fallos">0</strong></span>
        <span class="bg-amber-950 border border-amber-800/80 text-amber-400 px-3 py-1.5 rounded-full">Descartados: <strong id="c-descartados">0</strong></span>
      </div>
    </div>

    <!-- Grid de Tarjetas -->
    <div id="grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="col-span-full text-center py-12 text-slate-500">Cargando comprobantes...</div>
    </div>

  </div>

  <script>
    async function borrarRegistro(hash) {
      if(!confirm('¿Deseas eliminar este registro de la base de datos?')) return;
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
          document.getElementById('grid-container').innerHTML = \`
            <div class="col-span-full text-center py-12 text-rose-400 font-mono text-xs">
              ⚠️ Error en base de datos: \${items.error || 'Respuesta inesperada'}
            </div>\`;
          return;
        }

        let procesados = 0, fallos = 0, descartados = 0;
        document.getElementById('c-total').innerText = items.length;

        if (items.length === 0) {
          document.getElementById('grid-container').innerHTML = \`
            <div class="col-span-full text-center py-12 text-slate-500">
              No hay comprobantes registrados en las últimas 48 horas.
            </div>\`;
          return;
        }

        const html = items.map(item => {
          const estado = item.estado || 'PROCESADO';
          if (estado === 'PROCESADO') procesados++;
          else if (estado === 'FALLO') fallos++;
          else if (estado === 'DESCARTADO') descartados++;

          let badgeHTML = '';
          if (estado === 'PROCESADO') {
            badgeHTML = '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">✓ PROCESADO</span>';
          } else if (estado === 'DESCARTADO') {
            badgeHTML = '<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">🚫 DESCARTADO</span>';
          } else {
            badgeHTML = '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">❌ FALLO</span>';
          }

          const imgSrc = item.imagen_base64 
            ? (item.imagen_base64.startsWith('data:') ? item.imagen_base64 : 'data:image/jpeg;base64,' + item.imagen_base64)
            : 'https://via.placeholder.com/150?text=Sin+Imagen';

          return \`
            <div class="card-bg border border-slate-800 rounded-xl p-4 shadow-lg relative flex flex-col justify-between space-y-3 hover:border-slate-700 transition">
              
              <!-- Card Header -->
              <div class="flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800/80 pb-2">
                <span title="\${item.hash_largo}">\${item.hash_largo ? item.hash_largo.substring(0, 16) : 'N/A'}...</span>
                <div class="flex items-center gap-2">
                  \${badgeHTML}
                  <button onclick="borrarRegistro('\${item.hash_largo}')" class="text-slate-500 hover:text-rose-400 transition p-1" title="Eliminar registro">
                    🗑️
                  </button>
                </div>
              </div>

              <!-- Card Body -->
              <div class="flex gap-3 items-center">
                <!-- Thumbnail -->
                <div class="w-24 h-28 bg-slate-900 rounded-lg overflow-hidden border border-slate-800 flex-shrink-0">
                  <img src="\${imgSrc}" class="w-full h-full object-cover cursor-pointer" onclick="window.open(this.src)" title="Click para ampliar"/>
                </div>

                <!-- Detalle -->
                <div class="flex-1 space-y-1.5 text-xs">
                  <div class="flex justify-between items-baseline">
                    <span class="text-slate-400 font-medium">Monto:</span>
                    <span class="font-bold text-sm \${item.monto ? 'text-emerald-400' : 'text-slate-500 italic'}">
                      \${item.monto ? item.monto + ' ' + (item.moneda||'') : 'N/A'}
                    </span>
                  </div>

                  <div class="flex justify-between">
                    <span class="text-slate-400">Banco:</span>
                    <span class="font-semibold text-slate-200 truncate max-w-[120px]">\${item.banco || '—'}</span>
                  </div>

                  <div class="flex justify-between">
                    <span class="text-slate-400">Titular:</span>
                    <span class="text-slate-300 truncate max-w-[120px]" title="\${item.titular||''}">\${item.titular || '—'}</span>
                  </div>

                  <div class="flex justify-between font-mono text-[11px]">
                    <span class="text-slate-400">Ref:</span>
                    <span class="text-sky-400 font-bold truncate max-w-[120px]">\${item.referencia || '—'}</span>
                  </div>
                </div>
              </div>

              <!-- Card Footer -->
              <div class="text-[10px] text-slate-500 font-mono text-right pt-1 border-t border-slate-800/50">
                \${item.creado_en ? new Date(item.creado_en).toLocaleString('es-ES') : ''}
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

app.listen(PORT, () => console.log(`[Visor GUI] Dashboard web activo en el puerto ${PORT}`));
