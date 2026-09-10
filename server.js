const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.post('/api/v1/raw/escribir-completo', async (req, res) => {
  const {
    hash_corto,
    hash_largo,
    grupo_raw,
    usuario_raw,
    nombre_push,
    caption,
    timestamp_msg,
    imagen_base64 // El archivo viene directo en la petición
  } = req.body;

  if (!hash_largo || !hash_corto) {
    return res.status(400).json({ success: false, error: 'Hashes requeridos' });
  }

  try {
    let urlR2 = null;

    // 1. Guardar la imagen en Storage (R2/S3) si viene en el payload
    if (imagen_base64) {
      const bufferImagen = Buffer.from(imagen_base64, 'base64');
      const form = new FormData();
      form.append('file', bufferImagen, `${hash_corto}.jpg`);

      await axios.post('https://api.jairokov.com/upload', form, {
        headers: { ...form.getHeaders() }
      });

      urlR2 = `https://pub-49b9c87f6e6a418ba42de5ba36ddc73e.r2.dev/${hash_corto}.jpg`;
    }

    // 2. Transacción Atómica en PostgreSQL
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
    console.error('[ESCRITOR ERROR ATÓMICO]', error.message);
    return res.status(500).json({ success: false, error: 'Fallo al guardar registro e imagen' });
  }
});

app.listen(process.env.PORT || 3000);
