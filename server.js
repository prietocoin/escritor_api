const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

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

// Health Check para EasyPanel (Resuelve fallos de comprobación)
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'escritorAtom' });
});

// Endpoint Atómico: Carga de Imagen a R2 + Persistencia PostgreSQL
app.post('/api/v1/raw/escribir-completo', async (req, res) => {
  const {
    hash_corto,
    hash_largo,
    grupo_raw,
    usuario_raw,
    nombre_push,
    caption,
    timestamp_msg,
    imagen_base64
  } = req.body;

  if (!hash_largo || !hash_corto) {
    return res.status(400).json({ success: false, error: 'Hashes requeridos' });
  }

  try {
    let urlR2 = null;

    // 1. Carga de la imagen al Storage (R2)
    if (imagen_base64) {
      const bufferImagen = Buffer.from(imagen_base64, 'base64');
      const form = new FormData();
      form.append('file', bufferImagen, `${hash_corto}.jpg`);

      await axios.post('https://api.jairokov.com/upload', form, {
        headers: { ...form.getHeaders() },
        timeout: 10000 // Maximo 10 segundos de espera
      });

      urlR2 = `https://pub-49b9c87f6e6a418ba42de5ba36ddc73e.r2.dev/${hash_corto}.jpg`;
    }

    // 2. Transacción UPSERT en PostgreSQL
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

    return res.status(200).json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    const detalleError = error.response?.data || error.message;
    console.error('[escritorAtom ERROR]', detalleError);
    return res.status(500).json({ 
      success: false, 
      error: 'Fallo al procesar persistencia', 
      detalle: detalleError 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  initSchema();
  console.log(`[escritorAtom] Servicio escuchando en puerto ${PORT}`);
});
