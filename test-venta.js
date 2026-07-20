/**
 * TEST SINCRÓNICO — DSI Service
 * ================================
 * Ejecutar con: node test-venta.js
 * El proceso espera a que Puppeteer termine y muestra el resultado acá mismo.
 * No necesitás ver otra terminal.
 */

const DSI_SERVICE_URL = 'http://localhost:4000';

const ventaPrueba = {
    cliente: {
        documento: '99999999',
        nombre: 'test',
        apellido: 'test',
        email: 'prueba@test.com',
    },
    items: [
        {
            codigo: 'R6400-K92-001',
            cantidad: 1,
            precioUnitario: 20000,
        }
    ],
    formaPago: '106',   // 106 = Mercado Pago
    montoTotal: 20000,
    pagoData: {
        numero: '1234',
        fecha: '08/07/2026',
        nombre: 'test',
        apellido: 'test'
    },
    sucursalId: '2',
};

async function main() {
    console.log('='.repeat(55));
    console.log('  TEST DSI SERVICE — VENTA DE REPUESTOS (SYNC)');
    console.log('='.repeat(55));
    console.log(`  URL:  ${DSI_SERVICE_URL}`);
    console.log(`  Hora: ${new Date().toLocaleString('es-AR')}`);
    console.log('='.repeat(55));

    // 1. Health check
    console.log('\n📡 Verificando que el servicio esté UP...');
    const health = await fetch(`${DSI_SERVICE_URL}/health`).catch(() => null);
    if (!health || health.status !== 200) {
        console.error('❌ El servicio no está corriendo. Iniciá: npm run dev');
        process.exit(1);
    }
    console.log('   ✅ Servicio UP\n');

    // 2. Test sincrónico — espera el resultado completo de Puppeteer
    console.log('🤖 Lanzando Puppeteer (puede tardar 1-2 minutos)...');
    console.log('   Payload:', JSON.stringify(ventaPrueba, null, 4));
    console.log('\n   ⏳ Esperando resultado...\n');

    const startTime = Date.now();

    const res = await fetch(`${DSI_SERVICE_URL}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ventaPrueba),
    }).catch(err => { console.error('❌ Error de red:', err.message); process.exit(1); });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const textData = await res.text();
    let data;
    try {
        data = JSON.parse(textData);
    } catch (e) {
        console.log('Error parsing JSON. Raw response:', textData);
        process.exit(1);
    }

    console.log('='.repeat(55));
    console.log(`  RESULTADO (${elapsed}s)`);
    console.log('='.repeat(55));
    console.log(`  HTTP Status : ${res.status}`);
    console.log(`  Éxito       : ${data.status ? '✅ SÍ' : '❌ NO'}`);
    console.log(`  Mensaje     : ${data.msg}`);
    console.log(`  Tiempo      : ${data.elapsed}`);
    console.log('='.repeat(55));

    process.exit(data.status ? 0 : 1);
}

main().catch(err => {
    console.error('\n❌ Error inesperado:', err.message);
    process.exit(1);
});
