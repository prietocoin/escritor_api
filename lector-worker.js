const worker = new Worker('cola-analisis-ia', async (job) => {
  const { hash_largo, imageBase64, mimeType } = job.data;
  console.log(`[Lector Worker] Procesando IA para: ${hash_largo}`);

  const targetTable = process.env.TARGET_TABLE || 'comprobantes_test';

  try {
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 1. Limpieza estricta del String Base64 (Elimina prefijos data:image/...)
    const cleanBase64 = imageBase64.includes(',') 
      ? imageBase64.split(',')[1] 
      : imageBase64;

    const genAI = getRandomGenAI();

    // 2. Pasar el SYSTEM_PROMPT en systemInstruction (igual que n8n)
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

    // 3. Enviar SOLO la parte visual (el modelo ya conoce el prompt de sistema)
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
