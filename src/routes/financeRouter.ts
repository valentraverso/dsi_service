import { Router } from 'express';
import {
    handleCreditechPreapproval,
    handleCreditoArgentinoPreapproval,
    handleCreditoDirectoActionId
} from '../controllers/financeController';

const router = Router();

router.post('/creditech', handleCreditechPreapproval);
router.post('/credito-argentino', handleCreditoArgentinoPreapproval);
router.post('/creditodirecto-action-id', handleCreditoDirectoActionId);

export default router;
