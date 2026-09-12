const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Función para seleccionar una API Key al azar entre GEMINI_KEYS (o fallback a GEMINI_API_KEY)
function getRandomGenAI() {
  const keysString = process.env.GEMINI_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = keysString.split(',').map(k => k.trim()).filter(Boolean);
  
  if (keys.length === 0) {
    throw new Error('No se ha configurado ninguna API Key válida.');
  }

  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  return new GoogleGenerativeAI(randomKey);
}

// Lee el prompt directamente del entorno
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

if (!SYSTEM_PROMPT) {
  console.warn('[Lector Worker Warning] SYSTEM_PROMPT no está definido en las variables de entorno.');
}

const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';

  try {
    // 1. Pausa de 1.5s DENTRO de la función async para prevenir el error 429
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 2. Instancia dinámicamente Gemini usando una clave aleatoria
    const genAI = getRandomGenAI();
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: mimeType || 'image/jpeg'
      }
    };

    const result = await model.generateContent([SYSTEM_PROMPT, imagePart]);
    const responseText = result.response.text();
    const data = JSON.parse(responseText);

    if (data.valido === true) {
      // Guardar extracción exitosa
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
      console.log(`[Lector Worker] Registro descartado (No es comprobante): ${hash_largo}`);
    }

  } catch (err) {
    console.error(`[Lector Worker Error] Tarea ${hash_largo} falló:`, err.message);
    await pool.query(`UPDATE registros_raw SET estado = 'FALLO' WHERE hash_largo = $1`, [hash_largo]);
    throw err;
  }
}, { connection, concurrency: 2 });

console.log('[Lector Worker Service] Escuchando tareas de análisis IA...');
