import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ventasRouter from './routes/ventasRouter';
import financeRouter from './routes/financeRouter';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Rutas
app.use('/', ventasRouter);
app.use('/finance', financeRouter);

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'dsi_service' });
});

app.listen(PORT, () => {
    console.log(`DSI Service running on port ${PORT}`);
    console.log(`In-memory queue & Finance Puppeteer Scrapers ready.`);
});
