const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const app = express();
app.use(express.json({ limit: '50mb' }));

// 1. Configuración de PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// 2. Configuración de Redis y Cola BullMQ
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

const connection = new Redis(redisConfig);
const colaMensajes = new Queue('cola-escritor-atom', { connection });

// Auto-inicialización del esquema de base de datos
async function initSchema() {
  const query = `
    CREATE TABLE IF NOT EXISTS registros_raw (
      hash_largo VARCHAR(255) PRIMARY KEY,
      hash_corto VARCHAR(20),
      grupo_raw VARCHAR(100),
      usuario_raw VARCHAR(100),
      nombre_push VARCHAR(150),
      caption TEXT,
      conteo INT DEFAULT 1,
      grupo_raw_2 VARCHAR(100),
      usuario_raw_2 VARCHAR(100),
      url_imagen TEXT,
      timestamp_msg BIGINT,
      estado VARCHAR(50) DEFAULT 'PROCESADO'
    );
    CREATE INDEX IF NOT EXISTS idx_raw_hash ON registros_raw(hash_corto);
  `;
  try {
    await pool.query(query);
    console.log('[escritorAtom] Esquema verificado/creado exitosamente.');
  } catch (err) {
    console.error('[escritorAtom] Error al inicializar esquema:', err.message);
  }
}

// Health Check para EasyPanel
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'escritorAtom', queue: 'active' });
});

// 3. Endpoint ultrarrápido: Recibe la petición y la encola en Redis
app.post('/api/v1/raw/escribir-completo', async (req, res) => {
  const { hash_corto, hash_largo } = req.body;

  if (!hash_largo || !hash_corto) {
    return res.status(400).json({ success: false, error: 'Hashes requeridos' });
  }

  try {
    // Agrega el trabajo a la cola de Redis
    const job = await colaMensajes.add('procesar-mensaje', req.body, {
      removeOnComplete: true, // Limpia memoria al terminar
      attempts: 3,            // Reintenta 3 veces si falla
      backoff: 2000          // Espera 2 segundos entre reintentos
    });

    return res.status(200).json({
      success: true,
      message: 'Mensaje encolado en Redis correctamente',
      jobId: job.id
    });
  } catch (error) {
    console.error('[escritorAtom Error Encolar]', error.message);
    return res.status(500).json({ success: false, error: 'Fallo al agregar a la cola' });
  }
});

// 4. Worker en segundo plano: Procesa los trabajos de Redis hacia R2 y Postgres
const worker = new Worker('cola-escritor-atom', async (job) => {
  const {
    hash_corto,
    hash_largo,
    grupo_raw,
    usuario_raw,
    nombre_push,
    caption,
    timestamp_msg,
    imagen_base64
  } = job.data;

  let urlR2 = null;

  // Subida de imagen a R2
  if (imagen_base64) {
    const bufferImagen = Buffer.from(imagen_base64, 'base64');
    const form = new FormData();
    form.append('file', bufferImagen, `${hash_corto}.jpg`);

    await axios.post('https://api.jairokov.com/upload', form, {
      headers: { ...form.getHeaders() },
      timeout: 10000
    });

    urlR2 = `https://pub-49b9c87f6e6a418ba42de5ba36ddc73e.r2.dev/${hash_corto}.jpg`;
  }

  // Transacción UPSERT en PostgreSQL
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
    RETURNING (xmax = 0) AS es_nuevo, hash_corto, conteo, url_imagen;
  `;

  const values = [
    hash_corto, hash_largo, grupo_raw, usuario_raw, 
    nombre_push, caption, timestamp_msg, urlR2
  ];

  const result = await pool.query(queryUpsert, values);
  console.log(`[Worker] Procesado Hash: ${hash_corto} | Es nuevo: ${result.rows[0].es_nuevo}`);
  return result.rows[0];

}, { connection });

worker.on('failed', (job, err) => {
  console.error(`[Worker Error] Trabajo ${job.id} falló:`, err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  initSchema();
  console.log(`[escritorAtom] Servicio escuchando en puerto ${PORT}`);
});
