const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');

// Verificación de inicio
const rawEvoUrl = process.env.EVOLUTION_URL || 'https://evo.jairokov.com';
const evolutionUrl = rawEvoUrl.replace(/\/$/, ''); // Quita barra final si existe
console.log('[Worker Init] EVOLUTION_URL configurada como:', evolutionUrl);

// Conexión a PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Conexión a Redis
const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// Worker procesador
const worker = new Worker('cola-escritor-atom', async (job) => {
  const {
    hash_corto, hash_largo, grupo_raw, usuario_raw,
    nombre_push, caption, timestamp_msg, es_imagen, instance
  } = job.data;

  let urlR2 = null;

  // Descarga e inserción de imagen
  if (es_imagen) {
    try {
      const evolutionApiKey = process.env.EVOLUTION_APIKEY;
      const targetInstance = instance || 'default';

      const resMedia = await axios.post(
        `${evolutionUrl}/chat/getBase64FromMediaMessage/${targetInstance}`,
        {
          message: { key: { id: hash_largo } },
          convertToMp4: false
        },
        {
          headers: { 'apikey': evolutionApiKey },
          timeout: 10000
        }
      );

      const base64Data = resMedia.data?.base64 || resMedia.data?.mediaBase64;

      if (typeof base64Data === 'string' && base64Data.length > 0) {
        const bufferImagen = Buffer.from(base64Data, 'base64');
        const form = new FormData();
        form.append('file', bufferImagen, `${hash_corto}.jpg`);

        await axios.post('https://api.jairokov.com/upload', form, {
          headers: { ...form.getHeaders() },
          timeout: 10000
        });

        urlR2 = `https://pub-49b9c87f6e6a418ba42de5ba36ddc73e.r2.dev/${hash_corto}.jpg`;
      }
    } catch (err) {
      console.warn(`[Worker Warning] Error media ${hash_corto}:`, err.message);
    }
  }

  // Inserción / Actualización en PostgreSQL
  const queryUpsert = `
    INSERT INTO registros_raw (
      hash_corto, hash_largo, grupo_raw, usuario_raw, nombre_push,
      caption, timestamp_msg, url_imagen, conteo, estado
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'PROCESADO')
    ON CONFLICT (hash_largo) DO UPDATE SET
      conteo = registros_raw.conteo + 1,
      grupo_raw_2 = CASE WHEN registros_raw.grupo_raw <> EXCLUDED.grupo_raw THEN EXCLUDED.grupo_raw ELSE registros_raw.grupo_raw_2 END,
      usuario_raw_2 = CASE WHEN registros_raw.usuario_raw <> EXCLUDED.usuario_raw THEN EXCLUDED.usuario_raw ELSE registros_raw.usuario_raw_2 END,
      url_imagen = COALESCE(EXCLUDED.url_imagen, registros_raw.url_imagen),
      timestamp_msg = EXCLUDED.timestamp_msg,
      estado = 'PROCESADO'
    RETURNING (xmax = 0) AS es_nuevo, hash_corto, conteo;
  `;

  const values = [hash_corto, hash_largo, grupo_raw, usuario_raw, nombre_push, caption, timestamp_msg, urlR2];
  const result = await pool.query(queryUpsert, values);
  console.log(`[Worker] Procesado: ${hash_corto} | Es nuevo: ${result.rows[0].es_nuevo}`);
  return result.rows[0];
}, { connection });

// Captura global de errores de ejecución
worker.on('failed', (job, err) => {
  console.error(`[Worker Error] Tarea ${job?.data?.hash_corto} falló:`, err.message);
});

worker.on('error', (err) => {
  console.error('[Worker Fatal Error]', err.message);
});

console.log('[escritor-worker] Escuchando la cola de Redis...');
