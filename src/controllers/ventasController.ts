import { Request, Response } from 'express';
import { taskQueue } from '../queue/memoryQueue';
import { PuppeteerService, VentaRepuestosData } from '../services/puppeteerService';
import { NotificationService } from '../services/notificationService';

export class VentasController {

    // Endpoint ASINCRÓNICO — responde 202 inmediato, Puppeteer corre en background (uso producción)
    public static recibirVenta(req: Request, res: Response) {
        const ventaData: VentaRepuestosData = req.body;

        if (!ventaData) return res.status(400).json({ error: 'No se recibieron datos de la venta' });
        if (!ventaData.cliente?.documento) return res.status(400).json({ error: 'Faltan datos del cliente (documento es obligatorio)' });
        if (!ventaData.items || !Array.isArray(ventaData.items) || ventaData.items.length === 0) return res.status(400).json({ error: 'Falta el array de items o está vacío' });
        if (!ventaData.formaPago) ventaData.formaPago = '1';

        // Notificar entrada al servicio (en cola)
        NotificationService.notifyBackend({
            processName: "DSI_RECEPCION_VENTA",
            category: "DSI",
            status: "in_progress",
            input: {
                orderId: ventaData.pagoData?.numero,
                clienteDocumento: ventaData.cliente.documento,
                itemsCount: ventaData.items.length,
                montoTotal: ventaData.montoTotal
            }
        });

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

    public static async getPaymentMethods(req: Request, res: Response) {
        try {
            console.log('[DSI Service] Obteniendo formas de pago disponibles en DSI...');
            const options = await PuppeteerService.getPaymentMethods();
            return res.status(200).json({ success: true, options });
        } catch (e: any) {
            console.error('[DSI Service] Error obteniendo formas de pago:', e);
            return res.status(500).json({ success: false, error: e.message || String(e) });
        }
    }
}
