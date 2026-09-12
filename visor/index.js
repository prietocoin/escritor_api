const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// Selección aleatoria de API Key
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

const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';

  try {
    // Pausa preventiva de 1.5s
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Limpieza de encabezados data:image/... para evitar enviar Base64 corrupto
    const cleanBase64 = imageBase64 && imageBase64.includes(',') 
      ? imageBase64.split(',')[1] 
      : imageBase64;

    if (!cleanBase64) {
      throw new Error('Payload de imagen inválido o sin contenido Base64.');
    }

    const genAI = getRandomGenAI();

    // systemInstruction replica el comportamiento exacto del nodo de n8n
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

// ==========================================
// SERVIDOR WEB EXPRESS (PANEL TEST TEMPORAL)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/comprobantes', async (req, res) => {
  try {
    const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';
    const { rows } = await pool.query(`SELECT * FROM ${targetTable} ORDER BY creado_en DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Validación de Comprobantes Test</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-4">
    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-gray-800 pb-4">
      <div>
        <h1 class="text-xl font-bold text-emerald-400"> Panel Test - Validación Humana</h1>
        <p class="text-xs text-gray-400">Monitoreo visual en tiempo real de <code>comprobantes_test</code></p>
      </div>
      <div class="flex gap-3 text-xs">
        <div class="bg-gray-900 border border-gray-800 px-3 py-1.5 rounded-md">
          Total: <strong id="total-count" class="text-white">0</strong>
        </div>
        <div class="bg-red-950/50 border border-red-800/60 px-3 py-1.5 rounded-md text-red-300">
          Incompletos (null): <strong id="alert-count" class="text-red-400">0</strong>
        </div>
      </div>
    </div>

    <div class="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden shadow-2xl">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-gray-800/80 text-gray-300 uppercase tracking-wider border-b border-gray-700">
              <th class="p-3">Estado</th>
              <th class="p-3">Fecha/Hora</th>
              <th class="p-3">Banco</th>
              <th class="p-3">Monto</th>
              <th class="p-3">Referencia</th>
              <th class="p-3">Titular</th>
              <th class="p-3">Hash</th>
            </tr>
          </thead>
          <tbody id="rows-container" class="divide-y divide-gray-800">
            <tr><td colspan="7" class="p-6 text-center text-gray-500">Cargando registros...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function render() {
      try {
        const res = await fetch('/api/comprobantes');
        const list = await res.json();
        
        let alerts = 0;
        document.getElementById('total-count').innerText = list.length;

        const html = list.map(item => {
          const hasNulls = !item.monto || !item.banco || !item.referencia || !item.titular;
          if (hasNulls) alerts++;

          return \`
            <tr class="hover:bg-gray-800/50 transition \${hasNulls ? 'bg-red-950/20' : ''}">
              <td class="p-3 font-semibold">
                \${hasNulls 
                  ? '<span class="text-red-400 bg-red-950 border border-red-800 px-2 py-0.5 rounded">⚠️ Incompleto</span>' 
                  : '<span class="text-emerald-400 bg-emerald-950 border border-emerald-800 px-2 py-0.5 rounded">✓ OK</span>'}
              </td>
              <td class="p-3 font-mono text-gray-400 text-[11px]">\${new Date(item.creado_en).toLocaleString('es-ES')}</td>
              <td class="p-3 font-semibold \${item.banco ? 'text-sky-300' : 'text-red-400 italic'}">\${item.banco || 'NULL'}</td>
              <td class="p-3 font-bold text-sm \${item.monto ? 'text-emerald-300' : 'text-red-400 italic'}">
                \${item.monto || 'NULL'} <span class="text-xs font-normal text-gray-400">\${item.moneda || ''}</span>
              </td>
              <td class="p-3 font-mono \${item.referencia ? 'text-amber-300 font-bold' : 'text-red-400 italic'}">
                \${item.referencia || 'SIN REF'}
              </td>
              <td class="p-3 text-gray-200 \${!item.titular ? 'text-red-400 italic' : ''}">
                \${item.titular || 'NULL'}
              </td>
              <td class="p-3 font-mono text-gray-500 text-[10px]">\${item.hash_largo.substring(0, 8)}...</td>
            </tr>
          \`;
        }).join('');

        document.getElementById('rows-container').innerHTML = html;
        document.getElementById('alert-count').innerText = alerts;
      } catch (err) {
        console.error(err);
      }
    }

    render();
    setInterval(render, 4000);
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[Visor GUI] Dashboard web disponible en el puerto ${PORT}`));
