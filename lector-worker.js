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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `Eres un sistema quirúrgico experto en auditoría y extracción de datos financieros. Tu salida debe ser ÚNICAMENTE un objeto JSON válido, sin bloques de código (\`\`\`json) ni texto adicional.

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
Si la imagen APRUEBA la validación (es un comprobante válido), extrae los datos aplicando estas reglas estrictas:

1. "monto": Extrae SOLO el valor numérico. Usa PUNTO (.) para decimales. PROHIBIDO usar separadores de miles o comas. (Ejemplo correcto: 20312.58).
2. "moneda": Código ISO 4217 o ticker cripto en MAYÚSCULAS (Ej: USD, VES, COP, PEN, USDT).
3. "banco": Nombre de la entidad, exchange o billetera (Ej: BINANCE, YAPE, BANCAMIGA, ZINLI). Prioriza el texto sobre el logo. TODO EN MAYÚSCULAS.
4. "referencia": Número de operación, recibo o rastreo.
5. "titular": Nombre del receptor, documento de identidad, Nickname, Pay ID o Binance ID. TODO EN MAYÚSCULAS.

Si algún dato (2, 3, 4, 5) no existe en la imagen, asigna el valor null (sin comillas).`;

const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';

  try {
    // Configuración del modelo Gemini con salida JSON forzada
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
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
      // Guardar extracción exitosa en la tabla de destino
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
}, { connection, concurrency: 3 });

console.log('[Lector Worker Service] Escuchando tareas de análisis IA...');
