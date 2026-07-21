export class NotificationService {
    private static get backendUrl(): string {
        return process.env.BACKEND_URL || 'https://allmotorsgroup.com.ar';
    }

    private static get apiKey(): string {
        return process.env.BACKEND_API_KEY || '';
    }

    /**
     * Envía notificaciones de auditoría de entrada/salida al backend central de AllMotors via native fetch.
     */
    public static async notifyBackend(payload: {
        processName: string;
        category: string;
        status: 'in_progress' | 'success' | 'failed';
        input?: any;
        output?: any;
        error?: string;
        durationMs?: number;
    }): Promise<void> {
        try {
            const endpoint = `${this.backendUrl.replace(/\/$/, '')}/api/v1/notifications/ingest`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (res.ok) {
                console.log(`[NotificationService] Notificación enviada al backend: ${payload.processName} -> ${payload.status}`);
            } else {
                const text = await res.text();
                console.error(`[NotificationService] Respuesta no exitosa del backend (${res.status}): ${text}`);
            }
        } catch (err: any) {
            console.error('[NotificationService] Error notificando al backend:', err.message || String(err));
        }
    }
}
