import { Request, Response } from 'express';
import creditechService from '../services/financieras/creditechService';
import creditoArgentinoService from '../services/financieras/creditoArgentinoService';
import creditoDirectoService from '../services/financieras/creditoDirectoService';

export const handleCreditechPreapproval = async (req: Request, res: Response): Promise<void> => {
    try {
        const { dni, gender, user, pass } = req.body;
        if (!dni) {
            res.status(400).json({ approved: false, msg: 'DNI es requerido.' });
            return;
        }

        const result = await creditechService.getPreapproval(dni, gender || 'M', user, pass);
        res.status(200).json(result);
    } catch (error: any) {
        res.status(500).json({ approved: false, msg: error.message || 'Error en dsi_service Creditech' });
    }
};

export const handleCreditoArgentinoPreapproval = async (req: Request, res: Response): Promise<void> => {
    try {
        const { dni, gender, user, pass, phone } = req.body;
        if (!dni) {
            res.status(400).json({ approved: false, msg: 'DNI es requerido.' });
            return;
        }

        const result = await creditoArgentinoService.getPreapproval(dni, gender || 'M', user, pass, phone);
        res.status(200).json(result);
    } catch (error: any) {
        res.status(500).json({ approved: false, msg: error.message || 'Error en dsi_service Crédito Argentino' });
    }
};

export const handleCreditoDirectoActionId = async (req: Request, res: Response): Promise<void> => {
    try {
        const actionId = await creditoDirectoService.getActionId();
        res.status(200).json({ actionId });
    } catch (error: any) {
        res.status(500).json({ actionId: null, error: error.message });
    }
};

export const handleCreditoDirectoConsultar = async (req: Request, res: Response): Promise<void> => {
    try {
        const numeroCredito = req.body?.numeroCredito || req.params?.numeroCredito || req.query?.numeroCredito;
        const user = req.body?.user;
        const pass = req.body?.pass;

        if (!numeroCredito) {
            res.status(400).json({ success: false, msg: 'Número de crédito es requerido.' });
            return;
        }

        const result = await creditoDirectoService.consultarCredito(String(numeroCredito), user, pass);
        res.status(200).json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, msg: error.message || 'Error al consultar Crédito Directo' });
    }
};
