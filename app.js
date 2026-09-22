/**
 * PixiFX Web Flasher — Клиентский сценарий прошивки и настройки ESP32-S3
 * 
 * Включает:
 * 1. Управление Web Serial API и ESPLoader (esptool-js)
 * 2. Автоматическую загрузку и прошивку firmware.bin (0x10000) и littlefs.bin (0x210000)
 * 3. Аппаратный сброс ESP32-S3 (USB-JTAG CDC / RTS/DTR)
 * 4. Корректную реализацию протокола Improv Wi-Fi Serial (RPC Command & RPC Result)
 * 5. Управление пошаговым визардом (Шаги 1 - 4)
 */

// Импорт ES-модулей esptool-js (с локальным модулем и fallback на CDN)
let ESPLoader = null;
let Transport = null;

async function loadEsptool() {
  if (ESPLoader && Transport) return true;

  try {
    const mod = await import("./lib/esptool-js.js");
    ESPLoader = mod.ESPLoader;
    Transport = mod.Transport;
    logTerminal("Модуль esptool-js успешно загружен локально.");
    return true;
  } catch (errLocal) {
    logTerminal(`Локальный модуль esptool-js не загрузился: ${errLocal.message}. Попытка загрузки из CDN...`, "warn");
    try {
      const modCdn = await import("https://unpkg.com/esptool-js@0.5.4/bundle.js");
      ESPLoader = modCdn.ESPLoader;
      Transport = modCdn.Transport;
      logTerminal("Модуль esptool-js успешно загружен из CDN.");
      return true;
    } catch (errCdn) {
      logTerminal(`Ошибка загрузки esptool-js из CDN: ${errCdn.message}`, "error");
      return false;
    }
  }
}

// Константы смещений прошивки (согласно partitions.csv)
const FLASH_OFFSETS = {
  BOOTLOADER: 0x0000,   // Загрузчик ESP-IDF
  PARTITIONS: 0x8000,   // Таблица разделов
  FIRMWARE: 0x10000,    // Factory App
  LITTLEFS: 0x210000    // LittleFS Web UI
};

// Константы протокола Improv Serial (согласно https://www.improv-wifi.com/serial/)
const IMPROV = {
  HEADER: [0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56], // "IMPROV"
  VERSION: 0x01,
  TYPE_CURRENT_STATE: 0x01,
  TYPE_ERROR_STATE: 0x02,
  TYPE_RPC_COMMAND: 0x03,
  TYPE_RPC_RESULT: 0x04,
  STATE_STOPPED: 0x00,
  STATE_READY: 0x02,
  STATE_PROVISIONING: 0x03,
  STATE_PROVISIONED: 0x04,
  CMD_SEND_WIFI_SETTINGS: 0x01,
  CMD_REQUEST_CURRENT_STATE: 0x02,
  CMD_REQUEST_DEVICE_INFO: 0x03,
  CMD_REQUEST_WIFI_NETWORKS: 0x04
};

// Состояние приложения
const state = {
  currentStep: 1,
  port: null,
  esploader: null,
  transport: null,
  chipInfo: null,
  isFlashing: false,
  improvConnected: false,
  improvReader: null,
  improvWriter: null,
  readLoopActive: false,
  deviceIp: "10.10.1.1",
  macAddress: ""
};

// Хранилище отсканированных Wi-Fi сетей
let isScanningWifi = false;
const scannedNetworks = new Map();

// UI Элементы
const ui = {
  globalStatus: document.getElementById("global-serial-status"),
  globalStatusText: document.getElementById("global-serial-text"),
  browserWarning: document.getElementById("browser-warning"),
  // Вкладки режимов
  tabFullWizard: document.getElementById("tab-full-wizard"),
  tabWifiOnly: document.getElementById("tab-wifi-only"),
  stepsWizardNav: document.querySelector(".steps-wizard-nav"),
  viewWifiStandalone: document.getElementById("view-wifi-standalone"),

  // Шаг 1
  btnConnect: document.getElementById("btn-connect"),
  btnConnectText: document.getElementById("btn-connect-text"),
  btnToStep2: document.getElementById("btn-to-step-2"),
  deviceInfoContainer: document.getElementById("device-info-container"),
  infoChip: document.getElementById("info-chip"),
  infoFlash: document.getElementById("info-flash"),
  infoMac: document.getElementById("info-mac"),
  infoBaud: document.getElementById("info-baud"),
  
  // Шаг 2
  btnStartFlash: document.getElementById("btn-start-flash"),
  btnFlashText: document.getElementById("btn-flash-text"),
  btnForceRst: document.getElementById("btn-force-rst"),
  rebootNotice: document.getElementById("reboot-notice"),
  btnToStep3: document.getElementById("btn-to-step-3"),
  pctFirmware: document.getElementById("pct-firmware"),
  fillFirmware: document.getElementById("fill-firmware"),
  statusFirmware: document.getElementById("status-firmware"),
  pctFs: document.getElementById("pct-fs"),
  fillFs: document.getElementById("fill-fs"),
  statusFs: document.getElementById("status-fs"),

  // Шаг 3
  wifiSsid: document.getElementById("wifi-ssid"),
  wifiScanSelect: document.getElementById("wifi-scan-select"),
  wifiPass: document.getElementById("wifi-pass"),
  btnToggleWifiPass: document.getElementById("btn-toggle-wifi-pass"),
  btnScanWifi: document.getElementById("btn-scan-wifi"),
  btnSendWifi: document.getElementById("btn-send-wifi"),
  btnSendWifiText: document.getElementById("btn-send-wifi-text"),
  btnSkipWifi: document.getElementById("btn-skip-wifi"),
  apSsidDisplay: document.getElementById("ap-ssid-display"),
  btnCopyAp: document.getElementById("btn-copy-ap"),
  copyBtnText: document.getElementById("copy-btn-text"),

  // Режим только Wi-Fi (Standalone)
  wifiOnlyConnectBlock: document.getElementById("wifi-only-connect-block"),
  btnWifiOnlyConnect: document.getElementById("btn-wifi-only-connect"),
  wifiOnlyDeviceInfo: document.getElementById("wifi-only-device-info"),
  wifiOnlyInfoName: document.getElementById("wifi-only-info-name"),
  wifiOnlyInfoFw: document.getElementById("wifi-only-info-fw"),
  wifiOnlyInfoChip: document.getElementById("wifi-only-info-chip"),
  wifiOnlyInfoState: document.getElementById("wifi-only-info-state"),
  wifiOnlySsid: document.getElementById("wifi-only-ssid"),
  wifiOnlyScanSelect: document.getElementById("wifi-only-scan-select"),
  btnWifiOnlyScan: document.getElementById("btn-wifi-only-scan"),
  btnWifiOnlyScanText: document.getElementById("btn-wifi-only-scan-text"),
  wifiOnlyPass: document.getElementById("wifi-only-pass"),
  btnWifiOnlyTogglePass: document.getElementById("btn-wifi-only-toggle-pass"),
  btnWifiOnlySend: document.getElementById("btn-wifi-only-send"),
  btnWifiOnlySendText: document.getElementById("btn-wifi-only-send-text"),
  wifiOnlySuccessBox: document.getElementById("wifi-only-success-box"),
  wifiOnlyFinalIp: document.getElementById("wifi-only-final-ip"),
  btnWifiOnlyOpenWebui: document.getElementById("btn-wifi-only-open-webui"),

  // Шаг 4
  finalDeviceIp: document.getElementById("final-device-ip"),
  btnOpenWebui: document.getElementById("btn-open-webui"),
  btnRestartWizard: document.getElementById("btn-restart-wizard"),

  // Консоль
  terminalOutput: document.getElementById("terminal-output"),
  btnClearTerminal: document.getElementById("btn-clear-terminal")
};

// Вывод в терминал логов
function logTerminal(message, type = "info") {
  const time = new Date().toLocaleTimeString();
  let prefix = `[${time}] `;
  if (type === "error") prefix += "❌ ";
  else if (type === "success") prefix += "✓ ";
  else if (type === "warn") prefix += "⚠️ ";

  ui.terminalOutput.textContent += prefix + message + "\n";
  ui.terminalOutput.scrollTop = ui.terminalOutput.scrollHeight;
}

// Очистка консоли
if (ui.btnClearTerminal) {
  ui.btnClearTerminal.addEventListener("click", () => {
    ui.terminalOutput.textContent = "";
  });
}

// Проверка поддержки Web Serial и протокола
function checkEnvironment() {
  if (window.location.protocol === "file:") {
    ui.protocolWarning.style.display = "flex";
    logTerminal("Внимание: страница открыта по протоколу file://. Для загрузки модулей и Web Serial рекомендуется локальный сервер (http://localhost) или GitHub Pages.", "warn");
  }

  if (!("serial" in navigator)) {
    ui.browserWarning.style.display = "flex";
    ui.btnConnect.disabled = true;
    logTerminal("Web Serial API не поддерживается в вашем браузере", "error");
    return false;
  }
  return true;
}

// Переключение шагов визарда
function setStep(stepNumber) {
  state.currentStep = stepNumber;
  for (let i = 1; i <= 4; i++) {
    const nav = document.getElementById(`step-nav-${i}`);
    const view = document.getElementById(`view-step-${i}`);
    const line = document.getElementById(`line-${i}`);

    if (view) {
      if (i === stepNumber) {
        view.classList.add("active");
      } else {
        view.classList.remove("active");
      }
    }

    if (nav) {
      nav.classList.remove("active", "completed");
      if (i === stepNumber) {
        nav.classList.add("active");
      } else if (i < stepNumber) {
        nav.classList.add("completed");
      }
    }

    if (line) {
      if (i < stepNumber) {
        line.classList.add("active");
      } else {
        line.classList.remove("active");
      }
    }
  }
  logTerminal(`Переход к шагу ${stepNumber}`);
}

// Обновление глобального статуса подключения
function updateGlobalStatus(connected, text) {
  if (!ui.globalStatus || !ui.globalStatusText) return;
  if (connected) {
    ui.globalStatus.classList.remove("offline");
    ui.globalStatus.classList.add("online");
    ui.globalStatusText.textContent = text || "ONLINE";
  } else {
    ui.globalStatus.classList.remove("online");
    ui.globalStatus.classList.add("offline");
    ui.globalStatusText.textContent = text || "OFFLINE";
  }
}

// Подключение к ESP32-S3 через Web Serial
async function connectSerial() {
  if (!checkEnvironment()) return;

  const loaded = await loadEsptool();
  if (!loaded) {
    alert("Библиотека esptool-js не смогла загрузиться. Убедитесь, что страница запущена через веб-сервер (http:// или https://) или проверьте подключение к сети.");
    return;
  }

  try {
    logTerminal("Запрос выбора COM-порта через Web Serial...");
    state.port = await navigator.serial.requestPort();
    
    // Создаем терминал-транспорт для esptool-js
    const espLoaderTerminal = {
      clean() { ui.terminalOutput.textContent = ""; },
      writeLine(data) { logTerminal(data); },
      write(data) { logTerminal(data); }
    };

    state.transport = new Transport(state.port);
    state.esploader = new ESPLoader({
      transport: state.transport,
      baudrate: 115200,
      terminal: espLoaderTerminal
    });

    ui.btnConnectText.textContent = "Синхронизация с ROM...";
    ui.btnConnect.disabled = true;

    logTerminal("Попытка синхронизации с ROM загрузчиком ESP32-S3...");
    const chip = await state.esploader.main();
    logTerminal(`Контроллер обнаружен: ${chip}`, "success");

    // Получаем MAC-адрес чипа
    let mac = "";
    try {
      if (state.esploader.readMac) {
        mac = await state.esploader.readMac();
      } else if (state.esploader.chip && state.esploader.chip.readMac) {
        mac = await state.esploader.chip.readMac(state.esploader);
      }
    } catch (e) {
      logTerminal(`Не удалось прочитать MAC: ${e.message}`, "warn");
    }

    if (mac) {
      state.macAddress = mac;
      ui.infoMac.textContent = mac;
      const macSuffix = mac.replace(/[:-]/g, "").slice(-8).toUpperCase();
      ui.apSsidDisplay.textContent = `PixiFXSetup_${macSuffix}`;
    }

    ui.infoChip.textContent = chip || "ESP32-S3";
    ui.deviceInfoContainer.style.display = "grid";
    ui.btnConnectText.textContent = "Подключено";
    ui.btnToStep2.style.display = "inline-flex";
    updateGlobalStatus(true, "ONLINE");

  } catch (error) {
    logTerminal(`Ошибка подключения: ${error.message}`, "error");
    updateGlobalStatus(false, "OFFLINE");
    ui.btnConnectText.textContent = "Подключить ESP32-S3";
    ui.btnConnect.disabled = false;
  }
}

// Загрузка бинарных файлов с сервера
async function fetchBinary(url) {
  logTerminal(`Загрузка бинарного файла: ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить файл ${url}: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  logTerminal(`Файл ${url} успешно загружен (${buffer.byteLength} байт)`, "success");
  return buffer;
}

// Конвертация ArrayBuffer в бинарную строку для esptool-js
function bufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// Аппаратный сброс ESP32-S3
async function rebootEsp32S3() {
  logTerminal("Выполняется аппаратная перезагрузка ESP32-S3...");
  if (ui.rebootNotice) ui.rebootNotice.style.display = "flex";
  if (ui.btnForceRst) ui.btnForceRst.style.display = "inline-flex";

  try {
    // 1. Стандартный метод esptool-js
    if (state.esploader) {
      try {
        if (state.esploader.hardReset) {
          await state.esploader.hardReset();
        } else if (state.esploader.after) {
          await state.esploader.after("hard_reset");
        }
      } catch (e) {}
    }

    // 2. Двойной импульс линий RTS/DTR специально для USB-JTAG CDC (ESP32-S3 Zero)
    if (state.port && state.port.setSignals) {
      try {
        await state.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(r => setTimeout(r, 150));
        await state.port.setSignals({ dataTerminalReady: true, requestToSend: false });
        await new Promise(r => setTimeout(r, 150));
        await state.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch (e) {}
    }
  } catch (err) {
    logTerminal(`Сброс: ${err.message}`, "warn");
  } finally {
    // 3. Корректно закрываем дескрипторы для освобождения USB шины
    try {
      if (state.transport && state.transport.disconnect) {
        await state.transport.disconnect();
      }
    } catch (e) {}
    state.transport = null;
    state.esploader = null;

    try {
      if (state.port && state.port.readable) {
        await state.port.close();
      }
    } catch (e) {}
  }
}

// Прошивка ESP32-S3
async function flashDevice() {
  if (state.isFlashing || !state.esploader) return;

  state.isFlashing = true;
  ui.btnStartFlash.disabled = true;
  ui.btnFlashText.textContent = "Идет прошивка...";

  // Сброс индикаторов
  ui.pctFirmware.textContent = "0%";
  ui.fillFirmware.style.width = "0%";
  ui.fillFirmware.classList.add("active");
  ui.statusFirmware.textContent = "Загрузка файла...";

  ui.pctFs.textContent = "0%";
  ui.fillFs.style.width = "0%";
  ui.statusFs.textContent = "Ожидание...";

  try {
    // 1. Скачиваем бинарные файлы (bootloader, partitions, firmware, littlefs)
    let bootloaderBuffer = null, partitionsBuffer = null, firmwareBuffer = null, littlefsBuffer = null;

    try {
      bootloaderBuffer = await fetchBinary("./bin/bootloader.bin");
    } catch (e) {
      try { bootloaderBuffer = await fetchBinary("bin/bootloader.bin"); } catch (e2) {}
    }

    try {
      partitionsBuffer = await fetchBinary("./bin/partitions.bin");
    } catch (e) {
      try { partitionsBuffer = await fetchBinary("bin/partitions.bin"); } catch (e2) {}
    }
    
    try {
      firmwareBuffer = await fetchBinary("./bin/firmware.bin");
    } catch (e) {
      logTerminal("Поиск по альтернативному пути bin/firmware.bin...", "warn");
      firmwareBuffer = await fetchBinary("bin/firmware.bin");
    }

    try {
      littlefsBuffer = await fetchBinary("./bin/littlefs.bin");
    } catch (e) {
      logTerminal("Поиск по альтернативному пути bin/littlefs.bin...", "warn");
      littlefsBuffer = await fetchBinary("bin/littlefs.bin");
    }

    const fileArray = [];
    if (bootloaderBuffer) {
      fileArray.push({ data: bufferToBinaryString(bootloaderBuffer), address: FLASH_OFFSETS.BOOTLOADER });
    }
    if (partitionsBuffer) {
      fileArray.push({ data: bufferToBinaryString(partitionsBuffer), address: FLASH_OFFSETS.PARTITIONS });
    }
    const fwFileIndex = fileArray.length;
    fileArray.push({ data: bufferToBinaryString(firmwareBuffer), address: FLASH_OFFSETS.FIRMWARE });
    const fsFileIndex = fileArray.length;
    fileArray.push({ data: bufferToBinaryString(littlefsBuffer), address: FLASH_OFFSETS.LITTLEFS });

    logTerminal("Переключение скорости на 921600 бод для быстрой прошивки...");
    
    // Функция обратного вызова прогресса
    const calculateProgress = (fileIndex, written, total) => {
      const pct = Math.floor((written / total) * 100);
      if (fileIndex === fwFileIndex) {
        ui.pctFirmware.textContent = `${pct}%`;
        ui.fillFirmware.style.width = `${pct}%`;
        ui.statusFirmware.textContent = `Запись прошивки: ${Math.round(written / 1024)} / ${Math.round(total / 1024)} КБ`;
      } else if (fileIndex === fsFileIndex) {
        ui.pctFs.textContent = `${pct}%`;
        ui.fillFs.style.width = `${pct}%`;
        ui.statusFs.textContent = `Запись LittleFS: ${Math.round(written / 1024)} / ${Math.round(total / 1024)} КБ`;
      }
    };

    // Запуск прошивки через esptool-js
    ui.statusFirmware.textContent = "Прошивка Factory App...";
    ui.fillFs.classList.add("active");

    await state.esploader.writeFlash({
      fileArray: fileArray,
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        calculateProgress(fileIndex, written, total);
      }
    });

    logTerminal("Загрузчик, таблица разделов, прошивка и LittleFS успешно записаны!", "success");
    ui.pctFirmware.textContent = "100%";
    ui.fillFirmware.style.width = "100%";
    ui.fillFirmware.classList.remove("active");
    ui.statusFirmware.textContent = "Успешно записано";

    ui.pctFs.textContent = "100%";
    ui.fillFs.style.width = "100%";
    ui.fillFs.classList.remove("active");
    ui.statusFs.textContent = "Успешно записано";

    ui.btnFlashText.textContent = "Установка завершена!";
    ui.btnToStep3.style.display = "inline-flex";

    // Сброс и перезагрузка контроллера
    await rebootEsp32S3();

  } catch (error) {
    logTerminal(`Ошибка в процессе прошивки: ${error.message}`, "error");
    ui.btnFlashText.textContent = "Повторить попытку";
    ui.btnStartFlash.disabled = false;
    ui.statusFirmware.textContent = "Ошибка записи";
    ui.fillFirmware.classList.remove("active");
    ui.fillFs.classList.remove("active");
  } finally {
    state.isFlashing = false;
  }
}

// -------------------------------------------------------------
// ДРАЙВЕР IMPROV WI-FI SERIAL
// -------------------------------------------------------------

// Инициализация Improv Serial соединения после перезагрузки
async function initImprovSerial(forceUserPrompt = false) {
  if (!forceUserPrompt && state.improvConnected && state.improvWriter && state.port?.writable) {
    return true;
  }

  logTerminal("Инициализация Improv Serial подключения...");

  // 1. Освобождаем предыдущие стримы
  if (state.improvReader) {
    try { await state.improvReader.cancel(); } catch (e) {}
    try { state.improvReader.releaseLock(); } catch (e) {}
    state.improvReader = null;
  }
  if (state.improvWriter) {
    try { state.improvWriter.releaseLock(); } catch (e) {}
    state.improvWriter = null;
  }
  if (state.transport && state.transport.disconnect) {
    try { await state.transport.disconnect(); } catch (e) {}
    state.transport = null;
  }

  // 2. Закрываем старый порт без падения на ошибках
  if (state.port) {
    try {
      await state.port.close();
    } catch (e) {
      // Игнорируем ошибки уже закрытого порта
    }
    if (forceUserPrompt) {
      state.port = null;
    }
  }

  // 3. Получаем доступный COM-порт
  try {
    if (forceUserPrompt) {
      logTerminal("Запрос выбора COM-порта через Web Serial...");
      state.port = await navigator.serial.requestPort();
    } else {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        state.port = ports[ports.length - 1];
      } else {
        logTerminal("Запрос выбора COM-порта через Web Serial...");
        state.port = await navigator.serial.requestPort();
      }
    }
  } catch (err) {
    logTerminal(`Запрос порта: ${err.message}`, "warn");
  }

  if (!state.port) {
    logTerminal("COM-порт не выбран", "error");
    return false;
  }

  // Небольшая задержка для завершения USB-энумерации в Windows
  await new Promise(r => setTimeout(r, 500));

  // 4. Открываем порт на скорости 115200 бод
  try {
    logTerminal("Открытие Web Serial порта для Improv (115200 бод)...");
    await state.port.open({ baudRate: 115200 });
  } catch (openErr) {
    logTerminal(`Повторная попытка открытия порта: ${openErr.message}`, "warn");
    try {
      const allPorts = await navigator.serial.getPorts();
      if (allPorts.length > 0) {
        state.port = allPorts[allPorts.length - 1];
        await state.port.open({ baudRate: 115200 });
      } else {
        return false;
      }
    } catch (e2) {
      logTerminal(`Не удалось открыть Serial порт: ${e2.message}`, "error");
      return false;
    }
  }

  try {
    state.improvWriter = state.port.writable.getWriter();
    startImprovReader();
    state.improvConnected = true;
    updateGlobalStatus(true, "ONLINE");
    logTerminal("Improv Serial порт готов к работе.", "success");

    // Запрашиваем информацию и состояние устройства
    setTimeout(() => {
      sendImprovCommand(IMPROV.CMD_REQUEST_DEVICE_INFO);
      sendImprovCommand(IMPROV.CMD_REQUEST_CURRENT_STATE);
    }, 600);

    return true;
  } catch (err) {
    logTerminal(`Ошибка подключения Improv Serial: ${err.message}`, "error");
    updateGlobalStatus(false, "OFFLINE");
    return false;
  }
}

// Чтение байтов Improv из Serial
async function startImprovReader() {
  if (state.readLoopActive || !state.port || !state.port.readable) return;
  state.readLoopActive = true;

  try {
    state.improvReader = state.port.readable.getReader();
    let packetBuffer = [];

    while (state.readLoopActive) {
      const { value, done } = await state.improvReader.read();
      if (done) break;
      if (value) {
        for (let i = 0; i < value.length; i++) {
          processImprovByte(value[i], packetBuffer);
        }
      }
    }
  } catch (error) {
    logTerminal(`Serial Reader: ${error.message}`, "warn");
    updateGlobalStatus(false, "OFFLINE");
  } finally {
    state.readLoopActive = false;
  }
}

// Побайтовый парсер пакетов Improv
function processImprovByte(byte, buf) {
  buf.push(byte);

  // Проверяем наличие заголовка "IMPROV"
  if (buf.length >= 6) {
    const isHeader = IMPROV.HEADER.every((h, idx) => buf[idx] === h);
    if (!isHeader) {
      buf.shift();
      return;
    }

    // Если заголовок найден, проверяем длину всего пакета
    if (buf.length >= 9) {
      const dataLen = buf[8];
      const totalLen = 6 + 1 + 1 + 1 + dataLen + 1; // header(6) + ver(1) + type(1) + len(1) + data + crc(1)

      if (buf.length >= totalLen) {
        const packet = buf.splice(0, totalLen);
        handleImprovPacket(packet);
      }
    }
  }
}

// Обработка входящего Improv пакета
function handleImprovPacket(packet) {
  const type = packet[7];
  const len = packet[8];
  const data = packet.slice(9, 9 + len);

  // Валидация Checksum
  let sum = 0;
  for (let i = 0; i < packet.length - 1; i++) {
    sum = (sum + packet[i]) & 0xff;
  }
  if (sum !== packet[packet.length - 1]) {
    logTerminal("Improv: Несовпадение контрольной суммы пакета", "warn");
    return;
  }

  // 1. Current State (Тип 0x01)
  if (type === IMPROV.TYPE_CURRENT_STATE) {
    const currentState = data[0];
    const stateNames = {
      [IMPROV.STATE_STOPPED]: "Stopped",
      [IMPROV.STATE_READY]: "Ready (Готов к приему Wi-Fi)",
      [IMPROV.STATE_PROVISIONING]: "Provisioning (Подключение...)",
      [IMPROV.STATE_PROVISIONED]: "Provisioned (Подключено!)"
    };
    const stateLabel = stateNames[currentState] || ("0x0" + currentState);
    logTerminal(`Improv: Состояние -> ${stateLabel}`);
    
    if (ui.wifiOnlyInfoState) {
      ui.wifiOnlyInfoState.textContent = stateLabel;
    }

    if (currentState === IMPROV.STATE_PROVISIONED) {
      logTerminal("Контроллер успешно подключился к Wi-Fi!", "success");
      ui.btnSendWifiText.textContent = "Подключено!";
      ui.btnSendWifi.disabled = true;
      if (ui.btnWifiOnlySendText) {
        ui.btnWifiOnlySendText.textContent = "Подключено!";
        ui.btnWifiOnlySend.disabled = true;
      }
      if (state.activeTab === "wizard") {
        setStep(4);
      }
    }
  } 
  // 2. RPC Result (Тип 0x04)
  else if (type === IMPROV.TYPE_RPC_RESULT) {
    const cmd = data[0];
    // В спецификации Improv: data[0]=Command, data[1]=TotalDataLength, data[2..]=Strings
    const strings = parseRpcStrings(data.slice(2));

    // Результат сканирования Wi-Fi (команда 0x04)
    if (cmd === IMPROV.CMD_REQUEST_WIFI_NETWORKS) {
      if (strings.length >= 1 && strings[0]) {
        const ssid = strings[0];
        const rssi = strings[1] || "";
        const auth = strings[2] || "";

        if (!scannedNetworks.has(ssid)) {
          scannedNetworks.set(ssid, { rssi, auth });
          
          // Добавление в селектор визарда
          const opt = document.createElement("option");
          opt.value = ssid;
          opt.textContent = `${ssid} (${rssi} dBm)${auth === "YES" ? " 🔒" : ""}`;
          ui.wifiScanSelect.appendChild(opt);

          // Добавление в селектор standalone вкладки
          const optOnly = document.createElement("option");
          optOnly.value = ssid;
          optOnly.textContent = `${ssid} (${rssi} dBm)${auth === "YES" ? " 🔒" : ""}`;
          ui.wifiOnlyScanSelect.appendChild(optOnly);

          logTerminal(`Найдена сеть: ${ssid} (${rssi} dBm, защита: ${auth})`);
        }
      } else {
        // Пустой список строк сигнализирует о завершении сканирования
        logTerminal(`Сканирование сетей завершено. Найдено сетей: ${scannedNetworks.size}`, "success");
        endWifiScan();
      }
    } 
    // Информация об устройстве (команда 0x03)
    else if (cmd === IMPROV.CMD_REQUEST_DEVICE_INFO) {
      logTerminal(`Improv Info: Прошивка "${strings[0]}", Версия "${strings[1]}", Чип "${strings[2]}", Имя "${strings[3]}"`);
      if (ui.wifiOnlyInfoName) ui.wifiOnlyInfoName.textContent = strings[3] || "PixiFX";
      if (ui.wifiOnlyInfoFw) ui.wifiOnlyInfoFw.textContent = `v${strings[1] || "1.0.0"}`;
      if (ui.wifiOnlyInfoChip) ui.wifiOnlyInfoChip.textContent = strings[2] || "ESP32-S3";
      if (ui.wifiOnlyDeviceInfo) ui.wifiOnlyDeviceInfo.style.display = "grid";
      if (ui.wifiOnlyConnectBlock) ui.wifiOnlyConnectBlock.style.display = "none";
    }
    // Отправка Wi-Fi настроек (команда 0x01)
    else if (cmd === IMPROV.CMD_SEND_WIFI_SETTINGS) {
      if (strings.length > 0 && strings[0]) {
        let ip = strings[0].replace(/^http:\/\//, "").replace(/\/$/, "");
        state.deviceIp = ip;
        ui.finalDeviceIp.textContent = ip;
        ui.btnOpenWebui.href = `http://${ip}`;
        
        if (ui.wifiOnlyFinalIp) ui.wifiOnlyFinalIp.textContent = ip;
        if (ui.btnWifiOnlyOpenWebui) ui.btnWifiOnlyOpenWebui.href = `http://${ip}`;
        if (ui.wifiOnlySuccessBox) ui.wifiOnlySuccessBox.style.display = "flex";

        logTerminal(`Контроллер получил IP адрес: ${ip}`, "success");
        if (state.activeTab === "wizard") {
          setStep(4);
        }
      }
    }
    else {
      logTerminal(`Improv RPC Result [0x0${cmd}]: ${strings.join(", ")}`);
    }
  } 
  // 3. Error State (Тип 0x02)
  else if (type === IMPROV.TYPE_ERROR_STATE) {
    const err = data[0];
    const errMessages = {
      0x01: "Некорректный RPC пакет (Invalid RPC)",
      0x02: "Неизвестная RPC команда",
      0x03: "Не удалось подключиться к Wi-Fi сети (проверьте пароль)",
      0x04: "Не авторизовано",
      0x05: "Недопустимое имя хоста"
    };

    if (err !== 0) {
      logTerminal(`Improv Ошибка: ${errMessages[err] || ("Код 0x0" + err)}`, "error");
      ui.btnSendWifiText.textContent = "Ошибка. Повторить";
      ui.btnSendWifi.disabled = false;
      if (ui.btnWifiOnlySendText) {
        ui.btnWifiOnlySendText.textContent = "Ошибка. Повторить";
        ui.btnWifiOnlySend.disabled = false;
      }
      endWifiScan();
    }
  }
}

// Разбор строк формата Improv (длина + байты)
function parseRpcStrings(data) {
  const result = [];
  let idx = 0;
  while (idx < data.length) {
    const len = data[idx++];
    if (idx + len <= data.length) {
      const strBytes = data.slice(idx, idx + len);
      result.push(new TextDecoder().decode(new Uint8Array(strBytes)));
      idx += len;
    } else {
      break;
    }
  }
  return result;
}

// Отправка команды Improv RPC (согласно спецификации: [cmd, dataLen, ...params])
async function sendImprovCommand(commandId, params = []) {
  if (!state.improvWriter) {
    const ok = await initImprovSerial();
    if (!ok || !state.improvWriter) {
      logTerminal("Не удалось отправить Improv команду: порт не открыт.", "error");
      return;
    }
  }

  // Формируем полезную нагрузку параметров
  const paramPayload = [];
  for (const str of params) {
    const strBytes = new TextEncoder().encode(str);
    paramPayload.push(strBytes.length);
    for (const b of strBytes) paramPayload.push(b);
  }

  // dataPayload: [Command, TotalDataLength, ...paramPayload]
  const dataPayload = [commandId, paramPayload.length, ...paramPayload];

  const packet = [
    ...IMPROV.HEADER,
    IMPROV.VERSION,
    IMPROV.TYPE_RPC_COMMAND,
    dataPayload.length,
    ...dataPayload
  ];

  // Расчет контрольной суммы (Checksum)
  let checksum = 0;
  for (const b of packet) checksum = (checksum + b) & 0xff;
  packet.push(checksum);

  logTerminal(`Отправка Improv RPC команды 0x0${commandId}...`);
  try {
    await state.improvWriter.write(new Uint8Array(packet));
  } catch (err) {
    logTerminal(`Ошибка отправки Improv команды: ${err.message}`, "error");
  }
}

// Сканирование Wi-Fi сетей
async function requestWifiScan() {
  if (isScanningWifi) return;
  
  if (!state.improvWriter) {
    const ok = await initImprovSerial();
    if (!ok) {
      logTerminal("Не удалось запустить сканирование: Serial порт недоступен.", "error");
      return;
    }
  }

  isScanningWifi = true;
  ui.btnScanWifi.disabled = true;
  if (ui.btnWifiOnlyScan) ui.btnWifiOnlyScan.disabled = true;

  const spinHtml = `
    <svg class="spin-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="2" x2="12" y2="6"></line>
      <line x1="12" y1="18" x2="12" y2="22"></line>
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
      <line x1="2" y1="12" x2="6" y2="12"></line>
      <line x1="18" y1="12" x2="22" y2="12"></line>
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
    </svg>
    <span>Поиск...</span>
  `;

  ui.btnScanWifi.innerHTML = spinHtml;
  if (ui.btnWifiOnlyScan) ui.btnWifiOnlyScan.innerHTML = spinHtml;

  scannedNetworks.clear();
  ui.wifiScanSelect.innerHTML = '<option value="">Поиск сетей...</option>';
  ui.wifiScanSelect.style.display = "block";
  if (ui.wifiOnlyScanSelect) {
    ui.wifiOnlyScanSelect.innerHTML = '<option value="">Поиск сетей...</option>';
    ui.wifiOnlyScanSelect.style.display = "block";
  }

  logTerminal("Запуск сканирования Wi-Fi сетей через Improv RPC...");
  await sendImprovCommand(IMPROV.CMD_REQUEST_WIFI_NETWORKS);

  // Таймаут на случай отсутствия ответа
  setTimeout(() => {
    if (isScanningWifi) {
      endWifiScan();
    }
  }, 10000);
}

function endWifiScan() {
  isScanningWifi = false;
  ui.btnScanWifi.disabled = false;
  if (ui.btnWifiOnlyScan) ui.btnWifiOnlyScan.disabled = false;

  const btnHtml = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"></polyline>
      <polyline points="1 20 1 14 7 14"></polyline>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
    <span>Сканировать сети</span>
  `;

  ui.btnScanWifi.innerHTML = btnHtml;
  if (ui.btnWifiOnlyScan) ui.btnWifiOnlyScan.innerHTML = btnHtml;
}

// Отправка данных Wi-Fi (SSID + Password)
async function sendWifiCredentials(customSsid, customPass) {
  const ssid = (customSsid !== undefined ? customSsid : ui.wifiSsid.value).trim();
  const pass = (customPass !== undefined ? customPass : ui.wifiPass.value);

  if (!ssid) {
    alert("Пожалуйста, введите имя Wi-Fi сети (SSID)");
    return;
  }

  ui.btnSendWifi.disabled = true;
  ui.btnSendWifiText.textContent = "Подключение к сети...";
  if (ui.btnWifiOnlySend) {
    ui.btnWifiOnlySend.disabled = true;
    ui.btnWifiOnlySendText.textContent = "Подключение к сети...";
  }

  logTerminal(`Передача параметров Wi-Fi: SSID "${ssid}"...`);
  await sendImprovCommand(IMPROV.CMD_SEND_WIFI_SETTINGS, [ssid, pass]);
}

// Переключение вкладок «Полная установка» и «Настройка Wi-Fi»
function switchAppTab(tabName) {
  state.activeTab = tabName;

  if (tabName === "wizard") {
    ui.tabFullWizard.classList.add("active");
    ui.tabWifiOnly.classList.remove("active");
    ui.stepsWizardNav.style.display = "flex";
    ui.viewWifiStandalone.classList.remove("active");
    setStep(state.currentStep);
    logTerminal("Переключение на режим: Полная установка");
  } else if (tabName === "wifi") {
    ui.tabWifiOnly.classList.add("active");
    ui.tabFullWizard.classList.remove("active");
    ui.stepsWizardNav.style.display = "none";
    for (let i = 1; i <= 4; i++) {
      document.getElementById(`view-step-${i}`)?.classList.remove("active");
    }
    ui.viewWifiStandalone.classList.add("active");
    logTerminal("Переключение на режим: Настройка Wi-Fi");

    if (state.improvConnected) {
      if (ui.wifiOnlyConnectBlock) ui.wifiOnlyConnectBlock.style.display = "none";
      if (ui.wifiOnlyDeviceInfo) ui.wifiOnlyDeviceInfo.style.display = "grid";
      sendImprovCommand(IMPROV.CMD_REQUEST_DEVICE_INFO);
      sendImprovCommand(IMPROV.CMD_REQUEST_CURRENT_STATE);
    } else {
      if (ui.wifiOnlyConnectBlock) ui.wifiOnlyConnectBlock.style.display = "flex";
      if (ui.wifiOnlyDeviceInfo) ui.wifiOnlyDeviceInfo.style.display = "none";
    }
  }
}

// -------------------------------------------------------------
// НАЗНАЧЕНИЕ СОБЫТИЙ ИНТЕРФЕЙСА
// -------------------------------------------------------------

// Вкладки режимов в хедере
ui.tabFullWizard.addEventListener("click", () => switchAppTab("wizard"));
ui.tabWifiOnly.addEventListener("click", () => switchAppTab("wifi"));

// Кнопка подключения на Шаге 1
ui.btnConnect.addEventListener("click", connectSerial);

// Переход к Шагу 2
ui.btnToStep2.addEventListener("click", () => setStep(2));

// Кнопка запуска прошивки на Шаге 2
ui.btnStartFlash.addEventListener("click", flashDevice);

// Кнопка ручного импульса RST
if (ui.btnForceRst) {
  ui.btnForceRst.addEventListener("click", rebootEsp32S3);
}

// Переход к Шагу 3 (Настройка Wi-Fi)
ui.btnToStep3.addEventListener("click", async () => {
  setStep(3);
  await initImprovSerial();
});

// Кнопка сканирования Wi-Fi сетей (Шаг 3)
ui.btnScanWifi.addEventListener("click", requestWifiScan);

// Выбор сети из выпадающего списка (Шаг 3)
ui.wifiScanSelect.addEventListener("change", () => {
  if (ui.wifiScanSelect.value) {
    ui.wifiSsid.value = ui.wifiScanSelect.value;
    ui.wifiPass.focus();
  }
});

// Отправка Wi-Fi на Шаге 3
ui.btnSendWifi.addEventListener("click", () => sendWifiCredentials());

// Пропустить Wi-Fi и перейти к Шагу 4
ui.btnSkipWifi.addEventListener("click", () => {
  setStep(4);
});

// Кнопка "Начать заново" на Шаге 4
ui.btnRestartWizard.addEventListener("click", () => {
  location.reload();
});

// Переключение видимости пароля Wi-Fi (Шаг 3)
ui.btnToggleWifiPass.addEventListener("click", () => {
  ui.wifiPass.type = (ui.wifiPass.type === "password") ? "text" : "password";
});

// --- Обработчики режима «Настройка Wi-Fi» ---
if (ui.btnWifiOnlyConnect) {
  ui.btnWifiOnlyConnect.addEventListener("click", async () => {
    const ok = await initImprovSerial(true);
    if (ok) {
      if (ui.wifiOnlyConnectBlock) ui.wifiOnlyConnectBlock.style.display = "none";
      if (ui.wifiOnlyDeviceInfo) ui.wifiOnlyDeviceInfo.style.display = "grid";
      updateGlobalStatus(true, "ONLINE");
    }
  });
}

if (ui.btnWifiOnlyScan) {
  ui.btnWifiOnlyScan.addEventListener("click", requestWifiScan);
}

if (ui.wifiOnlyScanSelect) {
  ui.wifiOnlyScanSelect.addEventListener("change", () => {
    if (ui.wifiOnlyScanSelect.value) {
      ui.wifiOnlySsid.value = ui.wifiOnlyScanSelect.value;
      ui.wifiOnlyPass.focus();
    }
  });
}

if (ui.btnWifiOnlySend) {
  ui.btnWifiOnlySend.addEventListener("click", () => {
    sendWifiCredentials(ui.wifiOnlySsid.value, ui.wifiOnlyPass.value);
  });
}

if (ui.btnWifiOnlyTogglePass) {
  ui.btnWifiOnlyTogglePass.addEventListener("click", () => {
    ui.wifiOnlyPass.type = (ui.wifiOnlyPass.type === "password") ? "text" : "password";
  });
}

// Копирование префикса точки доступа
ui.btnCopyAp.addEventListener("click", () => {
  const text = ui.apSsidDisplay.textContent;
  navigator.clipboard.writeText(text).then(() => {
    ui.copyBtnText.textContent = "Скопировано!";
    setTimeout(() => {
      ui.copyBtnText.textContent = "Копировать";
    }, 2000);
  });
});

// Слушатель отключения USB-устройства в Web Serial API
if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", (event) => {
    logTerminal("Устройство отключено от USB (Serial Disconnect)", "warn");
    state.improvConnected = false;
    state.readLoopActive = false;
    updateGlobalStatus(false, "OFFLINE");
  });
}

// Инициализация при загрузке страницы
document.addEventListener("DOMContentLoaded", () => {
  state.activeTab = "wizard";
  checkEnvironment();
  logTerminal("Инициализация PixiFX Web Flasher завершена.");
});
