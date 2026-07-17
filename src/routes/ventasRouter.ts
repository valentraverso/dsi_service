import { Router } from 'express';
import { VentasController } from '../controllers/ventasController';

const router = Router();

router.post('/', VentasController.recibirVenta);
router.post('/test', VentasController.testVentaSync); // Síncrono — para testing

export default router;
