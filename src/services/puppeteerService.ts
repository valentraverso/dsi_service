import puppeteer, { Browser, Page } from 'puppeteer';

const DSI_BASE = 'http://52.21.150.76/concesionario';
const DSI_LOGIN_URL = `${DSI_BASE}/index.aspx`;
const DSI_NOVEDADES_URL = `${DSI_BASE}/Novedades/frmNovedades.aspx`;
const DSI_VENTA_URL = `${DSI_BASE}/Productos/Venta/frmVentaA.aspx?origen=0`;

export interface ItemVenta {
    codigo: string;
    cantidad: number;
    precioUnitario?: number; // Si se envía, se intenta setear el precio antes de agregar al carrito
}

export interface ClienteVenta {
    documento: string;
    nombre: string;
    apellido?: string;
    email?: string;
    telefono?: string;
}

export interface VentaRepuestosData {
    cliente: ClienteVenta;
    items: ItemVenta[];
    formaPago?: string;        // '1' = Efectivo (default), '106' = Mercado Pago
    montoTotal?: number;       // Si se envía, se usa este valor como monto de pago (en vez de leerlo del server)
    pagoData?: {
        numero?: string;       // N° transacción
        fecha?: string;        // dd/mm/yyyy — default: hoy
        nombre?: string;
        apellido?: string;
    };
    sucursalId?: string;
}

export class PuppeteerService {
    /**
     * Procesa una venta de repuestos de mostrador en DSI usando Puppeteer.
     * Interactúa con el formulario ASP.NET exactamente como un usuario real,
     * evitando los problemas de ViewState / EVENTVALIDATION del enfoque HTTP.
     */
    public static async procesarVentaRepuestos(ventaData: VentaRepuestosData): Promise<{ status: boolean; msg: string }> {
        console.log('[DSI Service] Iniciando venta con Puppeteer:', JSON.stringify(ventaData, null, 2));

        const dsiUser = process.env.DSI_USER || '';
        const dsiPass = process.env.DSI_PASS || '';

        if (!dsiUser || !dsiPass) {
            const msg = 'Faltan DSI_USER y/o DSI_PASS en el .env del dsi_service';
            console.error('[DSI Service]', msg);
            return { status: false, msg };
        }

        const browser: Browser = await puppeteer.launch({
            headless: 'shell' as any,
            // Usar el Chromium embebido de Puppeteer — sin perfil de usuario, sin extensiones,
            // sin restricciones de Safe Browsing que bloqueen URLs con session tokens ASP.NET (S(...)).
            // (Chrome del sistema bloqueaba estas URLs vía ERR_BLOCKED_BY_CLIENT)
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,SafeBrowsing'
            ],
        });

        try {
            const page: Page = await browser.newPage();
            page.setDefaultTimeout(30000);

            // =============================================
            // 1. LOGIN
            // =============================================
            console.log('[DSI Service] Navegando a DSI...');
            // ASP.NET cookieless sessions embeden el token en la URL ej: (S(xxx))/index.aspx
            // Chromium puede bloquear ese redirect — usamos 'load' para capturar el primer response
            // y luego verificamos si el form de login está disponible independientemente.
            await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(async (err: Error) => {
                console.warn(`[DSI Service] Navigation warning (puede ser redirect ASP.NET): ${err.message}`);
                // Esperar un poco para que el browser resuelva la redirección
                await PuppeteerService.wait(3000);
            });

            // Verificar si el form de login está presente (a pesar del error de redirect)
            const loginInput = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 10000 }).catch(() => null);
            if (!loginInput) {
                // Intentar navegar directo al index.aspx limpio como fallback
                console.warn('[DSI Service] Form de login no encontrado, intentando index.aspx directo...');
                await page.goto('http://52.21.150.76/concesionario/index.aspx', { waitUntil: 'load', timeout: 20000 }).catch(() => null);
                await PuppeteerService.wait(2000);
                const loginInput2 = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 8000 }).catch(() => null);
                if (!loginInput2) {
                    throw new Error('No se pudo acceder al formulario de login de DSI — verificar conectividad con 52.21.150.76');
                }
            }

            console.log('[DSI Service] Formulario de login detectado. URL actual:', page.url());
            await page.type('input[name="txtUser"]', dsiUser, { delay: 50 });
            await page.type('input[name="txtPassword"]', dsiPass, { delay: 50 });

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
                page.click('input[name="btnIniciar"]'),
            ]);

            const currentUrl = page.url();
            if (currentUrl.includes('index.aspx') || currentUrl.toLowerCase().includes('login')) {
                throw new Error('Login fallido — credenciales incorrectas o timeout');
            }
            console.log('[DSI Service] ✅ Login exitoso. URL:', currentUrl);

            // Calentar sesión en Novedades
            await page.goto(DSI_NOVEDADES_URL, { waitUntil: 'networkidle2' });

            // =============================================
            // 2. ABRIR FORMULARIO DE VENTA
            // =============================================
            console.log('[DSI Service] Abriendo formulario de Alta de Venta...');
            await page.goto(DSI_VENTA_URL, { waitUntil: 'networkidle2' });

            // =============================================
            // 3. DATOS DEL CLIENTE
            // =============================================
            console.log('[DSI Service] Ingresando cliente:', ventaData.cliente.documento);

            await PuppeteerService.wait(2000);
            await page.waitForSelector('input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]', { visible: true });
            await PuppeteerService.wait(1000);

            if (ventaData.sucursalId) {
                await page.evaluate((suc: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$hfId_Sucursal"]');
                    if (el) el.value = suc;
                }, ventaData.sucursalId);
            }

            const DNI_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]';
            await page.waitForSelector(DNI_SEL, { visible: true });
            await page.click(DNI_SEL, { count: 3 });
            await page.type(DNI_SEL, ventaData.cliente.documento, { delay: 60 });
            await PuppeteerService.wait(500);

            console.log('[DSI Service] Confirmando cliente con btnAceptar...');
            await page.click('input[name="ctl00$ContentPlaceHolder1$btnAceptar"]');
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            // Nombre
            await page.evaluate((nombre: string) => {
                const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtNombresComprador"]');
                if (el) { el.value = nombre; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }, ventaData.cliente.nombre);

            // Apellido
            if (ventaData.cliente.apellido) {
                await page.evaluate((ap: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtApellidoComprador"]');
                    if (el) { el.value = ap; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, ventaData.cliente.apellido);
            }

            // Email
            if (ventaData.cliente.email) {
                await page.evaluate((email: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtEmail"]');
                    if (el) { el.value = email; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, ventaData.cliente.email);
            }

            // =============================================
            // 4. CARGAR ÍTEMS
            // =============================================
            console.log('[DSI Service] Esperando que el formulario de ítems esté listo...');
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            for (const item of ventaData.items) {
                console.log(`[DSI Service] Cargando ítem: ${item.codigo} x${item.cantidad}` +
                    (item.precioUnitario ? ` a $${item.precioUnitario}` : ''));

                // --- 4a. Ingresar código del artículo ---
                // txtCodigo puede estar oculto visualmente pero debe estar en el DOM
                const CODIGO_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtCodigo"]';
                await page.waitForSelector(CODIGO_SEL, { timeout: 8000 });
                // Limpiar campo y escribir el código con interacción real
                await page.evaluate(() => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtCodigo"]');
                    if (el) { el.value = ''; el.focus(); }
                });
                await PuppeteerService.wait(300);
                await page.keyboard.type(item.codigo.toUpperCase(), { delay: 60 });

                // Tab dispara la búsqueda AJAX del producto en DSI
                await page.keyboard.press('Tab');
                // Esperar a que el AJAX del producto se complete (networkidle es más confiable que un timeout fijo)
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => null);
                await PuppeteerService.wait(1000);

                // --- 4b. Verificar que el producto fue encontrado (btnPrecioVenta debe aparecer) ---
                const btnPrecio = await page.waitForSelector('input[name*="btnPrecioVenta"]', {
                    visible: true, timeout: 10000
                }).catch(() => null);

                if (!btnPrecio) {
                    throw new Error(`Producto ${item.codigo} no encontrado en inventario DSI`);
                }

                // --- 4c. Setear CANTIDAD con interacción real (click + triple-select + type) ---
                // Esto es crítico: evaluate+dispatchEvent no es suficiente porque ASP.NET lee
                // el valor del campo al hacer submit, y el motor de validación podría ignorar
                // valores seteados solo via JS sin foco/blur real.
                const CANT_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtCantidadRepuesto"]';
                const cantField = await page.$(CANT_SEL);
                if (cantField) {
                    await cantField.click({ count: 3 }); // Seleccionar todo
                    await cantField.type(String(item.cantidad), { delay: 50 });
                    // Blur para confirmar el valor
                    await page.keyboard.press('Tab');
                    await PuppeteerService.wait(400);
                    // Volver el foco al campo de cantidad para asegurarse que ASP.NET lo registró
                    await cantField.click({ count: 3 });
                    await cantField.type(String(item.cantidad), { delay: 50 });
                    await PuppeteerService.wait(300);
                } else {
                    // Fallback: evaluate si el selector no está accesible por Puppeteer
                    console.warn(`[DSI Service] txtCantidadRepuesto no encontrado por selector directo para ${item.codigo}, usando evaluate`);
                    await page.evaluate((cant: string) => {
                        const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtCantidadRepuesto"]');
                        if (el) {
                            el.focus();
                            el.select();
                            el.value = cant;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }, String(item.cantidad));
                    await PuppeteerService.wait(400);
                }

                // --- 4d. Setear PRECIO UNITARIO si se especificó ---
                // CRÍTICO: el precio debe quedar en el campo ANTES de clickear btnPrecioVenta,
                // de lo contrario el carrito registra el precio de lista del sistema y el pago
                // resultante no va a coincidir con el monto enviado → DSI rechaza la venta.
                if (item.precioUnitario !== undefined) {
                    const precioFormatted = item.precioUnitario.toFixed(2).replace('.', ',');

                    // Log diagnóstico: mostrar TODOS los inputs de precio disponibles en el DOM
                    const camposDiag = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
                            .filter(el => {
                                const n = (el.name + el.id).toLowerCase();
                                return n.includes('precio') || n.includes('importe') || n.includes('valor');
                            })
                            .map(el => ({
                                name: el.name,
                                id: el.id,
                                value: el.value,
                                type: el.type,
                                disabled: el.disabled,
                                readOnly: el.readOnly,
                                visible: el.offsetParent !== null,
                            }));
                    });
                    console.log(`[DSI Service] Campos de precio encontrados en DOM:`, JSON.stringify(camposDiag, null, 2));

                    // Selectores a intentar en orden de especificidad
                    const PRECIO_SELECTORS = [
                        'input[name="ctl00$ContentPlaceHolder1$txtPrecioVentaRepuesto"]',
                        'input[name="ctl00$ContentPlaceHolder1$txtPrecioVenta"]',
                        'input[name*="txtPrecioVentaRepuesto"]',
                        'input[name*="txtPrecioVenta"]',
                        'input[name*="txtPrecioUnitario"]',
                        'input[name*="txtImporte"]',
                        'input[id*="txtPrecioVentaRepuesto"]',
                        'input[id*="txtPrecioVenta"]',
                    ];

                    let precioSeteado = false;
                    for (const sel of PRECIO_SELECTORS) {
                        const el = await page.$(sel);
                        if (el) {
                            const state = await el.evaluate((node: Element) => {
                                const inp = node as HTMLInputElement;
                                return { disabled: inp.disabled, readOnly: inp.readOnly, value: inp.value, visible: inp.offsetParent !== null };
                            });
                            console.log(`[DSI Service] Probando selector "${sel}": ${JSON.stringify(state)}`);
                            if (!state.disabled && !state.readOnly) {
                                await el.click({ count: 3 });
                                await el.type(precioFormatted, { delay: 60 });
                                await page.keyboard.press('Tab');
                                await PuppeteerService.wait(500);

                                // Verificar que el valor quedó seteado
                                const valorFinal = await el.evaluate((node: Element) => (node as HTMLInputElement).value);
                                console.log(`[DSI Service] ✅ Precio seteado en "${sel}": esperado="${precioFormatted}" actual="${valorFinal}"`);
                                precioSeteado = true;
                                break;
                            }
                        }
                    }

                    if (!precioSeteado) {
                        // Fallback: buscar por texto en el DOM cualquier input habilitado con "precio"/"importe"
                        const fallbackResult = await page.evaluate((precio: string) => {
                            const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'))
                                .filter(el => {
                                    const n = (el.name + el.id).toLowerCase();
                                    return (n.includes('precio') || n.includes('importe') || n.includes('valor'))
                                        && !el.disabled && !el.readOnly;
                                });
                            if (candidates.length === 0) return { ok: false, tried: [] };
                            const target = candidates[candidates.length - 1];
                            target.focus();
                            target.select();
                            target.value = precio;
                            target.dispatchEvent(new Event('input', { bubbles: true }));
                            target.dispatchEvent(new Event('change', { bubbles: true }));
                            target.dispatchEvent(new Event('blur', { bubbles: true }));
                            return { ok: true, name: target.name, id: target.id, value: target.value };
                        }, precioFormatted);

                        if (fallbackResult.ok) {
                            console.log(`[DSI Service] ⚠ Precio seteado via fallback: ${JSON.stringify(fallbackResult)}`);
                            precioSeteado = true;
                        } else {
                            console.warn(`[DSI Service] ❌ No se encontró campo de precio editable para ${item.codigo}. El precio del sistema se usará y puede causar rechazo si no coincide con el monto de pago.`);
                        }
                        await PuppeteerService.wait(400);
                    }
                }

                // --- 4e. Click en "Precio Venta" → agrega el ítem al carrito ---
                try {
                    await btnPrecio.click();
                } catch {
                    await page.evaluate(() => {
                        const btn = document.querySelector<HTMLInputElement>('input[name*="btnPrecioVenta"]');
                        if (btn) btn.click();
                    });
                }

                // Esperar a que el AJAX de agregar ítem complete (actualiza el grid y saldos)
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
                await PuppeteerService.wait(1500);
                console.log(`[DSI Service] ✓ Ítem ${item.codigo} x${item.cantidad} agregado al carrito`);
            }

            // =============================================
            // 5. FORMA DE PAGO
            // =============================================
            // PROBLEMA RAÍZ CORREGIDO: ASP.NET UpdatePanel NO responde a dispatchEvent('change').
            // Para disparar el postback del servidor (que habilita los campos de pago), se debe
            // llamar directamente a __doPostBack() que es el mecanismo interno de ASP.NET.
            // =============================================
            const formaPagoVal = ventaData.formaPago ?? '1';
            console.log(`[DSI Service] Configurando forma de pago: ${formaPagoVal}`);

            // 5a. Seleccionar Forma de Pago y disparar el postback de ASP.NET
            await page.evaluate((val: string) => {
                const sel = document.querySelector<HTMLSelectElement>('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago"]');
                if (!sel) {
                    console.warn('[DSI] ddlFormaDePago no encontrado en el DOM');
                    return;
                }
                
                // Log and resolve options
                let finalVal = val;
                const options = Array.from(sel.options);
                console.log('[DSI] Opciones de forma de pago disponibles en DSI:', options.map(o => `${o.value}: ${o.text}`).join(', '));
                
                const hasValue = options.some(o => o.value === val);
                if (!hasValue) {
                    // 1. Coincidencia aproximada para Mercado Pago o MP
                    const mpOption = options.find(o => {
                        const t = o.text.toUpperCase();
                        return t.includes('MERCADO') || t.includes('PAGO') || t.includes('MP');
                    });
                    
                    if (mpOption) {
                        finalVal = mpOption.value;
                        console.log(`[DSI] Forma de pago '${val}' no encontrada. Usando coincidencia por texto: '${finalVal}' (${mpOption.text})`);
                    } else {
                        // 2. Coincidencia aproximada para Tarjeta
                        const cardOption = options.find(o => {
                            const t = o.text.toUpperCase();
                            return t.includes('TARJETA') || t.includes('DEBITO') || t.includes('CREDITO');
                        });
                        
                        if (cardOption) {
                            finalVal = cardOption.value;
                            console.log(`[DSI] Fallback a Tarjeta/Débito: '${finalVal}' (${cardOption.text})`);
                        } else {
                            // 3. Fallback definitivo a Efectivo
                            finalVal = '1';
                            console.log(`[DSI] Usando fallback final a Efectivo ('1')`);
                        }
                    }
                }

                sel.value = finalVal;
                
                // Intentar primero con __doPostBack (ASP.NET UpdatePanel)
                if (typeof (window as any).__doPostBack === 'function') {
                    setTimeout(() => { (window as any).__doPostBack('ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago', ''); }, 0);
                } else {
                    // Fallback: event nativo
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, formaPagoVal);

            // Esperar a que inicie el postback disparado por setTimeout
            await PuppeteerService.wait(500);
            // Esperar a que el UpdatePanel recargue los campos del medio de pago
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => null);
            await PuppeteerService.wait(1500);

            // 5b. Seleccionar Concepto (también puede disparar postback en algunos casos)
            await page.evaluate(() => {
                const sel = document.querySelector<HTMLSelectElement>('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlConcepto"]');
                if (!sel) return;
                sel.value = '1';
                if (typeof (window as any).__doPostBack === 'function') {
                    setTimeout(() => { (window as any).__doPostBack('ctl00$ContentPlaceHolder1$wbPagos$ddlConcepto', ''); }, 0);
                } else {
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            await PuppeteerService.wait(500);
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => null);
            await PuppeteerService.wait(800);

            // 5c. Completar campos adicionales del medio de pago (transacción, fecha, titular)
            const pagoData = ventaData.pagoData ?? {};
            const today = new Date();
            const defaultDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;

            await page.evaluate((
                data: { numero?: string; fecha?: string; nombre?: string; apellido?: string },
                defDate: string,
                clienteNombre: string,
                clienteApellido: string
            ) => {
                const setVal = (selector: string, val: string) => {
                    const el = document.querySelector<HTMLInputElement>(selector);
                    if (el) {
                        el.focus();
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                };
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNumTransaccion"]', data.numero ?? '000000');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtFechaVencimiento"]', data.fecha ?? defDate);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtFechaPago"]', data.fecha ?? defDate);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNombre"]', data.nombre ?? clienteNombre);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtApellido"]', data.apellido ?? clienteApellido);
            }, pagoData, defaultDate, ventaData.cliente.nombre, ventaData.cliente.apellido ?? '');
            await PuppeteerService.wait(500);

            // =============================================
            // 5d. Determinar monto total a pagar
            // =============================================
            let montoAPagar: string;

            if (ventaData.montoTotal !== undefined) {
                montoAPagar = ventaData.montoTotal.toFixed(2).replace('.', ',');
                console.log(`[DSI Service] Usando monto explícito: ${montoAPagar}`);
            } else {
                // Leer el saldo calculado por DSI
                const saldoValidar = await page.evaluate(() => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtSaldoValidar"]');
                    return el ? el.value.trim() : '';
                });
                // El saldo validar puede venir como número negativo (ej. "-1500,00") indicando monto adeudado
                const saldoClean = saldoValidar.replace(/[^\d,.-]/g, '');
                montoAPagar = saldoClean.startsWith('-') ? saldoClean.slice(1) : saldoClean;
                console.log(`[DSI Service] Saldo calculado por DSI: raw="${saldoValidar}" → monto="${montoAPagar}"`);

                if (!montoAPagar || montoAPagar === '0' || montoAPagar === '0,00') {
                    console.warn('[DSI Service] ⚠ Saldo calculado es 0 o vacío — verificar que los ítems se agregaron correctamente');
                }
            }

            // Setear el monto en el campo de pago con interacción real
            const MONTO_SEL = 'input[name="ctl00$ContentPlaceHolder1$wbPagos$txtMonto"]';
            const montoField = await page.$(MONTO_SEL);
            let montoSeteadoOk = false;
            if (montoField) {
                try {
                    await montoField.click({ count: 3 });
                    await montoField.type(montoAPagar, { delay: 50 });
                    await page.keyboard.press('Tab');
                    await PuppeteerService.wait(500);
                    montoSeteadoOk = true;
                } catch (e) {
                    console.warn('[DSI Service] Falló click interactivo en montoField, usando evaluate...');
                }
            }
            if (!montoSeteadoOk) {
                // Fallback evaluate
                await page.evaluate((monto: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtMonto"]');
                    if (el) { el.value = monto; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, montoAPagar);
                await PuppeteerService.wait(500);
            }

            // =============================================
            // 6. AGREGAR PAGO
            // =============================================
            console.log(`[DSI Service] Haciendo click en Agregar Pago (monto: ${montoAPagar})...`);
            try {
                await page.click('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
            } catch {
                await page.evaluate(() => {
                    const btn = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
                    if (btn) btn.click();
                });
            }
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            // Verificar saldo restante después del primer pago
            const saldoFinal = await page.evaluate(() => {
                const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtSaldoValidar"]');
                return el ? el.value.trim() : '0';
            });
            console.log(`[DSI Service] Saldo después de Agregar Pago: ${saldoFinal}`);

            // Si quedó saldo pendiente, agregar un segundo pago por el saldo restante
            if (saldoFinal && saldoFinal !== '0' && saldoFinal !== '0,00') {
                const saldoNum = parseFloat(saldoFinal.replace(/\./g, '').replace(',', '.'));
                if (!isNaN(saldoNum) && saldoNum < 0) {
                    const saldoRestante = Math.abs(saldoNum).toFixed(2).replace('.', ',');
                    console.log(`[DSI Service] Saldo pendiente detectado: ${saldoRestante} — agregando pago complementario...`);

                    const montoField2 = await page.$(MONTO_SEL);
                    let montoSeteadoOk2 = false;
                    if (montoField2) {
                        try {
                            await montoField2.click({ count: 3 });
                            await montoField2.type(saldoRestante, { delay: 50 });
                            await page.keyboard.press('Tab');
                            await PuppeteerService.wait(400);
                            montoSeteadoOk2 = true;
                        } catch (e) {
                            console.warn('[DSI Service] Falló click interactivo en montoField2, usando evaluate...');
                        }
                    }
                    if (!montoSeteadoOk2) {
                        await page.evaluate((monto: string) => {
                            const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtMonto"]');
                            if (el) { el.value = monto; el.dispatchEvent(new Event('change', { bubbles: true })); }
                        }, saldoRestante);
                        await PuppeteerService.wait(400);
                    }

                    try {
                        await page.click('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
                    } catch {
                        await page.evaluate(() => {
                            const btn = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
                            if (btn) btn.click();
                        });
                    }
                    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null);
                    await PuppeteerService.wait(1500);

                    const saldoFinal2 = await page.evaluate(() => {
                        const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtSaldoValidar"]');
                        return el ? el.value.trim() : '0';
                    });
                    console.log(`[DSI Service] Saldo después del pago complementario: ${saldoFinal2}`);
                }
            }

            // =============================================
            // 7. GUARDAR
            // =============================================
            console.log('[DSI Service] Guardando la venta...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                page.click('input[name="ctl00$ContentPlaceHolder1$btnGuardar"]'),
            ]);

            const finalUrl = page.url();
            console.log(`[DSI Service] URL final: ${finalUrl}`);

            if (finalUrl.includes('Capturar_Error.aspx')) {
                const errorParam = (() => {
                    try { return new URL(finalUrl).searchParams.get('Error') ?? 'Error desconocido'; }
                    catch { return finalUrl; }
                })();
                throw new Error(`DSI devolvió error al guardar: ${errorParam}`);
            }

            console.log('[DSI Service] ✅ Venta guardada exitosamente.');
            return { status: true, msg: `Venta procesada correctamente. URL final: ${finalUrl}` };

        } catch (error: any) {
            console.error('[DSI Service] Error en Puppeteer:', error.message);
            return { status: false, msg: error.message ?? 'Error desconocido' };
        } finally {
            await browser.close();
            console.log('[DSI Service] Navegador cerrado.');
        }
    }

    public static async getPaymentMethods(): Promise<any[]> {
        const dsiUser = process.env.DSI_USER || '';
        const dsiPass = process.env.DSI_PASS || '';

        const browser = await puppeteer.launch({
            headless: 'shell' as any,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,SafeBrowsing'
            ],
        });

        let page: Page | null = null;
        try {
            page = await browser.newPage();
            page.setDefaultTimeout(30000);

            await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(async (err: Error) => {
                console.warn('[DSI Service] Error o timeout en page.goto a login, intentando recuperar...', err.message);
            });

            // Verificar si el form de login está presente (a pesar del error de redirect)
            const loginInput = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 10000 }).catch(() => null);
            if (!loginInput) {
                console.warn('[DSI Service] Form de login no encontrado, intentando index.aspx directo...');
                await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 8000 }).catch(() => null);
                const loginInput2 = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 8000 }).catch(() => null);
                if (!loginInput2) {
                    throw new Error('No se pudo acceder al formulario de login de DSI — verificar conectividad con 52.21.150.76');
                }
            }

            await page.type('input[name="txtUser"]', dsiUser);
            await page.type('input[name="txtPassword"]', dsiPass);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                page.click('input[name="btnIniciar"]'),
            ]);

            await page.goto(DSI_VENTA_URL, { waitUntil: 'networkidle2' });

            await page.waitForSelector('input[name="ctl00$ContentPlaceHolder1$txtNroDoc"]', { visible: true });
            await page.type('input[name="ctl00$ContentPlaceHolder1$txtNroDoc"]', "99999999");
            await page.keyboard.press('Tab');
            await PuppeteerService.wait(1000);

            await page.click('input[name="ctl00$ContentPlaceHolder1$btnAceptar"]');
            await page.waitForNetworkIdle({ idleTime: 800 }).catch(() => null);
            await PuppeteerService.wait(1500);

            const selectName = "ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago";
            const options = await page.evaluate((name) => {
                const sel = document.querySelector(`select[name="${name}"]`) as HTMLSelectElement;
                if (!sel) return null;
                return Array.from(sel.options).map((o: HTMLOptionElement) => ({ value: o.value, text: o.text }));
            }, selectName);

            return options || [];
        } catch (error: any) {
            const currentUrl = page ? page.url() : 'N/A';
            console.error('[DSI Service] Error en getPaymentMethods:', error.message);
            throw new Error(`[getPaymentMethods] Error en URL (${currentUrl}): ${error.message}`);
        } finally {
            await browser.close();
        }
    }

    private static wait(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
