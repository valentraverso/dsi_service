import puppeteer from 'puppeteer';

export class CreditoDirectoService {
    private baseUrl = "https://www.creditodirecto.com.ar";

    async getActionId(): Promise<string | null> {
        console.log("[dsi_service] [Directo] Action ID caducado. Levantando navegador táctico en dsi_service...");

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            });

            const page = await browser.newPage();
            await page.goto(`${this.baseUrl}/login`, { waitUntil: 'networkidle2' });

            const html = await page.content();
            const actionIdRegex = /[a-f0-9]{40,50}/g;
            let match = html.match(actionIdRegex);

            if (match && match.length > 0) {
                console.log(`[dsi_service] [Directo] Nuevo Action ID robado: ${match[0]}`);
                return match[0];
            }

            console.log("[dsi_service] [Directo] ❌ No se pudo encontrar el Action ID en el HTML.");
            return null;
        } catch (error: any) {
            console.error(`[dsi_service] [Directo] Error en extractor Puppeteer: ${error.message}`);
            return null;
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditoDirectoService();
