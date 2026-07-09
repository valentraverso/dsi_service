import { Router } from 'express';
import { VentasController } from '../controllers/ventasController';

const router = Router();

router.post('/repuestos', VentasController.recibirVenta);
router.post('/repuestos/test', VentasController.testVentaSync); // Síncrono — para testing

export default router;
