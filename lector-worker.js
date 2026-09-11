const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Definir la tabla destino (Protege tu producción)
// Si no existe la variable en EasyPanel, usa la de pruebas por defecto.
const TABLA_DESTINO = process.env.TARGET_TABLE || 'comprobantes_test';

// Conexiones
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// Pool de API Keys
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_A,
  process.env.GEMINI_KEY_B,
  process.env.GEMINI_KEY_C
].filter(Boolean);

function obtenerClienteGemini() {
  const key = GEMINI_KEYS[Math.floor(Math.random() * GEMINI_KEYS.length)];
  return new GoogleGenerativeAI(key);
}

const PROMPT_IA = `Eres un sistema quirúrgico experto en auditoría y extracción de datos financieros. Tu salida debe ser ÚNICAMENTE un objeto JSON válido, sin bloques de código (\`\`\`json) ni texto adicional.

PASO 1 - REGLA CERO (VALIDACIÓN CRÍTICA):
Analiza visualmente la imagen. ¿Es un comprobante de pago, transferencia bancaria o recibo de exchange/billetera INDIVIDUAL y legible?
- Si la imagen es una selfie, meme, paisaje, chat o es irreconocible -> ES INVÁLIDO.
- Si la imagen es una TABLA, EXCEL, LISTA, o un HISTORIAL con múltiples movimientos -> ES INVÁLIDO.

Si es INVÁLIDO, tu respuesta exacta debe ser:
{
  "valido": false,
  "monto": null,
  "moneda": null,
  "banco": null,
  "referencia": null,
  "titular": null
}

PASO 2 - EXTRACCIÓN QUIRÚRGICA:
Si es VÁLIDO, extrae:
1. "monto": Valor numérico con PUNTO (.) para decimales. Sin comas ni separadores de miles.
2. "moneda": ISO 4217 o ticker cripto en MAYÚSCULAS (Ej: USD, VES, COP, PEN, USDT).
3. "banco": Entidad, exchange o billetera (Ej: BINANCE, YAPE, BANCAMIGA, ZINLI) en MAYÚSCULAS.
4. "referencia": Número de operación o rastreo.
5. "titular": Receptor, cédula/DNI, Nickname o Binance ID en MAYÚSCULAS.

Asigna null a cualquier dato no existente.`;

// Worker Consumidor de Redis
const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const ai = obtenerClienteGemini();
  // OJO: Verifica si es 1.5 o 2.5 según lo que tengas en Google AI Studio
  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' }); 

  const imagePart = {
    inlineData: {
      data: imageBase64,
      mimeType: mimeType || 'image/jpeg'
    }
  };

  const result = await model.generateContent([PROMPT_IA, imagePart]);
  const textoLimpio = result.response.text().replace(/```json|```/g, '').trim();
  
  let resultadoIA;
  try {
    resultadoIA = JSON.parse(textoLimpio);
  } catch (error) {
    console.error(`[Lector Worker Error] La IA no devolvió un JSON válido para ${hash_largo}. Respuesta cruda:`, textoLimpio);
    throw new Error('Respuesta de IA no parseable a JSON'); // Fuerza a que el job pase al evento 'failed'
  }

  if (resultadoIA.valido === true) {
    await pool.query(`
      INSERT INTO ${TABLA_DESTINO} (hash_largo, monto, moneda, banco, referencia, titular, procesado_ia)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      ON CONFLICT (hash_largo) DO UPDATE SET
        monto = EXCLUDED.monto,
        moneda = EXCLUDED.moneda,
        banco = EXCLUDED.banco,
        referencia = EXCLUDED.referencia,
        titular = EXCLUDED.titular,
        procesado_ia = TRUE;
    `, [
      hash_largo,
      resultadoIA.monto ? parseFloat(resultadoIA.monto) : null,
      resultadoIA.moneda,
      resultadoIA.banco,
      resultadoIA.referencia,
      resultadoIA.titular
    ]);

    await pool.query(`UPDATE registros_raw SET estado = 'PROCESADO' WHERE hash_largo = $1`, [hash_largo]);
    console.log(`[Lector Worker OK] Guardado en ${TABLA_DESTINO}: ${hash_largo}`);
  } else {
    await pool.query(`UPDATE registros_raw SET estado = 'DESCARTADO' WHERE hash_largo = $1`, [hash_largo]);
    console.log(`[Lector Worker Descarte] Marcado como no válido: ${hash_largo}`);
  }

}, { connection, concurrency: 2 });

worker.on('failed', async (job, err) => {
  console.error(`[Lector Worker Error] Tarea ${job?.data?.hash_largo} falló:`, err.message);
  if (job?.data?.hash_largo) {
    await pool.query(`UPDATE registros_raw SET estado = 'FALLO' WHERE hash_largo = $1`, [job.data.hash_largo]);
  }
});

console.log(`[Lector Worker Service] Escuchando cola-analisis-ia. Destino configurado: ${TABLA_DESTINO}`);
