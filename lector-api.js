const { Pool } = require('pg');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');

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

const colaIA = new Queue('cola-analisis-ia', { connection });

// Flag para evitar solapamiento de ejecuciones
let estaProcesando = false;

async function extraerYEncolar() {
  if (estaProcesando) {
    console.log('[Lector API] Omite ciclo: el proceso anterior aún sigue activo.');
    return;
  }

  estaProcesando = true;
  const client = await pool.connect();

  try {
    // 1. Caducar registros huérfanos con casteo seguro ::bigint
    await client.query(`
      UPDATE registros_raw
      SET estado = 'CADUCADO'
      WHERE conteo = 1
        AND timestamp_msg::bigint < (EXTRACT(EPOCH FROM NOW()) - 86400)
        AND (estado IS NULL OR estado = 'PENDIENTE');
    `);

    // 2. Leer registros pendientes
    const { rows: cola } = await client.query(`
      SELECT c.hash_largo, c.url_imagen
      FROM registros_raw c
      LEFT JOIN comprobantes_fb f ON c.hash_largo = f.hash_largo
      WHERE f.hash_largo IS NULL 
        AND c.url_imagen IS NOT NULL 
        AND c.url_imagen LIKE 'http%'
        AND c.conteo > 1
        AND c.timestamp_msg::bigint >= (EXTRACT(EPOCH FROM NOW()) - 86400)
        AND (c.estado IS NULL OR c.estado = 'PENDIENTE')
      LIMIT 10;
    `);

    if (cola.length === 0) return;

    console.log(`[Lector API] Procesando ${cola.length} registro(s) pendientes...`);

    for (const item of cola) {
      try {
        // 3. Descargar imagen desde R2
        const res = await axios.get(item.url_imagen, {
          responseType: 'arraybuffer',
          timeout: 10000
        });

        const imageBase64 = Buffer.from(res.data).toString('base64');
        const mimeType = res.headers['content-type'] || 'image/jpeg';

        // 4. Publicar la tarea en la cola de Redis
        await colaIA.add('analizar-comprobante', {
          hash_largo: item.hash_largo,
          url_imagen: item.url_imagen,
          imageBase64,
          mimeType
        }, {
          removeOnComplete: true,
          removeOnFail: 100
        });

        // 5. Marcar como EN_COLA para liberar la consulta de lectura
        await client.query(`UPDATE registros_raw SET estado = 'EN_COLA' WHERE hash_largo = $1`, [item.hash_largo]);
        console.log(`[Lector API OK] Encolado correctamente: ${item.hash_largo}`);

      } catch (err) {
        console.error(`[Lector API Error] Falló descarga de ${item.hash_largo}:`, err.message);
        await client.query(`UPDATE registros_raw SET estado = 'FALLO' WHERE hash_largo = $1`, [item.hash_largo]);
      }
    }

  } catch (error) {
    console.error('[Lector API Fatal Error]:', error.message);
  } finally {
    client.release();
    estaProcesando = false;
  }
}

// Programación de ciclo
setInterval(extraerYEncolar, 5 * 1000);
extraerYEncolar();
console.log('[Lector API Service] Escaneando PostgreSQL y encolando en Redis...');
