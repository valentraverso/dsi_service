import { Router } from 'express';
import {
    handleCreditechPreapproval,
    handleCreditoArgentinoPreapproval,
    handleCreditoDirectoActionId,
    handleCreditoDirectoConsultar
} from '../controllers/financeController';

const router = Router();

router.post('/creditech', handleCreditechPreapproval);
router.post('/credito-argentino', handleCreditoArgentinoPreapproval);
router.post('/creditodirecto-action-id', handleCreditoDirectoActionId);
router.post('/creditodirecto/consultar', handleCreditoDirectoConsultar);
router.get('/creditodirecto/consultar/:numeroCredito', handleCreditoDirectoConsultar);

export default router;
