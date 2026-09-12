const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// API REST para obtener raw + IA cruzados
app.get('/api/comprobantes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        r.hash_largo,
        r.url_imagen,
        r.estado AS estado_raw,
        r.timestamp_msg,
        c.monto,
        c.moneda,
        c.banco,
        c.referencia,
        c.titular,
        c.creado_en AS fecha_procesado
      FROM registros_raw r
      LEFT JOIN comprobantes_test c ON r.hash_largo = c.hash_largo
      ORDER BY r.timestamp_msg::bigint DESC
      LIMIT 100;
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Servir la interfaz HTML del Visor
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditoría de Comprobantes - Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen pb-12">
  <header class="sticky top-0 z-30 bg-slate-800/95 backdrop-blur border-b border-slate-700 px-4 py-3 shadow-md">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-3">
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-receipt text-indigo-400 text-2xl"></i>
        <h1 class="font-bold text-lg text-white">Auditoría Visor IA</h1>
      </div>
      <div class="flex gap-2 text-xs font-semibold">
        <span id="badge-total" class="bg-slate-700 text-slate-200 px-2.5 py-1 rounded-full">Total: 0</span>
        <span id="badge-ok" class="bg-emerald-950 text-emerald-400 border border-emerald-800 px-2.5 py-1 rounded-full">Procesados: 0</span>
        <span id="badge-fail" class="bg-rose-950 text-rose-400 border border-rose-800 px-2.5 py-1 rounded-full">Fallos: 0</span>
        <span id="badge-discard" class="bg-amber-950 text-amber-400 border border-amber-800 px-2.5 py-1 rounded-full">Descartados: 0</span>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 mt-6">
    <div class="flex flex-col sm:flex-row gap-3 mb-6">
      <div class="relative flex-1">
        <i class="fa-solid fa-magnifying-glass absolute left-3 top-3.5 text-slate-400 text-sm"></i>
        <input type="text" id="searchInput" placeholder="Buscar por banco, titular, referencia o hash..." 
          class="w-full pl-9 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition">
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1">
        <button onclick="setFilter('ALL')" class="filter-btn active bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition">Todos</button>
        <button onclick="setFilter('PROCESADO')" class="filter-btn bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition">Procesados</button>
        <button onclick="setFilter('FALLO')" class="filter-btn bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition">Fallos</button>
        <button onclick="setFilter('DESCARTADO')" class="filter-btn bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition">Descartados</button>
      </div>
    </div>

    <div id="cardsGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>
  </main>

  <div id="imageModal" class="fixed inset-0 z-50 bg-black/90 hidden backdrop-blur-sm flex items-center justify-center p-2" onclick="closeModal()">
    <div class="relative max-w-4xl max-h-full flex flex-col items-center justify-center" onclick="event.stopPropagation()">
      <button onclick="closeModal()" class="absolute -top-10 right-0 text-white text-2xl hover:text-rose-400">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <img id="modalImg" src="" class="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl border border-slate-700">
      <div class="mt-2 text-center">
        <a id="modalLink" href="" target="_blank" class="text-xs text-indigo-400 hover:underline"><i class="fa-solid fa-arrow-up-right-from-square"></i> Abrir imagen original</a>
      </div>
    </div>
  </div>

  <script>
    let dataList = [];
    let currentFilter = 'ALL';
    let searchQuery = '';

    async function loadData() {
      try {
        const res = await fetch('/api/comprobantes');
        const json = await res.json();
        if (json.success) {
          dataList = json.data;
          render();
        }
      } catch (err) {
        console.error('Error cargando datos:', err);
      }
    }

    function render() {
      updateBadges();
      const grid = document.getElementById('cardsGrid');
      grid.innerHTML = '';

      const filtered = dataList.filter(item => {
        const matchesFilter = currentFilter === 'ALL' || item.estado_raw === currentFilter;
        const matchesSearch = !searchQuery || 
          (item.hash_largo && item.hash_largo.toLowerCase().includes(searchQuery)) ||
          (item.banco && item.banco.toLowerCase().includes(searchQuery)) ||
          (item.titular && item.titular.toLowerCase().includes(searchQuery)) ||
          (item.referencia && item.referencia.toLowerCase().includes(searchQuery));
        return matchesFilter && matchesSearch;
      });

      filtered.forEach(item => {
        grid.appendChild(createCard(item));
      });
    }

    function createCard(item) {
      const card = document.createElement('div');
      card.className = "bg-slate-800 border border-slate-700 rounded-xl overflow-hidden flex flex-col justify-between shadow-lg hover:border-slate-600 transition";
      const statusBadge = getStatusBadge(item.estado_raw);
      const imageSrc = item.url_imagen || 'https://via.placeholder.com/400x300?text=Sin+Imagen';

      card.innerHTML = \`
        <div>
          <div class="p-3 bg-slate-800/80 border-b border-slate-700/50 flex justify-between items-center">
            <span class="text-[10px] font-mono text-slate-400 truncate max-w-[180px]" title="\${item.hash_largo}">
              \${item.hash_largo}
            </span>
            \${statusBadge}
          </div>
          <div class="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
            <div class="sm:col-span-1 relative group cursor-pointer overflow-hidden rounded-lg border border-slate-700 bg-slate-950 h-36 flex items-center justify-center" onclick="openModal('\${imageSrc}')">
              <img src="\${imageSrc}" class="object-cover h-full w-full group-hover:scale-105 transition duration-300" loading="lazy">
              <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition text-white text-xs gap-1 font-semibold">
                <i class="fa-solid fa-magnifying-glass-plus"></i> Ver
              </div>
            </div>
            <div class="sm:col-span-2 space-y-1.5 text-xs">
              <div class="flex justify-between items-baseline border-b border-slate-700/50 pb-1">
                <span class="text-slate-400">Monto:</span>
                <span class="text-base font-bold text-emerald-400">\${item.monto ? \`\${item.monto} \${item.moneda || ''}\` : '<i class="text-slate-500 font-normal">N/A</i>'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400">Banco:</span>
                <span class="font-medium text-slate-200 truncate max-w-[140px]">\${item.banco || '—'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400">Titular:</span>
                <span class="font-medium text-slate-200 truncate max-w-[140px]">\${item.titular || '—'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400">Referencia:</span>
                <span class="font-mono text-indigo-300 font-semibold">\${item.referencia || '—'}</span>
              </div>
            </div>
          </div>
        </div>
      \`;
      return card;
    }

    function getStatusBadge(status) {
      if (status === 'PROCESADO') return \`<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold px-2 py-0.5 rounded-full"><i class="fa-solid fa-circle-check mr-1"></i>PROCESADO</span>\`;
      if (status === 'FALLO') return \`<span class="bg-rose-500/10 text-rose-400 border border-rose-500/20 text-[10px] font-bold px-2 py-0.5 rounded-full"><i class="fa-solid fa-circle-xmark mr-1"></i>FALLO</span>\`;
      if (status === 'DESCARTADO') return \`<span class="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold px-2 py-0.5 rounded-full"><i class="fa-solid fa-ban mr-1"></i>DESCARTADO</span>\`;
      return \`<span class="bg-slate-700 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">\${status}</span>\`;
    }

    function updateBadges() {
      document.getElementById('badge-total').innerText = \`Total: \${dataList.length}\`;
      document.getElementById('badge-ok').innerText = \`Procesados: \${dataList.filter(d=>d.estado_raw==='PROCESADO').length}\`;
      document.getElementById('badge-fail').innerText = \`Fallos: \${dataList.filter(d=>d.estado_raw==='FALLO').length}\`;
      document.getElementById('badge-discard').innerText = \`Descartados: \${dataList.filter(d=>d.estado_raw==='DESCARTADO').length}\`;
    }

    function setFilter(type) {
      currentFilter = type;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-600', 'text-white');
        btn.classList.add('bg-slate-800', 'text-slate-300');
      });
      event.target.classList.remove('bg-slate-800', 'text-slate-300');
      event.target.classList.add('bg-indigo-600', 'text-white');
      render();
    }

    function openModal(url) {
      document.getElementById('modalImg').src = url;
      document.getElementById('modalLink').href = url;
      document.getElementById('imageModal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('imageModal').classList.add('hidden');
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      render();
    });

    window.onload = loadData;
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`[Visor Service] Dashboard activo en puerto ${port}`);
});
