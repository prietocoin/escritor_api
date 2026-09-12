const express = require('express');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const app = express();
app.use(express.json({ limit: '10mb' }));

const connection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

const colaMensajes = new Queue('cola-escritor-atom', { connection });

app.get('/', (req, res) => res.status(200).json({ status: 'ok', service: 'escritor-api' }));

app.post('/api/v1/webhook/whatsapp', async (req, res) => {
  // Responde 200 OK inmediatamente a la fuente
  res.status(200).json({ status: 'processing' });

  try {
    // Normaliza la entrada si viene envuelta en un arreglo desde n8n
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    
    const data = body.data || body;
    const key = data.key || {};
    const message = data.message || {};

    const hash_largo = key.id || body.hash_largo;
    if (!hash_largo) return;

    // Payload ultra-liviano para Redis
    const payload = {
      hash_largo,
      hash_corto: body.hash_corto || (hash_largo.length >= 8 ? hash_largo.slice(-8) : hash_largo),
      grupo_raw: key.remoteJid || body.grupo_raw || '',
      usuario_raw: key.participantAlt || key.participant || key.remoteJid || body.usuario_raw || '',
      nombre_push: data.pushName || body.nombre_push || 'Desconocido',
      caption: message.imageMessage?.caption || message.conversation || message.extendedTextMessage?.text || body.caption || '',
      timestamp_msg: Number(data.messageTimestamp || body.timestamp_msg || Math.floor(Date.now() / 1000)),
      es_imagen: Boolean(body.es_imagen || body.imagen_base64 || message.imageMessage),
      instance: body.instance || data.instance || 'default'
    };

    await colaMensajes.add('procesar-mensaje', payload, {
      removeOnComplete: true,
      attempts: 3,
      backoff: 2000
    });
  } catch (error) {
    console.error('[API Error]', error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[escritor-api] Escuchando en puerto ${PORT}`);
});
