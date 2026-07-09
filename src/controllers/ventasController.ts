import { Request, Response } from 'express';
import { taskQueue } from '../queue/memoryQueue';
import { PuppeteerService, VentaRepuestosData } from '../services/puppeteerService';

export class VentasController {

    // Endpoint ASINCRÓNICO — responde 202 inmediato, Puppeteer corre en background (uso producción)
    public static recibirVenta(req: Request, res: Response) {
        const ventaData: VentaRepuestosData = req.body;

        if (!ventaData) return res.status(400).json({ error: 'No se recibieron datos de la venta' });
        if (!ventaData.cliente?.documento) return res.status(400).json({ error: 'Faltan datos del cliente (documento es obligatorio)' });
        if (!ventaData.items || !Array.isArray(ventaData.items) || ventaData.items.length === 0) return res.status(400).json({ error: 'Falta el array de items o está vacío' });
        if (!ventaData.formaPago) ventaData.formaPago = '1';

        taskQueue.enqueue(async () => {
            const result = await PuppeteerService.procesarVentaRepuestos(ventaData);
            if (!result.status) {
                console.error('[DSI Service Queue] Venta falló:', result.msg);
            } else {
                console.log('[DSI Service Queue] Venta procesada:', result.msg);
            }
        });

        return res.status(202).json({
            message: 'Venta recibida y encolada para su procesamiento en DSI',
            status: 'queued',
        });
    }

    // Endpoint SINCRÓNICO — espera el resultado completo de Puppeteer antes de responder (uso testing)
    // POST /api/v1/ventas/repuestos/test
    public static async testVentaSync(req: Request, res: Response) {
        const ventaData: VentaRepuestosData = req.body;

        if (!ventaData) return res.status(400).json({ error: 'No se recibieron datos de la venta' });
        if (!ventaData.cliente?.documento) return res.status(400).json({ error: 'Faltan datos del cliente (documento es obligatorio)' });
        if (!ventaData.items || !Array.isArray(ventaData.items) || ventaData.items.length === 0) return res.status(400).json({ error: 'Falta el array de items o está vacío' });
        if (!ventaData.formaPago) ventaData.formaPago = '1';

        console.log('[DSI Service TEST-SYNC] Iniciando procesamiento sincrónico...');
        const startTime = Date.now();

        const result = await PuppeteerService.procesarVentaRepuestos(ventaData);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[DSI Service TEST-SYNC] Finalizado en ${elapsed}s — status: ${result.status}`);

        return res.status(result.status ? 200 : 500).json({
            status: result.status,
            msg: result.msg,
            elapsed: `${elapsed}s`,
        });
    }
}
